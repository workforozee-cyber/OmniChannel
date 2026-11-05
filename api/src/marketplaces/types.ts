/**
 * Marketplace adapter contract.
 *
 * The core (catalog, inventory, orders) never talks to a marketplace directly — it goes through an adapter.
 * Adding a new channel (e.g. WooCommerce, TikTok Shop, a custom site) = implement this interface and register it.
 */

export type MarketplaceCode = 'ebay' | 'amazon' | 'etsy' | 'walmart' | 'shopify';
export const MP_LABEL: Record<string, string> = { ebay: 'eBay', amazon: 'Amazon', etsy: 'Etsy', walmart: 'Walmart', shopify: 'Shopify' };

export interface Connection {
  id: string;
  org_id: string;
  marketplace: MarketplaceCode;
  account_name: string;
  external_account_id: string | null;
  mode: 'live' | 'mock';
  status: string;
  settings: Record<string, any>;
  credentials: Record<string, any> | null; // decrypted, in-memory only
}

export interface EffectiveVariant {
  variantId: string;
  sku: string;
  barcode: string | null;
  options: Record<string, string>;
  price: number;
  quantity: number;          // quantity to advertise (after reservations + safety buffer)
  weightGrams: number | null;
  dimensions: any;
  externalRef: string | null;
}

/** Master product merged with per-channel overrides — what actually gets sent to a marketplace. */
export interface EffectiveListing {
  listingId: string;
  productId: string;
  externalId: string | null;
  title: string;
  description: string;
  brand: string | null;
  manufacturer: string | null;
  category: string | null;
  images: { url: string; alt?: string }[];
  videos: { url: string }[];
  attributes: Record<string, any>;  // generic + this marketplace's attributes merged
  shipping: Record<string, any>;
  productType: 'simple' | 'variable' | 'bundle';
  variants: EffectiveVariant[];
  currency: string;
}

export interface MissingField { field: string; label: string; message: string }

export interface PublishResult {
  externalId: string;
  url: string | null;
  variantRefs: Record<string, string>; // variantId → marketplace ref (SKU / variant id / offer id)
}

export interface NormalizedOrderItem {
  externalLineId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  unitPrice: number;
}

export interface NormalizedOrder {
  externalOrderId: string;
  orderDate: string;
  customerName: string | null;
  customerEmail: string | null;
  shipAddress: any;
  marketplaceStatus: string;
  paymentStatus: 'paid' | 'pending' | 'refunded' | 'partially_refunded';
  cancelled: boolean;
  fulfilled: boolean;
  currency: string;
  subtotal: number;
  shippingCost: number;
  tax: number;
  fees: number | null;
  refunds: number;
  total: number;
  shippingMethod: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  items: NormalizedOrderItem[];
  raw: any;
}

export interface ImportedListing {
  externalId: string;
  externalVariantRef: string;
  sku: string | null;
  barcode: string | null;
  title: string;
  price: number | null;
  quantity: number | null;
  imageUrl: string | null;
  raw: any;
}

export interface WebhookResult {
  eventId: string;
  topic: string;
  orders: NormalizedOrder[];          // orders to ingest (new or updated)
  challengeResponse?: any;            // some platforms (eBay) require a verification echo
}

export interface Capabilities {
  /** 'live' = real API calls implemented here. 'framework' = mapping/validation implemented, API calls pending credentials. */
  implementation: 'live' | 'framework';
  auth: 'oauth2' | 'oauth2_pkce' | 'lwa' | 'client_credentials';
  orderDetection: string;
  webhooks: boolean;
  labelPurchase: boolean;
  trackingUpload: boolean;
  pauseListing: 'native' | 'zero_quantity' | 'unsupported';
  multipleAccounts: boolean;
  approval: string | null;
  docs: string;
  notes: string[];
}

export class IntegrationNotImplementedError extends Error {
  constructor(marketplace: string, op: string) {
    super(`${marketplace}: '${op}' has no live implementation yet. Use mock mode, or supply credentials and complete this adapter.`);
  }
}

/** Errors carrying a retry hint (rate limits, 5xx) so the job runner can back off. */
export class MarketplaceApiError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number, public body?: any) { super(message); }
  get retryable() { return this.status === 429 || this.status >= 500; }
}

export interface MarketplaceAdapter {
  code: MarketplaceCode;
  displayName: string;
  capabilities: Capabilities;

  /** Static validation: which fields are missing/invalid for this platform. Never throws. */
  validateListing(l: EffectiveListing, conn: Connection): MissingField[];

  // Auth
  getAuthorizeUrl?(ctx: { state: string; codeChallenge?: string; shop?: string; redirectUri: string }): string;
  exchangeCode?(params: Record<string, string>, ctx: { codeVerifier?: string; redirectUri: string; context: any }): Promise<{ credentials: any; accountName: string; externalAccountId?: string; expiresAt?: Date | null }>;
  refreshCredentials?(conn: Connection): Promise<{ credentials: any; expiresAt: Date | null }>;

  // Listings
  publishListing(conn: Connection, l: EffectiveListing): Promise<PublishResult>;
  updateListing(conn: Connection, l: EffectiveListing): Promise<void>;
  setListingStatus(conn: Connection, l: EffectiveListing, status: 'active' | 'paused' | 'ended'): Promise<void>;

  // Inventory & price (absolute values → idempotent)
  pushInventory(conn: Connection, items: { sku: string; externalRef: string | null; quantity: number; listingExternalId: string | null }[]): Promise<void>;
  pushPrices(conn: Connection, items: { sku: string; externalRef: string | null; price: number; listingExternalId: string | null }[], currency: string): Promise<void>;

  // Orders
  fetchOrders(conn: Connection, since: Date): Promise<NormalizedOrder[]>;
  addTracking(conn: Connection, order: { external_order_id: string; raw: any }, t: { carrier: string; trackingNumber: string; items?: { externalLineId: string | null; quantity: number }[] }): Promise<void>;
  sellerPortalOrderUrl(conn: Connection, externalOrderId: string): string;

  // Webhooks
  verifyWebhook(conn: Connection | null, headers: Record<string, any>, rawBody: Buffer, url: string): Promise<boolean>;
  parseWebhook(conn: Connection, headers: Record<string, any>, body: any): Promise<WebhookResult>;

  // Import
  fetchListings(conn: Connection): Promise<ImportedListing[]>;
}
