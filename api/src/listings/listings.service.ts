import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import { Db, one, pool, q, tx } from '../common/db';
import { InventoryService } from '../inventory/inventory.service';
import { JobsService } from '../jobs/jobs.service';
import { ConnectionsService } from '../marketplaces/connections.service';
import { adapterFor } from '../marketplaces/registry';
import { EffectiveListing, MissingField, MP_LABEL } from '../marketplaces/types';
import { PricingService } from '../pricing/pricing.service';

const CONTENT_KEYS = ['title', 'description', 'images', 'category', 'attributes', 'shipping'] as const;

@Injectable()
export class ListingsService {
  constructor(
    private jobs: JobsService, private activity: ActivityService, private inventory: InventoryService,
    private connections: ConnectionsService, private pricing: PricingService,
  ) {}

  /**
   * Master product + channel overrides → what the marketplace should show.
   * Override wins for any key present in listing.overrides; otherwise the master value is used.
   * So editing the master never clobbers a customised channel field.
   */
  async effective(listingId: string, db: Db = pool): Promise<{ eff: EffectiveListing; listing: any; conn: any }> {
    const l = await one(
      `SELECT l.*, p.title, p.description, p.brand, p.manufacturer, p.category, p.images, p.videos, p.attributes, p.shipping, p.type,
              c.marketplace, c.mode, c.settings AS conn_settings, o.currency
         FROM listings l JOIN products p ON p.id=l.product_id
         JOIN marketplace_connections c ON c.id=l.connection_id JOIN organizations o ON o.id=l.org_id
        WHERE l.id=$1`, [listingId], db);
    if (!l) throw new NotFoundException('Listing not found');
    const vs = await q(
      `SELECT v.*, lv.external_ref FROM listing_variants lv JOIN variants v ON v.id=lv.variant_id
        WHERE lv.listing_id=$1 ORDER BY v.position, v.sku`, [listingId], db);
    const av = await this.inventory.availability(l.org_id, vs.map((v) => v.id), db);
    const ov = l.overrides ?? {};
    const masterAttrs = l.attributes ?? {};
    const attrs = { ...stripChannels(masterAttrs), ...(masterAttrs[l.marketplace] ?? {}), ...(ov.attributes ?? {}) };
    const prices = await this.pricing.listingPrices(l, vs, db);
    const eff: EffectiveListing = {
      listingId: l.id, productId: l.product_id, externalId: l.external_id,
      title: ov.title ?? l.title, description: ov.description ?? l.description,
      brand: l.brand, manufacturer: l.manufacturer, category: ov.category ?? l.category,
      images: ov.images ?? l.images, videos: l.videos, attributes: attrs, shipping: { ...l.shipping, ...(ov.shipping ?? {}) },
      productType: l.type, currency: l.currency,
      variants: vs.map((v) => ({
        variantId: v.id, sku: v.sku, barcode: v.barcode, options: v.options, price: prices.get(v.id)!,
        quantity: av.get(v.id)?.channelQuantity ?? 0, weightGrams: v.weight_grams, dimensions: v.dimensions, externalRef: v.external_ref,
      })),
    };
    return { eff, listing: l, conn: { marketplace: l.marketplace, mode: l.mode, settings: l.conn_settings } };
  }

