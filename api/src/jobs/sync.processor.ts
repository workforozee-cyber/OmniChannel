import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import { one, q } from '../common/db';
import { InventoryService } from '../inventory/inventory.service';
import { ListingsService } from '../listings/listings.service';
import { ConnectionsService } from '../marketplaces/connections.service';
import { adapterFor } from '../marketplaces/registry';
import { MP_LABEL } from '../marketplaces/types';
import { OrdersService } from '../orders/orders.service';
import { PricingService } from '../pricing/pricing.service';
import { JobsService } from './jobs.service';

/** Job handlers. Registered on boot in both the API process (inline mode) and the worker process. */
@Injectable()
export class SyncProcessor implements OnModuleInit {
  private log = new Logger('Sync');
  constructor(
    private jobs: JobsService, private inventory: InventoryService, private listings: ListingsService,
    private connections: ConnectionsService, private activity: ActivityService, private orders: OrdersService,
    private pricing: PricingService,
  ) {}

  onModuleInit() {
    this.jobs.register('inventory_sync', (d, a) => this.inventorySync(d.orgId, d.variantIds, a));
    this.jobs.register('price_sync', (d) => this.priceSync(d.listingIds));
    this.jobs.register('publish', (d, a) => this.listings.runPublish(d.listingId, a));
    this.jobs.register('listing_update', (d) => this.listings.runUpdate(d.listingId));
    this.jobs.register('listing_status', async (d) => {
      await this.listings.runStatus(d.listingId, d.status);
      if (d.status === 'active') {
        const vs = await q('SELECT variant_id FROM listing_variants WHERE listing_id=$1', [d.listingId]);
        const l = await one('SELECT org_id FROM listings WHERE id=$1', [d.listingId]);
        await this.inventorySync(l!.org_id, vs.map((v) => v.variant_id), 1, true);
      }
    });
    this.jobs.register('webhook', (d) => this.orders.processWebhookEvent(d.eventId));
    this.jobs.register('poll_orders', (d) => this.orders.pollConnection(d.connectionId));
    this.jobs.register('reconcile', (d) => this.reconcile(d?.orgId));
  }

