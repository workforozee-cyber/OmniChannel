import * as crypto from 'crypto';
import { pool } from '../src/common/db';
import { decryptJson, encryptJson } from '../src/common/crypto';
import { EtsyAdapter } from '../src/marketplaces/adapters/framework.adapters';
import { ShopifyAdapter } from '../src/marketplaces/adapters/shopify.adapter';
import { resolvePrice } from '../src/pricing/pricing.service';
import { boot, connectAllMock, fullProduct, http, owner, publishedEverywhere, reset, shutdown } from './helpers';

beforeAll(boot);
afterAll(shutdown);
beforeEach(reset);

describe('Publishing (spec section 2)', () => {
  it('publishes per channel and reports missing fields instead of failing everything', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    const p = (await a.post('/products', { type: 'simple', title: 'Electric Money Gun', description: 'x', variants: [{ sku: 'MG-1', price: 20, initialStock: 10 }] }).expect(201)).body;
    const r = (await a.post(`/products/${p.id}/publish`, { connectionIds: Object.values(c).map((x: any) => x.id) }).expect(201)).body.results;
    const by = Object.fromEntries(r.map((x: any) => [x.marketplace, x]));
    expect(by.shopify.status).toBe('published');
    for (const m of ['ebay', 'amazon', 'etsy', 'walmart']) expect(by[m].status).toBe('validation_required');
    expect(by.ebay.missingFields.map((f: any) => f.field)).toEqual(expect.arrayContaining(['attributes.ebay.categoryId', 'images']));
    expect(by.amazon.missingFields.map((f: any) => f.field)).toEqual(expect.arrayContaining(['brand', 'barcode']));
    expect(by.etsy.missingFields.map((f: any) => f.field)).toEqual(expect.arrayContaining(['attributes.etsy.whoMade']));
  });

  it('a complete product publishes to all five; external IDs are clearly MOCK', async () => {
    const a = await owner();
    const { publish } = await publishedEverywhere(a, await connectAllMock(a));
    expect(publish.results.map((r: any) => r.status)).toEqual(['published', 'published', 'published', 'published', 'published']);
    const ids = (await pool.query('SELECT external_id FROM listings')).rows.map((r) => r.external_id);
    expect(ids.every((id) => id.startsWith('MOCK-'))).toBe(true);
  });

  it('channel overrides survive master edits; sync-from-master restores them on request', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    const { product } = await publishedEverywhere(a, c);
    const ebayListing = (await a.get('/listings?marketplace=ebay').expect(200)).body.rows[0];
    await a.patch(`/listings/${ebayListing.id}`, { overrides: { title: 'Money Gun – eBay special' } }).expect(200);
    const full = (await a.get(`/products/${product.id}`)).body;
    await a.put(`/products/${product.id}`, { ...fullProduct(), title: 'Money Gun v2', variants: [{ ...fullProduct().variants[0], id: full.variants[0].id }] }).expect(200);
    expect((await a.get(`/listings/${ebayListing.id}/preview`)).body.title).toBe('Money Gun – eBay special');
    const shop = (await a.get('/listings?marketplace=shopify')).body.rows[0];
    expect((await a.get(`/listings/${shop.id}/preview`)).body.title).toBe('Money Gun v2');
    await a.post(`/listings/${ebayListing.id}/sync-from-master`, { fields: ['title'] }).expect(201);
    expect((await a.get(`/listings/${ebayListing.id}/preview`)).body.title).toBe('Money Gun v2');
  });

  it('pause / activate / end listing transitions', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    const ids = (await a.get('/listings')).body.rows.map((l: any) => l.id);
    await a.post('/listings/bulk/status', { listingIds: ids.slice(0, 2), action: 'pause' }).expect(201);
    expect((await a.get('/listings?status=paused')).body.total).toBe(2);
    await a.post('/listings/bulk/status', { listingIds: ids.slice(0, 1), action: 'end' }).expect(201);
    const r = (await a.post('/listings/bulk/status', { listingIds: ids.slice(0, 1), action: 'activate' }).expect(201)).body;
    expect(r[0].ok).toBe(false);
  });
});

