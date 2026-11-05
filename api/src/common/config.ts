import * as fs from 'fs';
import * as path from 'path';

/** Minimal .env loader (no dependency). Real environment variables always win. */
function loadDotEnv() {
  const file = path.resolve(__dirname, '../../.env');
  const alt = path.resolve(__dirname, '../../../.env');
  const target = fs.existsSync(file) ? file : fs.existsSync(alt) ? alt : null;
  if (!target) return;
  for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}
const opt = (name: string, fallback = '') => process.env[name] ?? fallback;

export const config = {
  env: opt('NODE_ENV', 'development'),
  port: Number(opt('PORT', '4000')),
  databaseUrl: req('DATABASE_URL'),
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),
  // On Render, RENDER_EXTERNAL_URL is set automatically (https://<service>.onrender.com).
  // In single-service mode the website and API share that one URL.
  publicApiUrl: opt('PUBLIC_API_URL') || opt('RENDER_EXTERNAL_URL') || 'http://localhost:4000',
  webOrigin: opt('WEB_ORIGIN') || opt('RENDER_EXTERNAL_URL') || 'http://localhost:3000',
  /** Open self-registration. When false, only the very first account can sign up (the owner). */
  allowSignup: opt('ALLOW_SIGNUP', 'true') === 'true',
  /** Run order polling + reconciliation timers inside the API process (single-service hosting, no separate worker). */
  inProcessScheduler: opt('IN_PROCESS_SCHEDULER', 'false') === 'true',
  jwtSecret: req('JWT_SECRET'),
  encryptionKey: req('ENCRYPTION_KEY'),
  jobsInline: opt('JOBS_INLINE', 'false') === 'true',
  orderPollMinutes: Number(opt('ORDER_POLL_MINUTES', '10')),
  reconcileMinutes: Number(opt('RECONCILE_MINUTES', '60')),
  shopify: {
    clientId: opt('SHOPIFY_CLIENT_ID'),
    clientSecret: opt('SHOPIFY_CLIENT_SECRET'),
    scopes: opt('SHOPIFY_SCOPES') || 'read_products,write_products,read_inventory,write_inventory,read_orders,read_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders',
    apiVersion: opt('SHOPIFY_API_VERSION', '2026-04'),
  },
  ebay: {
    env: opt('EBAY_ENV', 'sandbox') as 'sandbox' | 'production',
    clientId: opt('EBAY_CLIENT_ID'),
    clientSecret: opt('EBAY_CLIENT_SECRET'),
    ruName: opt('EBAY_RUNAME'),
    notificationToken: opt('EBAY_NOTIFICATION_VERIFICATION_TOKEN'),
  },
  etsy: {
    keystring: opt('ETSY_KEYSTRING'),
    sharedSecret: opt('ETSY_SHARED_SECRET'),
    webhookSecret: opt('ETSY_WEBHOOK_SECRET'),
  },
  amazon: {
    clientId: opt('AMAZON_LWA_CLIENT_ID'),
    clientSecret: opt('AMAZON_LWA_CLIENT_SECRET'),
    appId: opt('AMAZON_SP_APP_ID'),
    region: opt('AMAZON_REGION', 'eu'),
  },
  walmart: {
    clientId: opt('WALMART_CLIENT_ID'),
    clientSecret: opt('WALMART_CLIENT_SECRET'),
  },
};
