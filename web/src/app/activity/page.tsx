'use client';
import { Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Empty, Loading, PageHeader, useApi } from '@/components/ui';

const DOT: Record<string, string> = { success: 'bg-emerald-500', error: 'bg-rose-500', warning: 'bg-amber-500', info: 'bg-slate-400' };

function Activity() {
  const sp = useSearchParams();
  const [level, setLevel] = useState(sp.get('level') ?? '');
  const [search, setSearch] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '100', ...(level && { level }), ...(search && { search }), ...(entityType && { entityType }) });
  const { data } = useApi(`/activity?${qs}`);
  return (
    <>
      <PageHeader title="Activity Logs" description="Every important operation, in order. Use it to trace exactly what happened to an order or SKU." />
      <div className="card">
        <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
          <div className="relative min-w-56 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input className="input pl-8" placeholder="Search messages (order #, SKU, marketplace…)" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
          <select className="input w-auto" value={level} onChange={(e) => { setLevel(e.target.value); setPage(1); }}><option value="">All levels</option><option value="success">Success</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select>
          <select className="input w-auto" value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }}><option value="">All types</option>{['order', 'variant', 'listing', 'product', 'connection'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </div>
        {!data ? <Loading /> : !data.length ? <Empty title="No activity matches" /> : (
          <ol className="divide-y divide-slate-100 font-mono text-[13px]">
            {data.map((a: any) => (
              <li key={a.id} className="flex gap-3 px-4 py-2">
                <span className="w-36 shrink-0 text-slate-400">{new Date(a.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[a.level]}`} />
                <span className={`flex-1 ${a.level === 'error' ? 'text-rose-700' : 'text-slate-700'}`}>{a.message}</span>
                <span className="hidden shrink-0 text-xs text-slate-400 sm:block">{a.user_name ?? 'system'}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="flex justify-between border-t border-slate-200 p-2">
          <button className="btn-ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Newer</button>
          <button className="btn-ghost" disabled={(data?.length ?? 0) < 100} onClick={() => setPage(page + 1)}>Older</button>
        </div>
      </div>
    </>
  );
}
export default function Page() { return <Suspense><Activity /></Suspense>; }
