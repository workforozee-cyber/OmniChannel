import * as crypto from 'crypto';
import { config } from '../../common/config';
import { apiFetch } from '../http';
import {
  Capabilities, Connection, EffectiveListing, ImportedListing, MarketplaceAdapter, MarketplaceApiError,
  NormalizedOrder, PublishResult, WebhookResult,
} from '../types';
import { validateFor } from '../validation';

/**
 * eBay — LIVE adapter using the REST Sell APIs.
 *   Listing:  Sell Inventory API (inventory_item → offer → publishOffer; item groups for variations)
 *   Stock:    bulk_update_price_quantity (≤25 SKUs per call)
 *   Orders:   Sell Fulfillment API getOrders, polled on a schedule. eBay's REST Notification API does not
 *             currently offer a general seller "new order" topic, so polling is the primary path.
 *   Webhooks: Notification API pushes are verified with X-EBAY-SIGNATURE (ECDSA, public key by kid).
 */
const hosts = () => config.ebay.env === 'production'
  ? { api: 'https://api.ebay.com', auth: 'https://auth.ebay.com', site: 'https://www.ebay.com' }
  : { api: 'https://api.sandbox.ebay.com', auth: 'https://auth.sandbox.ebay.com', site: 'https://sandbox.ebay.com' };

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
].join(' ');

export class EbayAdapter implements MarketplaceAdapter {
  code = 'ebay' as const;
  displayName = 'eBay';
  capabilities: Capabilities = {
    implementation: 'live',
    auth: 'oauth2',
    orderDetection: 'Scheduled polling of the Fulfillment API (getOrders by lastmodifieddate)',
    webhooks: true,
    labelPurchase: false,
    trackingUpload: true,
    pauseListing: 'zero_quantity',
    multipleAccounts: true,
    approval: 'eBay Developers Program account + production keyset. Some notification topics are restricted to approved partners. You must also handle Marketplace Account Deletion notifications to keep a production keyset active.',
    docs: 'https://developer.ebay.com/api-docs/sell/inventory/overview.html',
    notes: [
      'Sellers need business policies (payment, return, fulfillment) opted in on their account.',
      'eBay has no "pause"; we pause by setting available quantity to 0 and resume by restoring it.',
      'eBay Labels are bought in Seller Hub; the public Logistics API is limited-release, so we link out.',
    ],
  };

  validateListing(l: EffectiveListing, c: Connection) { return validateFor('ebay', l, c); }

  getAuthorizeUrl({ state }: { state: string }) {
    const p = new URLSearchParams({ client_id: config.ebay.clientId, redirect_uri: config.ebay.ruName, response_type: 'code', scope: SCOPES, state });
    return `${hosts().auth}/oauth2/authorize?${p}`;
  }

  private basic() { return 'Basic ' + Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64'); }

  async exchangeCode(params: Record<string, string>) {
    const tok = await apiFetch(`${hosts().api}/identity/v1/oauth2/token`, {
      method: 'POST', label: 'eBay OAuth',
      headers: { Authorization: this.basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: config.ebay.ruName }),
    });
    const credentials = {
      accessToken: tok.access_token, refreshToken: tok.refresh_token,
      accessExpiresAt: Date.now() + tok.expires_in * 1000,
      refreshExpiresAt: Date.now() + tok.refresh_token_expires_in * 1000,
    };
    // Identify the account so multiple eBay stores can be connected.
    let accountName = 'eBay account';
    try {
      const priv = await apiFetch(`${hosts().api}/sell/account/v1/privilege`, { headers: { Authorization: `Bearer ${tok.access_token}` }, label: 'eBay' });
      accountName = priv?.sellerRegistrationCompleted ? 'eBay seller' : accountName;
    } catch { /* non-fatal */ }
    return { credentials, accountName, expiresAt: new Date(credentials.refreshExpiresAt) };
  }