  /**
   * One-click multi-channel publish. Each channel is validated and queued independently —
   * a channel missing data returns "validation_required" with its missing fields; others still publish.
   */
  async publish(orgId: string, userId: string, productId: string, connectionIds: string[]) {
    const product = await one('SELECT id, title FROM products WHERE id=$1 AND org_id=$2', [productId, orgId]);
    if (!product) throw new NotFoundException('Product not found');
    const results: { connectionId: string; marketplace: string; accountName: string; listingId: string; status: string; missingFields: MissingField[]; mode: string }[] = [];
    for (const cid of connectionIds) {
      const conn = await this.connections.load(cid, orgId);
      if (conn.status !== 'connected') {
        results.push({ connectionId: cid, marketplace: conn.marketplace, accountName: conn.account_name, listingId: '', status: 'failed', mode: conn.mode, missingFields: [{ field: 'connection', label: 'Connection', message: `Connection is ${conn.status}; reconnect first` }] });
        continue;
      }
      const listingId = await tx(async (c) => {
        const l = await one(
          `INSERT INTO listings(org_id,product_id,connection_id) VALUES ($1,$2,$3)
           ON CONFLICT (product_id,connection_id) DO UPDATE SET updated_at=now() RETURNING id`, [orgId, productId, cid], c);
        await q(`INSERT INTO listing_variants(listing_id,variant_id) SELECT $1, id FROM variants WHERE product_id=$2 ON CONFLICT DO NOTHING`, [l!.id, productId], c);
        return l!.id as string;
      });
      const { eff } = await this.effective(listingId);
      const missing = adapterFor(conn).validateListing(eff, conn);
      const existing = await one('SELECT status, external_id FROM listings WHERE id=$1', [listingId]);
      if (existing!.status === 'published' && existing!.external_id) {
        results.push({ connectionId: cid, marketplace: conn.marketplace, accountName: conn.account_name, listingId, status: 'published', missingFields: [], mode: conn.mode });
        continue;
      }
      const status = missing.length ? 'validation_required' : 'queued';
      await q(`UPDATE listings SET status=$2, missing_fields=$3, last_error=NULL, updated_at=now() WHERE id=$1`, [listingId, status, JSON.stringify(missing)]);
      if (!missing.length) await this.jobs.enqueue('publish', { listingId });
      else await this.activity.log({ orgId, userId, action: 'listing.validation', level: 'warning', entityType: 'listing', entityId: listingId, message: `"${product.title}" needs ${missing.length} more field(s) for ${MP_LABEL[conn.marketplace]}: ${missing.map((m) => m.label).join(', ')}` });
      const final = await one('SELECT status, missing_fields FROM listings WHERE id=$1', [listingId]);
      results.push({ connectionId: cid, marketplace: conn.marketplace, accountName: conn.account_name, listingId, status: final!.status, missingFields: final!.missing_fields, mode: conn.mode });
    }
    return { productId, results };
  }

  /** Job handler: actually call the marketplace. */
  async runPublish(listingId: string, attempt: number) {
    const { eff, listing } = await this.effective(listingId);
    const conn = await this.connections.withFreshCredentials(await this.connections.load(listing.connection_id));
    const adapter = adapterFor(conn);
    const missing = adapter.validateListing(eff, conn);
    if (missing.length) {
      await q(`UPDATE listings SET status='validation_required', missing_fields=$2 WHERE id=$1`, [listingId, JSON.stringify(missing)]);
      return;
    }
    try {
      const r = await adapter.publishListing(conn, eff);
      await tx(async (c) => {
        await q(`UPDATE listings SET status='published', external_id=$2, external_url=$3, published_at=now(), last_error=NULL, missing_fields='[]', updated_at=now() WHERE id=$1`, [listingId, r.externalId, r.url], c);
        for (const v of eff.variants) {
          await q(`UPDATE listing_variants SET external_ref=$3, last_pushed_qty=$4, last_pushed_price=$5, last_pushed_at=now() WHERE listing_id=$1 AND variant_id=$2`,
            [listingId, v.variantId, r.variantRefs[v.variantId] ?? null, v.quantity, v.price], c);
        }
        await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status,detail,attempt) VALUES ($1,$2,$3,'publish','success',$4,$5)`,
          [listing.org_id, conn.id, listingId, { externalId: r.externalId, mock: conn.mode === 'mock' }, attempt], c);
        await this.activity.log({ orgId: listing.org_id, action: 'listing.published', level: 'success', entityType: 'listing', entityId: listingId,
          message: `"${eff.title}" published to ${MP_LABEL[conn.marketplace]}${conn.mode === 'mock' ? ' (mock)' : ''} — ${r.externalId}` }, c);
      });
    } catch (e: any) {
      const final = !(e.retryable) || attempt >= 5 || this.jobs.inline;
      await q(`UPDATE listings SET status=$3, last_error=$2, updated_at=now() WHERE id=$1`, [listingId, e.message, final ? 'failed' : 'queued']);
      await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status,error,attempt) VALUES ($1,$2,$3,'publish','failed',$4,$5)`, [listing.org_id, conn.id, listingId, e.message, attempt]);
      if (final) {
        await this.activity.notify({ orgId: listing.org_id, type: 'listing_failed', severity: 'error', title: `Publishing "${eff.title}" to ${MP_LABEL[conn.marketplace]} failed`, body: e.message, refType: 'listing', refId: listingId, dedupeKey: `listfail:${listingId}` });
        await this.activity.log({ orgId: listing.org_id, action: 'listing.failed', level: 'error', entityType: 'listing', entityId: listingId, message: `Publishing "${eff.title}" to ${MP_LABEL[conn.marketplace]} failed: ${e.message}` });
        return;
      }
      throw e; // let BullMQ retry with backoff
    }
  }

