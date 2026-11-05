'use client';
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: any) { super(message); }
}

export function getToken() { return typeof window === 'undefined' ? null : localStorage.getItem('oc_token'); }
export function setToken(t: string | null) { if (t) localStorage.setItem('oc_token', t); else localStorage.removeItem('oc_token'); }

export async function api<T = any>(path: string, init: RequestInit & { json?: any } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as any) };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  let body = init.body;
  if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(`${API_URL}/api${path}`, { ...init, headers, body });
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
    setToken(null); window.location.href = '/login'; throw new ApiError('Session expired', 401);
  }
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = data?.issues?.length ? data.issues.map((i: any) => `${i.path}: ${i.message}`).join('; ') : (data?.message ?? res.statusText);
    throw new ApiError(Array.isArray(msg) ? msg.join('; ') : msg, res.status, data);
  }
  return data as T;
}

export async function download(path: string, filename: string) {
  const res = await fetch(`${API_URL}/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError('Download failed', res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click(); URL.revokeObjectURL(url);
}

export const money = (n: number | null | undefined, cur = 'GBP') =>
  n == null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(Number(n));
export const fmtDate = (d: string | null | undefined, time = false) =>
  !d ? '—' : new Date(d).toLocaleString('en-GB', time ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' });
export const MARKETPLACES = ['ebay', 'amazon', 'etsy', 'walmart', 'shopify'] as const;
export const MP_NAME: Record<string, string> = { ebay: 'eBay', amazon: 'Amazon', etsy: 'Etsy', walmart: 'Walmart', shopify: 'Shopify' };
