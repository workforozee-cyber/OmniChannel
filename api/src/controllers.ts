import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors, BadRequestException, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { ActivityService } from './activity/activity.service';
import { AnalyticsService } from './analytics/analytics.service';
import { BulkService } from './bulk/bulk.service';
import { CatalogService, ProductSchema } from './catalog/catalog.service';
import { one, q } from './common/db';
import { AuthUser, CurrentUser, MinRole, paginate, Zod } from './common/http';
import { InventoryService } from './inventory/inventory.service';
import { JobsService } from './jobs/jobs.service';
import { ListingsService } from './listings/listings.service';
import { ConnectionsService } from './marketplaces/connections.service';
import { MARKETPLACES, liveAdapter } from './marketplaces/registry';
import { MarketplaceCode } from './marketplaces/types';
import { OrdersService } from './orders/orders.service';
import { PricingService } from './pricing/pricing.service';

const Uuid = new ParseUUIDPipe();
const Marketplace = z.enum(MARKETPLACES as [MarketplaceCode, ...MarketplaceCode[]]);

// ───────────────────────── Products ─────────────────────────
@Controller('products')
export class ProductsController {
  constructor(private catalog: CatalogService, private listings: ListingsService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query() qs: any) { const p = paginate(qs); return this.catalog.list(u.orgId, qs, p.pageSize, p.offset); }
  @Get('import/staging') staging(@CurrentUser() u: AuthUser, @Query('status') s?: string) { return this.catalog.staging(u.orgId, s); }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) { return this.catalog.get(u.orgId, id); }
  @Post() @MinRole('manager') create(@CurrentUser() u: AuthUser, @Body(new Zod(ProductSchema)) b: any) { return this.catalog.create(u.orgId, u.id, b); }
  @Put(':id') @MinRole('manager') update(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(ProductSchema)) b: any) { return this.catalog.update(u.orgId, u.id, id, b); }
  @Post(':id/duplicate') @MinRole('manager') dup(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) { return this.catalog.duplicate(u.orgId, u.id, id); }
  @Delete(':id') @MinRole('admin') archive(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) { return this.catalog.archive(u.orgId, u.id, id); }
  @Post(':id/publish') @MinRole('manager')
  publish(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({ connectionIds: z.array(z.string().uuid()).min(1) }))) b: { connectionIds: string[] }) {
    return this.listings.publish(u.orgId, u.id, id, b.connectionIds);
  }
  @Post('import/:connectionId') @MinRole('manager') importFrom(@CurrentUser() u: AuthUser, @Param('connectionId', Uuid) cid: string) { return this.catalog.importFromConnection(u.orgId, u.id, cid); }
  @Post('import/staging/:id') @MinRole('manager')
  match(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({ linkTo: z.string().uuid().optional(), createNew: z.boolean().optional(), ignore: z.boolean().optional() }))) b: any) {
    return this.catalog.confirmMatch(u.orgId, u.id, id, b);
  }
}

// ───────────────────────── Listings ─────────────────────────
@Controller('listings')
export class ListingsController {
  constructor(private listings: ListingsService, private catalog: CatalogService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query() qs: any) { const p = paginate(qs); return this.listings.list(u.orgId, { ...qs, limit: p.pageSize, offset: p.offset }); }
  @Get(':id/preview') async preview(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) {
    const r = await this.listings.effective(id);
    if (r.listing.org_id !== u.orgId) throw new NotFoundException();
    return r.eff;
  }
  @Patch(':id') @MinRole('manager')
  customize(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({
    overrides: z.record(z.string(), z.any()).optional(), priceOverride: z.number().positive().nullable().optional(), syncPriceWithMaster: z.boolean().optional(),
  }))) b: any) { return this.listings.updateOverrides(u.orgId, u.id, id, b); }
  @Post(':id/sync-from-master') @MinRole('manager')
  syncMaster(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({ fields: z.array(z.enum(['title', 'description', 'images', 'category', 'attributes', 'shipping', 'price'])).min(1) }))) b: any) {
    return this.listings.syncFromMaster(u.orgId, u.id, id, b.fields);
  }
  @Post('bulk/status') @MinRole('manager')
  status(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ listingIds: z.array(z.string().uuid()).min(1), action: z.enum(['pause', 'activate', 'end']) }))) b: any) {
    return this.listings.setStatus(u.orgId, u.id, b.listingIds, b.action);
  }
  @Post('bulk/publish') @MinRole('manager')
  async bulkPublish(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ productIds: z.array(z.string().uuid()).min(1).max(500), connectionIds: z.array(z.string().uuid()).min(1) }))) b: any) {
    const out = [];
    for (const pid of b.productIds) out.push(await this.listings.publish(u.orgId, u.id, pid, b.connectionIds));
    return out;
  }
  @Post(':id/retry') @MinRole('manager')
  async retry(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) {
    const l = await one('SELECT product_id, connection_id FROM listings WHERE id=$1 AND org_id=$2', [id, u.orgId]);
    if (!l) throw new NotFoundException();
    await q(`UPDATE listings SET status='draft' WHERE id=$1 AND status IN ('failed','validation_required')`, [id]);
    return this.listings.publish(u.orgId, u.id, l.product_id, [l.connection_id]);
  }
}

