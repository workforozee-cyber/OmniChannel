import { MarketplaceApiError } from './types';

/**
 * fetch wrapper used by every adapter:
 *  - retries 429 / 5xx with exponential backoff + jitter, honouring Retry-After
 *  - surfaces structured MarketplaceApiError so job runners can decide to retry later
 */
export async function apiFetch(url: string, init: RequestInit & { retries?: number; label?: string } = {}): Promise<any> {
  const retries = init.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (e: any) {
      if (attempt < retries) { await sleep(backoff(attempt)); continue; }
      throw new MarketplaceApiError(`${init.label ?? 'API'} network error: ${e.message}`, 503);
    }
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (res.ok) return body;

    const retryAfter = Number(res.headers.get('retry-after')) * 1000 || undefined;
    const err = new MarketplaceApiError(
      `${init.label ?? 'API'} ${res.status}: ${summarize(body)}`, res.status, retryAfter, body,
    );
    if (err.retryable && attempt < retries) { await sleep(retryAfter ?? backoff(attempt)); continue; }
    throw err;
  }
}

const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function summarize(body: any): string {
  if (!body) return 'no body';
  if (typeof body === 'string') return body.slice(0, 300);
  if (body.errors) return JSON.stringify(body.errors).slice(0, 300);
  return JSON.stringify(body).slice(0, 300);
}
