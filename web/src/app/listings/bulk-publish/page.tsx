'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Loading, MarketplaceTag, PageHeader, Spinner, StatusBadge, Table, useApi, useToast } from '@/components/ui';
import { api } from '@/lib/api';

function BulkPublish() {
  const ids = (useSearchParams().get('ids') ?? '').split(',').filter(Boolean);
  const toast = useToast();
  const { data: conns } = useApi('/marketplaces/connections');
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any[] | null>(null);
  if (!conns) return <Loading />;
  const usable = conns.filter((c: any) => c.status === 'connected');
  async function go() {
    setBusy(true);
    try { setOut(await api('/listings/bulk/publish', { method: 'POST', json: { productIds: ids, connectionIds: sel } })); toast('success', 'Bulk publish submitted'); }
    catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title={`Publish ${ids.length} product(s)`} description="Choose channels. Each product × channel is validated independently." />
      <div className="card mb-6 p-4">
        <div className="flex flex-wrap gap-3">{usable.map((c: any) => (
          <label key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2"><input type="checkbox" checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} /><MarketplaceTag code={c.marketplace} mode={c.mode} /></label>
        ))}</div>
        <button className="btn-primary mt-4" disabled={!sel.length || busy} onClick={go}>{busy && <Spinner />}Publish to selected channels</button>
      </div>
      {out && <div className="card"><Table>
        <thead className="bg-slate-50"><tr><th className="th">Product</th><th className="th">Marketplace</th><th className="th">Status</th><th className="th">Missing</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{out.flatMap((p: any) => p.results.map((r: any) => (
          <tr key={p.productId + r.connectionId}><td className="td"><Link className="text-indigo-600" href={`/products/${p.productId}`}>{p.productId.slice(0, 8)}</Link></td><td className="td"><MarketplaceTag code={r.marketplace} mode={r.mode} /></td><td className="td"><StatusBadge status={r.status} /></td><td className="td whitespace-normal text-xs text-amber-700">{r.missingFields.map((m: any) => m.label).join(', ')}</td></tr>
        )))}</tbody>
      </Table></div>}
    </>
  );
}
export default function Page() { return <Suspense><BulkPublish /></Suspense>; }