// ───────────────────────── Inventory ─────────────────────────
@Controller('inventory')
export class InventoryController {
  constructor(private inv: InventoryService) {}
  @Get() async list(@CurrentUser() u: AuthUser, @Query() qs: any) {
    const p = paginate(qs);
    const params: any[] = [u.orgId];
    let f = '';
    if (qs.search) { params.push(`%${qs.search}%`); f = `AND (v.sku ILIKE $2 OR p.title ILIKE $2)`; }
    const total = (await one(`SELECT count(*)::int n FROM variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 AND p.status<>'archived' ${f}`, params))!.n;
    params.push(p.pageSize, p.offset);
    const rows = await q(
      `SELECT v.id, v.sku, v.options, v.safety_buffer, v.low_stock_threshold, p.id AS product_id, p.title, p.type, p.images->0->>'url' AS image,
              (SELECT json_agg(json_build_object('warehouse', w.name, 'warehouseId', w.id, 'onHand', il.on_hand, 'reserved', il.reserved)) FROM inventory_levels il JOIN warehouses w ON w.id=il.warehouse_id WHERE il.variant_id=v.id) AS levels,
              (SELECT json_agg(json_build_object('marketplace', c.marketplace, 'mode', c.mode, 'qty', lv.last_pushed_qty, 'at', lv.last_pushed_at, 'status', l.status) ORDER BY c.marketplace)
                 FROM listing_variants lv JOIN listings l ON l.id=lv.listing_id JOIN marketplace_connections c ON c.id=l.connection_id WHERE lv.variant_id=v.id) AS channels
         FROM variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 AND p.status<>'archived' ${f}
        ORDER BY p.title, v.position LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const av = await this.inv.availability(u.orgId, rows.map((r) => r.id));
    let out = rows.map((r) => ({ ...r, ...av.get(r.id) }));
    if (qs.stock === 'low') out = out.filter((r: any) => r.available > 0 && r.available <= (r.low_stock_threshold ?? 5));
    if (qs.stock === 'out') out = out.filter((r: any) => r.available <= 0);
    return { total, rows: out };
  }
  @Post('adjust') @MinRole('manager')
  adjust(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({
    variantId: z.string().uuid(), warehouseId: z.string().uuid().optional(), set: z.number().int().nonnegative().optional(), delta: z.number().int().optional(), note: z.string().max(500).optional(),
  }).refine((b) => (b.set === undefined) !== (b.delta === undefined), 'Provide exactly one of set or delta'))) b: any) {
    return this.inv.adjust(u.orgId, u.id, b);
  }
  @Post('bulk-adjust') @MinRole('manager')
  async bulkAdjust(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ items: z.array(z.object({ variantId: z.string().uuid(), set: z.number().int().nonnegative() })).min(1).max(1000) }))) b: any) {
    const out = [];
    for (const it of b.items) { try { await this.inv.adjust(u.orgId, u.id, it); out.push({ ...it, ok: true }); } catch (e: any) { out.push({ ...it, ok: false, error: e.message }); } }
    return out;
  }
  @Get(':variantId/history') history(@CurrentUser() u: AuthUser, @Param('variantId', Uuid) id: string) { return this.inv.history(u.orgId, id); }
  @Get('sync-logs') syncLogs(@CurrentUser() u: AuthUser, @Query() qs: any) {
    const p = paginate(qs);
    return q(`SELECT s.*, c.marketplace, c.mode, v.sku FROM sync_logs s LEFT JOIN marketplace_connections c ON c.id=s.connection_id LEFT JOIN variants v ON v.id=s.variant_id
              WHERE s.org_id=$1 ${qs.status ? 'AND s.status=$4' : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT $2 OFFSET $3`, qs.status ? [u.orgId, p.pageSize, p.offset, qs.status] : [u.orgId, p.pageSize, p.offset]);
  }
}

// ───────────────────────── Orders & shipping ─────────────────────────
@Controller('orders')
export class OrdersController {
  constructor(private orders: OrdersService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query() qs: any) { const p = paginate(qs); return this.orders.list(u.orgId, qs, p.pageSize, p.offset); }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) { return this.orders.detail(u.orgId, id); }
  @Post(':id/notes') @MinRole('manager') note(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({ body: z.string().min(1).max(5000) }))) b: any) { return this.orders.addNote(u.orgId, u.id, id, b.body); }
  @Patch(':id/status') @MinRole('manager') status(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({ status: z.enum(['new', 'processing', 'on_hold', 'shipped', 'completed']) }))) b: any) { return this.orders.setInternalStatus(u.orgId, u.id, id, b.status); }
  @Post(':id/tracking') @MinRole('manager') tracking(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({ carrier: z.string().min(1).max(60), trackingNumber: z.string().min(3).max(80) }))) b: any) { return this.orders.addTracking(u.orgId, u.id, id, b); }
}

// ───────────────────────── Marketplaces ─────────────────────────
@Controller('marketplaces')
export class MarketplacesController {
  constructor(private conns: ConnectionsService, private orders: OrdersService, private jobs: JobsService) {}
  @Get('catalog') catalog() {
    return MARKETPLACES.map((m) => ({ code: m, name: liveAdapter(m).displayName, capabilities: liveAdapter(m).capabilities }));
  }
  @Get('connections') list(@CurrentUser() u: AuthUser) { return this.conns.list(u.orgId); }
  @Post('connections/mock') @MinRole('admin')
  mock(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ marketplace: Marketplace, accountName: z.string().min(1).max(120), settings: z.record(z.string(), z.any()).default({}) }))) b: any) {
    return this.conns.createMock(u.orgId, u.id, b.marketplace, b.accountName, b.settings);
  }
  @Post('connections/:marketplace/oauth') @MinRole('admin')
  oauth(@CurrentUser() u: AuthUser, @Param('marketplace') m: string, @Body(new Zod(z.object({ shop: z.string().optional(), reconnectId: z.string().uuid().optional() }))) b: any) {
    return this.conns.startOAuth(u.orgId, Marketplace.parse(m), b);
  }
  @Post('connections/:marketplace/credentials') @MinRole('admin')
  creds(@CurrentUser() u: AuthUser, @Param('marketplace') m: string, @Body(new Zod(z.object({ accountName: z.string().min(1), clientId: z.string().min(1), clientSecret: z.string().min(1) }))) b: any) {
    const mp = Marketplace.parse(m);
    if (mp !== 'walmart') throw new BadRequestException(`${mp} connects via OAuth, not pasted credentials`);
    return this.conns.saveApiCredentials(u.orgId, u.id, mp, b.accountName, { clientId: b.clientId, clientSecret: b.clientSecret });
  }
  @Patch('connections/:id') @MinRole('admin') settings(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body() b: Record<string, any>) { return this.conns.updateSettings(u.orgId, id, b ?? {}); }
  @Delete('connections/:id') @MinRole('admin') disconnect(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) { return this.conns.disconnect(u.orgId, u.id, id); }
  @Post('connections/:id/sync') @MinRole('manager') async sync(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string) {
    const c = await this.conns.load(id, u.orgId);
    await this.jobs.enqueue('poll_orders', { connectionId: c.id });
    await this.jobs.enqueue('reconcile', { orgId: u.orgId });
    return { queued: true };
  }

  /**
   * MOCK ONLY: simulate a marketplace order arriving. Goes through the same OrdersService.ingest() used by
   * webhooks and polling (dedupe → atomic reservation → fan-out sync). The signed-webhook path itself is
   * exercised by POSTing to /api/webhooks/:marketplace/:connectionId with x-mock-signature (see tests).
   */
  @Post('connections/:id/mock-order') @MinRole('manager')
  async mockOrder(@CurrentUser() u: AuthUser, @Param('id', Uuid) id: string, @Body(new Zod(z.object({
    externalOrderId: z.string().optional(), customerName: z.string().default('Test Customer'),
    items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive(), unitPrice: z.number().nonnegative().optional() })).min(1),
    cancelled: z.boolean().default(false),
  }))) b: any) {
    const conn = await this.conns.load(id, u.orgId);
    if (conn.mode !== 'mock') throw new BadRequestException('Order simulation is only available on MOCK connections');
    const prices = await q(`SELECT v.sku, v.price, p.title FROM variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 AND v.sku = ANY($2)`, [u.orgId, b.items.map((i: any) => i.sku)]);
    const items = b.items.map((i: any, n: number) => ({ externalLineId: String(n + 1), sku: i.sku, title: prices.find((p) => p.sku === i.sku)?.title ?? i.sku, quantity: i.quantity, unitPrice: i.unitPrice ?? prices.find((p) => p.sku === i.sku)?.price ?? 10 }));
    const subtotal = items.reduce((s: number, i: any) => s + i.unitPrice * i.quantity, 0);
    const extId = b.externalOrderId ?? `M${Date.now().toString().slice(-8)}`;
    return this.orders.ingest(conn, {
      externalOrderId: extId, orderDate: new Date().toISOString(), customerName: b.customerName, customerEmail: null,
      shipAddress: { name: b.customerName, city: 'London', country: 'GB' }, marketplaceStatus: b.cancelled ? 'CANCELLED' : 'PAID', paymentStatus: 'paid',
      cancelled: b.cancelled, fulfilled: false, currency: 'GBP', subtotal, shippingCost: 3.99, tax: 0, fees: Math.round(subtotal * 0.12 * 100) / 100,
      refunds: 0, total: subtotal + 3.99, shippingMethod: 'Standard', carrier: null, trackingNumber: null, items, raw: { mock: true },
    });
  }
}

// ───────────────────────── Pricing ─────────────────────────
@Controller('pricing')
export class PricingController {
  constructor(private pricing: PricingService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query() qs: any) { const p = paginate(qs); return this.pricing.overview(u.orgId, p.pageSize, p.offset, qs.search); }
  @Get(':variantId/history') history(@CurrentUser() u: AuthUser, @Param('variantId', Uuid) id: string) { return this.pricing.history(u.orgId, id); }
  @Post('bulk') @MinRole('manager')
  bulk(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ variantIds: z.array(z.string().uuid()).min(1), op: z.enum(['set', 'increase', 'decrease', 'percent']), value: z.number(), dryRun: z.boolean().optional() }))) b: any) {
    return this.pricing.bulkAdjust(u.orgId, u.id, b);
  }
  @Put('rules/:connectionId') @MinRole('admin')
  rule(@CurrentUser() u: AuthUser, @Param('connectionId', Uuid) cid: string, @Body(new Zod(z.object({ kind: z.enum(['percent', 'fixed']), value: z.number().min(-90).max(1000), active: z.boolean().default(true) }))) b: any) {
    return this.pricing.setRule(u.orgId, u.id, cid, b.kind, b.value, b.active);
  }
}

// ───────────────────────── Analytics ─────────────────────────
@Controller('analytics')
export class AnalyticsController {
  constructor(private a: AnalyticsService) {}
  @Get('dashboard') dashboard(@CurrentUser() u: AuthUser) { return this.a.dashboard(u.orgId); }
  @Get('sales') sales(@CurrentUser() u: AuthUser, @Query() qs: any) { return this.a.sales(u.orgId, qs); }
  @Get('inventory-value') inv(@CurrentUser() u: AuthUser) { return this.a.inventoryValue(u.orgId); }
}

// ───────────────────────── Bulk ─────────────────────────
@Controller('bulk')
export class BulkController {
  constructor(private bulk: BulkService) {}
  @Post('products/preview') @MinRole('manager') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async preview(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Attach a CSV or XLSX file as "file"');
    const rows = await this.bulk.parseFile(file.buffer, file.originalname);
    return { ...(await this.bulk.preview(u.orgId, rows)), parsed: rows };
  }
  @Post('products/apply') @MinRole('manager')
  apply(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ rows: z.array(z.record(z.string(), z.any())).min(1).max(5000) }))) b: any) {
    return this.bulk.apply(u.orgId, u.id, b.rows.map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)]))));
  }
  @Get('products/export') async export(@CurrentUser() u: AuthUser, @Query('format') format: string, @Res() res: Response) {
    const rows = await this.bulk.exportRows(u.orgId);
    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="products.xlsx"');
      return res.send(await this.bulk.toXlsx(rows));
    }
    res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    return res.send(this.bulk.toCsv(rows));
  }
}

// ───────────────────────── Notifications, activity, settings ─────────────────────────
@Controller()
export class SystemController {
  constructor(private activity: ActivityService, private jobs: JobsService) {}
  @Get('notifications') notifications(@CurrentUser() u: AuthUser, @Query() qs: any) {
    const p = paginate(qs);
    return q(`SELECT * FROM notifications WHERE org_id=$1 ${qs.unread === 'true' ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [u.orgId, p.pageSize, p.offset]);
  }
  @Get('notifications/count') async count(@CurrentUser() u: AuthUser) { return one(`SELECT count(*)::int AS unread FROM notifications WHERE org_id=$1 AND read_at IS NULL`, [u.orgId]); }
  @Post('notifications/read') read(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ ids: z.array(z.string().uuid()).optional() }))) b: any) {
    return b.ids?.length
      ? q(`UPDATE notifications SET read_at=now() WHERE org_id=$1 AND id = ANY($2::uuid[]) RETURNING id`, [u.orgId, b.ids])
      : q(`UPDATE notifications SET read_at=now() WHERE org_id=$1 AND read_at IS NULL RETURNING id`, [u.orgId]);
  }
  @Get('activity') log(@CurrentUser() u: AuthUser, @Query() qs: any) {
    const p = paginate(qs); const params: any[] = [u.orgId, p.pageSize, p.offset]; const w: string[] = [];
    if (qs.level) { params.push(qs.level); w.push(`a.level=$${params.length}`); }
    if (qs.search) { params.push(`%${qs.search}%`); w.push(`a.message ILIKE $${params.length}`); }
    if (qs.entityType) { params.push(qs.entityType); w.push(`a.entity_type=$${params.length}`); }
    return q(`SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.org_id=$1 ${w.map((x) => 'AND ' + x).join(' ')} ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`, params);
  }
  @Get('settings') async get(@CurrentUser() u: AuthUser) {
    return { organization: await one('SELECT id,name,currency,settings FROM organizations WHERE id=$1', [u.orgId]), warehouses: await q('SELECT * FROM warehouses WHERE org_id=$1 ORDER BY is_default DESC, name', [u.orgId]) };
  }
  @Patch('settings') @MinRole('admin')
  async set(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({
    name: z.string().min(2).optional(), currency: z.string().length(3).optional(),
    safetyBuffer: z.object({ mode: z.enum(['units', 'percent']), value: z.number().min(0).max(100) }).optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
  }))) b: any) {
    const { name, currency, ...s } = b;
    await q(`UPDATE organizations SET name=COALESCE($2,name), currency=COALESCE($3,currency), settings = settings || $4 WHERE id=$1`, [u.orgId, name ?? null, currency ?? null, s]);
    await this.activity.log({ orgId: u.orgId, userId: u.id, action: 'settings.update', message: `Settings updated: ${Object.keys(b).join(', ')}` });
    // A new safety buffer changes what every channel should show → re-push all quantities.
    if (b.safetyBuffer) await this.jobs.enqueue('reconcile', { orgId: u.orgId });
    return this.get(u);
  }
  @Post('warehouses') @MinRole('admin') addWarehouse(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ name: z.string().min(1) }))) b: any) {
    return one(`INSERT INTO warehouses(org_id,name) VALUES ($1,$2) RETURNING *`, [u.orgId, b.name]);
  }
}