  async list(orgId: string, f: { status?: string; connectionId?: string; marketplace?: string; search?: string; limit: number; offset: number }) {
    const where = ['l.org_id=$1']; const params: any[] = [orgId];
    if (f.status) { params.push(f.status); where.push(`l.status=$${params.length}`); }
    if (f.connectionId) { params.push(f.connectionId); where.push(`l.connection_id=$${params.length}`); }
    if (f.marketplace) { params.push(f.marketplace); where.push(`c.marketplace=$${params.length}`); }
    if (f.search) { params.push(`%${f.search}%`); where.push(`(p.title ILIKE $${params.length} OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.sku ILIKE $${params.length}))`); }
    const base = `FROM listings l JOIN products p ON p.id=l.product_id JOIN marketplace_connections c ON c.id=l.connection_id WHERE ${where.join(' AND ')}`;
    const total = (await one(`SELECT count(*)::int AS n ${base}`, params))!.n;
    params.push(f.limit, f.offset);
    const rows = await q(
      `SELECT l.id, l.status, l.external_id, l.external_url, l.missing_fields, l.last_error, l.price_override, l.sync_price_with_master,
              l.overrides, l.published_at, l.updated_at, p.id AS product_id, p.title, p.images->0->>'url' AS image,
              c.id AS connection_id, c.marketplace, c.account_name, c.mode,
              (SELECT string_agg(v.sku, ', ') FROM listing_variants lv JOIN variants v ON v.id=lv.variant_id WHERE lv.listing_id=l.id) AS skus,
              (SELECT sum(lv.last_pushed_qty)::int FROM listing_variants lv WHERE lv.listing_id=l.id) AS listed_qty
         ${base} ORDER BY l.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { total, rows };
  }

  async updateOverrides(orgId: string, userId: string, listingId: string, b: { overrides?: Record<string, any>; priceOverride?: number | null; syncPriceWithMaster?: boolean }) {
    const l = await one('SELECT * FROM listings WHERE id=$1 AND org_id=$2', [listingId, orgId]);
    if (!l) throw new NotFoundException();
    const overrides = { ...l.overrides };
    for (const [k, v] of Object.entries(b.overrides ?? {})) {
      if (!(CONTENT_KEYS as readonly string[]).includes(k)) throw new BadRequestException(`Unknown override field ${k}`);
      if (v === null) delete overrides[k]; else overrides[k] = v;
    }
    await q(`UPDATE listings SET overrides=$2, price_override=COALESCE($3, price_override), sync_price_with_master=COALESCE($4, sync_price_with_master), updated_at=now() WHERE id=$1`,
      [listingId, overrides, b.priceOverride ?? null, b.syncPriceWithMaster ?? null]);
    if (b.priceOverride === null) await q('UPDATE listings SET price_override=NULL WHERE id=$1', [listingId]);
    await this.activity.log({ orgId, userId, action: 'listing.customize', entityType: 'listing', entityId: listingId, message: `Channel customisations updated (${Object.keys(overrides).join(', ') || 'none'})` });
    await this.afterListingChange(listingId, l.status);
    return one('SELECT * FROM listings WHERE id=$1', [listingId]);
  }

  /** Explicit "sync from master": drop chosen overrides so the channel follows the master again. */
  async syncFromMaster(orgId: string, userId: string, listingId: string, fields: string[]) {
    const l = await one('SELECT * FROM listings WHERE id=$1 AND org_id=$2', [listingId, orgId]);
    if (!l) throw new NotFoundException();
    const overrides = { ...l.overrides };
    for (const f of fields) delete overrides[f];
    const resetPrice = fields.includes('price');
    await q(`UPDATE listings SET overrides=$2, sync_price_with_master = sync_price_with_master OR $3, price_override = CASE WHEN $3 THEN NULL ELSE price_override END, updated_at=now() WHERE id=$1`, [listingId, overrides, resetPrice]);
    await this.activity.log({ orgId, userId, action: 'listing.sync_master', entityType: 'listing', entityId: listingId, message: `Re-synced ${fields.join(', ')} from master product` });
    await this.afterListingChange(listingId, l.status);
    return { ok: true };
  }

  private async afterListingChange(listingId: string, status: string) {
    if (['published', 'paused'].includes(status)) {
      await this.jobs.enqueue('listing_update', { listingId });
      await this.jobs.enqueue('price_sync', { listingIds: [listingId] });
    }
  }

  async runUpdate(listingId: string) {
    const { eff, listing } = await this.effective(listingId);
    if (!listing.external_id) return;
    const conn = await this.connections.withFreshCredentials(await this.connections.load(listing.connection_id));
    try {
      await adapterFor(conn).updateListing(conn, eff);
      await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status) VALUES ($1,$2,$3,'update','success')`, [listing.org_id, conn.id, listingId]);
    } catch (e: any) {
      await q(`UPDATE listings SET last_error=$2 WHERE id=$1`, [listingId, e.message]);
      await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status,error) VALUES ($1,$2,$3,'update','failed',$4)`, [listing.org_id, conn.id, listingId, e.message]);
      throw e;
    }
  }

  async setStatus(orgId: string, userId: string, listingIds: string[], action: 'pause' | 'activate' | 'end') {
    const map = { pause: 'paused', activate: 'published', end: 'ended' } as const;
    const out = [];
    for (const id of listingIds) {
      const l = await one('SELECT l.*, p.title FROM listings l JOIN products p ON p.id=l.product_id WHERE l.id=$1 AND l.org_id=$2', [id, orgId]);
      if (!l) continue;
      if (!l.external_id) { out.push({ id, ok: false, error: 'Listing is not published yet' }); continue; }
      if (l.status === 'ended') { out.push({ id, ok: false, error: 'Ended listings cannot be changed; publish again instead' }); continue; }
      await this.jobs.enqueue('listing_status', { listingId: id, status: action === 'activate' ? 'active' : action === 'pause' ? 'paused' : 'ended' });
      await q(`UPDATE listings SET status=$2, updated_at=now() WHERE id=$1`, [id, map[action]]);
      await this.activity.log({ orgId, userId, action: `listing.${action}`, entityType: 'listing', entityId: id, message: `Listing "${l.title}" ${map[action]}` });
      out.push({ id, ok: true });
    }
    return out;
  }

  async runStatus(listingId: string, status: 'active' | 'paused' | 'ended') {
    const { eff, listing } = await this.effective(listingId);
    const conn = await this.connections.withFreshCredentials(await this.connections.load(listing.connection_id));
    try {
      await adapterFor(conn).setListingStatus(conn, eff, status);
      await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status,detail) VALUES ($1,$2,$3,'status','success',$4)`, [listing.org_id, conn.id, listingId, { status }]);
    } catch (e: any) {
      await q(`INSERT INTO sync_logs(org_id,connection_id,listing_id,kind,status,error) VALUES ($1,$2,$3,'status','failed',$4)`, [listing.org_id, conn.id, listingId, e.message]);
      await q(`UPDATE listings SET last_error=$2 WHERE id=$1`, [listingId, e.message]);
      throw e;
    }
  }
}

function stripChannels(a: Record<string, any>) {
  const { ebay, amazon, etsy, walmart, shopify, ...rest } = a;
  return rest;
}
