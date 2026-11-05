/* Demo data: one org, MOCK connections for all five marketplaces, sample catalog and 30 days of mock orders.
   Everything created here is mock — no marketplace is contacted. Login: demo@omnichannel.dev / demo-password-123 */
process.env.JOBS_INLINE = 'true';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import { WorkerModule } from '../src/app.module';
import { CatalogService } from '../src/catalog/catalog.service';
import { one, pool, q } from '../src/common/db';
import { ListingsService } from '../src/listings/listings.service';
import { ConnectionsService } from '../src/marketplaces/connections.service';
import { OrdersService } from '../src/orders/orders.service';
import { PricingService } from '../src/pricing/pricing.service';
import { migrate } from './migrate';

async function main() {
  await migrate(false);
  if (await one(`SELECT 1 FROM users WHERE email='demo@omnichannel.dev'`)) { console.log('Demo data already present.'); return; }
  const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  const catalog = ctx.get(CatalogService), listings = ctx.get(ListingsService), conns = ctx.get(ConnectionsService);
  const orders = ctx.get(OrdersService), pricing = ctx.get(PricingService);

  const org = await one(`INSERT INTO organizations(name,settings) VALUES ('Demo Store','{"safetyBuffer":{"mode":"units","value":0},"lowStockThreshold":5}') RETURNING id`);
  await q(`INSERT INTO warehouses(org_id,name,is_default) VALUES ($1,'Main warehouse',true)`, [org!.id]);
  const user = await one(`INSERT INTO users(org_id,email,name,password_hash,role) VALUES ($1,'demo@omnichannel.dev','Demo Owner',$2,'owner') RETURNING id`, [org!.id, await bcrypt.hash(process.env.DEMO_PASSWORD || 'demo-password-123', 12)]);
  const O = org!.id, U = user!.id;

  const settings: Record<string, any> = {
    ebay: { fulfillmentPolicyId: 'demo', paymentPolicyId: 'demo', returnPolicyId: 'demo', merchantLocationKey: 'main' },
    etsy: { shippingProfileId: 'demo' },
  };
  const c: Record<string, any> = {};
  for (const m of ['ebay', 'amazon', 'etsy', 'walmart', 'shopify'] as const) c[m] = await conns.createMock(O, U, m, `Demo ${m} store`, settings[m] ?? {});
  await pricing.setRule(O, U, c.ebay.id, 'fixed', 2);
  await pricing.setRule(O, U, c.amazon.id, 'fixed', 4);
  await pricing.setRule(O, U, c.etsy.id, 'fixed', 1);
  await pricing.setRule(O, U, c.walmart.id, 'fixed', 3);

  const attrs = (cat: string, tax: number) => ({
    condition: 'NEW', ebay: { categoryId: cat }, amazon: { productType: 'TOY_FIGURE', condition: 'new_new', bulletPoints: ['Great gift'] },
    etsy: { taxonomyId: tax, whoMade: 'someone_else', whenMade: '2020_2026', isSupply: false }, walmart: { productType: 'Toys' },
  });
  const img = (seed: string) => [{ url: `https://picsum.photos/seed/${seed}/600/600` }];
  const products = [
    { title: 'Electric Money Gun', sku: 'MG-001', price: 20, cost: 8, stock: 100, barcode: '012345678905', brand: 'PartyCo', img: 'moneygun' },
    { title: 'LED Party Glasses', sku: 'LED-GL-01', price: 9.5, cost: 2.1, stock: 240, barcode: '012345678912', brand: 'PartyCo', img: 'glasses' },
    { title: 'Confetti Cannon (pack of 4)', sku: 'CONF-4', price: 14, cost: 4.5, stock: 6, barcode: '012345678929', brand: 'PartyCo', img: 'confetti' },
    { title: 'Mini Bubble Machine', sku: 'BUB-MINI', price: 24.99, cost: 11, stock: 0, barcode: '012345678936', brand: 'Bubbly', img: 'bubbles' },
  ];
  const created: any[] = [];
  for (const p of products) {
    created.push(await catalog.create(O, U, {
      type: 'simple', title: p.title, description: `${p.title} — demo product.`, brand: p.brand, manufacturer: p.brand, category: 'Party Supplies',
      tags: ['party'], images: img(p.img), videos: [], attributes: attrs('19169', 1), shipping: { handlingDays: 1 }, status: 'active',
      variants: [{ sku: p.sku, barcode: p.barcode, options: {}, price: p.price, costPrice: p.cost, weightGrams: 350, initialStock: p.stock }],
    } as any));
  }
  // Variable product (with a deliberately missing Walmart barcode on one size → shows "Validation required")
  created.push(await catalog.create(O, U, {
    type: 'variable', title: 'Party Crew T-Shirt', description: 'Soft cotton tee.', brand: 'PartyCo', category: 'Apparel', tags: ['apparel'],
    images: img('tshirt'), videos: [], attributes: attrs('15687', 2), shipping: {}, status: 'active',
    variants: [
      { sku: 'TEE-BLK-M', barcode: '012345678943', options: { color: 'Black', size: 'M' }, price: 15, costPrice: 5, weightGrams: 180, initialStock: 30 },
      { sku: 'TEE-BLK-L', barcode: '012345678950', options: { color: 'Black', size: 'L' }, price: 15, costPrice: 5, weightGrams: 190, initialStock: 25 },
      { sku: 'TEE-WHT-M', barcode: null, options: { color: 'White', size: 'M' }, price: 15, costPrice: 5, weightGrams: 180, initialStock: 4 },
    ],
  } as any));
  // A product that is missing marketplace data, to demonstrate per-channel validation.
  created.push(await catalog.create(O, U, {
    type: 'simple', title: 'Handmade Party Banner', description: '', tags: [], images: [], videos: [], attributes: {}, shipping: {}, status: 'active',
    variants: [{ sku: 'BANNER-01', options: {}, price: 12, costPrice: 3, initialStock: 15 }],
  } as any));

  const all = Object.values(c).map((x: any) => x.id);
  for (const p of created) await listings.publish(O, U, p.id, all);

  // 30 days of mock orders
  const conList = Object.values(c) as any[];
  const conn = await Promise.all(conList.map((x) => conns.load(x.id)));
  const skus = [['MG-001', 20], ['LED-GL-01', 9.5], ['TEE-BLK-M', 15], ['TEE-BLK-L', 15], ['CONF-4', 14]] as const;
  let n = 1000;
  for (let d = 29; d >= 0; d--) {
    const perDay = 1 + ((d * 7) % 4);
    for (let k = 0; k < perDay; k++) {
      const cn = conn[(d + k) % conn.length];
      const [sku, price] = skus[(d + k * 3) % skus.length];
      if (sku === 'CONF-4' && d < 25) continue;
      const qty = 1 + ((d + k) % 3 === 0 ? 1 : 0);
      const date = new Date(Date.now() - d * 86400_000 - k * 3600_000);
      const subtotal = price * qty;
      const done = d > 3;
      await orders.ingest(cn, {
        externalOrderId: `${cn.marketplace.toUpperCase().slice(0, 2)}-${n++}`, orderDate: date.toISOString(),
        customerName: ['Ava Patel', 'Liam Jones', 'Sara Khan', 'Noah Smith', 'Mia Brown', 'Omar Ali'][(d + k) % 6], customerEmail: null,
        shipAddress: { city: 'London', country: 'GB' }, marketplaceStatus: done ? 'SHIPPED' : 'PAID', paymentStatus: 'paid', cancelled: d === 12 && k === 0,
        fulfilled: done, currency: 'GBP', subtotal, shippingCost: 3.99, tax: 0, fees: Math.round(subtotal * 0.12 * 100) / 100,
        refunds: d === 20 && k === 0 ? subtotal : 0, total: subtotal + 3.99, shippingMethod: ['Royal Mail 2nd Class', 'Evri Standard', 'DPD Next Day'][(d + k) % 3],
        carrier: done ? 'Royal Mail' : null, trackingNumber: done ? `RM${100000000 + n}GB` : null,
        items: [{ externalLineId: '1', sku, title: sku, quantity: qty, unitPrice: price }], raw: { mock: true },
      });
    }
  }
  await ctx.close();
  console.log(`Seeded demo data. Login: demo@omnichannel.dev / ${process.env.DEMO_PASSWORD ? '(your DEMO_PASSWORD)' : 'demo-password-123'}`);
}
main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
