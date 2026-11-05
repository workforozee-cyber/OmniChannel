import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { ActivityService } from '../activity/activity.service';
import { config } from '../common/config';
import { decryptJson, encryptJson, randomToken } from '../common/crypto';
import { Db, one, pool, q } from '../common/db';
import { adapterFor, liveAdapter } from './registry';
import { ShopifyAdapter } from './adapters/shopify.adapter';
import { Connection, MarketplaceCode } from './types';

/** Fields safe to return to the browser — credentials never leave the server. */
const PUBLIC_COLS = `id, marketplace, account_name, external_account_id, mode, status, settings, token_expires_at, last_sync_at, last_error, created_at`;

@Injectable()
export class ConnectionsService {
  constructor(private activity: ActivityService) {}

  redirectUri(code: MarketplaceCode) { return `${config.publicApiUrl}/api/marketplaces/oauth/${code}/callback`; }
  webhookUrl(conn: { id: string; marketplace: string }) { return `${config.publicApiUrl}/api/webhooks/${conn.marketplace}/${conn.id}`; }

  async list(orgId: string) {
    const rows = await q(`SELECT ${PUBLIC_COLS} FROM marketplace_connections WHERE org_id=$1 AND status <> 'disconnected' ORDER BY marketplace, created_at`, [orgId]);
    return rows.map((r) => ({ ...r, settings: redactSettings(r.settings), capabilities: adapterFor(r).capabilities, webhookUrl: this.webhookUrl(r) }));
  }

  /** Load a connection with decrypted credentials (server-side only). */
  async load(id: string, orgId?: string, db: Db = pool): Promise<Connection> {
    const r = await one(`SELECT * FROM marketplace_connections WHERE id=$1 ${orgId ? 'AND org_id=$2' : ''}`, orgId ? [id, orgId] : [id], db);
    if (!r) throw new NotFoundException('Connection not found');
    return { ...r, credentials: decryptJson(r.credentials_enc) };
  }

  /** Refresh OAuth tokens shortly before expiry; mark connection expired + notify if refresh fails. */
  async withFreshCredentials(conn: Connection): Promise<Connection> {
    if (conn.mode === 'mock' || !conn.credentials?.accessExpiresAt) return conn;
    if (conn.credentials.accessExpiresAt - Date.now() > 5 * 60_000) return conn;
    const adapter = liveAdapter(conn.marketplace);
    if (!adapter.refreshCredentials) return conn;
    try {
      const { credentials, expiresAt } = await adapter.refreshCredentials(conn);
      await q(`UPDATE marketplace_connections SET credentials_enc=$2, token_expires_at=$3, status='connected', last_error=NULL WHERE id=$1`, [conn.id, encryptJson(credentials), expiresAt]);
      return { ...conn, credentials };
    } catch (e: any) {
      await this.markExpired(conn, e.message);
      throw e;
    }
  }

  async markExpired(conn: Connection, reason: string) {
    await q(`UPDATE marketplace_connections SET status='expired', last_error=$2 WHERE id=$1`, [conn.id, reason]);
    await this.activity.notify({ orgId: conn.org_id, type: 'connection_expired', severity: 'error', title: `${conn.account_name} (${conn.marketplace}) needs reconnecting`, body: reason, refType: 'connection', refId: conn.id, dedupeKey: `expired:${conn.id}` });
    await this.activity.log({ orgId: conn.org_id, action: 'connection.expired', level: 'error', entityType: 'connection', entityId: conn.id, message: `${conn.marketplace} connection "${conn.account_name}" expired: ${reason}` });
  }

  async createMock(orgId: string, userId: string, marketplace: MarketplaceCode, accountName: string, settings: any = {}) {
    const row = await one(
      `INSERT INTO marketplace_connections(org_id,marketplace,account_name,mode,status,settings)
       VALUES ($1,$2,$3,'mock','connected',$4) RETURNING ${PUBLIC_COLS}`,
      [orgId, marketplace, accountName, { ...settings, mockWebhookSecret: randomToken() }],
    );
    await this.activity.log({ orgId, userId, action: 'connection.create', entityType: 'connection', entityId: row!.id, message: `Connected ${marketplace} account "${accountName}" in MOCK mode` });
    return row;
  }