describe('Pricing (spec section 6)', () => {
  it('master change only updates channels that follow master; rules and min/max apply', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    const { product } = await publishedEverywhere(a, c);
    await a.put(`/pricing/rules/${c.ebay.id}`, { kind: 'percent', value: 10 }).expect(200);
    const amazon = (await a.get('/listings?marketplace=amazon')).body.rows[0];
    await a.patch(`/listings/${amazon.id}`, { priceOverride: 24, syncPriceWithMaster: false }).expect(200);
    const vid = product.variants[0].id;
    await a.post('/pricing/bulk', { variantIds: [vid], op: 'increase', value: 2 }).expect(201);
    const prices = (await pool.query(`SELECT c.marketplace, lv.last_pushed_price p FROM listing_variants lv JOIN listings l ON l.id=lv.listing_id JOIN marketplace_connections c ON c.id=l.connection_id`)).rows
      .reduce((o: any, r) => ({ ...o, [r.marketplace]: r.p }), {});
    expect(prices).toEqual({ amazon: 24, ebay: 24.2, etsy: 22, shopify: 22, walmart: 22 });
    const h = (await a.get(`/pricing/${vid}/history`)).body;
    expect(h.some((x: any) => x.reason === 'bulk_increase' && x.new_price === 22)).toBe(true);
  });

  it('min/max price protection clamps', () => {
    const v = { id: 'v', price: 20, min_price: 18, max_price: 21 };
    expect(resolvePrice(v, { sync_price_with_master: true, overrides: {} }, { active: true, kind: 'percent', value: 50 })).toBe(21);
    expect(resolvePrice(v, { sync_price_with_master: true, overrides: {} }, { active: true, kind: 'fixed', value: -10 })).toBe(18);
  });
});

describe('Security', () => {
  it('credentials are AES-GCM encrypted at rest and tamper-evident', () => {
    const env = encryptJson({ accessToken: 'secret-token' });
    expect(env).not.toContain('secret-token');
    expect(decryptJson(env)).toEqual({ accessToken: 'secret-token' });
    const parts = env.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptJson(parts.join('.'))).toThrow();
  });

  it('API never returns credentials or webhook secrets', async () => {
    const a = await owner();
    await a.post('/marketplaces/connections/walmart/credentials', { accountName: 'WM', clientId: 'id', clientSecret: 'super-secret' }).expect(201);
    await connectAllMock(a);
    const body = JSON.stringify((await a.get('/marketplaces/connections').expect(200)).body);
    expect(body).not.toContain('super-secret');
    expect(body).not.toContain('credentials_enc');
    expect(body).not.toMatch(/mockWebhookSecret":"(?!••••)/);
  });

  it('RBAC: viewers can read but not write; unauthenticated requests are rejected', async () => {
    const a = await owner();
    await a.post('/auth/users', { name: 'V', email: 'viewer@test.dev', password: 'viewer-password-1', role: 'viewer' }).expect(201);
    const t = (await http().post('/api/auth/login').send({ email: 'viewer@test.dev', password: 'viewer-password-1' }).expect(201)).body.token;
    await http().get('/api/products').set('Authorization', `Bearer ${t}`).expect(200);
    await http().post('/api/products').set('Authorization', `Bearer ${t}`).send(fullProduct()).expect(403);
    await http().get('/api/products').expect(401);
  });

  it('tenants are isolated', async () => {
    const a = await owner(); const b = await owner();
    const p = (await a.post('/products', fullProduct()).expect(201)).body;
    await b.get(`/products/${p.id}`).expect(404);
    expect((await b.get('/products')).body.total).toBe(0);
  });

  it('webhooks: rejects bad signatures, accepts valid ones, de-duplicates replays', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    const secret = (await pool.query(`SELECT settings->>'mockWebhookSecret' s FROM marketplace_connections WHERE id=$1`, [c.shopify.id])).rows[0].s;
    const body = JSON.stringify({ id: 'evt1', order: {
      externalOrderId: 'WH-1', orderDate: new Date().toISOString(), customerName: 'A', customerEmail: null, shipAddress: null, marketplaceStatus: 'paid',
      paymentStatus: 'paid', cancelled: false, fulfilled: false, currency: 'GBP', subtotal: 20, shippingCost: 0, tax: 0, fees: null, refunds: 0, total: 20,
      shippingMethod: null, carrier: null, trackingNumber: null, items: [{ externalLineId: '1', sku: 'MG-001', title: 'x', quantity: 1, unitPrice: 20 }], raw: {} } });
    const url = `/api/webhooks/shopify/${c.shopify.id}`;
    await http().post(url).set('Content-Type', 'application/json').set('x-mock-signature', 'bad').set('x-mock-event-id', 'evt1').send(body).expect(401);
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    await http().post(url).set('Content-Type', 'application/json').set('x-mock-signature', sig).set('x-mock-event-id', 'evt1').send(body).expect(200);
    const dup = await http().post(url).set('Content-Type', 'application/json').set('x-mock-signature', sig).set('x-mock-event-id', 'evt1').send(body).expect(200);
    expect(dup.body.duplicate).toBe(true);
    expect((await pool.query(`SELECT count(*)::int n FROM orders WHERE external_order_id='WH-1'`)).rows[0].n).toBe(1);
  });

  it('Shopify webhook + OAuth callback HMAC verification', async () => {
    const s = new ShopifyAdapter();
    const raw = Buffer.from('{"id":1}');
    const good = crypto.createHmac('sha256', 'shpss_test_secret').update(raw).digest('base64');
    expect(await s.verifyWebhook(null, { 'x-shopify-hmac-sha256': good }, raw)).toBe(true);
    expect(await s.verifyWebhook(null, { 'x-shopify-hmac-sha256': good }, Buffer.from('{"id":2}'))).toBe(false);
    const qs: Record<string, string> = { code: 'abc', shop: 'test.myshopify.com', state: 'xyz', timestamp: '1' };
    qs.hmac = crypto.createHmac('sha256', 'shpss_test_secret').update('code=abc&shop=test.myshopify.com&state=xyz&timestamp=1').digest('hex');
    expect(ShopifyAdapter.verifyCallbackHmac(qs, 'shpss_test_secret')).toBe(true);
    expect(ShopifyAdapter.verifyCallbackHmac({ ...qs, shop: 'evil.myshopify.com' }, 'shpss_test_secret')).toBe(false);
  });

  it('Etsy Standard Webhooks signature + replay window', () => {
    const secret = process.env.ETSY_WEBHOOK_SECRET!;
    const key = Buffer.from(secret.slice(6), 'base64');
    const raw = Buffer.from('{"event_type":"order.paid"}');
    const now = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', key).update(`msg_1.${now}.${raw}`).digest('base64');
    const h = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(now), 'webhook-signature': `v1,${sig}` };
    expect(EtsyAdapter.verifyStandardWebhook(h, raw, secret, now)).toBe(true);
    expect(EtsyAdapter.verifyStandardWebhook(h, raw, secret, now + 600)).toBe(false);
    expect(EtsyAdapter.verifyStandardWebhook({ ...h, 'webhook-signature': 'v1,AAAA' }, raw, secret, now)).toBe(false);
  });

  it('framework adapters refuse live calls instead of pretending to work', async () => {
    const { AmazonAdapter } = await import('../src/marketplaces/adapters/framework.adapters');
    await expect(new AmazonAdapter().pushInventory()).rejects.toThrow(/no live implementation/);
  });
});

