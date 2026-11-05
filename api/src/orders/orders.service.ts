import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ActivityService } from '../activity/activity.service';
import { one, q, tx } from '../common/db';
import { InventoryService } from '../inventory/inventory.service';
import { JobsService } from '../jobs/jobs.service';
import { ConnectionsService } from '../marketplaces/connections.service';
import { adapterFor } from '../marketplaces/registry';
import { Connection, MP_LABEL, NormalizedOrder } from '../marketplaces/types';

const cap = (s: string) => MP_LABEL[s] ?? s;

@Injectable()
export class OrdersService {
  constructor(
    private inventory: InventoryService, private activity: ActivityService,
    private connections: ConnectionsService, private jobs: JobsService,
  ) {}

  /**
   * Ingest a marketplace order (from webhook, poll, or mock simulation). Idempotent.
   *  - New order   → insert + reserve stock per line (atomic), notify, then sync all channels.
   *  - Known order → apply state transitions only (cancel → release; fulfilled → consume stock).
   */
  async ingest(conn: Connection, o: NormalizedOrder): Promise<{ orderId: string; created: boolean }> {
    const changed: string[] = [];
    const result = await tx(async (c) => {
      const ins = await one(
        `INSERT INTO orders(org_id,connection_id,marketplace,external_order_id,customer_name,customer_email,ship_address,order_date,
                            marketplace_status,payment_status,currency,subtotal,shipping_cost,tax,fees,refunds,total,shipping_method,carrier,tracking_number,raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (connection_id, external_order_id) DO NOTHING RETURNING id`,
        [conn.org_id, conn.id, conn.marketplace, o.externalOrderId, o.customerName, o.customerEmail, o.shipAddress, o.orderDate,
          o.marketplaceStatus, o.paymentStatus, o.currency, o.subtotal, o.shippingCost, o.tax, o.fees, o.refunds, o.total,
          o.shippingMethod, o.carrier, o.trackingNumber, o.raw], c);

      if (ins) {
        await this.activity.log({ orgId: conn.org_id, action: 'order.received', entityType: 'order', entityId: ins.id,
          message: `New order received from ${cap(conn.marketplace)}${conn.mode === 'mock' ? ' (mock)' : ''} — #${o.externalOrderId}` }, c);
        let short = false;
        for (const it of o.items) {
          const variant = await this.mapSku(c, conn, it.sku);
          const item = await one(
            `INSERT INTO order_items(order_id,variant_id,external_line_id,sku,title,quantity,unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [ins.id, variant?.id ?? null, it.externalLineId, it.sku, it.title, it.quantity, it.unitPrice], c);
          if (!variant) {
            await this.activity.log({ orgId: conn.org_id, action: 'order.unmapped', level: 'warning', entityType: 'order', entityId: ins.id, message: `SKU "${it.sku ?? '(none)'}" on order #${o.externalOrderId} is not in the catalog — stock not deducted` }, c);
            continue;
          }
          if (o.cancelled) { await q(`UPDATE order_items SET stock_state='released' WHERE id=$1`, [item!.id], c); continue; }
          const ok = await this.inventory.reserve(c, conn.org_id, item!.id, variant.id, it.quantity, ins.id);
          if (ok) {
            changed.push(variant.id);
            await q(`UPDATE order_items SET stock_state='reserved' WHERE id=$1`, [item!.id], c);
            await this.activity.log({ orgId: conn.org_id, action: 'inventory.deducted', entityType: 'variant', entityId: variant.id, message: `Inventory deducted by ${it.quantity} unit${it.quantity > 1 ? 's' : ''} (${variant.sku})` }, c);
            if (o.fulfilled) await this.settleItem(c, conn.org_id, item!.id, 'fulfil', ins.id);
          } else {
            short = true;
            await q(`UPDATE order_items SET stock_state='short' WHERE id=$1`, [item!.id], c);
          }
        }
        await q(`UPDATE orders SET stock_conflict=$2, internal_status=$3, fulfillment_status=$4 WHERE id=$1`,
          [ins.id, short, o.cancelled ? 'cancelled' : o.fulfilled ? 'shipped' : 'new', o.cancelled ? 'cancelled' : o.fulfilled ? 'fulfilled' : 'unfulfilled'], c);
        if (short) {
          await this.activity.notify({ orgId: conn.org_id, type: 'stock_conflict', severity: 'error', title: `Possible oversell on ${cap(conn.marketplace)} order #${o.externalOrderId}`,
            body: 'This order asked for more units than were available. Review stock, then fulfil or cancel on the marketplace.', refType: 'order', refId: ins.id }, c);
          await this.activity.log({ orgId: conn.org_id, action: 'order.stock_conflict', level: 'error', entityType: 'order', entityId: ins.id, message: `Insufficient stock for order #${o.externalOrderId} — flagged for review` }, c);
        }
        await this.activity.notify({ orgId: conn.org_id, type: 'new_order', title: `New ${cap(conn.marketplace)} order #${o.externalOrderId}`, body: `${o.items.reduce((s, i) => s + i.quantity, 0)} item(s) · ${o.currency} ${o.total.toFixed(2)}`, refType: 'order', refId: ins.id }, c);
        return { orderId: ins.id as string, created: true };
      }

      // Existing order: lock and apply transitions.
      const ex = await one(`SELECT * FROM orders WHERE connection_id=$1 AND external_order_id=$2 FOR UPDATE`, [conn.id, o.externalOrderId], c);
      const items = await q(`SELECT * FROM order_items WHERE order_id=$1`, [ex!.id], c);
      if (o.cancelled && ex!.internal_status !== 'cancelled') {
        for (const it of items.filter((i) => i.stock_state === 'reserved')) changed.push(...(await this.settleItem(c, conn.org_id, it.id, 'release', ex!.id)));
        await q(`UPDATE orders SET internal_status='cancelled', fulfillment_status='cancelled' WHERE id=$1`, [ex!.id], c);
        await this.activity.log({ orgId: conn.org_id, action: 'order.cancelled', level: 'warning', entityType: 'order', entityId: ex!.id, message: `Order #${o.externalOrderId} cancelled on ${cap(conn.marketplace)} — reserved stock released` }, c);
      } else if (o.fulfilled && ex!.fulfillment_status !== 'fulfilled') {
        for (const it of items.filter((i) => i.stock_state === 'reserved')) changed.push(...(await this.settleItem(c, conn.org_id, it.id, 'fulfil', ex!.id)));
        await q(`UPDATE orders SET fulfillment_status='fulfilled', internal_status=CASE WHEN internal_status IN ('new','processing') THEN 'shipped' ELSE internal_status END WHERE id=$1`, [ex!.id], c);
      }
      await q(`UPDATE orders SET marketplace_status=$2, payment_status=$3, refunds=$4, fees=COALESCE($5,fees), tracking_number=COALESCE(tracking_number,$6), carrier=COALESCE(carrier,$7), raw=$8, updated_at=now() WHERE id=$1`,
        [ex!.id, o.marketplaceStatus, o.paymentStatus, o.refunds, o.fees, o.trackingNumber, o.carrier, o.raw], c);
      return { orderId: ex!.id as string, created: false };
    });
    if (changed.length) await this.inventory.afterChange(conn.org_id, Array.from(new Set(changed)));
    return result;
  }

