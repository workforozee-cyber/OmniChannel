import * as crypto from 'crypto';
import { config } from '../../common/config';
import { timingSafeEqualStr } from '../../common/crypto';
import { apiFetch } from '../http';
import {
  Capabilities, Connection, EffectiveListing, ImportedListing, IntegrationNotImplementedError, MarketplaceAdapter,
  MarketplaceCode, NormalizedOrder, PublishResult, WebhookResult,
} from '../types';
import { validateFor } from '../validation';

/**
 * FRAMEWORK adapters: Etsy, Amazon, Walmart.
 *
 * Implemented now: listing validation rules, auth URL + token exchange, webhook signature verification,
 * capability metadata. Listing/inventory/order API calls deliberately throw IntegrationNotImplementedError
 * rather than pretending to work. Until credentials + approvals exist, connect these in MOCK mode.
 */
abstract class FrameworkAdapter implements MarketplaceAdapter {
  abstract code: MarketplaceCode;
  abstract displayName: string;
  abstract capabilities: Capabilities;
  validateListing(l: EffectiveListing, c: Connection) { return validateFor(this.code, l, c); }
  private ni(op: string): never { throw new IntegrationNotImplementedError(this.displayName, op); }
  async publishListing(): Promise<PublishResult> { this.ni('publishListing'); }
  async updateListing() { this.ni('updateListing'); }
  async setListingStatus() { this.ni('setListingStatus'); }
  async pushInventory() { this.ni('pushInventory'); }
  async pushPrices() { this.ni('pushPrices'); }
  async fetchOrders(): Promise<NormalizedOrder[]> { this.ni('fetchOrders'); }
  async addTracking() { this.ni('addTracking'); }
  async fetchListings(): Promise<ImportedListing[]> { this.ni('fetchListings'); }
  async parseWebhook(): Promise<WebhookResult> { this.ni('parseWebhook'); }
  async verifyWebhook(_c: Connection | null, _h: Record<string, any>, _b: Buffer) { return false; }
  abstract sellerPortalOrderUrl(c: Connection, id: string): string;
}

export class EtsyAdapter extends FrameworkAdapter {
  code = 'etsy' as const;
  displayName = 'Etsy';
  capabilities: Capabilities = {
    implementation: 'framework',
    auth: 'oauth2_pkce',
    orderDetection: 'Webhooks (order.paid, order.canceled) + polling getShopReceipts',
    webhooks: true, labelPurchase: false, trackingUpload: true, pauseListing: 'native', multipleAccounts: true,
    approval: 'Register an app at etsy.com/developers. Apps start with personal access; commercial access (other sellers\' shops) needs Etsy review.',
    docs: 'https://developer.etsy.com/documentation/',
    notes: [
      'Every request needs both the OAuth bearer token and the x-api-key header.',
      'Webhook payloads carry only IDs + resource_url; the receipt must be fetched afterwards.',
      'Etsy listings require who_made, when_made, is_supply, taxonomy_id and a shipping profile.',
      'Etsy labels are bought in Shop Manager; we link out.',
    ],
  };

  getAuthorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge?: string; redirectUri: string }) {
    const p = new URLSearchParams({
      response_type: 'code', client_id: config.etsy.keystring, redirect_uri: redirectUri,
      scope: 'listings_r listings_w transactions_r transactions_w shops_r', state,
      code_challenge: codeChallenge!, code_challenge_method: 'S256',
    });
    return `https://www.etsy.com/oauth/connect?${p}`;
  }

  async exchangeCode(params: Record<string, string>, ctx: { codeVerifier?: string; redirectUri: string }) {
    const tok = await apiFetch('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST', label: 'Etsy OAuth', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.etsy.keystring, redirect_uri: ctx.redirectUri, code: params.code, code_verifier: ctx.codeVerifier }),
    });
    const userId = String(tok.access_token).split('.')[0]; // Etsy tokens are prefixed with the user id
    return {
      credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token, accessExpiresAt: Date.now() + tok.expires_in * 1000 },
      accountName: `Etsy user ${userId}`, externalAccountId: userId, expiresAt: null,
    };
  }

  /** Etsy signs webhooks per the Standard Webhooks scheme: HMAC-SHA256(secret, `${id}.${timestamp}.${body}`), base64, "v1," prefix. */
  static verifyStandardWebhook(headers: Record<string, any>, rawBody: Buffer, secret: string, nowSec = Math.floor(Date.now() / 1000)) {
    const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sigHeader = headers['webhook-signature'];
    if (!id || !ts || !sigHeader || !secret) return false;
    if (Math.abs(nowSec - Number(ts)) > 300) return false; // replay protection
    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody.toString('utf8')}`).digest('base64');
    return String(sigHeader).split(' ').some((part) => {
      const [ver, sig] = part.split(',');
      return ver === 'v1' && !!sig && timingSafeEqualStr(sig, expected);
    });
  }

  async verifyWebhook(_c: Connection | null, headers: Record<string, any>, rawBody: Buffer) {
    return EtsyAdapter.verifyStandardWebhook(headers, rawBody, config.etsy.webhookSecret);
  }

  sellerPortalOrderUrl(_c: Connection, id: string) { return `https://www.etsy.com/your/orders/sold?order_id=${id}`; }
}

