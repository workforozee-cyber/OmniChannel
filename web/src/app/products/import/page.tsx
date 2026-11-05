'use client';
import { useState } from 'react';
import { Badge, Empty, Loading, MarketplaceTag, PageHeader, Spinner, Table, useApi, useToast } from '@/components/ui';
import { api, money } from '@/lib/api';

/** Import existing marketplace listings and link them to central products — by SKU / barcode, always user-confirmed. */
export default function ImportMatch() {
  const toast = useToast();
  const { data: conns } = useApi('/marketplaces/connections');
  const { data: rows, reload } = useApi('/products/import/staging');
  const [busy, setBusy] = useState<string | null>(null);
  async function fetchFrom(id: string) {
    setBusy(id);
    try { const r = await api(`/products/import/${id}`, { method: 'POST' }); toast('success', `${r.staged} listing(s) fetched for review`); reload(); }
    catch (e: any) { toast('error', e.message); } finally { setBusy(null); }
  }
  async function act(id: string, body: any) {
    try { await api(`/products/import/staging/${id}`, { method: 'POST', json: body }); reload(); } catch (e: any) { toast('error', e.message); }
  }
  return (
    <>
      <PageHeader title="Import from marketplaces" description="Bring in listings you already have, then link each one to a central product. Matches are suggested by SKU or barcode only — never by title — and nothing is linked until you confirm." />
      <div className="card mb-6 p-4">
        <div className="mb-2 text-sm font-medium">1. Fetch listings from a connection</div>
        <div className="flex flex-wrap gap-2">{(conns ?? []).filter((c: any) => c.status === 'connected').map((c: any) => (
          <button key={c.id} className="btn-secondary" disabled={!!busy} onClick={() => fetchFrom(c.id)}>{busy === c.id && <Spinner />}<MarketplaceTag code={c.marketplace} mode={c.mode} /></button>
        ))}</div>
        <p className="mt-2 text-xs text-slate-500">Mock connections return no listings. Live import is implemented for Shopify and eBay.</p>
      </div>
      <div className="card">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium">2. Review and confirm matches</div>
        {!rows ? <Loading /> : !rows.length ? <Empty title="Nothing waiting for review" /> : (
          <Table>
            <thead className="bg-slate-50"><tr><th className="th">Imported listing</th><th className="th">From</th><th className="th">SKU / barcode</th><th className="th">Price · qty</th><th className="th">Suggested match</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{rows.map((r: any) => (
              <tr key={r.id}>
                <td className="td"><div className="flex items-center gap-2">{r.image_url && <img src={r.image_url} alt="" className="h-8 w-8 rounded object-cover" />}{r.title}</div></td>
                <td className="td"><MarketplaceTag code={r.marketplace} /></td>
                <td className="td text-xs">{r.sku ?? '—'}<div className="text-slate-400">{r.barcode}</div></td>
                <td className="td text-xs">{money(r.price)} · {r.quantity ?? '—'}</td>
                <td className="td">{r.suggested_sku ? <span>{r.suggested_sku} <Badge tone="blue">by {r.match_method}</Badge></span> : <span className="text-xs text-slate-400">No SKU/barcode match</span>}</td>
                <td className="td text-right space-x-1">
                  {r.suggested_variant_id && <button className="btn-primary px-2 py-1 text-xs" onClick={() => act(r.id, { linkTo: r.suggested_variant_id })}>Link</button>}
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => act(r.id, { createNew: true })}>Create product</button>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => act(r.id, { ignore: true })}>Ignore</button>
                </td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </div>
    </>
  );
}