  private async settleItem(c: PoolClient, orgId: string, itemId: string, action: 'fulfil' | 'release', ref: string) {
    const vs = await this.inventory.settle(c, orgId, itemId, action, ref);
    await q(`UPDATE order_items SET stock_state=$2 WHERE id=$1`, [itemId, action === 'fulfil' ? 'fulfilled' : 'released'], c);
    return vs;
  }

  /** SKU mapping: the listing's mapped variant first (handles marketplace SKUs that differ), then catalog SKU. */
  private async mapSku(c: PoolClient, conn: Connection, sku: string | null) {
    if (!sku) return null;
    return (await one(
      `SELECT v.id, v.sku FROM listing_variants lv JOIN listings l ON l.id=lv.listing_id JOIN variants v ON v.id=lv.variant_id
        WHERE l.connection_id=$1 AND (lv.external_ref=$2 OR v.sku=$2) LIMIT 1`, [conn.id, sku], c))
      ?? (await one(`SELECT id, sku FROM variants WHERE org_id=$1 AND sku=$2`, [conn.org_id, sku], c));
  }

  async processWebhookEvent(eventId: string) {
    const ev = await one('SELECT * FROM webhook_events WHERE id=$1', [eventId]);
    if (!ev || ev.status === 'processed') return;
    try {
      const conn = await this.connections.load(ev.connection_id);
      const parsed = await adapterFor(conn).parseWebhook(conn, ev.payload.headers ?? {}, ev.payload.body);
      for (const o of parsed.orders) await this.ingest(conn, o);
      if (!parsed.orders.length && conn.marketplace === 'ebay') await this.jobs.enqueue('poll_orders', { connectionId: conn.id });
      await q(`UPDATE webhook_events SET status='processed', processed_at=now() WHERE id=$1`, [eventId]);
    } catch (e: any) {
      await q(`UPDATE webhook_events SET status='failed', error=$2 WHERE id=$1`, [eventId, e.message]);
      throw e;
    }
  }

