import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ActivityService } from '../activity/activity.service';
import { Db, one, pool, q, tx } from '../common/db';
import { JobsService } from '../jobs/jobs.service';

export interface Availability { variantId: string; onHand: number; reserved: number; available: number; channelQuantity: number; buffer: number }

/**
 * Centralised inventory engine.
 *
 * Model:  on_hand (physical) − reserved (open orders) = available.
 *         channelQuantity = max(0, available − safety buffer)  ← what every marketplace is told.
 *
 * Overselling protection:
 *  1. Reservation is a single conditional UPDATE (`... WHERE on_hand - reserved >= qty`). Postgres row
 *     locks serialise concurrent orders on the same SKU; the second order re-evaluates the condition
 *     after the first commits, so two orders can never both take the last unit. DB CHECKs back this up.
 *  2. Orders are de-duplicated by UNIQUE(connection_id, external_order_id) — webhook + poll can't double-deduct.
 *  3. Every change enqueues an absolute-quantity push to all linked listings (idempotent, retryable).
 *  4. A safety buffer advertises less than you hold, absorbing the window before marketplaces update.
 *  If a marketplace still sells stock we don't have (sold before our push landed), the line is marked
 *  'short', the order is flagged stock_conflict and the user is notified — we never go negative.
 */
@Injectable()
export class InventoryService {
  constructor(private jobs: JobsService, private activity: ActivityService) {}

  async defaultWarehouse(orgId: string, db: Db = pool): Promise<string> {
    const w = await one('SELECT id FROM warehouses WHERE org_id=$1 AND is_default', [orgId], db);
    if (!w) throw new BadRequestException('Organization has no default warehouse');
    return w.id;
  }

  private async ensureLevel(orgId: string, variantId: string, warehouseId: string, db: Db) {
    await q(
      `INSERT INTO inventory_levels(org_id,variant_id,warehouse_id) VALUES ($1,$2,$3) ON CONFLICT (variant_id,warehouse_id) DO NOTHING`,
      [orgId, variantId, warehouseId], db,
    );
  }

  /** Availability for variants, including derived bundle stock and the safety buffer. */
  async availability(orgId: string, variantIds: string[], db: Db = pool): Promise<Map<string, Availability>> {
    const out = new Map<string, Availability>();
    if (!variantIds.length) return out;
    const org = await one('SELECT settings FROM organizations WHERE id=$1', [orgId], db);
    const orgBuf = org?.settings?.safetyBuffer ?? { mode: 'units', value: 0 };
    const rows = await q(
      `SELECT v.id, v.safety_buffer, p.type,
              COALESCE(SUM(il.on_hand),0)::int AS on_hand, COALESCE(SUM(il.reserved),0)::int AS reserved
         FROM variants v JOIN products p ON p.id=v.product_id
         LEFT JOIN inventory_levels il ON il.variant_id=v.id
        WHERE v.org_id=$1 AND v.id = ANY($2::uuid[])
        GROUP BY v.id, p.type`, [orgId, variantIds], db,
    );
    const comps = await q(
      `SELECT bc.bundle_variant_id, bc.quantity,
              COALESCE(SUM(il.on_hand - il.reserved),0)::int AS comp_available,
              COALESCE(SUM(il.on_hand),0)::int AS comp_on_hand
         FROM bundle_components bc LEFT JOIN inventory_levels il ON il.variant_id=bc.component_variant_id
        WHERE bc.bundle_variant_id = ANY($1::uuid[])
        GROUP BY bc.bundle_variant_id, bc.component_variant_id, bc.quantity`, [variantIds], db,
    );
    for (const r of rows) {
      let onHand = r.on_hand, reserved = r.reserved, available = r.on_hand - r.reserved;
      const mine = comps.filter((c) => c.bundle_variant_id === r.id);
      if (r.type === 'bundle' && mine.length) {
        available = Math.min(...mine.map((c) => Math.floor(c.comp_available / c.quantity)));
        onHand = Math.min(...mine.map((c) => Math.floor(c.comp_on_hand / c.quantity)));
        reserved = onHand - available;
      }
      const buffer = r.safety_buffer ?? (orgBuf.mode === 'percent' ? Math.ceil((onHand * Number(orgBuf.value)) / 100) : Number(orgBuf.value));
      out.set(r.id, { variantId: r.id, onHand, reserved, available, buffer, channelQuantity: Math.max(0, available - buffer) });
    }
    return out;
  }

