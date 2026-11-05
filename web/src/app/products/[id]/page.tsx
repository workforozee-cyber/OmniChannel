'use client';
import { ExternalLink, RefreshCw, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ProductEditor, toForm } from '@/components/ProductEditor';
import { ListingCustomizer } from '@/components/ListingCustomizer';
import { ErrorBox, Loading, MarketplaceTag, PageHeader, Spinner, StatusBadge, Table, useApi, useToast } from '@/components/ui';
import { api, money } from '@/lib/api';

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, reload } = useApi(`/products/${id}`);
  const { data: conns } = useApi('/marketplaces/connections');
  const [editorKey, setEditorKey] = useState(0);
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Loading />;
  return (
    <>
      <PageHeader title={p.title} description={<span>{p.variants.length} SKU · {p.type} · <Link href={`/inventory?search=${encodeURIComponent(p.variants[0].sku)}`} className="text-indigo-600">stock & history</Link></span>} />
      <PublishPanel product={p} connections={conns ?? []} onChange={reload} />
      <div className="mt-6" />
      <ProductEditor key={editorKey} initial={toForm(p)} productId={p.id} onSaved={() => { reload(); setEditorKey((k) => k + 1); }} />
    </>
  );
}

function PublishPanel({ product, connections, onChange }: { product: any; connections: any[]; onChange: () => void }) {
  const toast = useToast();
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [customize, setCustomize] = useState<any>(null);
  const listingFor = (cid: string) => product.listings.find((l: any) => l.connection_id === cid);
  const usable = connections.filter((c) => c.status === 'connected');

  async function publish() {
    setBusy(true);
    try {
      const r = await api(`/products/${product.id}/publish`, { method: 'POST', json: { connectionIds: sel } });
      setResults(r.results); setSel([]);
      const ok = r.results.filter((x: any) => ['published', 'queued'].includes(x.status)).length;
      toast(ok === r.results.length ? 'success' : 'info', `${ok} of ${r.results.length} channel(s) published or queued`);
      onChange();
    } catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <div><h2 className="font-semibold">Publish to channels</h2><p className="text-sm text-slate-500">Each channel is validated separately — missing fields never block the others.</p></div>
        <button className="btn-primary" disabled={!sel.length || busy} onClick={publish}>{busy ? <Spinner /> : <Send className="h-4 w-4" />} Publish to selected channels</button>
      </div>
      {!usable.length && <div className="p-5 text-sm text-slate-500">No connected marketplaces. <Link className="text-indigo-600" href="/marketplaces">Connect one first.</Link></div>}
      {usable.length > 0 && (
        <Table>
          <thead className="bg-slate-50"><tr><th className="th w-8"><input type="checkbox" aria-label="Select all" checked={sel.length === usable.length} onChange={(e) => setSel(e.target.checked ? usable.map((c) => c.id) : [])} /></th>
            <th className="th">Marketplace</th><th className="th">Status</th><th className="th">Channel price</th><th className="th">Listing</th><th className="th">Missing / errors</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {usable.map((c) => {
              const l = listingFor(c.id);
              const r = results?.find((x) => x.connectionId === c.id);
              const missing = r?.missingFields ?? l?.missing_fields ?? [];
              return (
                <tr key={c.id} className="align-top">
                  <td className="td"><input type="checkbox" aria-label={`Select ${c.marketplace}`} checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} /></td>
                  <td className="td"><MarketplaceTag code={c.marketplace} mode={c.mode} account={c.account_name} /></td>
                  <td className="td"><StatusBadge status={r?.status ?? l?.status ?? 'not listed'} /></td>
                  <td className="td tabular-nums">{l ? (l.sync_price_with_master ? <span title="Follows master price + channel rule">Follows master</span> : money(l.price_override)) : '—'}</td>
                  <td className="td text-xs">{l?.external_id ? (l.external_url ? <a className="inline-flex items-center gap-1 text-indigo-600" href={l.external_url} target="_blank" rel="noreferrer">{l.external_id}<ExternalLink className="h-3 w-3" /></a> : <code>{l.external_id}</code>) : '—'}</td>
                  <td className="td min-w-[28rem] whitespace-normal text-xs leading-5">
                    {missing.length > 0 && <div className="text-amber-800"><span className="font-semibold">Missing {missing.length}:</span> {missing.map((m: any, i: number) => <span key={m.field} title={m.message} className="cursor-help underline decoration-dotted">{m.label}{i < missing.length - 1 ? ', ' : ''}</span>)}</div>}
                    {l?.last_error && <div className="text-rose-600">{l.last_error}</div>}
                  </td>
                  <td className="td text-right">{l && <button className="btn-ghost text-xs" onClick={() => setCustomize({ listing: l, conn: c })}>Customise</button>}
                    {l && ['failed', 'validation_required'].includes(l.status) && <button className="btn-ghost text-xs" onClick={async () => { await api(`/listings/${l.id}/retry`, { method: 'POST' }); onChange(); }}><RefreshCw className="h-3 w-3" /> Retry</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {customize && <ListingCustomizer listing={customize.listing} conn={customize.conn} product={product} onClose={() => setCustomize(null)} onSaved={() => { setCustomize(null); onChange(); }} />}
    </section>
  );
}
