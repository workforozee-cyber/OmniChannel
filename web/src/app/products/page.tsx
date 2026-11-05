'use client';
import { Copy, Download, Plus, Search, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BulkImport } from '@/components/BulkImport';
import { Badge, Empty, ErrorBox, Loading, PageHeader, Pagination, StatusBadge, Table, useApi, useToast } from '@/components/ui';
import { api, download, money } from '@/lib/api';

export default function Products() {
  const router = useRouter();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const qs = new URLSearchParams({ page: String(page), pageSize: '25', ...(search && { search }), ...(status && { status }), ...(type && { type }) });
  const { data, error, loading, reload } = useApi(`/products?${qs}`);

  async function duplicate(id: string) {
    try { const p = await api(`/products/${id}/duplicate`, { method: 'POST' }); toast('success', 'Duplicated as draft'); router.push(`/products/${p.id}`); }
    catch (e: any) { toast('error', e.message); }
  }

  return (
    <>
      <PageHeader title="Products" description="Your central catalog. Create once, publish everywhere."
        actions={<>
          <button className="btn-secondary" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" /> Import CSV / Excel</button>
          <button className="btn-secondary" onClick={() => download('/bulk/products/export?format=xlsx', 'products.xlsx')}><Download className="h-4 w-4" /> Export</button>
          <Link href="/products/import" className="btn-secondary">Import from marketplace</Link>
          <Link href="/products/new" className="btn-primary"><Plus className="h-4 w-4" /> New product</Link>
        </>} />
      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-8" placeholder="Search title, SKU, barcode, brand…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="input w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option><option value="active">Active</option><option value="draft">Draft</option><option value="archived">Archived</option>
          </select>
          <select className="input w-auto" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
            <option value="">All types</option><option value="simple">Simple</option><option value="variable">Variable</option><option value="bundle">Bundle / kit</option>
          </select>
          {sel.length > 0 && <Link className="btn-primary" href={`/listings/bulk-publish?ids=${sel.join(',')}`}>Publish {sel.length} selected…</Link>}
        </div>
        {error && <div className="p-3"><ErrorBox error={error} /></div>}
        {loading && !data ? <Loading /> : data?.rows.length === 0 ? <Empty title="No products yet">Create a product or import from a marketplace.</Empty> : (
          <Table>
            <thead className="bg-slate-50"><tr>
              <th className="th w-8"><input type="checkbox" aria-label="Select all" checked={!!data?.rows.length && sel.length === data.rows.length} onChange={(e) => setSel(e.target.checked ? data!.rows.map((r: any) => r.id) : [])} /></th>
              <th className="th">Product</th><th className="th">SKU(s)</th><th className="th">Price</th><th className="th">Stock</th><th className="th">Channels</th><th className="th">Status</th><th className="th" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data?.rows.map((p: any) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="td"><input type="checkbox" aria-label={`Select ${p.title}`} checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} /></td>
                  <td className="td">
                    <Link href={`/products/${p.id}`} className="flex items-center gap-3">
                      {p.image ? <img src={p.image} alt="" className="h-10 w-10 rounded-md border border-slate-200 object-cover" /> : <div className="h-10 w-10 rounded-md bg-slate-100" />}
                      <div><div className="font-medium text-slate-900 hover:underline">{p.title}</div><div className="text-xs text-slate-500">{p.brand ?? '—'} · {p.type}</div></div>
                    </Link>
                  </td>
                  <td className="td text-slate-600">{p.variants?.length > 1 ? <span title={p.variants.map((v: any) => v.sku).join(', ')}>{p.variants[0].sku} +{p.variants.length - 1}</span> : p.variants?.[0]?.sku}</td>
                  <td className="td tabular-nums">{money(p.variants?.[0]?.price)}</td>
                  <td className="td tabular-nums"><span className={p.stock <= 0 ? 'font-semibold text-rose-600' : p.stock <= 5 ? 'font-semibold text-amber-600' : ''}>{p.stock}</span></td>
                  <td className="td"><div className="flex flex-wrap gap-1">{(p.listings ?? []).map((l: any, i: number) => (
                    <span key={i} title={`${l.marketplace}: ${l.status}`}><Badge tone={l.status === 'published' ? 'green' : l.status === 'validation_required' || l.status === 'failed' ? 'amber' : 'slate'}>{l.marketplace}</Badge></span>
                  ))}{!p.listings?.length && <span className="text-xs text-slate-400">Not listed</span>}</div></td>
                  <td className="td"><StatusBadge status={p.status} /></td>
                  <td className="td text-right"><button className="btn-ghost p-1.5" title="Duplicate" onClick={() => duplicate(p.id)}><Copy className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
      </div>
      <BulkImport open={importOpen} onClose={() => setImportOpen(false)} onDone={reload} />
    </>
  );
}
