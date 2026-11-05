import { pool } from '../src/common/db';
import { boot, connectAllMock, level, owner, publishedEverywhere, pushed, reset, shutdown, Api } from './helpers';

beforeAll(boot);
afterAll(shutdown);
beforeEach(reset);

const order = (a: Api, connId: string, sku: string, quantity: number, externalOrderId?: string) =>
  a.post(`/marketplaces/connections/${connId}/mock-order`, { items: [{ sku, quantity }], externalOrderId });

describe('Centralised inventory sync (spec section 3)', () => {
  it('Scenario A + B: Amazon sale of 1 then eBay sale of 3 sync remaining stock to every channel', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    expect(await pushed('MG-001')).toEqual({ amazon: 100, ebay: 100, etsy: 100, shopify: 100, walmart: 100 });

    await order(a, c.amazon.id, 'MG-001', 1).expect(201);
    expect(await pushed('MG-001')).toEqual({ amazon: 99, ebay: 99, etsy: 99, shopify: 99, walmart: 99 });

    await order(a, c.ebay.id, 'MG-001', 3).expect(201);
    expect(await pushed('MG-001')).toEqual({ amazon: 96, ebay: 96, etsy: 96, shopify: 96, walmart: 96 });
    expect(await level('MG-001')).toEqual({ on_hand: 100, reserved: 4 });

    const log = (await a.get('/activity?pageSize=50').expect(200)).body.map((x: any) => x.message);
    expect(log.some((m: string) => /New order received from Amazon/.test(m))).toBe(true);
    expect(log.some((m: string) => /Inventory deducted by 1 unit/.test(m))).toBe(true);
    expect(log.some((m: string) => /Shopify \(mock\) inventory updated successfully/.test(m))).toBe(true);
  });

  it('safety buffer: 100 on hand with a 5-unit buffer advertises 95', async () => {
    const a = await owner();
    await a.patch('/settings', { safetyBuffer: { mode: 'units', value: 5 } }).expect(200);
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    expect(Object.values(await pushed('MG-001'))).toEqual([95, 95, 95, 95, 95]);
  });

  it('never oversells: 10 simultaneous orders for the last unit across marketplaces → exactly 1 succeeds', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c, 'LAST-1', 1);
    const conns = Object.values(c) as any[];
    await Promise.all(Array.from({ length: 10 }, (_, i) => order(a, conns[i % 5].id, 'LAST-1', 1, `race-${i}`)));
    const items = (await pool.query(`SELECT stock_state, count(*)::int n FROM order_items WHERE sku='LAST-1' GROUP BY 1`)).rows;
    expect(items.find((r) => r.stock_state === 'reserved')?.n).toBe(1);
    expect(items.find((r) => r.stock_state === 'short')?.n).toBe(9);
    expect(await level('LAST-1')).toEqual({ on_hand: 1, reserved: 1 });
    expect(Object.values(await pushed('LAST-1')).every((q) => q === 0)).toBe(true);
    const conflicts = (await pool.query(`SELECT count(*)::int n FROM notifications WHERE type='stock_conflict'`)).rows[0].n;
    expect(conflicts).toBe(9);
  });

  it('100 concurrent single-unit orders against 100 units all succeed and land at exactly 0', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c, 'BULK-100', 100);
    const conns = Object.values(c) as any[];
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => order(a, conns[i % 5].id, 'BULK-100', 1, `o-${i}`)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await level('BULK-100')).toEqual({ on_hand: 100, reserved: 100 });
  });

  it('deduplicates the same marketplace order arriving twice (webhook + poll) — deducts once', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    await Promise.all([order(a, c.amazon.id, 'MG-001', 2, 'DUP-1'), order(a, c.amazon.id, 'MG-001', 2, 'DUP-1'), order(a, c.amazon.id, 'MG-001', 2, 'DUP-1')]);
    expect((await pool.query(`SELECT count(*)::int n FROM orders WHERE external_order_id='DUP-1'`)).rows[0].n).toBe(1);
    expect(await level('MG-001')).toEqual({ on_hand: 100, reserved: 2 });
  });

  it('cancellation releases reserved stock; tracking upload fulfils and consumes stock', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    await order(a, c.etsy.id, 'MG-001', 5, 'E-1').expect(201);
    expect(await level('MG-001')).toEqual({ on_hand: 100, reserved: 5 });
    await a.post(`/marketplaces/connections/${c.etsy.id}/mock-order`, { items: [{ sku: 'MG-001', quantity: 5 }], externalOrderId: 'E-1', cancelled: true }).expect(201);
    expect(await level('MG-001')).toEqual({ on_hand: 100, reserved: 0 });
    expect(Object.values(await pushed('MG-001')).every((q) => q === 100)).toBe(true);

    const o = (await order(a, c.shopify.id, 'MG-001', 2, 'S-1').expect(201)).body;
    await a.post(`/orders/${o.orderId}/tracking`, { carrier: 'Royal Mail', trackingNumber: 'RM123456789GB' }).expect(201);
    expect(await level('MG-001')).toEqual({ on_hand: 98, reserved: 0 });
    const d = (await a.get(`/orders/${o.orderId}`).expect(200)).body;
    expect(d.fulfillment_status).toBe('fulfilled');
    expect(d.shipping.sellerPortalUrl).toContain('mock-shopify');
  });

  it('manual adjustments cannot go below reserved stock, and are recorded in history', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    const { product } = await publishedEverywhere(a, c);
    await order(a, c.amazon.id, 'MG-001', 10).expect(201);
    const vid = product.variants[0].id;
    await a.post('/inventory/adjust', { variantId: vid, set: 5 }).expect(400);
    await a.post('/inventory/adjust', { variantId: vid, delta: 20, note: 'restock' }).expect(201);
    expect(await level('MG-001')).toEqual({ on_hand: 120, reserved: 10 });
    expect(Object.values(await pushed('MG-001')).every((q) => q === 110)).toBe(true);
    const h = (await a.get(`/inventory/${vid}/history`).expect(200)).body;
    expect(h.map((x: any) => x.reason)).toEqual(expect.arrayContaining(['manual_adjustment', 'order_reserved', 'initial']));
  });

  it('bundles: stock is derived from components and orders reserve the components', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    const comp = (await a.post('/products', { type: 'simple', title: 'Battery', variants: [{ sku: 'BAT', price: 2, initialStock: 5 }] }).expect(201)).body;
    const bundle = (await a.post('/products', { type: 'bundle', title: 'Gun + 2 batteries', variants: [{ sku: 'KIT', price: 25, components: [{ variantId: comp.variants[0].id, quantity: 2 }] }] }).expect(201)).body;
    expect(bundle.variants[0].stock.available).toBe(2);
    await a.post(`/products/${bundle.id}/publish`, { connectionIds: [c.shopify.id] }).expect(201);
    await a.post(`/products/${comp.id}/publish`, { connectionIds: [c.shopify.id] }).expect(201);
    await order(a, c.shopify.id, 'KIT', 1).expect(201);
    expect(await level('BAT')).toEqual({ on_hand: 5, reserved: 2 });
    expect(await pushed('KIT')).toEqual({ shopify: 1 });
    expect(await pushed('BAT')).toEqual({ shopify: 3 });
  });

  it('a failing marketplace is isolated: others still sync, failure is logged and notified', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    await a.patch(`/marketplaces/connections/${c.walmart.id}`, { mockFailInventory: true }).expect(200);
    await order(a, c.amazon.id, 'MG-001', 1).expect(201);
    const p = await pushed('MG-001');
    expect(p.walmart).toBe(100);
    expect(p.ebay).toBe(99);
    const n = (await a.get('/notifications').expect(200)).body;
    expect(n.some((x: any) => x.type === 'sync_failed' && /Walmart/.test(x.title))).toBe(true);
    const logs = (await a.get('/inventory/sync-logs?status=failed').expect(200)).body;
    expect(logs[0].marketplace).toBe('walmart');
  });
});
