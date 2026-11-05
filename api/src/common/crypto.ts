import * as crypto from 'crypto';
import { config } from './config';

/**
 * AES-256-GCM envelope for marketplace credentials (OAuth tokens, API keys).
 * Format: v1.<iv b64>.<tag b64>.<ciphertext b64>
 * Key comes from ENCRYPTION_KEY (base64, 32 bytes). In production, source it from a secret manager
 * (AWS Secrets Manager / GCP Secret Manager / Vault) and inject as an env var.
 */
function key(): Buffer {
  const raw = Buffer.from(config.encryptionKey, 'base64');
  if (raw.length === 32) return raw;
  // Allow non-base64 dev keys, but derive a proper 32-byte key from them.
  return crypto.createHash('sha256').update(config.encryptionKey).digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export function decryptJson<T = any>(payload: string | null | undefined): T | null {
  if (!payload) return null;
  const [v, ivB64, tagB64, ctB64] = payload.split('.');
  if (v !== 'v1') throw new Error('Unknown credential envelope version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