export class AmazonAdapter extends FrameworkAdapter {
  code = 'amazon' as const;
  displayName = 'Amazon';
  capabilities: Capabilities = {
    implementation: 'framework',
    auth: 'lwa',
    orderDetection: 'Notifications API (ORDER_CHANGE) delivered to Amazon SQS/EventBridge — not HTTP webhooks — plus polling getOrders',
    webhooks: false, labelPurchase: true, trackingUpload: true, pauseListing: 'zero_quantity', multipleAccounts: true,
    approval: 'SP-API developer registration (Solution Provider Portal) with role approval. Buyer name/address (PII) needs the restricted Direct-to-Consumer Shipping role and Restricted Data Tokens. Some brands/categories need seller ungating.',
    docs: 'https://developer-docs.amazon.com/sp-api/',
    notes: [
      'Listings use the Listings Items API (putListingsItem) with product-type JSON Schemas from the Product Type Definitions API.',
      'Listing issues arrive asynchronously via LISTINGS_ITEM_ISSUES_CHANGE notifications.',
      'FBA stock is controlled by Amazon; only merchant-fulfilled (MFN) quantity can be pushed.',
      'Merchant Fulfillment / Shipping API can buy labels for MFN orders once approved.',
    ],
  };

  getAuthorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    const base = config.amazon.region === 'na' ? 'https://sellercentral.amazon.com' : config.amazon.region === 'fe' ? 'https://sellercentral.amazon.co.jp' : 'https://sellercentral-europe.amazon.com';
    const p = new URLSearchParams({ application_id: config.amazon.appId, state, redirect_uri: redirectUri, version: 'beta' });
    return `${base}/apps/authorize/consent?${p}`;
  }

  async exchangeCode(params: Record<string, string>) {
    const tok = await apiFetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST', label: 'Amazon LWA', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: params.spapi_oauth_code, client_id: config.amazon.clientId, client_secret: config.amazon.clientSecret }),
    });
    return {
      credentials: { refreshToken: tok.refresh_token, sellingPartnerId: params.selling_partner_id },
      accountName: `Amazon seller ${params.selling_partner_id}`, externalAccountId: params.selling_partner_id, expiresAt: null,
    };
  }

  sellerPortalOrderUrl(_c: Connection, id: string) { return `https://sellercentral.amazon.co.uk/orders-v3/order/${id}`; }
}

export class WalmartAdapter extends FrameworkAdapter {
  code = 'walmart' as const;
  displayName = 'Walmart Marketplace';
  capabilities: Capabilities = {
    implementation: 'framework',
    auth: 'client_credentials',
    orderDetection: 'Notifications API (PO_CREATED) webhooks + polling Orders API',
    webhooks: true, labelPurchase: true, trackingUpload: true, pauseListing: 'zero_quantity', multipleAccounts: false,
    approval: 'Walmart Marketplace seller approval. A single seller uses their own client ID/secret; managing other sellers requires approved Solution Provider status and delegated OAuth.',
    docs: 'https://developer.walmart.com/us-marketplace/docs',
    notes: [
      'Items are created via bulk item feeds (MP_ITEM spec); status is asynchronous.',
      'Walmart Marketplace is US/CA/MX/CL only.',
      'Ship with Walmart can buy labels via API for eligible sellers.',
    ],
  };
  sellerPortalOrderUrl(_c: Connection, id: string) { return `https://seller.walmart.com/orders/manage-orders?orderGroups=All&poNumber=${id}`; }
}
