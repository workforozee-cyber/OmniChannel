import { EbayAdapter } from './adapters/ebay.adapter';
import { AmazonAdapter, EtsyAdapter, WalmartAdapter } from './adapters/framework.adapters';
import { MockAdapter } from './adapters/mock.adapter';
import { ShopifyAdapter } from './adapters/shopify.adapter';
import { Connection, MarketplaceAdapter, MarketplaceCode } from './types';

/** Single place to register channels. To add one: write an adapter, add it here, add its code to the DB CHECK. */
const live: Record<MarketplaceCode, MarketplaceAdapter> = {
  ebay: new EbayAdapter(),
  amazon: new AmazonAdapter(),
  etsy: new EtsyAdapter(),
  walmart: new WalmartAdapter(),
  shopify: new ShopifyAdapter(),
};
const mocks = Object.fromEntries(
  (Object.keys(live) as MarketplaceCode[]).map((k) => [k, new MockAdapter(k, live[k])]),
) as unknown as Record<MarketplaceCode, MarketplaceAdapter>;

export const MARKETPLACES = Object.keys(live) as MarketplaceCode[];
export const liveAdapter = (code: MarketplaceCode) => live[code];
export const adapterFor = (conn: Pick<Connection, 'marketplace' | 'mode'>) =>
  conn.mode === 'mock' ? mocks[conn.marketplace] : live[conn.marketplace];
