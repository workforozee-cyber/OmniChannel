import { BadRequestException, Injectable } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import { Db, one, pool, q, tx } from '../common/db';
import { JobsService } from '../jobs/jobs.service';

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Clamp to the SKU's min/max price protection. */
export function clamp(price: number, v: { min_price: number | null; max_price: number | null }) {
  let p = price;
  if (v.min_price != null && p < v.min_price) p = v.min_price;
  if (v.max_price != null && p > v.max_price) p = v.max_price;
  return round2(p);
}

/**
 * Channel price resolution, per variant:
 *  - sync_price_with_master = true  → master price, adjusted by the channel's pricing rule (e.g. +10% on eBay)
 *  - sync_price_with_master = false → listing price override (or per-variant override), frozen until changed
 * Min/max protection always applies last.
 */
export function resolvePrice(v: any, listing: any, rule: any | null): number {
  const perVariant = listing.overrides?.variantPrices?.[v.id];
  if (!listing.sync_price_with_master) {
    const manual = perVariant ?? listing.price_override;
    if (manual != null) return clamp(Number(manual), v);
  }
  let p = Number(v.price);
  if (rule?.active) p = rule.kind === 'percent' ? p * (1 + Number(rule.value) / 100) : p + Number(rule.value);
  return clamp(p, v);
}

@Injectable()
export class PricingService {
  constructor(private jobs: JobsService, private activity: ActivityService) {}

  async listingPrices(listing: any, variants: any[], db: Db = pool): Promise<Map<string, number>> {
    const rule = await one('SELECT * FROM pricing_rules WHERE connection_id=$1', [listing.connection_id], db);
    return new Map(variants.map((v) => [v.id, resolvePrice(v, listing, rule)]));
  }

  async setRule(orgId: string, userId: string, connectionId: string, kind: 'percent' | 'fixed', value: number, active = true) {
    const conn = await one('SELECT marketplace, account_name FROM marketplace_connections WHERE id=$1 AND org_id=$2', [connectionId, orgId]);
    if (!conn) throw new BadRequestException('Unknown connection');
    await q(`INSERT INTO pricing_rules(org_id,connection_id,kind,value,active) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (connection_id) DO UPDATE SET kind=$3, value=$4, active=$5`, [orgId, connectionId, kind, value, active]);
    await this.activity.log({ orgId, userId, action: 'pricing.rule', entityType: 'connection', entityId: connectionId, message: `Pricing rule for ${conn.marketplace} set to ${kind === 'percent' ? `${value}%` : `${value >= 0 ? '+' : ''}${value}`}` });
    const ls = await q(`SELECT id FROM listings WHERE connection_id=$1 AND sync_price_with_master AND status IN ('published','paused')`, [connectionId]);
    if (ls.length) await this.jobs.enqueue('price_sync', { listingIds: ls.map((l) => l.id) });
    return { ok: true, listingsQueued: ls.length };
  }

  /**
   * Bulk master-price change. op: set | increase | decrease | percent.
   * Pushes only to listings with master-price sync enabled; customised channel prices are untouched.
   */
  async bulkAdjust(orgId: string, userId: string, b: { variantIds: string[]; op: 'set' | 'increase' | 'decrease' | 'percent'; value: number; dryRun?: boolean }) {
    const vs = await q('SELECT * FROM variants WHERE org_id=$1 AND id = ANY($2::uuid[])', [orgId, b.variantIds]);
    const preview = vs.map((v) => {
      const raw = b.op === 'set' ? b.value : b.op === 'increase' ? v.price + b.value : b.op === 'decrease' ? v.price - b.value : v.price * (1 + b.value / 100);
      const next = clamp(raw, v);
      return { variantId: v.id, sku: v.sku, oldPrice: v.price, newPrice: next, clamped: round2(raw) !== next, invalid: next <= 0 };
    });
    if (b.dryRun) return { preview };
    if (preview.some((p) => p.invalid)) throw new BadRequestException('One or more prices would be zero or negative');
    const changed = preview.filter((p) => p.newPrice !== p.oldPrice);
    await tx(async (c) => {
      for (const p of changed) {
        await q('UPDATE variants SET price=$2 WHERE id=$1', [p.variantId, p.newPrice], c);
        await q(`INSERT INTO price_history(org_id,variant_id,old_price,new_price,reason,user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, p.variantId, p.oldPrice, p.newPrice, `bulk_${b.op}`, userId], c);
      }
      if (changed.length) await this.activity.log({ orgId, userId, action: 'pricing.bulk', entityType: 'variant', message: `Master price updated for ${changed.length} SKU(s) (${b.op} ${b.value})` }, c);
    });
    await this.syncMasterPriceChange(changed.map((p) => p.variantId));
    return { preview, updated: changed.length };
  }

  /** Called whenever master prices change: queue pushes for listings that follow master. */
  async syncMasterPriceChange(variantIds: string[]) {
    if (!variantIds.length) return;
    const ls = await q(
      `SELECT DISTINCT l.id FROM listings l JOIN listing_variants lv ON lv.listing_id=l.id
        WHERE lv.variant_id = ANY($1::uuid[]) AND l.sync_price_with_master AND l.status IN ('published','paused')`, [variantIds]);
    if (ls.length) await this.jobs.enqueue('price_sync', { listingIds: ls.map((l) => l.id) });
  }

  async overview(orgId: string, limit: number, offset: number, search?: string) {
    const params: any[] = [orgId, limit, offset];
    let filter = '';
    if (search) { params.push(`%${search}%`); filter = `AND (v.sku ILIKE $4 OR p.title ILIKE $4)`; }
    const rows = await q(
      `SELECT v.id, v.sku, v.price, v.cost_price, v.min_price, v.max_price, p.title,
              COALESCE(json_agg(json_build_object('listingId', l.id, 'marketplace', c.marketplace, 'account', c.account_name,
                 'sync', l.sync_price_with_master, 'override', l.price_override, 'pushed', lv.last_pushed_price, 'status', l.status))
                 FILTER (WHERE l.id IS NOT NULL), '[]') AS channels
         FROM variants v JOIN products p ON p.id=v.product_id
         LEFT JOIN listing_variants lv ON lv.variant_id=v.id LEFT JOIN listings l ON l.id=lv.listing_id
         LEFT JOIN marketplace_connections c ON c.id=l.connection_id
        WHERE v.org_id=$1 ${filter} GROUP BY v.id, p.title ORDER BY p.title, v.sku LIMIT $2 OFFSET $3`, params);
    const total = (await one(`SELECT count(*)::int n FROM variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 ${search ? 'AND (v.sku ILIKE $2 OR p.title ILIKE $2)' : ''}`, search ? [orgId, `%${search}%`] : [orgId]))!.n;
    const rules = await q(`SELECT r.*, c.marketplace, c.account_name FROM pricing_rules r JOIN marketplace_connections c ON c.id=r.connection_id WHERE r.org_id=$1`, [orgId]);
    return { total, rows, rules };
  }

  history(orgId: string, variantId: string) {
    return q(`SELECT h.*, u.name AS user_name FROM price_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.org_id=$1 AND h.variant_id=$2 ORDER BY h.created_at DESC LIMIT 100`, [orgId, variantId]);
  }
}
