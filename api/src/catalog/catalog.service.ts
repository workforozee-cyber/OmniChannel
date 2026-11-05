import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ActivityService } from '../activity/activity.service';
import { one, q, tx } from '../common/db';
import { InventoryService } from '../inventory/inventory.service';
import { JobsService } from '../jobs/jobs.service';
import { ConnectionsService } from '../marketplaces/connections.service';
import { adapterFor } from '../marketplaces/registry';
import { PricingService } from '../pricing/pricing.service';

const money = z.coerce.number().nonnegative().max(10_000_000);
export const VariantSchema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._\-\/]+$/, 'SKU may contain letters, digits, . _ - /'),
  barcode: z.string().trim().regex(/^\d{8,14}$/, 'Barcode must be 8–14 digits (UPC/EAN/GTIN)').nullish(),
  options: z.record(z.string(), z.string()).default({}),
  costPrice: money.nullish(),
  price: money,
  minPrice: money.nullish(),
  maxPrice: money.nullish(),
  weightGrams: z.coerce.number().int().nonnegative().nullish(),
  dimensions: z.object({ lengthCm: z.number(), widthCm: z.number(), heightCm: z.number() }).partial().nullish(),
  lowStockThreshold: z.coerce.number().int().nonnegative().nullish(),
  safetyBuffer: z.coerce.number().int().nonnegative().nullish(),
  initialStock: z.coerce.number().int().nonnegative().optional(),
  components: z.array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().positive() })).optional(),
}).refine((v) => v.minPrice == null || v.maxPrice == null || v.minPrice <= v.maxPrice, 'Min price must not exceed max price');

export const ProductSchema = z.object({
  type: z.enum(['simple', 'variable', 'bundle']).default('simple'),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).default(''),
  brand: z.string().max(120).nullish(),
  manufacturer: z.string().max(120).nullish(),
  category: z.string().max(200).nullish(),
  tags: z.array(z.string().max(60)).default([]),
  images: z.array(z.object({ url: z.string().url(), alt: z.string().optional() })).default([]),
  videos: z.array(z.object({ url: z.string().url() })).default([]),
  attributes: z.record(z.string(), z.any()).default({}),
  shipping: z.record(z.string(), z.any()).default({}),
  supplier: z.object({ name: z.string(), contact: z.string().optional(), sku: z.string().optional(), leadTimeDays: z.number().optional() }).partial().nullish(),
  status: z.enum(['draft', 'active', 'archived']).default('active'),
  variants: z.array(VariantSchema).min(1, 'At least one SKU is required'),
});
export type ProductInput = z.infer<typeof ProductSchema>;

@Injectable()
export class CatalogService {
  constructor(
    private activity: ActivityService, private inventory: InventoryService, private pricing: PricingService,
    private jobs: JobsService, private connections: ConnectionsService,
  ) {}