  /** Step 1 of live OAuth: persist state (+ PKCE verifier) and return the marketplace consent URL. */
  async startOAuth(orgId: string, marketplace: MarketplaceCode, opts: { shop?: string; reconnectId?: string }) {
    const adapter = liveAdapter(marketplace);
    if (!adapter.getAuthorizeUrl) throw new BadRequestException(`${marketplace} does not use OAuth; submit API credentials instead`);
    assertAppConfigured(marketplace);
    const state = randomToken();
    const verifier = randomToken(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    await q(`INSERT INTO oauth_states(state,org_id,connection_id,marketplace,code_verifier,context) VALUES ($1,$2,$3,$4,$5,$6)`,
      [state, orgId, opts.reconnectId ?? null, marketplace, verifier, { shop: opts.shop }]);
    return { url: adapter.getAuthorizeUrl({ state, codeChallenge: challenge, shop: opts.shop, redirectUri: this.redirectUri(marketplace) }) };
  }

  /** Step 2: marketplace redirects back; validate state, exchange code, store encrypted tokens. */
  async completeOAuth(marketplace: MarketplaceCode, params: Record<string, string>) {
    const st = await one(`DELETE FROM oauth_states WHERE state=$1 AND marketplace=$2 AND created_at > now() - interval '15 minutes' RETURNING *`, [params.state, marketplace]);
    if (!st) throw new BadRequestException('OAuth state is invalid or expired — start the connection again');
    const adapter = liveAdapter(marketplace);
    const res = await adapter.exchangeCode!(params, { codeVerifier: st.code_verifier, redirectUri: this.redirectUri(marketplace), context: st.context });
    let row;
    if (st.connection_id) {
      row = await one(`UPDATE marketplace_connections SET credentials_enc=$2, token_expires_at=$3, status='connected', last_error=NULL WHERE id=$1 RETURNING id, org_id, marketplace`,
        [st.connection_id, encryptJson(res.credentials), res.expiresAt ?? null]);
    } else {
      row = await one(
        `INSERT INTO marketplace_connections(org_id,marketplace,account_name,external_account_id,mode,status,credentials_enc,token_expires_at)
         VALUES ($1,$2,$3,$4,'live','connected',$5,$6) RETURNING id, org_id, marketplace`,
        [st.org_id, marketplace, res.accountName, res.externalAccountId ?? null, encryptJson(res.credentials), res.expiresAt ?? null]);
    }
    if (marketplace === 'shopify') {
      const conn = await this.load(row!.id);
      const shopify = adapter as ShopifyAdapter;
      const locationId = await shopify.locationId(conn);
      await q(`UPDATE marketplace_connections SET settings = settings || $2 WHERE id=$1`, [conn.id, { locationId }]);
      await shopify.registerWebhooks(conn, this.webhookUrl(conn));
    }
    await this.activity.log({ orgId: row!.org_id, action: 'connection.oauth', level: 'success', entityType: 'connection', entityId: row!.id, message: `${marketplace} account "${res.accountName}" connected` });
    return row;
  }

  /** For client-credential marketplaces (Walmart seller keys). Secret is encrypted immediately and never echoed. */
  async saveApiCredentials(orgId: string, userId: string, marketplace: MarketplaceCode, accountName: string, creds: Record<string, string>) {
    const row = await one(
      `INSERT INTO marketplace_connections(org_id,marketplace,account_name,mode,status,credentials_enc)
       VALUES ($1,$2,$3,'live','pending',$4) RETURNING ${PUBLIC_COLS}`,
      [orgId, marketplace, accountName, encryptJson(creds)]);
    await this.activity.log({ orgId, userId, action: 'connection.credentials', entityType: 'connection', entityId: row!.id, message: `API credentials stored (encrypted) for ${marketplace} "${accountName}"` });
    return row;
  }

  async updateSettings(orgId: string, id: string, settings: Record<string, any>) {
    const { mockWebhookSecret, ...safe } = settings; // can't be overwritten from the client
    const row = await one(`UPDATE marketplace_connections SET settings = settings || $3 WHERE id=$1 AND org_id=$2 RETURNING ${PUBLIC_COLS}`, [id, orgId, safe]);
    if (!row) throw new NotFoundException();
    return { ...row, settings: redactSettings(row.settings) };
  }

  async disconnect(orgId: string, userId: string, id: string) {
    const row = await one(`UPDATE marketplace_connections SET status='disconnected', credentials_enc=NULL WHERE id=$1 AND org_id=$2 RETURNING marketplace, account_name`, [id, orgId]);
    if (!row) throw new NotFoundException();
    await this.activity.log({ orgId, userId, action: 'connection.disconnect', level: 'warning', entityType: 'connection', entityId: id, message: `Disconnected ${row.marketplace} account "${row.account_name}"; stored credentials deleted` });
    return { ok: true };
  }
}

function redactSettings(s: any) {
  const { mockWebhookSecret, ...rest } = s ?? {};
  return { ...rest, ...(mockWebhookSecret ? { mockWebhookSecret: '••••' } : {}) };
}

function assertAppConfigured(m: MarketplaceCode) {
  const missing: Record<MarketplaceCode, boolean> = {
    shopify: !config.shopify.clientId || !config.shopify.clientSecret,
    ebay: !config.ebay.clientId || !config.ebay.clientSecret || !config.ebay.ruName,
    etsy: !config.etsy.keystring,
    amazon: !config.amazon.clientId || !config.amazon.appId,
    walmart: true,
  };
  if (missing[m]) throw new BadRequestException(`${m} app credentials are not configured on the server yet. Add them as environment variables (on Render: your service → Environment), then redeploy. See docs/MARKETPLACES.md.`);
}