describe('Bulk import / export (spec section 8)', () => {
  it('previews with validation errors, applies only valid rows, round-trips export', async () => {
    const a = await owner();
    await a.post('/products', fullProduct('EXIST-1', 10, 20)).expect(201);
    const csv = [
      'parent_sku,sku,title,price,quantity,color,size,barcode',
      ',EXIST-1,,25,40,,,',
      'TEE,TEE-RED-M,Tee,12,5,Red,M,',
      'TEE,TEE-BLU-M,Tee,12,7,Blue,M,',
      ',BAD SKU,No price,,1,,,123',
    ].join('\n');
    const pv = (await http().post('/api/bulk/products/preview').set('Authorization', `Bearer ${a.token}`).attach('file', Buffer.from(csv), 'p.csv').expect(201)).body;
    expect(pv.summary).toMatchObject({ total: 4, create: 2, update: 1, errors: 1 });
    expect(pv.rows[0].changes).toEqual({ price: [20, 25], quantity: [10, 40] });
    const ap = (await a.post('/bulk/products/apply', { rows: pv.parsed }).expect(201)).body.results;
    expect(ap.filter((r: any) => r.ok).length).toBe(3);
    const tee = (await a.get('/products?search=TEE-RED')).body.rows[0];
    expect(tee.type).toBe('variable');
    expect(tee.variants).toHaveLength(2);
    const exp = await a.get('/bulk/products/export?format=csv').expect(200);
    expect(exp.text).toContain('EXIST-1');
    const x = await a.get('/bulk/products/export?format=xlsx').expect(200);
    expect(Number(x.headers['content-length'])).toBeGreaterThan(1000);
  });
});

describe('Analytics (spec section 9)', () => {
  it('separates gross, refunds, fees and estimated profit; dashboard counts', async () => {
    const a = await owner();
    const c = await connectAllMock(a);
    await publishedEverywhere(a, c);
    await a.post(`/marketplaces/connections/${c.amazon.id}/mock-order`, { items: [{ sku: 'MG-001', quantity: 2 }] }).expect(201);
    await a.post(`/marketplaces/connections/${c.ebay.id}/mock-order`, { items: [{ sku: 'MG-001', quantity: 1 }] }).expect(201);
    const s = (await a.get('/analytics/sales').expect(200)).body;
    expect(s.summary.orders).toBe(2);
    expect(s.summary.gross).toBeCloseTo(40 + 3.99 + 20 + 3.99);
    expect(s.summary.fees).toBeCloseTo(4.8 + 2.4);
    expect(s.summary.cogs).toBe(24);
    expect(s.byMarketplace.map((m: any) => m.marketplace)).toEqual(['amazon', 'ebay']);
    const d = (await a.get('/analytics/dashboard').expect(200)).body;
    expect(d).toMatchObject({ total_orders: 2, active_listings: 5, unfulfilled_orders: 2 });
  });
});
