'use client';
import { ExternalLink, Pause, Play, RefreshCw, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Empty, ErrorBox, Loading, MarketplaceTag, PageHeader, Pagination, StatusBadge, Table, useApi, useConfirm, useToast } from '@/components/ui';
import { api, fmtDate, MARKETPLACES, MP_NAME } from '@/lib/api';

function Listings() {
  const sp = useSearchParams();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [marketplace, setMarketplace] = useState('');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const qs = new URLSearchParams({ page: String(page), pageSize: '25', ...(status && { status }), ...(marketplace && { marketplace }), ...(search && { search }) });
  const { data, error, loading, reload } = useApi(`/listings?${qs}`);

  async function bulk(action: 'pause' | 'activate' | 'end') {
    if (action === 'end' && !(await confirm('End listings?', `End ${sel.length} listing(s) on their marketplaces? Ended listings can't be reactivated — you'd publish again.`, { danger: true, confirmLabel: 'End listings' }))) return;
    const r = await api('/listings/bulk/status', { method: 'POST', json: { listingIds: sel, action } });
    const bad = r.filter((x: any) => !x.ok);
    toast(bad.length ? 'info' : 'success', `${r.length - bad.length} updated${bad.length ? `, ${bad.length} skipped (${bad[0].error})` : ''}`);
    setSel([]); reload();
  }

  return (
    <>
      <PageHeader title="Listings" description="Every product on every channel — status, live quantity and problems." />
      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
          <div className="relative min-w-56 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input className="input pl-8" placeholder="Search title or SKU" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
          <select className="input w-auto" value={marketplace} onChange={(e) => { setMarketplace(e.target.value); setPage(1); }}><option value="">All marketplaces</option>{MARKETPLACES.map((m) => <option key={m} value={m}>{MP_NAME[m]}</option>)}</select>
          <select className="input w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>{['published', 'validation_required', 'queued', 'failed', 'paused', 'ended'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          {sel.length > 0 && <div className="flex gap-1">
            <button className="btn-secondary" onClick={() => bulk('pause')}><Pause className="h-4 w-4" /> Pause</button>
            <button className="btn-secondary" onClick={() => bulk('activate')}><Play className="h-4 w-4" /> Reactivate</button>
            <button className="btn-secondary text-rose-600" onClick={() => bulk('end')}><Trash2 className="h-4 w-4" /> End</button>
          </div>}
        </div>
        {error && <div className="p-3"><ErrorBox error={error} /></div>}
        {loading && !data ? <Loading /> : !data?.rows.length ? <Empty title="No listings match">Publish a product from its page.</Empty> : (
          <Table>
            <thead className="bg-slate-50"><tr>
              <th className="th w-8"><input type="checkbox" aria-label="Select all" checked={sel.length === data.rows.length} onChange={(e) => setSel(e.target.checked ? data.rows.map((r: any) => r.id) : [])} /></th>
              <th className="th">Product</th><th className="th">Marketplace</th><th className="th">Status</th><th className="th">Listed qty</th><th className="th">Marketplace ID</th><th className="th">Issues</th><th className="th">Updated</th><th className="th" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((l: any) => (
                <tr key={l.id} className="align-top hover:bg-slate-50">
                  <td className="td"><input type="checkbox" aria-label="Select" checked={sel.includes(l.id)} onChange={(e) => setSel(e.target.checked ? [...sel, l.id] : sel.filter((x) => x !== l.id))} /></td>
                  <td className="td"><Link href={`/products/${l.product_id}`} className="font-medium hover:underline">{l.title}</Link><div className="text-xs text-slate-500">{l.skus}</div></td>
                  <td className="td"><MarketplaceTag code={l.marketplace} mode={l.mode} /></td>
                  <td className="td"><StatusBadge status={l.status} /></td>
                  <td className="td tabular-nums">{l.listed_qty ?? '—'}</td>
                  <td className="td text-xs">{l.external_url ? <a href={l.external_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-600">{l.external_id}<ExternalLink className="h-3 w-3" /></a> : <code>{l.external_id ?? '—'}</code>}</td>
                  <td className="td max-w-xs whitespace-normal text-xs">
                    {(l.missing_fields ?? []).map((m: any) => <div key={m.field} className="text-amber-700">Missing {m.label}</div>)}
                    {l.last_error && <div className="text-rose-600">{l.last_error}</div>}
                  </td>
                  <td className="td text-xs text-slate-500">{fmtDate(l.updated_at, true)}</td>
                  <td className="td">{['failed', 'validation_required'].includes(l.status) && <button className="btn-ghost p-1.5" title="Retry" onClick={async () => { await api(`/listings/${l.id}/retry`, { method: 'POST' }); reload(); }}><RefreshCw className="h-4 w-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
      </div>
      {dialog}
    </>
  );
}
export default function Page() { return <Suspense><Listings /></Suspense>; }