  /**
   * Push the current advertised quantity of each variant to every live listing of it.
   * Grouped per connection so adapters can batch (eBay: 25/call). Skips unchanged quantities unless forced.
   * Each connection is isolated: one marketplace failing never blocks the others.
   */
  async inventorySync(orgId: string, variantIds: string[], attempt = 1, force = false) {
    const av = await this.inventory.availability(orgId, variantIds);
    const targets = await q(
      `SELECT lv.id AS lv_id, lv.variant_id, lv.external_ref, lv.last_pushed_qty, l.id AS listing_id, l.external_id, l.connection_id, v.sku
         FROM listing_variants lv JOIN listings l ON l.id=lv.listing_id JOIN variants v ON v.id=lv.variant_id
         JOIN marketplace_connections c ON c.id=l.connection_id
        WHERE lv.variant_id = ANY($1::uuid[]) AND l.status='published' AND c.status='connected'`, [variantIds]);
    const byConn = new Map<string, typeof targets>();
    for (const t of targets) {
      const qty = av.get(t.variant_id)?.channelQuantity ?? 0;
      if (!force && t.last_pushed_qty === qty) continue;
      t.qty = qty;
      byConn.set(t.connection_id, [...(byConn.get(t.connection_id) ?? []), t]);
    }
    const failures: string[] = [];
    for (const [cid, items] of byConn) {
      const conn = await this.connections.load(cid);
      try {
        const fresh = await this.connections.withFreshCredentials(conn);
        await adapterFor(fresh).pushInventory(fresh, items.map((i) => ({ sku: i.sku, externalRef: i.external_ref, quantity: i.qty, listingExternalId: i.external_id })));
        for (const i of items) {
          await q(`UPDATE listing_variants SET last_pushed_qty=$2, last_pushed_at=now() WHERE id=$1`, [i.lv_id, i.qty]);
          await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,variant_id,kind,status,detail,attempt) VALUES ($1,$2,$3,$4,'inventory','success',$5,$6)`,
            [orgId, cid, i.listing_id, i.variant_id, { quantity: i.qty, sku: i.sku, mock: conn.mode === 'mock' }, attempt]);
        }
        await q(`UPDATE marketplace_connections SET last_sync_at=now() WHERE id=$1`, [cid]);
        await this.activity.log({ orgId, action: 'inventory.synced', level: 'success', entityType: 'connection', entityId: cid,
          message: `${label(conn)} inventory updated successfully (${items.map((i) => `${i.sku}→${i.qty}`).join(', ')})` });
      } catch (e: any) {
        failures.push(cid);
        for (const i of items) {
          await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,variant_id,kind,status,detail,error,attempt) VALUES ($1,$2,$3,$4,'inventory','failed',$5,$6,$7)`,
            [orgId, cid, i.listing_id, i.variant_id, { quantity: i.qty, sku: i.sku }, e.message, attempt]);
        }
        await this.activity.log({ orgId, action: 'inventory.sync_failed', level: 'error', entityType: 'connection', entityId: cid, message: `${label(conn)} synchronization failed: ${e.message}` });
        await this.activity.notify({ orgId, type: 'sync_failed', severity: 'error', title: `Inventory sync to ${label(conn)} failed`, body: `${e.message}. It will be retried automatically; the hourly reconciliation also corrects drift.`, refType: 'connection', refId: cid, dedupeKey: `syncfail:${cid}` });
      }
    }
    // Retry only the failed connections (re-enqueue narrows the work); successful ones are already marked.
    if (failures.length && !this.jobs.inline && attempt < 5) {
      const failedVariants = targets.filter((t) => failures.includes(t.connection_id)).map((t) => t.variant_id);
      await this.jobs.enqueue('inventory_sync', { orgId, variantIds: Array.from(new Set(failedVariants)) }, { delayMs: 15_000 * 2 ** attempt });
    }
  }

  async priceSync(listingIds: string[]) {
    for (const id of listingIds) {
      const { eff, listing } = await this.listings.effective(id);
      if (!listing.external_id || !['published', 'paused'].includes(listing.status)) continue;
      const conn = await this.connections.load(listing.connection_id);
      const lvs = await q('SELECT variant_id, last_pushed_price FROM listing_variants WHERE listing_id=$1', [id]);
      const changed = eff.variants.filter((v) => lvs.find((x) => x.variant_id === v.variantId)?.last_pushed_price !== v.price);
      if (!changed.length) continue;
      try {
        const fresh = await this.connections.withFreshCredentials(conn);
        await adapterFor(fresh).pushPrices(fresh, changed.map((v) => ({ sku: v.sku, externalRef: v.externalRef, price: v.price, listingExternalId: eff.externalId })), eff.currency);
        for (const v of changed) {
          const old = lvs.find((x) => x.variant_id === v.variantId)?.last_pushed_price ?? null;
          await q(`UPDATE listing_variants SET last_pushed_price=$3 WHERE listing_id=$1 AND variant_id=$2`, [id, v.variantId, v.price]);
          await q(`INSERT INTO price_history(org_id,variant_id,listing_id,old_price,new_price,reason) VALUES ($1,$2,$3,$4,$5,'channel_push')`, [listing.org_id, v.variantId, id, old, v.price]);
        }
        await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status,detail) VALUES ($1,$2,$3,'price','success',$4)`, [listing.org_id, conn.id, id, { prices: changed.map((v) => [v.sku, v.price]) }]);
        await this.activity.log({ orgId: listing.org_id, action: 'pricing.synced', level: 'success', entityType: 'listing', entityId: id, message: `${label(conn)} prices updated: ${changed.map((v) => `${v.sku} ${v.price.toFixed(2)}`).join(', ')}` });
      } catch (e: any) {
        await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status,error) VALUES ($1,$2,$3,'price','failed',$4)`, [listing.org_id, conn.id, id, e.message]);
        await this.activity.notify({ orgId: listing.org_id, type: 'sync_failed', severity: 'error', title: `Price sync to ${label(conn)} failed`, body: e.message, refType: 'listing', refId: id, dedupeKey: `pricefail:${id}` });
        if (!this.jobs.inline) throw e;
      }
    }
  }

  /** Safety net: periodically re-push every listing's quantity, catching anything a failed push or missed webhook left behind. */
  async reconcile(orgId?: string) {
    const orgs = orgId ? [{ id: orgId }] : await q('SELECT id FROM organizations');
    for (const o of orgs) {
      const vs = await q(`SELECT DISTINCT lv.variant_id FROM listing_variants lv JOIN listings l ON l.id=lv.listing_id WHERE l.org_id=$1 AND l.status='published'`, [o.id]);
      if (vs.length) await this.inventorySync(o.id, vs.map((v) => v.variant_id), 1, true); // force: re-assert even if we think it's unchanged
    }
  }
}

const label = (c: { marketplace: string; account_name: string; mode: string }) =>
  `${MP_LABEL[c.marketplace] ?? c.marketplace}${c.mode === 'mock' ? ' (mock)' : ''}`;
