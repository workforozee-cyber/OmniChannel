import * as crypto from 'crypto';
import { timingSafeEqualStr } from '../../common/crypto';
import {
  Capabilities, Connection, EffectiveListing, ImportedListing, MarketplaceAdapter, MarketplaceApiError,
  MarketplaceCode, NormalizedOrder, PublishResult, WebhookResult,
} from '../types';
import { validateFor } from '../validation';

/**
 * MOCK / SANDBOX adapter — clearly labelled everywhere in the UI.
 *
 * Mirrors a real marketplace's *validation rules* (so "Validation Required" behaves realistically)
 * but makes no network calls. Used for demos, development and tests, and for channels whose live
 * adapter is still framework-only. Every external ID it returns starts with "MOCK-".
 *
 * Failure simulation (connection.settings):
 *   mockFailInventory: true  → pushInventory throws (exercise failed-sync notifications)
 *   mockFailPublish:   true  → publishListing throws
 * Mock webhooks are signed with HMAC-SHA256(connection.settings.mockWebhookSecret, body), header x-mock-signature.
 */
export class MockAdapter implements MarketplaceAdapter {
  displayName: string;
  capabilities: Capabilities;
  constructor(public code: MarketplaceCode, private real: MarketplaceAdapter) {
    this.displayName = `${real.displayName} (mock)`;
    this.capabilities = { ...real.capabilities, notes: ['MOCK MODE — no data is sent to the marketplace.', ...real.capabilities.notes] };
  }

  validateListing(l: EffectiveListing, c: Connection) { return validateFor(this.code, l, c); }

  async publishListing(c: Connection, l: EffectiveListing): Promise<PublishResult> {
    if (c.settings.mockFailPublish) throw new MarketplaceApiError(`[mock] ${this.code} rejected the listing (simulated)`, 422);
    const id = `MOCK-${this.code.toUpperCase()}-${crypto.randomBytes(4).toString('hex')}`;
    const refs: Record<string, string> = {};
    l.variants.forEach((v) => (refs[v.variantId] = `${id}-${v.sku}`));
    return { externalId: id, url: null, variantRefs: refs };
  }
  async updateListing() {}
  async setListingStatus() {}
  async pushInventory(c: Connection) {
    if (c.settings.mockFailInventory) throw new MarketplaceApiError(`[mock] ${this.code} inventory API unavailable (simulated)`, 503);
  }
  async pushPrices() {}
  async fetchOrders(): Promise<NormalizedOrder[]> { return []; }
  async addTracking() {}
  sellerPortalOrderUrl(_c: Connection, id: string) { return `about:blank#mock-${this.code}-order-${id}`; }

  async verifyWebhook(c: Connection | null, headers: Record<string, any>, raw: Buffer) {
    const secret = c?.settings?.mockWebhookSecret;
    const sig = headers['x-mock-signature'];
    if (!secret || !sig) return false;
    return timingSafeEqualStr(crypto.createHmac('sha256', secret).update(raw).digest('hex'), String(sig));
  }

  async parseWebhook(_c: Connection, headers: Record<string, any>, body: any): Promise<WebhookResult> {
    return { eventId: String(headers['x-mock-event-id'] ?? body.id), topic: 'order', orders: [body.order] };
  }

  async fetchListings(): Promise<ImportedListing[]> { return []; }
}
