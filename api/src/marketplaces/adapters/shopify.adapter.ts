import * as crypto from 'crypto';
import { config } from '../../common/config';
import { timingSafeEqualStr } from '../../common/crypto';
import { apiFetch } from '../http';
import {
  Capabilities, Connection, EffectiveListing, ImportedListing, MarketplaceAdapter, MarketplaceApiError,
  NormalizedOrder, PublishResult, WebhookResult,
} from '../types';
import { validateFor } from '../validation';

/**
 * Shopify — LIVE adapter using the Admin GraphQL API.
 * Pinned to Admin API 2026-04 (verified against Shopify's schema, Nov 2026).
 * Shopify marked REST Admin as legacy (Oct 2024); new public apps must be GraphQL-only since April 2025.
 * Order webhooks: orders/create, orders/updated, orders/cancelled (HMAC-SHA256 of the raw body, base64).
 */
const gidNum = (gid: string) => gid.split('/').pop()!;

export class ShopifyAdapter implements MarketplaceAdapter {
  code = 'shopify' as const;
  displayName = 'Shopify';
  capabilities: Capabilities = {
    implementation: 'live',
    auth: 'oauth2',
    orderDetection: 'Webhooks (orders/create, orders/updated, orders/cancelled) + scheduled polling backup',
    webhooks: true,
    labelPurchase: false,
    trackingUpload: true,
    pauseListing: 'native',
    multipleAccounts: true,
    approval: 'Create an app in the Shopify Partner Dashboard (or a custom app per store). Public apps reading customer names/addresses need Protected Customer Data approval.',
    docs: 'https://shopify.dev/docs/api/admin-graphql',
    notes: [
      'Shipping labels are bought inside Shopify Admin (Shopify Shipping); there is no public API to purchase them, so we link out.',
      'Pause = set product status to DRAFT; End = ARCHIVED.',
    ],
  };

  validateListing(l: EffectiveListing, c: Connection) { return validateFor('shopify', l, c); }

  // ── OAuth ──
  getAuthorizeUrl({ state, shop, redirectUri }: { state: string; shop?: string; redirectUri: string }) {
    if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('A valid *.myshopify.com shop domain is required');
    const p = new URLSearchParams({ client_id: config.shopify.clientId, scope: config.shopify.scopes, redirect_uri: redirectUri, state });
    return `https://${shop}/admin/oauth/authorize?${p}`;
  }

  /** Verifies Shopify's callback HMAC (query string signed with the app secret) before exchanging the code. */
  static verifyCallbackHmac(query: Record<string, string>, secret = config.shopify.clientSecret): boolean {
    const { hmac, signature, ...rest } = query;
    if (!hmac) return false;
    const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
    const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
    return timingSafeEqualStr(digest, hmac);
  }