  async list(orgId: string, f: { search?: string; status?: string; type?: string; tag?: string; stock?: string }, limit: number, offset: number) {
    const where = ['p.org_id=$1']; const p: any[] = [orgId];
    if (f.search) { p.push(`%${f.search}%`); where.push(`(p.title ILIKE $${p.length} OR p.brand ILIKE $${p.length} OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND (v.sku ILIKE $${p.length} OR v.barcode ILIKE $${p.length})))`); }
    if (f.status) { p.push(f.status); where.push(`p.status=$${p.length}`); }
    if (f.type) { p.push(f.type); where.push(`p.type=$${p.length}`); }
    if (f.tag) { p.push(f.tag); where.push(`$${p.length} = ANY(p.tags)`); }
    const W = where.join(' AND ');
    const total = (await one(`SELECT count(*)::int n FROM products p WHERE ${W}`, p))!.n;
    p.push(limit, offset);
    const rows = await q(
      `SELECT p.id, p.type, p.title, p.brand, p.category, p.status, p.tags, p.images->0->>'url' AS image, p.updated_at,
              (SELECT json_agg(json_build_object('id', v.id, 'sku', v.sku, 'price', v.price, 'options', v.options) ORDER BY v.position) FROM variants v WHERE v.product_id=p.id) AS variants,
              (SELECT json_agg(json_build_object('marketplace', c.marketplace, 'status', l.status, 'mode', c.mode) ORDER BY c.marketplace) FROM listings l JOIN marketplace_connections c ON c.id=l.connection_id WHERE l.product_id=p.id) AS listings
         FROM products p WHERE ${W} ORDER BY p.updated_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    const ids = rows.flatMap((r) => (r.variants ?? []).map((v: any) => v.id));
    const av = await this.inventory.availability(orgId, ids);
    for (const r of rows) {
      r.stock = (r.variants ?? []).reduce((s: number, v: any) => s + (av.get(v.id)?.available ?? 0), 0);
      for (const v of r.variants ?? []) Object.assign(v, av.get(v.id));
    }
    const filtered = f.stock === 'low' ? rows.filter((r) => r.stock > 0 && r.stock <= 5) : f.stock === 'out' ? rows.filter((r) => r.stock <= 0) : rows;
    return { total, rows: filtered };
  }

  async get(orgId: string, id: string) {
    const p = await one('SELECT * FROM products WHERE id=$1 AND org_id=$2', [id, orgId]);
    if (!p) throw new NotFoundException('Product not found');
    const variants = await q('SELECT * FROM variants WHERE product_id=$1 ORDER BY position, sku', [id]);
    const av = await this.inventory.availability(orgId, variants.map((v) => v.id));
    const comps = await q(`SELECT bc.*, v.sku FROM bundle_components bc JOIN variants v ON v.id=bc.component_variant_id WHERE bc.bundle_variant_id = ANY($1::uuid[])`, [variants.map((v) => v.id)]);
    const listings = await q(
      `SELECT l.id, l.status, l.external_id, l.external_url, l.missing_fields, l.last_error, l.overrides, l.price_override, l.sync_price_with_master,
              c.id AS connection_id, c.marketplace, c.account_name, c.mode FROM listings l JOIN marketplace_connections c ON c.id=l.connection_id WHERE l.product_id=$1`, [id]);
    return { ...p, variants: variants.map((v) => ({ ...v, stock: av.get(v.id), components: comps.filter((c) => c.bundle_variant_id === v.id) })), listings };
  }

  async create(orgId: string, userId: string, b: ProductInput) {
    this.assertTypeShape(b);
    const created = await tx(async (c) => {
      const p = await one(
        `INSERT INTO products(org_id,type,title,description,brand,manufacturer,category,tags,images,videos,attributes,shipping,supplier,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [orgId, b.type, b.title, b.description, b.brand ?? null, b.manufacturer ?? null, b.category ?? null, b.tags,
          JSON.stringify(b.images), JSON.stringify(b.videos), b.attributes, b.shipping, b.supplier ?? null, b.status], c);
      const wh = await this.inventory.defaultWarehouse(orgId, c);
      for (const [i, v] of b.variants.entries()) {
        const row = await this.insertVariant(c, orgId, p!.id, v, i).catch((e) => { if (e.code === '23505') throw new ConflictException(`SKU ${v.sku} already exists`); throw e; });
        if (b.type !== 'bundle') {
          await q(`INSERT INTO inventory_levels(org_id,variant_id,warehouse_id,on_hand) VALUES ($1,$2,$3,$4)`, [orgId, row.id, wh, v.initialStock ?? 0], c);
          if (v.initialStock) await q(`INSERT INTO inventory_movements(org_id,variant_id,warehouse_id,delta_on_hand,on_hand_after,reserved_after,reason,user_id) VALUES ($1,$2,$3,$4,$4,0,'initial',$5)`, [orgId, row.id, wh, v.initialStock, userId], c);
        }
        for (const comp of v.components ?? []) await q(`INSERT INTO bundle_components VALUES ($1,$2,$3)`, [row.id, comp.variantId, comp.quantity], c);
        await q(`INSERT INTO price_history(org_id,variant_id,new_price,reason,user_id) VALUES ($1,$2,$3,'created',$4)`, [orgId, row.id, v.price, userId], c);
      }
      await this.activity.log({ orgId, userId, action: 'product.create', entityType: 'product', entityId: p!.id, message: `Product "${b.title}" created with ${b.variants.length} SKU(s)` }, c);
      return p!.id as string;
    });
    return this.get(orgId, created);
  }

  private assertTypeShape(b: ProductInput) {
    if (b.type === 'simple' && b.variants.length !== 1) throw new BadRequestException('A simple product has exactly one SKU; use type "variable" for variations');
    if (b.type === 'bundle' && b.variants.some((v) => !v.components?.length)) throw new BadRequestException('Bundle SKUs need at least one component');
    if (b.type === 'variable') {
      const keys = new Set(b.variants.map((v) => JSON.stringify(Object.entries(v.options).sort())));
      if (keys.size !== b.variants.length) throw new BadRequestException('Each variation needs a unique combination of options');
    }
  }

  private insertVariant(c: any, orgId: string, productId: string, v: z.infer<typeof VariantSchema>, position: number) {
    return one(
      `INSERT INTO variants(org_id,product_id,sku,barcode,options,cost_price,price,min_price,max_price,weight_grams,dimensions,low_stock_threshold,safety_buffer,position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [orgId, productId, v.sku, v.barcode ?? null, v.options, v.costPrice ?? null, v.price, v.minPrice ?? null, v.maxPrice ?? null,
        v.weightGrams ?? null, v.dimensions ?? null, v.lowStockThreshold ?? null, v.safetyBuffer ?? null, position], c);
  }

  /**
   * Update master product. Content changes propagate to published listings that have NOT customised that field
   * (effective() already prefers overrides). Price changes go through price history + master-price sync.
   */
  async update(orgId: string, userId: string, id: string, b: ProductInput) {
    this.assertTypeShape(b);
    const priceChanged: string[] = [];
    const stockChanged: string[] = [];
    await tx(async (c) => {
      const p = await one('SELECT id FROM products WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, orgId], c);
      if (!p) throw new NotFoundException();
      await q(`UPDATE products SET type=$2,title=$3,description=$4,brand=$5,manufacturer=$6,category=$7,tags=$8,images=$9,videos=$10,attributes=$11,shipping=$12,supplier=$13,status=$14,updated_at=now() WHERE id=$1`,
        [id, b.type, b.title, b.description, b.brand ?? null, b.manufacturer ?? null, b.category ?? null, b.tags, JSON.stringify(b.images), JSON.stringify(b.videos), b.attributes, b.shipping, b.supplier ?? null, b.status], c);
      const existing = await q('SELECT * FROM variants WHERE product_id=$1', [id], c);
      const keep = new Set(b.variants.filter((v) => v.id).map((v) => v.id));
      for (const ev of existing.filter((e) => !keep.has(e.id))) {
        const open = await one(`SELECT 1 FROM order_item_allocations a WHERE a.variant_id=$1 AND a.state='reserved' LIMIT 1`, [ev.id], c);
        if (open) throw new BadRequestException(`SKU ${ev.sku} has open reserved orders and cannot be removed`);
        await q('DELETE FROM variants WHERE id=$1', [ev.id], c);
      }
      const wh = await this.inventory.defaultWarehouse(orgId, c);
      for (const [i, v] of b.variants.entries()) {
        if (v.id) {
          const ev = existing.find((e) => e.id === v.id);
          if (!ev) throw new BadRequestException(`Variant ${v.id} does not belong to this product`);
          await q(`UPDATE variants SET sku=$2,barcode=$3,options=$4,cost_price=$5,price=$6,min_price=$7,max_price=$8,weight_grams=$9,dimensions=$10,low_stock_threshold=$11,safety_buffer=$12,position=$13 WHERE id=$1`,
            [v.id, v.sku, v.barcode ?? null, v.options, v.costPrice ?? null, v.price, v.minPrice ?? null, v.maxPrice ?? null, v.weightGrams ?? null, v.dimensions ?? null, v.lowStockThreshold ?? null, v.safetyBuffer ?? null, i], c)
            .catch((e) => { if (e.code === '23505') throw new ConflictException(`SKU ${v.sku} already exists`); throw e; });
          if (Number(ev.price) !== v.price) {
            priceChanged.push(v.id);
            await q(`INSERT INTO price_history(org_id,variant_id,old_price,new_price,reason,user_id) VALUES ($1,$2,$3,$4,'master_edit',$5)`, [orgId, v.id, ev.price, v.price, userId], c);
          }
          if ((ev.safety_buffer ?? null) !== (v.safetyBuffer ?? null)) stockChanged.push(v.id);
        } else {
          const row = await this.insertVariant(c, orgId, id, v, i);
          if (b.type !== 'bundle') await q(`INSERT INTO inventory_levels(org_id,variant_id,warehouse_id,on_hand) VALUES ($1,$2,$3,$4)`, [orgId, row.id, wh, v.initialStock ?? 0], c);
          await q(`INSERT INTO listing_variants(listing_id,variant_id) SELECT l.id, $2 FROM listings l WHERE l.product_id=$1 ON CONFLICT DO NOTHING`, [id, row.id], c);
        }
      }
      await this.activity.log({ orgId, userId, action: 'product.update', entityType: 'product', entityId: id, message: `Product "${b.title}" updated${priceChanged.length ? ` (master price changed on ${priceChanged.length} SKU)` : ''}` }, c);
    });
    const published = await q(`SELECT id FROM listings WHERE product_id=$1 AND status IN ('published','paused')`, [id]);
    for (const l of published) await this.jobs.enqueue('listing_update', { listingId: l.id });
    await this.pricing.syncMasterPriceChange(priceChanged);
    if (stockChanged.length) await this.inventory.afterChange(orgId, stockChanged);
    return this.get(orgId, id);
  }

  async duplicate(orgId: string, userId: string, id: string) {
    const p = await this.get(orgId, id);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return this.create(orgId, userId, {
      type: p.type, title: `${p.title} (copy)`, description: p.description, brand: p.brand, manufacturer: p.manufacturer, category: p.category,
      tags: p.tags, images: p.images, videos: p.videos, attributes: p.attributes, shipping: p.shipping, supplier: p.supplier, status: 'draft',
      variants: p.variants.map((v: any) => ({
        sku: `${v.sku}-COPY-${suffix}`, barcode: null, options: v.options, costPrice: v.cost_price, price: v.price, minPrice: v.min_price, maxPrice: v.max_price,
        weightGrams: v.weight_grams, dimensions: v.dimensions, lowStockThreshold: v.low_stock_threshold, safetyBuffer: v.safety_buffer, initialStock: 0,
        components: v.components?.map((c: any) => ({ variantId: c.component_variant_id, quantity: c.quantity })),
      })),
    });
  }

  async archive(orgId: string, userId: string, id: string) {
    const live = await one(`SELECT count(*)::int n FROM listings WHERE product_id=$1 AND status IN ('published','queued')`, [id]);
    if (live!.n) throw new BadRequestException('End or pause this product\'s live listings before archiving it');
    await q(`UPDATE products SET status='archived', updated_at=now() WHERE id=$1 AND org_id=$2`, [id, orgId]);
    await this.activity.log({ orgId, userId, action: 'product.archive', entityType: 'product', entityId: id, message: 'Product archived' });
    return { ok: true };
  }

  // ── Import from marketplaces + matching (SKU / barcode only — never by title) ──
  async importFromConnection(orgId: string, userId: string, connectionId: string) {
    const conn = await this.connections.withFreshCredentials(await this.connections.load(connectionId, orgId));
    const items = await adapterFor(conn).fetchListings(conn);
    let staged = 0;
    for (const it of items) {
      const match = (it.sku && (await one(`SELECT id FROM variants WHERE org_id=$1 AND sku=$2`, [orgId, it.sku])) && 'sku')
        || (it.barcode && (await one(`SELECT id FROM variants WHERE org_id=$1 AND barcode=$2`, [orgId, it.barcode])) && 'barcode') || null;
      const vid = match === 'sku' ? (await one(`SELECT id FROM variants WHERE org_id=$1 AND sku=$2`, [orgId, it.sku]))!.id
        : match === 'barcode' ? (await one(`SELECT id FROM variants WHERE org_id=$1 AND barcode=$2`, [orgId, it.barcode]))!.id : null;
      await q(
        `INSERT INTO import_staging(org_id,connection_id,external_id,external_variant_ref,sku,barcode,title,price,quantity,image_url,raw,suggested_variant_id,match_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (connection_id,external_id,external_variant_ref) DO UPDATE SET sku=EXCLUDED.sku, barcode=EXCLUDED.barcode, title=EXCLUDED.title, price=EXCLUDED.price, quantity=EXCLUDED.quantity, suggested_variant_id=EXCLUDED.suggested_variant_id, match_method=EXCLUDED.match_method`,
        [orgId, connectionId, it.externalId, it.externalVariantRef, it.sku, it.barcode, it.title, it.price, it.quantity, it.imageUrl, it.raw, vid, match]);
      staged++;
    }
    await this.activity.log({ orgId, userId, action: 'import.fetch', entityType: 'connection', entityId: connectionId, message: `Fetched ${staged} listing(s) from ${conn.marketplace} for matching` });
    return { staged };
  }

  staging(orgId: string, status = 'pending') {
    return q(`SELECT s.*, c.marketplace, c.account_name, v.sku AS suggested_sku, p.title AS suggested_title
                FROM import_staging s JOIN marketplace_connections c ON c.id=s.connection_id
                LEFT JOIN variants v ON v.id=s.suggested_variant_id LEFT JOIN products p ON p.id=v.product_id
               WHERE s.org_id=$1 AND s.status=$2 ORDER BY s.match_method NULLS LAST, s.title`, [orgId, status]);
  }

  /** User-confirmed match: link an imported marketplace listing to a catalog variant (creates the listing rows). */
  async confirmMatch(orgId: string, userId: string, stagingId: string, action: { linkTo?: string; createNew?: boolean; ignore?: boolean }) {
    const s = await one('SELECT * FROM import_staging WHERE id=$1 AND org_id=$2', [stagingId, orgId]);
    if (!s) throw new NotFoundException();
    if (action.ignore) { await q(`UPDATE import_staging SET status='ignored' WHERE id=$1`, [stagingId]); return { ok: true }; }
    let variantId = action.linkTo;
    if (action.createNew) {
      if (!s.sku) throw new BadRequestException('Imported item has no SKU; give it one on the marketplace or link it manually');
      const p = await this.create(orgId, userId, {
        type: 'simple', title: s.title, description: '', tags: [], images: s.image_url ? [{ url: s.image_url }] : [], videos: [], attributes: {}, shipping: {}, status: 'active',
        variants: [{ sku: s.sku, barcode: s.barcode, options: {}, price: s.price ?? 0, initialStock: s.quantity ?? 0 }],
      } as any);
      variantId = p.variants[0].id;
    }
    if (!variantId) throw new BadRequestException('Choose a SKU to link to, or create a new product');
    const v = await one('SELECT id, product_id, sku FROM variants WHERE id=$1 AND org_id=$2', [variantId, orgId]);
    if (!v) throw new BadRequestException('Unknown variant');
    await tx(async (c) => {
      const l = await one(`INSERT INTO listings(org_id,product_id,connection_id,status,external_id,published_at) VALUES ($1,$2,$3,'published',$4,now())
                           ON CONFLICT (product_id,connection_id) DO UPDATE SET external_id=COALESCE(listings.external_id,EXCLUDED.external_id), status='published' RETURNING id`,
        [orgId, v.product_id, s.connection_id, s.external_id], c);
      await q(`INSERT INTO listing_variants(listing_id,variant_id,external_ref,last_pushed_price) VALUES ($1,$2,$3,$4)
               ON CONFLICT (listing_id,variant_id) DO UPDATE SET external_ref=EXCLUDED.external_ref`, [l!.id, v.id, s.external_variant_ref, s.price], c);
      await q(`UPDATE import_staging SET status=$2, suggested_variant_id=$3 WHERE id=$1`, [stagingId, action.createNew ? 'created' : 'linked', v.id], c);
      await this.activity.log({ orgId, userId, action: 'import.link', level: 'success', entityType: 'variant', entityId: v.id, message: `Linked imported listing "${s.title}" to ${v.sku}` }, c);
    });
    // From now on this channel follows central stock.
    await this.inventory.afterChange(orgId, [v.id]);
    return { ok: true, variantId: v.id };
  }
}
