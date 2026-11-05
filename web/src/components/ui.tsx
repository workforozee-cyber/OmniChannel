'use client';
import clsx from 'clsx';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, MP_NAME } from '@/lib/api';

// ── Data hook ──
export function useApi<T = any>(path: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true); setError(null);
    try { setData(await api<T>(path)); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

// ── Toasts ──
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} role="status" className={clsx('rounded-lg border px-4 py-3 text-sm shadow-lg',
            t.kind === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
            t.kind === 'error' && 'border-rose-200 bg-rose-50 text-rose-900',
            t.kind === 'info' && 'border-slate-200 bg-white text-slate-800')}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Status badges ──
const TONES: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};
const STATUS_TONE: Record<string, keyof typeof TONES> = {
  published: 'green', connected: 'green', fulfilled: 'green', success: 'green', paid: 'green', completed: 'green', shipped: 'green', active: 'green', reserved: 'blue',
  validation_required: 'amber', pending: 'amber', queued: 'blue', processing: 'blue', unfulfilled: 'amber', partial: 'amber', on_hold: 'amber', warning: 'amber', paused: 'slate', draft: 'slate', new: 'blue',
  failed: 'red', error: 'red', expired: 'red', cancelled: 'red', short: 'red', ended: 'slate', disconnected: 'slate', refunded: 'red', archived: 'slate', info: 'slate',
};
export function Badge({ children, tone = 'slate', className }: { children: ReactNode; tone?: keyof typeof TONES; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone], className)}>{children}</span>;
}
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-slate-400">—</span>;
  return <Badge tone={STATUS_TONE[status] ?? 'slate'}>{status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}</Badge>;
}
export function MockBadge() {
  return <Badge tone="violet" className="uppercase tracking-wide" ><span title="Mock mode: no data is sent to the marketplace">Mock</span></Badge>;
}

const MP_COLOR: Record<string, string> = { ebay: 'bg-[#e53238]', amazon: 'bg-[#232f3e]', etsy: 'bg-[#f1641e]', walmart: 'bg-[#0071ce]', shopify: 'bg-[#5e8e3e]' };
export function MarketplaceTag({ code, mode, account }: { code: string; mode?: string; account?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white', MP_COLOR[code] ?? 'bg-slate-500')}>{(MP_NAME[code] ?? code)[0]}</span>
      <span className="text-sm">{MP_NAME[code] ?? code}</span>
      {account && <span className="text-xs text-slate-400">· {account}</span>}
      {mode === 'mock' && <MockBadge />}
    </span>
  );
}

// ── Layout bits ──
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'red' | 'amber' | 'green' }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone === 'red' && 'text-rose-600', tone === 'amber' && 'text-amber-600', tone === 'green' && 'text-emerald-600', !tone && 'text-slate-900')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={clsx('h-4 w-4 animate-spin', className)} />;
export function Loading() { return <div className="flex items-center gap-2 p-8 text-sm text-slate-500"><Spinner /> Loading…</div>; }
export function ErrorBox({ error }: { error: string }) {
  return <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="p-10 text-center"><div className="text-sm font-medium text-slate-700">{title}</div>{children && <div className="mt-1 text-sm text-slate-500">{children}</div>}</div>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm text-slate-500">
      <span>{total === 0 ? 'No results' : `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`}</span>
      <div className="flex gap-1">
        <button className="btn-ghost px-2" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
        <button className="btn-ghost px-2" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center" onMouseDown={onClose}>
      <div role="dialog" aria-modal className={clsx('card w-full', wide ? 'max-w-3xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="font-semibold text-slate-900">{title}</h2>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Confirmation dialog for destructive / important actions. */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: ReactNode; danger?: boolean; confirmLabel?: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = (title: string, body: ReactNode, opts: { danger?: boolean; confirmLabel?: string } = {}) =>
    new Promise<boolean>((resolve) => setState({ title, body, ...opts, resolve }));
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  const dialog = (
    <Modal open={!!state} onClose={() => close(false)} title={state?.title ?? ''}
      footer={<><button className="btn-secondary" onClick={() => close(false)}>Cancel</button>
        <button className={state?.danger ? 'btn-danger' : 'btn-primary'} onClick={() => close(true)}>{state?.confirmLabel ?? 'Confirm'}</button></>}>
      <div className="text-sm text-slate-600">{state?.body}</div>
    </Modal>
  );
  return { confirm, dialog };
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return <label className={clsx('block', className)}><span className="label">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}</label>;
}

export function Table({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-200">{children}</table></div>;
}
