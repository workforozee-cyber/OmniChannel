import { Injectable } from '@nestjs/common';
import { one, q } from '../common/db';
import { InventoryService } from '../inventory/inventory.service';

/**
 * Reporting. Money figures are kept separate and explicit:
 *   gross = order totals (excl. cancelled)   refunds = reported refunds
 *   fees  = marketplace fees where the API reports them (null → unknown, never guessed)
 *   COGS  = Σ qty × cost price (only lines with a cost)   estimated profit = gross − refunds − fees − shipping − tax − COGS
 * Currency: figures are summed in the order's currency; multi-currency conversion is a future item.
 */
@Injectable()
export class AnalyticsService {
  constructor(private inventory: InventoryService) {}

  private range(f: { from?: string; to?: string }) {
    const to = f.to ? new Date(f.to) : new Date();
    const from = f.from ? new Date(f.from) : new Date(Date.now() - 30 * 86400_000);
    return { from: from.toISOString(), to: new Date(to.getTime() + 86400_000).toISOString() };
  }

  async dashboard(orgId: string) {
    const [counts, conns, low] = await Promise.all([
      one(`SELECT
             (SELECT count(*) FROM orders WHERE org_id=$1)::int AS total_orders,
             (SELECT COALESCE(sum(total),0) FROM orders WHERE org_id=$1 AND internal_status<>'cancelled') AS total_revenue,
             (SELECT count(*) FROM products WHERE org_id=$1 AND status<>'archived')::int AS total_products,
             (SELECT count(*) FROM listings WHERE org_id=$1 AND status='published')::int AS active_listings,
             (SELECT count(*) FROM orders WHERE org_id=$1 AND internal_status IN ('new','processing','on_hold'))::int AS pending_orders,
             (SELECT count(*) FROM orders WHERE org_id=$1 AND fulfillment_status IN ('unfulfilled','partial'))::int AS unfulfilled_orders,
             (SELECT count(*) FROM listings WHERE org_id=$1 AND status IN ('failed','validation_required'))::int AS failed_listings,
             (SELECT count(*) FROM sync_logs WHERE org_id=$1 AND kind='inventory' AND status='failed' AND created_at > now() - interval '24 hours')::int AS failed_syncs_24h,
             (SELECT count(*) FROM orders WHERE org_id=$1 AND stock_conflict AND fulfillment_status='unfulfilled')::int AS stock_conflicts`, [orgId]),
      q(`SELECT id, marketplace, account_name, mode, status, last_sync_at, last_error FROM marketplace_connections WHERE org_id=$1 AND status<>'disconnected' ORDER BY marketplace`, [orgId]),
      this.stockStatus(orgId),
    ]);
    return { ...counts, low_stock_products: low.low.length, out_of_stock_products: low.out.length, lowStock: low.low.slice(0, 8), outOfStock: low.out.slice(0, 8), connections: conns };
  }

  async stockStatus(orgId: string) {
    const org = await one('SELECT settings FROM organizations WHERE id=$1', [orgId]);
    const vs = await q(`SELECT v.id, v.sku, v.low_stock_threshold, p.title, p.id AS product_id FROM variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 AND p.status<>'archived'`, [orgId]);
    const av = await this.inventory.availability(orgId, vs.map((v) => v.id));
    const rows = vs.map((v) => ({ ...v, available: av.get(v.id)?.available ?? 0, threshold: v.low_stock_threshold ?? org?.settings?.lowStockThreshold ?? 5 }));
    return { low: rows.filter((r) => r.available > 0 && r.available <= r.threshold), out: rows.filter((r) => r.available <= 0) };
  }

  async sales(orgId: string, f: { from?: string; to?: string; marketplace?: string; granularity?: 'day' | 'month' }) {
    const { from, to } = this.range(f);
    const p: any[] = [orgId, from, to];
    const mp = f.marketplace ? (p.push(f.marketplace), `AND o.marketplace=$${p.length}`) : '';
    const g = f.granularity === 'month' ? 'month' : 'day';
    const [summary, byMarketplace, series, best] = await Promise.all([
      one(`WITH ord AS (SELECT * FROM orders o WHERE o.org_id=$1 AND o.order_date >= $2 AND o.order_date < $3 AND o.internal_status<>'cancelled' ${mp}),
                cogs AS (SELECT COALESCE(sum(i.quantity * v.cost_price),0) AS cogs, bool_and(v.cost_price IS NOT NULL) AS complete
                           FROM ord JOIN order_items i ON i.order_id=ord.id LEFT JOIN variants v ON v.id=i.variant_id)
           SELECT count(*)::int AS orders, COALESCE(sum(total),0) AS gross, COALESCE(sum(refunds),0) AS refunds,
                  sum(fees) AS fees, count(*) FILTER (WHERE fees IS NULL)::int AS orders_missing_fees,
                  COALESCE(sum(shipping_cost),0) AS shipping, COALESCE(sum(tax),0) AS tax,
                  (SELECT cogs FROM cogs) AS cogs, (SELECT complete FROM cogs) AS cogs_complete
             FROM ord`, p),
      q(`SELECT o.marketplace, count(*)::int AS orders, COALESCE(sum(o.total),0) AS gross, COALESCE(sum(o.refunds),0) AS refunds, sum(o.fees) AS fees
           FROM orders o WHERE o.org_id=$1 AND o.order_date >= $2 AND o.order_date < $3 AND o.internal_status<>'cancelled' ${mp}
          GROUP BY o.marketplace ORDER BY gross DESC`, p),
      q(`SELECT date_trunc('${g}', o.order_date) AS bucket, o.marketplace, count(*)::int AS orders, COALESCE(sum(o.total),0) AS gross
           FROM orders o WHERE o.org_id=$1 AND o.order_date >= $2 AND o.order_date < $3 AND o.internal_status<>'cancelled' ${mp}
          GROUP BY 1,2 ORDER BY 1`, p),
      q(`SELECT i.sku, COALESCE(max(p.title), max(i.title)) AS title, sum(i.quantity)::int AS units, sum(i.quantity * i.unit_price) AS revenue
           FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN variants v ON v.id=i.variant_id LEFT JOIN products p ON p.id=v.product_id
          WHERE o.org_id=$1 AND o.order_date >= $2 AND o.order_date < $3 AND o.internal_status<>'cancelled' ${mp}
          GROUP BY i.sku ORDER BY units DESC LIMIT 10`, p),
    ]);
    const s = summary!;
    const profit = s.gross - s.refunds - (s.fees ?? 0) - s.shipping - s.tax - s.cogs;
    return {
      range: { from, to },
      summary: { ...s, estimated_profit: Math.round(profit * 100) / 100, profit_is_partial: s.orders_missing_fees > 0 || !s.cogs_complete },
      byMarketplace, series, bestSellers: best,
    };
  }

  async inventoryValue(orgId: string) {
    return one(
      `SELECT COALESCE(sum(il.on_hand * v.cost_price),0) AS at_cost, COALESCE(sum(il.on_hand * v.price),0) AS at_retail,
              COALESCE(sum(il.on_hand),0)::int AS units, count(*) FILTER (WHERE v.cost_price IS NULL)::int AS skus_missing_cost
         FROM inventory_levels il JOIN variants v ON v.id=il.variant_id WHERE il.org_id=$1`, [orgId]);
  }
}