  /** Scheduled backup to webhooks; also the primary path for eBay. Overlaps the window to tolerate clock skew. */
  async pollConnection(connectionId: string) {
    const conn0 = await this.connections.load(connectionId);
    if (conn0.status !== 'connected' || conn0.mode === 'mock') return;
    const since = new Date(Math.min(Date.now() - 2 * 3600_000, (conn0.settings.lastOrderPollAt ? Date.parse(conn0.settings.lastOrderPollAt) : Date.now() - 7 * 86400_000) - 15 * 60_000));
    const startedAt = new Date().toISOString();
    try {
      const conn = await this.connections.withFreshCredentials(conn0);
      const orders = await adapterFor(conn).fetchOrders(conn, since);
      let created = 0;
      for (const o of orders) if ((await this.ingest(conn, o)).created) created++;
      await q(`UPDATE marketplace_connections SET settings = settings || $2, last_sync_at=now(), last_error=NULL WHERE id=$1`, [conn.id, { lastOrderPollAt: startedAt }]);
      await q(`INSERT INTO sync_logs(org_id,connection_id,kind,status,detail) VALUES ($1,$2,'orders_poll','success',$3)`, [conn.org_id, conn.id, { fetched: orders.length, created }]);
    } catch (e: any) {
      await q(`UPDATE marketplace_connections SET last_error=$2 WHERE id=$1`, [conn0.id, e.message]);
      await q(`INSERT INTO sync_logs(org_id,connection_id,kind,status,error) VALUES ($1,$2,'orders_poll','failed',$3)`, [conn0.org_id, conn0.id, e.message]);
      if (e.status === 401) await this.connections.markExpired(conn0, e.message);
      else await this.activity.notify({ orgId: conn0.org_id, type: 'api_error', severity: 'warning', title: `Order download from ${conn0.marketplace} failed`, body: e.message, refType: 'connection', refId: conn0.id, dedupeKey: `pollfail:${conn0.id}` });
      throw e;
    }
  }