  async exchangeCode(params: Record<string, string>) {
    if (!ShopifyAdapter.verifyCallbackHmac(params)) throw new Error('Shopify callback HMAC verification failed');
    const shop = params.shop;
    const tok = await apiFetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, label: 'Shopify OAuth',
      body: JSON.stringify({ client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret, code: params.code }),
    });
    const credentials = { shop, accessToken: tok.access_token, scope: tok.scope };
    return { credentials, accountName: shop, externalAccountId: shop, expiresAt: null };
  }

  // ── GraphQL helper ──
  private async gql(conn: Connection, query: string, variables: any = {}) {
    const { shop, accessToken } = conn.credentials ?? {};
    if (!shop || !accessToken) throw new MarketplaceApiError('Shopify connection has no access token — reconnect', 401);
    const res = await apiFetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
      method: 'POST', label: 'Shopify',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (res.errors?.length) {
      const throttled = res.errors.some((e: any) => e.extensions?.code === 'THROTTLED');
      throw new MarketplaceApiError(`Shopify GraphQL: ${res.errors.map((e: any) => e.message).join('; ')}`, throttled ? 429 : 400, throttled ? 2000 : undefined);
    }
    return res.data;
  }

  private assertNoUserErrors(payload: any, op: string) {
    const errs = payload?.userErrors ?? [];
    if (errs.length) throw new MarketplaceApiError(`Shopify ${op}: ${errs.map((e: any) => `${(e.field ?? []).join('.')} ${e.message}`).join('; ')}`, 422, undefined, errs);
  }

  async locationId(conn: Connection): Promise<string> {
    if (conn.settings.locationId) return conn.settings.locationId;
    const d = await this.gql(conn, `query { locations(first: 1) { nodes { id } } }`);
    const id = d.locations.nodes[0]?.id;
    if (!id) throw new MarketplaceApiError('Shopify store has no location', 422);
    return id;
  }

  private productSetInput(l: EffectiveListing, locationId: string) {
    const optionNames = l.productType === 'variable'
      ? Array.from(new Set(l.variants.flatMap((v) => Object.keys(v.options))))
      : ['Title'];
    const productOptions = optionNames.map((name) => ({
      name,
      values: Array.from(new Set(l.variants.map((v) => (l.productType === 'variable' ? v.options[name] : 'Default Title')))).map((n) => ({ name: n })),
    }));
    return {
      title: l.title,
      descriptionHtml: l.description,
      vendor: l.brand ?? undefined,
      productType: l.category ?? undefined,
      status: 'ACTIVE',
      productOptions,
      files: l.images.map((i) => ({ originalSource: i.url, alt: i.alt ?? l.title, contentType: 'IMAGE' })),
      variants: l.variants.map((v) => ({
        optionValues: optionNames.map((optionName) => ({ optionName, name: l.productType === 'variable' ? v.options[optionName] : 'Default Title' })),
        price: v.price.toFixed(2),
        sku: v.sku,
        ...(v.barcode ? { barcodes: [{ value: v.barcode }] } : {}),
        inventoryItem: {
          tracked: true,
          ...(v.weightGrams ? { measurement: { weight: { value: v.weightGrams, unit: 'GRAMS' } } } : {}),
        },
        inventoryQuantities: [{ locationId, name: 'available', quantity: v.quantity }],
      })),
    };
  }

  async publishListing(conn: Connection, l: EffectiveListing): Promise<PublishResult> {
    const locationId = await this.locationId(conn);
    const d = await this.gql(conn, `
      mutation PublishProduct($input: ProductSetInput!) {
        productSet(synchronous: true, input: $input) {
          product { id handle onlineStoreUrl variants(first: 100) { nodes { id sku inventoryItem { id } } } }
          userErrors { field message code }
        }
      }`, { input: this.productSetInput(l, locationId) });
    this.assertNoUserErrors(d.productSet, 'productSet');
    const p = d.productSet.product;
    const refs: Record<string, string> = {};
    for (const v of l.variants) {
      const node = p.variants.nodes.find((n: any) => n.sku === v.sku);
      if (node) refs[v.variantId] = `${node.id}|${node.inventoryItem.id}`;
    }
    return { externalId: p.id, url: p.onlineStoreUrl ?? `https://${conn.credentials!.shop}/admin/products/${gidNum(p.id)}`, variantRefs: refs };
  }

  async updateListing(conn: Connection, l: EffectiveListing) {
    const locationId = await this.locationId(conn);
    const input = this.productSetInput(l, locationId);
    delete (input as any).status;
    // productSet treats `variants` as a full list: entries without an id are created, missing ones deleted.
    // So pass each existing variant's id, and never overwrite live stock from a content update
    // (stock is pushed separately via inventorySetQuantities).
    input.variants.forEach((v: any, i: number) => {
      delete v.inventoryQuantities;
      const ref = l.variants[i].externalRef;
      if (ref) v.id = ref.split('|')[0];
    });
    const d = await this.gql(conn, `
      mutation UpdateProduct($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
        productSet(synchronous: true, identifier: $identifier, input: $input) { product { id } userErrors { field message code } }
      }`, { identifier: { id: l.externalId }, input });
    this.assertNoUserErrors(d.productSet, 'productSet(update)');
  }

  async setListingStatus(conn: Connection, l: EffectiveListing, status: 'active' | 'paused' | 'ended') {
    const map = { active: 'ACTIVE', paused: 'DRAFT', ended: 'ARCHIVED' } as const;
    const d = await this.gql(conn, `
      mutation SetStatus($product: ProductUpdateInput!) {
        productUpdate(product: $product) { product { id status } userErrors { field message } }
      }`, { product: { id: l.externalId, status: map[status] } });
    this.assertNoUserErrors(d.productUpdate, 'productUpdate');
  }

  async pushInventory(conn: Connection, items: { sku: string; externalRef: string | null; quantity: number }[]) {
    const locationId = await this.locationId(conn);
    const quantities = items.filter((i) => i.externalRef).map((i) => ({
      inventoryItemId: i.externalRef!.split('|')[1], locationId, quantity: i.quantity,
      // We are the source of truth for stock, so we opt out of compare-and-swap explicitly.
      // (API 2026-04 requires changeFromQuantity on every entry; null = skip the check.)
      changeFromQuantity: null,
    }));
    if (!quantities.length) return;
    // Absolute "set" (not adjust) → idempotent; safe to retry.
    const d = await this.gql(conn, `
      mutation SetQty($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message code } }
      }`, { input: { name: 'available', reason: 'correction', quantities } });
    this.assertNoUserErrors(d.inventorySetQuantities, 'inventorySetQuantities');
  }

  async pushPrices(conn: Connection, items: { externalRef: string | null; price: number; listingExternalId: string | null }[]) {
    const byProduct = new Map<string, { id: string; price: string }[]>();
    for (const i of items) {
      if (!i.externalRef || !i.listingExternalId) continue;
      const arr = byProduct.get(i.listingExternalId) ?? [];
      arr.push({ id: i.externalRef.split('|')[0], price: i.price.toFixed(2) });
      byProduct.set(i.listingExternalId, arr);
    }
    for (const [productId, variants] of byProduct) {
      const d = await this.gql(conn, `
        mutation Prices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { field message } }
        }`, { productId, variants });
      this.assertNoUserErrors(d.productVariantsBulkUpdate, 'productVariantsBulkUpdate');
    }
  }

  // ── Orders ──
  private static ORDER_FIELDS = `
    id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus email currencyCode
    customer { firstName lastName }
    shippingAddress { name address1 address2 city province zip country countryCodeV2 phone }
    shippingLine { title carrierIdentifier }
    subtotalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }
    totalTaxSet { shopMoney { amount } } totalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
    lineItems(first: 100) { nodes { id sku title quantity originalUnitPriceSet { shopMoney { amount } } } }
    fulfillments(first: 5) { trackingInfo { company number } }`;

  normalizeGraphqlOrder(o: any): NormalizedOrder {
    const amt = (s: any) => Number(s?.shopMoney?.amount ?? 0);
    const track = o.fulfillments?.[0]?.trackingInfo?.[0];
    const fin = String(o.displayFinancialStatus ?? '').toLowerCase();
    return {
      externalOrderId: gidNum(o.id),
      orderDate: o.createdAt,
      customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || o.shippingAddress?.name || null,
      customerEmail: o.email ?? null,
      shipAddress: o.shippingAddress ?? null,
      marketplaceStatus: `${o.displayFinancialStatus}/${o.displayFulfillmentStatus}`,
      paymentStatus: fin === 'paid' ? 'paid' : fin === 'refunded' ? 'refunded' : fin === 'partially_refunded' ? 'partially_refunded' : 'pending',
      cancelled: !!o.cancelledAt,
      fulfilled: o.displayFulfillmentStatus === 'FULFILLED',
      currency: o.currencyCode,
      subtotal: amt(o.subtotalPriceSet), shippingCost: amt(o.totalShippingPriceSet), tax: amt(o.totalTaxSet),
      fees: null, refunds: amt(o.totalRefundedSet), total: amt(o.totalPriceSet),
      shippingMethod: o.shippingLine?.title ?? null, carrier: track?.company ?? null, trackingNumber: track?.number ?? null,
      items: o.lineItems.nodes.map((li: any) => ({
        externalLineId: gidNum(li.id), sku: li.sku, title: li.title, quantity: li.quantity, unitPrice: amt(li.originalUnitPriceSet),
      })),
      raw: o,
    };
  }

  /** Webhook payloads use the REST order shape. */
  normalizeRestOrder(o: any): NormalizedOrder {
    const n = (v: any) => Number(v ?? 0);
    const fin = String(o.financial_status ?? '');
    return {
      externalOrderId: String(o.id),
      orderDate: o.created_at,
      customerName: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || o.shipping_address?.name || null,
      customerEmail: o.email ?? o.contact_email ?? null,
      shipAddress: o.shipping_address ?? null,
      marketplaceStatus: `${o.financial_status}/${o.fulfillment_status ?? 'unfulfilled'}`,
      paymentStatus: fin === 'paid' ? 'paid' : fin === 'refunded' ? 'refunded' : fin === 'partially_refunded' ? 'partially_refunded' : 'pending',
      cancelled: !!o.cancelled_at,
      fulfilled: o.fulfillment_status === 'fulfilled',
      currency: o.currency,
      subtotal: n(o.subtotal_price), shippingCost: n(o.total_shipping_price_set?.shop_money?.amount), tax: n(o.total_tax),
      fees: null, refunds: 0, total: n(o.total_price),
      shippingMethod: o.shipping_lines?.[0]?.title ?? null, carrier: null, trackingNumber: null,
      items: (o.line_items ?? []).map((li: any) => ({
        externalLineId: String(li.id), sku: li.sku || null, title: li.title, quantity: li.quantity, unitPrice: n(li.price),
      })),
      raw: o,
    };
  }

  async fetchOrders(conn: Connection, since: Date): Promise<NormalizedOrder[]> {
    const out: NormalizedOrder[] = [];
    let after: string | null = null;
    do {
      const d: any = await this.gql(conn, `
        query Orders($q: String!, $after: String) {
          orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
            nodes { ${ShopifyAdapter.ORDER_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`, { q: `updated_at:>'${since.toISOString()}'`, after });
      out.push(...d.orders.nodes.map((o: any) => this.normalizeGraphqlOrder(o)));
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async addTracking(conn: Connection, order: { external_order_id: string }, t: { carrier: string; trackingNumber: string }) {
    const d = await this.gql(conn, `
      query FO($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
      { id: `gid://shopify/Order/${order.external_order_id}` });
    const open = d.order.fulfillmentOrders.nodes.filter((f: any) => ['OPEN', 'IN_PROGRESS'].includes(f.status));
    if (!open.length) throw new MarketplaceApiError('No open fulfillment orders on this Shopify order', 422);
    const r = await this.gql(conn, `
      mutation Fulfill($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } }
      }`, {
      fulfillment: {
        lineItemsByFulfillmentOrder: open.map((f: any) => ({ fulfillmentOrderId: f.id })),
        trackingInfo: { company: t.carrier, number: t.trackingNumber },
        notifyCustomer: true,
      },
    });
    this.assertNoUserErrors(r.fulfillmentCreate, 'fulfillmentCreate');
  }

  sellerPortalOrderUrl(conn: Connection, id: string) {
    return `https://${conn.credentials?.shop ?? conn.account_name}/admin/orders/${id}`;
  }

  // ── Webhooks ──
  async verifyWebhook(_conn: Connection | null, headers: Record<string, any>, rawBody: Buffer) {
    const sig = headers['x-shopify-hmac-sha256'];
    if (!sig || !config.shopify.clientSecret) return false;
    const digest = crypto.createHmac('sha256', config.shopify.clientSecret).update(rawBody).digest('base64');
    return timingSafeEqualStr(digest, String(sig));
  }

  async parseWebhook(_conn: Connection, headers: Record<string, any>, body: any): Promise<WebhookResult> {
    const topic = String(headers['x-shopify-topic'] ?? '');
    const eventId = String(headers['x-shopify-event-id'] ?? headers['x-shopify-webhook-id'] ?? '');
    const orders = topic.startsWith('orders/') ? [this.normalizeRestOrder(body)] : [];
    return { eventId, topic, orders };
  }

  /** Registers order webhooks after OAuth. */
  async registerWebhooks(conn: Connection, callbackUrl: string) {
    for (const topic of ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'APP_UNINSTALLED']) {
      const d = await this.gql(conn, `
        mutation Sub($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
        }`, { topic, sub: { uri: callbackUrl, format: 'JSON' } });
      const errs = d.webhookSubscriptionCreate.userErrors;
      if (errs.length && !errs.some((e: any) => /taken|already/i.test(e.message))) this.assertNoUserErrors(d.webhookSubscriptionCreate, 'webhookSubscriptionCreate');
    }
  }

  async fetchListings(conn: Connection): Promise<ImportedListing[]> {
    const out: ImportedListing[] = [];
    let after: string | null = null;
    do {
      const d: any = await this.gql(conn, `
        query Products($after: String) {
          products(first: 50, after: $after) {
            nodes { id title featuredMedia { preview { image { url } } }
              variants(first: 100) { nodes { id sku barcodes(first: 1) { nodes { value } } price inventoryQuantity inventoryItem { id } } } }
            pageInfo { hasNextPage endCursor }
          }
        }`, { after });
      for (const p of d.products.nodes) {
        for (const v of p.variants.nodes) {
          out.push({
            externalId: p.id, externalVariantRef: `${v.id}|${v.inventoryItem.id}`, sku: v.sku || null, barcode: v.barcodes?.nodes?.[0]?.value || null,
            title: p.title, price: Number(v.price), quantity: v.inventoryQuantity, imageUrl: p.featuredMedia?.preview?.image?.url ?? null, raw: { product: p.id, variant: v },
          });
        }
      }
      after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    } while (after);
    return out;
  }
}
