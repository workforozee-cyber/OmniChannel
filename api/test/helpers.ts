import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { pool } from '../src/common/db';
import { createApp } from '../src/main';
import { migrate } from '../scripts/migrate';

export let app: INestApplication;
export const http = () => request(app.getHttpServer());

export async function boot() {
  await migrate(false);
  app = await createApp();
  await app.init();
}
export async function shutdown() { await app.close(); await pool.end(); }

export async function reset() {
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`)).rows.map((r) => r.tablename);
  await pool.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(',')} RESTART IDENTITY CASCADE`);
}

export async function owner(email = `owner${Math.random().toString(36).slice(2, 7)}@test.dev`) {
  const r = await http().post('/api/auth/register').send({ organization: 'Test Co', name: 'Owner', email, password: 'correct-horse-battery' }).expect(201);
  const token = r.body.token as string;
  const api = {
    token,
    get: (u: string) => http().get(`/api${u}`).set('Authorization', `Bearer ${token}`),
    post: (u: string, b?: any) => http().post(`/api${u}`).set('Authorization', `Bearer ${token}`).send(b),
    put: (u: string, b?: any) => http().put(`/api${u}`).set('Authorization', `Bearer ${token}`).send(b),
    patch: (u: string, b?: any) => http().patch(`/api${u}`).set('Authorization', `Bearer ${token}`).send(b),
  };
  return { ...api, orgId: r.body.user.orgId as string, userId: r.body.user.id as string };
}
export type Api = Awaited<ReturnType<typeof owner>>;

export async function connectAllMock(a: Api) {
  const out: Record<string, any> = {};
  for (const m of ['ebay', 'amazon', 'etsy', 'walmart', 'shopify']) {
    out[m] = (await a.post('/marketplaces/connections/mock', {
      marketplace: m, accountName: `${m} store`,
      settings: m === 'ebay' ? { fulfillmentPolicyId: 'f', paymentPolicyId: 'p', returnPolicyId: 'r', merchantLocationKey: 'wh1' } : m === 'etsy' ? { shippingProfileId: '123' } : {},
    }).expect(201)).body;
  }
  return out;
}

/** A product complete enough to pass every marketplace's validation. */
export function fullProduct(sku = 'MG-001', stock = 100, price = 20) {
  return {
    type: 'simple', title: 'Electric Money Gun', description: 'Shoots play money. Party favourite.', brand: 'PartyCo', category: 'Toys',
    images: [{ url: 'https://example.com/mg.jpg' }],
    attributes: {
      condition: 'NEW',
      ebay: { categoryId: '19169' },
      amazon: { productType: 'TOY_FIGURE', condition: 'new_new', bulletPoints: ['Fun'] },
      etsy: { taxonomyId: 1, whoMade: 'someone_else', whenMade: '2020_2026', isSupply: false },
      walmart: { productType: 'Toys' },
    },
    variants: [{ sku, barcode: '012345678905', price, costPrice: 8, weightGrams: 400, initialStock: stock }],
  };
}

export async function publishedEverywhere(a: Api, conns: Record<string, any>, sku = 'MG-001', stock = 100) {
  const p = (await a.post('/products', fullProduct(sku, stock)).expect(201)).body;
  const r = (await a.post(`/products/${p.id}/publish`, { connectionIds: Object.values(conns).map((c: any) => c.id) }).expect(201)).body;
  return { product: p, publish: r };
}

export async function pushed(sku: string) {
  return (await pool.query(
    `SELECT c.marketplace, lv.last_pushed_qty FROM listing_variants lv JOIN variants v ON v.id=lv.variant_id
       JOIN listings l ON l.id=lv.listing_id JOIN marketplace_connections c ON c.id=l.connection_id WHERE v.sku=$1 ORDER BY c.marketplace`, [sku])).rows
    .reduce((o: any, r) => ({ ...o, [r.marketplace]: r.last_pushed_qty }), {});
}

export async function level(sku: string) {
  return (await pool.query(`SELECT il.on_hand, il.reserved FROM inventory_levels il JOIN variants v ON v.id=il.variant_id WHERE v.sku=$1`, [sku])).rows[0];
}