  /** Manual stock adjustment (set absolute or apply delta) on a warehouse. */
  async adjust(orgId: string, userId: string | null, b: { variantId: string; warehouseId?: string; set?: number; delta?: number; note?: string }) {
    const variantIds = await tx(async (c) => {
      const v = await one('SELECT id, sku FROM variants WHERE id=$1 AND org_id=$2', [b.variantId, orgId], c);
      if (!v) throw new NotFoundException('Variant not found');
      const wh = b.warehouseId ?? (await this.defaultWarehouse(orgId, c));
      await this.ensureLevel(orgId, v.id, wh, c);
      const lvl = await one('SELECT * FROM inventory_levels WHERE variant_id=$1 AND warehouse_id=$2 FOR UPDATE', [v.id, wh], c);
      const target = b.set !== undefined ? b.set : lvl!.on_hand + (b.delta ?? 0);
      if (target < 0) throw new BadRequestException('Stock cannot go below zero');
      if (target < lvl!.reserved) throw new BadRequestException(`${lvl!.reserved} units are reserved by open orders; stock cannot be set below that`);
      const delta = target - lvl!.on_hand;
      if (delta === 0) return [];
      await this.applyMovement(c, { orgId, variantId: v.id, warehouseId: wh, dOnHand: delta, dReserved: 0, reason: 'manual_adjustment', userId, note: b.note });
      await this.activity.log({ orgId, userId, action: 'inventory.adjust', entityType: 'variant', entityId: v.id, message: `Stock for ${v.sku} ${delta > 0 ? 'increased' : 'decreased'} by ${Math.abs(delta)} (now ${target} on hand)` }, c);
      return [v.id];
    });
    if (variantIds.length) await this.afterChange(orgId, variantIds);
    return (await this.availability(orgId, [b.variantId])).get(b.variantId);
  }