  async refreshCredentials(conn: Connection) {
    const c = conn.credentials!;
    const tok = await apiFetch(`${hosts().api}/identity/v1/oauth2/token`, {
      method: 'POST', label: 'eBay OAuth refresh',
      headers: { Authorization: this.basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, scope: SCOPES }),
    });
    return {
      credentials: { ...c, accessToken: tok.access_token, accessExpiresAt: Date.now() + tok.expires_in * 1000 },
      expiresAt: new Date(c.refreshExpiresAt),
    };
  }

  private async call(conn: Connection, method: string, path: string, body?: any, extraHeaders: Record<string, string> = {}) {
    if (!conn.credentials?.accessToken) throw new MarketplaceApiError('eBay connection has no token — reconnect', 401);
    // Tokens are refreshed proactively by ConnectionsService.withFreshCredentials before calls.
    return apiFetch(`${hosts().api}${path}`, {
      method, label: 'eBay',
      headers: {
        Authorization: `Bearer ${conn.credentials.accessToken}`,
        'Content-Type': 'application/json', 'Content-Language': conn.settings.contentLanguage ?? 'en-GB',
        'X-EBAY-C-MARKETPLACE-ID': conn.settings.marketplaceId ?? 'EBAY_GB', ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private inventoryItem(l: EffectiveListing, v: EffectiveListing['variants'][0]) {
    const aspects: Record<string, string[]> = { ...(l.attributes.aspects ?? {}) };
    if (l.brand) aspects.Brand = [l.brand];
    for (const [k, val] of Object.entries(v.options)) aspects[k[0].toUpperCase() + k.slice(1)] = [String(val)];
    return {
      availability: { shipToLocationAvailability: { quantity: v.quantity } },
      condition: l.attributes.condition,
      product: {
        title: l.title, description: l.description, aspects,
        imageUrls: l.images.map((i) => i.url).slice(0, 24),
        ...(l.brand ? { brand: l.brand } : {}),
        ...(l.attributes.mpn ? { mpn: l.attributes.mpn } : {}),
        ...(v.barcode ? (v.barcode.length === 13 ? { ean: [v.barcode] } : { upc: [v.barcode] }) : {}),
      },
      ...(v.weightGrams ? { packageWeightAndSize: { weight: { value: v.weightGrams, unit: 'GRAM' } } } : {}),
    };
  }

  private offer(conn: Connection, l: EffectiveListing, v: EffectiveListing['variants'][0]) {
    return {
      sku: v.sku, marketplaceId: conn.settings.marketplaceId ?? 'EBAY_GB', format: 'FIXED_PRICE',
      availableQuantity: v.quantity, categoryId: String(l.attributes.categoryId),
      listingDescription: l.description, merchantLocationKey: conn.settings.merchantLocationKey,
      listingPolicies: {
        fulfillmentPolicyId: conn.settings.fulfillmentPolicyId,
        paymentPolicyId: conn.settings.paymentPolicyId,
        returnPolicyId: conn.settings.returnPolicyId,
      },
      pricingSummary: { price: { value: v.price.toFixed(2), currency: l.currency } },
    };
  }

  /** Create-or-reuse an offer for a SKU (createOffer fails if one exists, so look first). */
  private async upsertOffer(conn: Connection, l: EffectiveListing, v: EffectiveListing['variants'][0]): Promise<string> {
    const existing = await this.call(conn, 'GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(v.sku)}`).catch((e) => {
      if (e instanceof MarketplaceApiError && e.status === 404) return null; throw e;
    });
    const offer = this.offer(conn, l, v);
    const found = existing?.offers?.find((o: any) => o.marketplaceId === offer.marketplaceId);
    if (found) {
      await this.call(conn, 'PUT', `/sell/inventory/v1/offer/${found.offerId}`, offer);
      return found.offerId;
    }
    const created = await this.call(conn, 'POST', '/sell/inventory/v1/offer', offer);
    return created.offerId;
  }

  async publishListing(conn: Connection, l: EffectiveListing): Promise<PublishResult> {
    const refs: Record<string, string> = {};
    for (const v of l.variants) {
      await this.call(conn, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(v.sku)}`, this.inventoryItem(l, v));
      refs[v.variantId] = await this.upsertOffer(conn, l, v);
    }
    let listingId: string;
    if (l.productType === 'variable' && l.variants.length > 1) {
      const groupKey = `grp-${l.productId}`;
      const specs = Array.from(new Set(l.variants.flatMap((v) => Object.keys(v.options))));
      await this.call(conn, 'PUT', `/sell/inventory/v1/inventory_item_group/${groupKey}`, {
        title: l.title, description: l.description, imageUrls: l.images.map((i) => i.url),
        aspects: l.brand ? { Brand: [l.brand] } : {},
        variantSKUs: l.variants.map((v) => v.sku),
        variesBy: {
          aspectsImageVariesBy: [],
          specifications: specs.map((s) => ({
            name: s[0].toUpperCase() + s.slice(1), values: Array.from(new Set(l.variants.map((v) => v.options[s]))),
          })),
        },
      });
      const r = await this.call(conn, 'POST', '/sell/inventory/v1/offer/publish_by_inventory_item_group', {
        inventoryItemGroupKey: groupKey, marketplaceId: conn.settings.marketplaceId ?? 'EBAY_GB',
      });
      listingId = r.listingId;
    } else {
      const r = await this.call(conn, 'POST', `/sell/inventory/v1/offer/${refs[l.variants[0].variantId]}/publish`);
      listingId = r.listingId;
    }
    return { externalId: listingId, url: `${hosts().site}/itm/${listingId}`, variantRefs: refs };
  }

  async updateListing(conn: Connection, l: EffectiveListing) {
    for (const v of l.variants) {
      // Content-only update: re-PUT the inventory item but keep the quantity that was last pushed.
      await this.call(conn, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(v.sku)}`, this.inventoryItem(l, v));
      if (v.externalRef) await this.call(conn, 'PUT', `/sell/inventory/v1/offer/${v.externalRef}`, this.offer(conn, l, v));
    }
  }

  async setListingStatus(conn: Connection, l: EffectiveListing, status: 'active' | 'paused' | 'ended') {
    if (status === 'ended') {
      for (const v of l.variants) if (v.externalRef) await this.call(conn, 'POST', `/sell/inventory/v1/offer/${v.externalRef}/withdraw`);
      return;
    }
    // paused → quantity 0 ; active → current available (computed by caller into v.quantity)
    await this.pushInventory(conn, l.variants.map((v) => ({
      sku: v.sku, externalRef: v.externalRef, quantity: status === 'paused' ? 0 : v.quantity, listingExternalId: l.externalId,
    })));
  }

  async pushInventory(conn: Connection, items: { sku: string; externalRef: string | null; quantity: number }[]) {
    for (let i = 0; i < items.length; i += 25) {
      const requests = items.slice(i, i + 25).map((it) => ({
        sku: it.sku,
        shipToLocationAvailability: { quantity: it.quantity },
        ...(it.externalRef ? { offers: [{ offerId: it.externalRef, availableQuantity: it.quantity }] } : {}),
      }));
      const r = await this.call(conn, 'POST', '/sell/inventory/v1/bulk_update_price_quantity', { requests });
      const failed = (r?.responses ?? []).filter((x: any) => x.statusCode >= 400);
      if (failed.length) throw new MarketplaceApiError(`eBay rejected ${failed.length} stock update(s): ${JSON.stringify(failed[0].errors ?? failed[0]).slice(0, 200)}`, 422, undefined, failed);
    }
  }

  async pushPrices(conn: Connection, items: { sku: string; externalRef: string | null; price: number }[], currency: string) {
    for (let i = 0; i < items.length; i += 25) {
      const requests = items.slice(i, i + 25).filter((it) => it.externalRef).map((it) => ({
        sku: it.sku, offers: [{ offerId: it.externalRef, price: { value: it.price.toFixed(2), currency } }],
      }));
      if (!requests.length) continue;
      await this.call(conn, 'POST', '/sell/inventory/v1/bulk_update_price_quantity', { requests });
    }
  }

  normalizeOrder(o: any): NormalizedOrder {
    const n = (m: any) => Number(m?.value ?? 0);
    const ship = o.fulfillmentStartInstructions?.[0]?.shippingStep;
    return {
      externalOrderId: o.orderId,
      orderDate: o.creationDate,
      customerName: ship?.shipTo?.fullName ?? o.buyer?.username ?? null,
      customerEmail: ship?.shipTo?.email ?? null,
      shipAddress: ship?.shipTo ?? null,
      marketplaceStatus: `${o.orderPaymentStatus}/${o.orderFulfillmentStatus}`,
      paymentStatus: o.orderPaymentStatus === 'PAID' ? 'paid' : o.orderPaymentStatus === 'FULLY_REFUNDED' ? 'refunded' : o.orderPaymentStatus === 'PARTIALLY_REFUNDED' ? 'partially_refunded' : 'pending',
      cancelled: o.cancelStatus?.cancelState === 'CANCELED',
      fulfilled: o.orderFulfillmentStatus === 'FULFILLED',
      currency: o.pricingSummary?.total?.currency ?? 'GBP',
      subtotal: n(o.pricingSummary?.priceSubtotal), shippingCost: n(o.pricingSummary?.deliveryCost), tax: n(o.pricingSummary?.tax),
      fees: o.totalMarketplaceFee ? n(o.totalMarketplaceFee) : null,
      refunds: (o.paymentSummary?.refunds ?? []).reduce((s: number, r: any) => s + n(r.amount), 0),
      total: n(o.pricingSummary?.total),
      shippingMethod: ship?.shippingServiceCode ?? null, carrier: null, trackingNumber: null,
      items: (o.lineItems ?? []).map((li: any) => ({
        externalLineId: li.lineItemId, sku: li.sku ?? null, title: li.title, quantity: li.quantity, unitPrice: n(li.lineItemCost) / Math.max(1, li.quantity),
      })),
      raw: o,
    };
  }

  async fetchOrders(conn: Connection, since: Date): Promise<NormalizedOrder[]> {
    const out: NormalizedOrder[] = [];
    let offset = 0;
    for (;;) {
      const r = await this.call(conn, 'GET', `/sell/fulfillment/v1/order?filter=${encodeURIComponent(`lastmodifieddate:[${since.toISOString()}..]`)}&limit=200&offset=${offset}`);
      out.push(...(r.orders ?? []).map((o: any) => this.normalizeOrder(o)));
      offset += 200;
      if (!r.next || offset >= (r.total ?? 0)) break;
    }
    return out;
  }

  async addTracking(conn: Connection, order: { external_order_id: string; raw: any }, t: { carrier: string; trackingNumber: string; items?: { externalLineId: string | null; quantity: number }[] }) {
    const lineItems = (t.items?.length ? t.items : (order.raw?.lineItems ?? []).map((li: any) => ({ externalLineId: li.lineItemId, quantity: li.quantity })))
      .map((i: any) => ({ lineItemId: i.externalLineId, quantity: i.quantity }));
    await this.call(conn, 'POST', `/sell/fulfillment/v1/order/${order.external_order_id}/shipping_fulfillment`, {
      lineItems, shippedDate: new Date().toISOString(), shippingCarrierCode: t.carrier, trackingNumber: t.trackingNumber,
    });
  }

  sellerPortalOrderUrl(_c: Connection, id: string) {
    return config.ebay.env === 'production' ? `https://www.ebay.co.uk/sh/ord/details?orderid=${id}` : `https://sandbox.ebay.com/sh/ord/details?orderid=${id}`;
  }

  // ── Webhooks ──
  private keyCache = new Map<string, { pem: string; at: number }>();

  /** Application token (client credentials) needed to fetch notification public keys. */
  private async appToken(): Promise<string> {
    const tok = await apiFetch(`${hosts().api}/identity/v1/oauth2/token`, {
      method: 'POST', label: 'eBay app token',
      headers: { Authorization: this.basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
    });
    return tok.access_token;
  }

  async verifyWebhook(_c: Connection | null, headers: Record<string, any>, rawBody: Buffer) {
    const header = headers['x-ebay-signature'];
    if (!header) return false;
    let sig: { kid: string; signature: string; digest?: string };
    try { sig = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { return false; }
    let cached = this.keyCache.get(sig.kid);
    if (!cached || Date.now() - cached.at > 3600_000) {
      const r = await apiFetch(`${hosts().api}/commerce/notification/v1/public_key/${sig.kid}`, {
        headers: { Authorization: `Bearer ${await this.appToken()}` }, label: 'eBay public key',
      });
      const body = String(r.key).replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
      cached = { pem: `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`, at: Date.now() };
      this.keyCache.set(sig.kid, cached);
    }
    return crypto.verify(sig.digest?.toLowerCase() === 'sha256' ? 'sha256' : 'sha1', rawBody, cached.pem, Buffer.from(sig.signature, 'base64'));
  }

  /** eBay endpoint validation: GET ?challenge_code=… must echo SHA-256(challengeCode + verificationToken + endpointUrl). */
  static challengeResponse(challengeCode: string, endpointUrl: string) {
    return crypto.createHash('sha256').update(challengeCode + config.ebay.notificationToken + endpointUrl).digest('hex');
  }

  async parseWebhook(_c: Connection, _h: Record<string, any>, body: any): Promise<WebhookResult> {
    // Notifications carry IDs; orders are always re-read via the Fulfillment API (poll job picks them up).
    return { eventId: String(body?.notification?.notificationId ?? ''), topic: String(body?.metadata?.topic ?? ''), orders: [] };
  }

  async fetchListings(conn: Connection): Promise<ImportedListing[]> {
    const out: ImportedListing[] = [];
    let offset = 0;
    for (;;) {
      const r = await this.call(conn, 'GET', `/sell/inventory/v1/inventory_item?limit=100&offset=${offset}`);
      for (const it of r.inventoryItems ?? []) {
        out.push({
          externalId: it.sku, externalVariantRef: it.sku, sku: it.sku,
          barcode: it.product?.upc?.[0] ?? it.product?.ean?.[0] ?? null, title: it.product?.title ?? it.sku,
          price: null, quantity: it.availability?.shipToLocationAvailability?.quantity ?? null,
          imageUrl: it.product?.imageUrls?.[0] ?? null, raw: it,
        });
      }
      offset += 100;
      if (!r.next) break;
    }
    return out;
  }
}