  // ── Read / manage ──
  async list(orgId: string, f: any, limit: number, offset: number) {
    const where = ['o.org_id=$1']; const p: any[] = [orgId];
    const add = (sql: string, v: any) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (f.marketplace) add('o.marketplace=?', f.marketplace);
    if (f.status) add('o.internal_status=?', f.status);
    if (f.fulfillment) add('o.fulfillment_status=?', f.fulfillment);
    if (f.from) add('o.order_date>=?', f.from);
    if (f.to) add(`o.order_date<(?::date + 1)`, f.to);
    if (f.sku) add('EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.sku ILIKE ?)', `%${f.sku}%`);
    if (f.customer) add('(o.customer_name ILIKE ? OR o.customer_email ILIKE $' + p.length + ')', `%${f.customer}%`);
    if (f.shippingMethod) add('o.shipping_method ILIKE ?', `%${f.shippingMethod}%`);
    if (f.search) add(`(o.external_order_id ILIKE ? OR o.customer_name ILIKE $${p.length})`, `%${f.search}%`);
    if (f.conflict === 'true') where.push('o.stock_conflict');
    const W = where.join(' AND ');
    const total = (await one(`SELECT count(*)::int n FROM orders o WHERE ${W}`, p))!.n;
    p.push(limit, offset);
    const rows = await q(
      `SELECT o.id, o.marketplace, o.external_order_id, o.customer_name, o.order_date, o.internal_status, o.payment_status,
              o.fulfillment_status, o.total, o.shipping_cost, o.currency, o.tracking_number, o.shipping_method, o.stock_conflict,
              c.account_name, c.mode,
              (SELECT json_agg(json_build_object('sku', i.sku, 'title', i.title, 'quantity', i.quantity, 'unitPrice', i.unit_price)) FROM order_items i WHERE i.order_id=o.id) AS items
         FROM orders o JOIN marketplace_connections c ON c.id=o.connection_id
        WHERE ${W} ORDER BY o.order_date DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    return { total, rows };
  }

  async detail(orgId: string, id: string) {
    const o = await one(`SELECT o.*, c.account_name, c.mode FROM orders o JOIN marketplace_connections c ON c.id=o.connection_id WHERE o.id=$1 AND o.org_id=$2`, [id, orgId]);
    if (!o) throw new NotFoundException('Order not found');
    const conn = await this.connections.load(o.connection_id);
    const adapter = adapterFor(conn);
    const [items, notes, history] = await Promise.all([
      q(`SELECT i.*, p.images->0->>'url' AS image FROM order_items i LEFT JOIN variants v ON v.id=i.variant_id LEFT JOIN products p ON p.id=v.product_id WHERE i.order_id=$1`, [id]),
      q(`SELECT n.*, u.name AS user_name FROM order_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.order_id=$1 ORDER BY n.created_at`, [id]),
      q(`SELECT action, message, level, created_at FROM activity_log WHERE org_id=$1 AND entity_type='order' AND entity_id=$2 ORDER BY created_at`, [orgId, id]),
    ]);
    const { raw, ...rest } = o;
    return {
      ...rest, items, notes, history,
      shipping: {
        marketplace: o.marketplace,
        provider: o.carrier, service: o.shipping_method, trackingNumber: o.tracking_number, labelAvailable: !!o.label_url, labelUrl: o.label_url,
        canUploadTracking: adapter.capabilities.trackingUpload,
        canPurchaseLabel: adapter.capabilities.labelPurchase && adapter.capabilities.implementation === 'live',
        labelNote: adapter.capabilities.labelPurchase
          ? `${cap(o.marketplace)} supports buying labels via API once the integration is approved and live.`
          : `Labels for ${cap(o.marketplace)} orders are created in the marketplace's own seller portal.`,
        sellerPortalUrl: adapter.sellerPortalOrderUrl(conn, o.external_order_id),
      },
    };
  }

  async addNote(orgId: string, userId: string, id: string, body: string) {
    if (!(await one('SELECT 1 FROM orders WHERE id=$1 AND org_id=$2', [id, orgId]))) throw new NotFoundException();
    return one(`INSERT INTO order_notes(order_id,user_id,body) VALUES ($1,$2,$3) RETURNING *`, [id, userId, body]);
  }

  async setInternalStatus(orgId: string, userId: string, id: string, status: string) {
    const o = await one(`UPDATE orders SET internal_status=$3, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING external_order_id`, [id, orgId, status]);
    if (!o) throw new NotFoundException();
    await this.activity.log({ orgId, userId, action: 'order.status', entityType: 'order', entityId: id, message: `Internal status of #${o.external_order_id} set to ${status}` });
    return { ok: true };
  }

  /** Upload tracking to the originating marketplace (where supported), then consume reserved stock. */
  async addTracking(orgId: string, userId: string, id: string, t: { carrier: string; trackingNumber: string }) {
    const o = await one('SELECT * FROM orders WHERE id=$1 AND org_id=$2', [id, orgId]);
    if (!o) throw new NotFoundException();
    if (o.fulfillment_status === 'cancelled') throw new BadRequestException('Order is cancelled');
    const conn = await this.connections.withFreshCredentials(await this.connections.load(o.connection_id));
    const adapter = adapterFor(conn);
    if (!adapter.capabilities.trackingUpload) throw new BadRequestException(`${conn.marketplace} does not accept tracking via API; use the seller portal`);
    const items = await q('SELECT * FROM order_items WHERE order_id=$1', [id]);
    try {
      await adapter.addTracking(conn, o, { ...t, items: items.map((i) => ({ externalLineId: i.external_line_id, quantity: i.quantity })) });
    } catch (e: any) {
      await q(`INSERT INTO sync_logs(org_id,connection_id,kind,status,error,detail) VALUES ($1,$2,'tracking','failed',$3,$4)`, [orgId, conn.id, e.message, { orderId: id }]);
      await this.activity.notify({ orgId, type: 'fulfillment_issue', severity: 'error', title: `Tracking upload failed for #${o.external_order_id}`, body: e.message, refType: 'order', refId: id });
      throw new BadRequestException(`Marketplace rejected tracking: ${e.message}`);
    }
    const changed: string[] = [];
    await tx(async (c) => {
      for (const it of items.filter((i) => i.stock_state === 'reserved')) changed.push(...(await this.settleItem(c, orgId, it.id, 'fulfil', id)));
      await q(`UPDATE orders SET carrier=$2, tracking_number=$3, fulfillment_status='fulfilled', internal_status='shipped', updated_at=now() WHERE id=$1`, [id, t.carrier, t.trackingNumber], c);
      await q(`INSERT INTO sync_logs(org_id,connection_id,kind,status,detail) VALUES ($1,$2,'tracking','success',$3)`, [orgId, conn.id, { orderId: id, ...t }], c);
      await this.activity.log({ orgId, userId, action: 'order.fulfilled', level: 'success', entityType: 'order', entityId: id, message: `Tracking ${t.carrier} ${t.trackingNumber} sent to ${cap(conn.marketplace)}${conn.mode === 'mock' ? ' (mock)' : ''}; order marked fulfilled` }, c);
    });
    if (changed.length) await this.inventory.afterChange(orgId, changed);
    return { ok: true };
  }
}