  async applyMovement(c: PoolClient, m: {
    orgId: string; variantId: string; warehouseId: string; dOnHand: number; dReserved: number; reason: string;
    refType?: string; refId?: string; userId?: string | null; note?: string;
  }) {
    const lvl = await one(
      `UPDATE inventory_levels SET on_hand = on_hand + $3, reserved = reserved + $4, updated_at = now()
        WHERE variant_id=$1 AND warehouse_id=$2 RETURNING on_hand, reserved`,
      [m.variantId, m.warehouseId, m.dOnHand, m.dReserved], c,
    );
    await q(
      `INSERT INTO inventory_movements(org_id,variant_id,warehouse_id,delta_on_hand,delta_reserved,on_hand_after,reserved_after,reason,ref_type,ref_id,user_id,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [m.orgId, m.variantId, m.warehouseId, m.dOnHand, m.dReserved, lvl!.on_hand, lvl!.reserved, m.reason, m.refType ?? null, m.refId ?? null, m.userId ?? null, m.note ?? null], c,
    );
  }

  /**
   * Atomically reserve qty of a variant for an order line, inside the caller's transaction.
   * Bundles reserve each component. All-or-nothing via SAVEPOINT. Returns false if stock is short.
   */
  async reserve(c: PoolClient, orgId: string, orderItemId: string, variantId: string, qty: number, ref: string): Promise<boolean> {
    const comps = await q('SELECT component_variant_id AS id, quantity FROM bundle_components WHERE bundle_variant_id=$1', [variantId], c);
    const parts = comps.length ? comps.map((x) => ({ id: x.id, qty: x.quantity * qty })) : [{ id: variantId, qty }];
    await c.query('SAVEPOINT reserve_line');
    for (const part of parts) {
      // Prefer the default warehouse, then any warehouse that can cover the whole quantity.
      const got = await one(
        `UPDATE inventory_levels il SET reserved = reserved + $2, updated_at = now()
          WHERE il.id = (
            SELECT l.id FROM inventory_levels l JOIN warehouses w ON w.id=l.warehouse_id
             WHERE l.variant_id=$1 AND l.on_hand - l.reserved >= $2
             ORDER BY w.is_default DESC, (l.on_hand - l.reserved) DESC LIMIT 1
             FOR UPDATE OF l
          ) AND il.on_hand - il.reserved >= $2
          RETURNING il.warehouse_id, il.on_hand, il.reserved`,
        [part.id, part.qty], c,
      );
      if (!got) { await c.query('ROLLBACK TO SAVEPOINT reserve_line'); return false; }
      await q(`INSERT INTO order_item_allocations(order_item_id,variant_id,warehouse_id,quantity) VALUES ($1,$2,$3,$4)`, [orderItemId, part.id, got.warehouse_id, part.qty], c);
      await q(
        `INSERT INTO inventory_movements(org_id,variant_id,warehouse_id,delta_reserved,on_hand_after,reserved_after,reason,ref_type,ref_id)
         VALUES ($1,$2,$3,$4,$5,$6,'order_reserved','order',$7)`,
        [orgId, part.id, got.warehouse_id, part.qty, got.on_hand, got.reserved, ref], c,
      );
    }
    await c.query('RELEASE SAVEPOINT reserve_line');
    return true;
  }

  /** Consume (fulfil) or release (cancel) an order line's reserved allocations. Returns affected variant ids. */
  async settle(c: PoolClient, orgId: string, orderItemId: string, action: 'fulfil' | 'release', ref: string): Promise<string[]> {
    const allocs = await q(`SELECT * FROM order_item_allocations WHERE order_item_id=$1 AND state='reserved' FOR UPDATE`, [orderItemId], c);
    for (const a of allocs) {
      await this.applyMovement(c, {
        orgId, variantId: a.variant_id, warehouseId: a.warehouse_id,
        dOnHand: action === 'fulfil' ? -a.quantity : 0, dReserved: -a.quantity,
        reason: action === 'fulfil' ? 'order_fulfilled' : 'order_cancelled', refType: 'order', refId: ref,
      });
      await q(`UPDATE order_item_allocations SET state=$2 WHERE id=$1`, [a.id, action === 'fulfil' ? 'fulfilled' : 'released'], c);
    }
    return allocs.map((a) => a.variant_id);
  }

  /** Expand a set of changed variants to everything whose advertised stock depends on them (bundles). */
  async affectedVariants(variantIds: string[], db: Db = pool): Promise<string[]> {
    if (!variantIds.length) return [];
    // A bundle sale moves its components' stock; a component change moves every bundle that uses it.
    const comps = await q(`SELECT DISTINCT component_variant_id AS id FROM bundle_components WHERE bundle_variant_id = ANY($1::uuid[])`, [variantIds], db);
    const base = Array.from(new Set([...variantIds, ...comps.map((c) => c.id)]));
    const bundles = await q(`SELECT DISTINCT bundle_variant_id AS id FROM bundle_components WHERE component_variant_id = ANY($1::uuid[])`, [base], db);
    return Array.from(new Set([...base, ...bundles.map((b) => b.id)]));
  }

  /** After any committed stock change: alerts + fan-out sync to every channel. */
  async afterChange(orgId: string, variantIds: string[]) {
    const all = await this.affectedVariants(variantIds);
    await this.checkAlerts(orgId, all);
    await this.jobs.enqueue('inventory_sync', { orgId, variantIds: all });
  }

  async checkAlerts(orgId: string, variantIds: string[]) {
    const av = await this.availability(orgId, variantIds);
    const org = await one('SELECT settings FROM organizations WHERE id=$1', [orgId]);
    const vs = await q('SELECT id, sku, low_stock_threshold FROM variants WHERE id = ANY($1::uuid[])', [variantIds]);
    for (const v of vs) {
      const a = av.get(v.id)!;
      const threshold = v.low_stock_threshold ?? org?.settings?.lowStockThreshold ?? 5;
      if (a.available <= 0) {
        await this.activity.notify({ orgId, type: 'out_of_stock', severity: 'error', title: `${v.sku} is out of stock`, body: 'All channels have been set to 0.', refType: 'variant', refId: v.id, dedupeKey: `oos:${v.id}` });
      } else if (a.available <= threshold) {
        await this.activity.notify({ orgId, type: 'low_stock', severity: 'warning', title: `${v.sku} is low on stock`, body: `${a.available} available (threshold ${threshold}).`, refType: 'variant', refId: v.id, dedupeKey: `low:${v.id}` });
      }
    }
  }

  async history(orgId: string, variantId: string) {
    return q(
      `SELECT m.*, w.name AS warehouse_name, u.name AS user_name FROM inventory_movements m
         JOIN warehouses w ON w.id=m.warehouse_id LEFT JOIN users u ON u.id=m.user_id
        WHERE m.org_id=$1 AND m.variant_id=$2 ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, [orgId, variantId],
    );
  }
}
