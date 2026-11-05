import { BadRequestException, Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { ActivityService } from '../activity/activity.service';
import { one, q } from '../common/db';
import { CatalogService, ProductSchema } from '../catalog/catalog.service';
import { InventoryService } from '../inventory/inventory.service';

/** Flat one-row-per-SKU format used for both import and export. Rows sharing parent_sku form a variable product. */
export const COLUMNS = ['parent_sku', 'sku', 'title', 'description', 'brand', 'manufacturer', 'category', 'tags', 'barcode',
  'price', 'cost_price', 'min_price', 'max_price', 'quantity', 'weight_grams', 'color', 'size', 'material', 'image_urls', 'status'] as const;

export interface PreviewRow { row: number; sku: string; action: 'create' | 'update' | 'skip'; errors: string[]; warnings: string[]; changes: Record<string, [any, any]> }

@Injectable()
export class BulkService {
  constructor(private catalog: CatalogService, private inventory: InventoryService, private activity: ActivityService) {}

  async parseFile(buf: Buffer, filename: string): Promise<Record<string, string>[]> {
    if (/\.xlsx$/i.test(filename)) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as any);
      const ws = wb.worksheets[0];
      if (!ws) throw new BadRequestException('Workbook has no sheets');
      const header = (ws.getRow(1).values as any[]).slice(1).map((h) => String(h ?? '').trim().toLowerCase());
      const rows: Record<string, string>[] = [];
      ws.eachRow((r, i) => {
        if (i === 1) return;
        const vals = (r.values as any[]).slice(1);
        const o: Record<string, string> = {};
        header.forEach((h, j) => { const v = vals[j]; o[h] = v == null ? '' : typeof v === 'object' && 'text' in v ? String(v.text) : String(v); });
        if (Object.values(o).some((v) => v !== '')) rows.push(o);
      });
      return rows;
    }
    return parse(buf, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  }

  /** Validate every row and show exactly what would change. Nothing is written. */
  async preview(orgId: string, rows: Record<string, string>[]): Promise<{ rows: PreviewRow[]; summary: any }> {
    if (rows.length > 5000) throw new BadRequestException('Import at most 5,000 rows per file');
    const skus = rows.map((r) => r.sku).filter(Boolean);
    const existing = await q(`SELECT v.*, p.title, p.brand FROM variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 AND v.sku = ANY($2)`, [orgId, skus]);
    const av = await this.inventory.availability(orgId, existing.map((e) => e.id));
    const seen = new Set<string>();
    const out: PreviewRow[] = rows.map((r, i) => {
      const errors: string[] = []; const warnings: string[] = []; const changes: Record<string, [any, any]> = {};
      const sku = (r.sku ?? '').trim();
      if (!sku) errors.push('sku is required');
      else if (!/^[A-Za-z0-9._\-\/]+$/.test(sku)) errors.push('sku has invalid characters');
      if (seen.has(sku)) errors.push('duplicate sku in file'); seen.add(sku);
      const num = (k: string) => { if (r[k] === undefined || r[k] === '') return undefined; const n = Number(r[k]); if (!Number.isFinite(n) || n < 0) errors.push(`${k} must be a non-negative number`); return n; };
      const price = num('price'), cost = num('cost_price'), qty = num('quantity'), min = num('min_price'), max = num('max_price');
      if (qty !== undefined && !Number.isInteger(qty)) errors.push('quantity must be a whole number');
      if (r.barcode && !/^\d{8,14}$/.test(r.barcode)) errors.push('barcode must be 8–14 digits');
      if (min !== undefined && max !== undefined && min > max) errors.push('min_price exceeds max_price');
      for (const u of (r.image_urls ?? '').split('|').filter(Boolean)) if (!/^https?:\/\//.test(u)) errors.push(`image url "${u.slice(0, 40)}" is not http(s)`);
      const ex = existing.find((e) => e.sku === sku);
      if (ex) {
        if (price !== undefined && price !== ex.price) changes.price = [ex.price, price];
        if (cost !== undefined && cost !== ex.cost_price) changes.cost_price = [ex.cost_price, cost];
        if (r.title && r.title !== ex.title) changes.title = [ex.title, r.title];
        if (qty !== undefined) {
          const a = av.get(ex.id)!;
          if (qty !== a.onHand) changes.quantity = [a.onHand, qty];
          if (qty < a.reserved) errors.push(`quantity ${qty} is below the ${a.reserved} units reserved by open orders`);
        }
        if (price !== undefined && ex.min_price != null && price < ex.min_price) warnings.push(`price is below the SKU's minimum (${ex.min_price}); it will be clamped on channels`);
      } else {
        if (!r.title) errors.push('title is required for new products');
        if (price === undefined) errors.push('price is required for new products');
      }
      return { row: i + 2, sku, action: errors.length ? 'skip' : ex ? (Object.keys(changes).length ? 'update' : 'skip') : 'create', errors, warnings, changes };
    });
    return { rows: out, summary: { total: out.length, create: out.filter((r) => r.action === 'create').length, update: out.filter((r) => r.action === 'update').length, errors: out.filter((r) => r.errors.length).length } };
  }

  /** Apply only rows that passed validation. Re-validates first (file could be stale). Returns per-row outcome. */
  async apply(orgId: string, userId: string, rows: Record<string, string>[]) {
    const { rows: pv } = await this.preview(orgId, rows);
    const results: { row: number; sku: string; ok: boolean; error?: string }[] = [];
    // Group new rows by parent_sku → variable products.
    const groups = new Map<string, Record<string, string>[]>();
    pv.forEach((p, i) => {
      if (p.action !== 'create') return;
      const key = rows[i].parent_sku || rows[i].sku;
      groups.set(key, [...(groups.get(key) ?? []), { ...rows[i], __row: String(p.row) }]);
    });
    for (const [, grp] of groups) {
      const first = grp[0];
      const variable = grp.length > 1 || !!first.parent_sku && grp.some((g) => g.color || g.size || g.material);
      try {
        const input = ProductSchema.parse({
          type: variable ? 'variable' : 'simple', title: first.title, description: first.description ?? '',
          brand: first.brand || null, manufacturer: first.manufacturer || null, category: first.category || null,
          tags: (first.tags ?? '').split('|').filter(Boolean), images: (first.image_urls ?? '').split('|').filter(Boolean).map((url) => ({ url })),
          status: first.status || 'active',
          variants: grp.map((g) => ({
            sku: g.sku, barcode: g.barcode || null, price: g.price, costPrice: g.cost_price || null, minPrice: g.min_price || null, maxPrice: g.max_price || null,
            weightGrams: g.weight_grams || null, initialStock: g.quantity ? Number(g.quantity) : 0,
            options: Object.fromEntries((['color', 'size', 'material'] as const).filter((k) => g[k]).map((k) => [k, g[k]])),
          })),
        });
        await this.catalog.create(orgId, userId, input);
        grp.forEach((g) => results.push({ row: Number(g.__row), sku: g.sku, ok: true }));
      } catch (e: any) {
        const msg = e.issues ? e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message;
        grp.forEach((g) => results.push({ row: Number(g.__row), sku: g.sku, ok: false, error: msg }));
      }
    }
    for (const [i, p] of pv.entries()) {
      if (p.action !== 'update') continue;
      try {
        const v = await one('SELECT * FROM variants WHERE org_id=$1 AND sku=$2', [orgId, p.sku]);
        const prod = await this.catalog.get(orgId, v!.product_id);
        const r = rows[i];
        const needsProductUpdate = p.changes.price || p.changes.cost_price || p.changes.title;
        if (needsProductUpdate) {
          await this.catalog.update(orgId, userId, prod.id, {
            ...toInput(prod),
            title: r.title || prod.title,
            variants: prod.variants.map((x: any) => ({ ...toVariantInput(x), ...(x.id === v!.id ? { price: p.changes.price?.[1] ?? x.price, costPrice: p.changes.cost_price?.[1] ?? x.cost_price } : {}) })),
          });
        }
        if (p.changes.quantity) await this.inventory.adjust(orgId, userId, { variantId: v!.id, set: p.changes.quantity[1], note: 'bulk import' });
        results.push({ row: p.row, sku: p.sku, ok: true });
      } catch (e: any) { results.push({ row: p.row, sku: p.sku, ok: false, error: e.message }); }
    }
    pv.filter((p) => p.errors.length).forEach((p) => results.push({ row: p.row, sku: p.sku, ok: false, error: p.errors.join('; ') }));
    results.sort((a, b) => a.row - b.row);
    await this.activity.log({ orgId, userId, action: 'bulk.import', level: results.some((r) => !r.ok) ? 'warning' : 'success', message: `Bulk import: ${results.filter((r) => r.ok).length} applied, ${results.filter((r) => !r.ok).length} failed` });
    return { results };
  }

  async exportRows(orgId: string) {
    const vs = await q(
      `SELECT p.id AS product_id, p.type, p.title, p.description, p.brand, p.manufacturer, p.category, p.tags, p.images, p.status, v.*
         FROM variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 ORDER BY p.title, v.position`, [orgId]);
    const av = await this.inventory.availability(orgId, vs.map((v) => v.id));
    const parents = new Map<string, string>();
    vs.forEach((v) => { if (!parents.has(v.product_id)) parents.set(v.product_id, v.sku); });
    return vs.map((v) => ({
      parent_sku: v.type === 'variable' ? parents.get(v.product_id) : '', sku: v.sku, title: v.title, description: v.description, brand: v.brand ?? '',
      manufacturer: v.manufacturer ?? '', category: v.category ?? '', tags: (v.tags ?? []).join('|'), barcode: v.barcode ?? '', price: v.price,
      cost_price: v.cost_price ?? '', min_price: v.min_price ?? '', max_price: v.max_price ?? '', quantity: av.get(v.id)?.onHand ?? 0,
      weight_grams: v.weight_grams ?? '', color: v.options?.color ?? '', size: v.options?.size ?? '', material: v.options?.material ?? '',
      image_urls: (v.images ?? []).map((i: any) => i.url).join('|'), status: v.status,
    }));
  }

  toCsv(rows: any[]) { return stringify(rows, { header: true, columns: COLUMNS as any }); }

  async toXlsx(rows: any[]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Products');
    ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: Math.max(12, c.length + 2) }));
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

export const toVariantInput = (x: any) => ({
  id: x.id, sku: x.sku, barcode: x.barcode, options: x.options, costPrice: x.cost_price, price: x.price, minPrice: x.min_price, maxPrice: x.max_price,
  weightGrams: x.weight_grams, dimensions: x.dimensions, lowStockThreshold: x.low_stock_threshold, safetyBuffer: x.safety_buffer,
  components: x.components?.map((c: any) => ({ variantId: c.component_variant_id, quantity: c.quantity })),
});
export const toInput = (p: any) => ({
  type: p.type, title: p.title, description: p.description, brand: p.brand, manufacturer: p.manufacturer, category: p.category, tags: p.tags,
  images: p.images, videos: p.videos, attributes: p.attributes, shipping: p.shipping, supplier: p.supplier, status: p.status,
  variants: p.variants.map(toVariantInput),
});
