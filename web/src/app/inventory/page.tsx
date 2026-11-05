'use client';
import { History, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge, Empty, ErrorBox, Field, Loading, MarketplaceTag, Modal, PageHeader, Pagination, Spinner, StatusBadge, Table, useApi, useToast } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

function Inventory() {
  const sp = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(sp.get('search') ?? '');
  const [stock, setStock] = useState(sp.get('stock') ?? '');
  const [adjust, setAdjust] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [tab, setTab] = useState<'stock' | 'logs'>('stock');
  const qs = new URLSearchParams({ page: String(page), pageSize: '25', ...(search && { search }), ...(stock && { stock }) });
  const { data, error, loading, reload } = useApi(`/inventory?${qs}`);

  return (
    <>
      <PageHeader title="Inventory" description="One stock pool per SKU. Every channel is told: on hand − reserved − safety buffer." />
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {(['stock', 'logs'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500'}`}>{t === 'stock' ? 'Stock levels' : 'Sync log'}</button>)}
      </div>
      {tab === 'logs' ? <SyncLogs /> : (
        <div className="card">
          <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
            <div className="relative min-w-56 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input className="input pl-8" placeholder="Search SKU or product" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
            <select className="input w-auto" value={stock} onChange={(e) => { setStock(e.target.value); setPage(1); }}><option value="">All stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select>
          </div>
          {error && <div className="p-3"><ErrorBox error={error} /></div>}
          {loading && !data ? <Loading /> : !data?.rows.length ? <Empty title="No SKUs match" /> : (
            <Table>
              <thead className="bg-slate-50"><tr><th className="th">SKU</th><th className="th">On hand</th><th className="th">Reserved</th><th className="th">Available</th><th className="th">Buffer</th><th className="th">Shown on channels</th><th className="th">Last pushed per channel</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows.map((r: any) => (
                  <tr key={r.id} className="align-top hover:bg-slate-50">
                    <td className="td"><div className="font-medium">{r.sku}</div><Link href={`/products/${r.product_id}`} className="text-xs text-slate-500 hover:underline">{r.title}{Object.values(r.options ?? {}).length ? ` · ${Object.values(r.options).join(' / ')}` : ''}</Link>{r.type === 'bundle' && <Badge tone="violet" className="ml-1">bundle</Badge>}</td>
                    <td className="td tabular-nums">{r.onHand}</td>
                    <td className="td tabular-nums text-sky-700">{r.reserved}</td>
                    <td className={`td tabular-nums font-semibold ${r.available <= 0 ? 'text-rose-600' : r.available <= (r.low_stock_threshold ?? 5) ? 'text-amber-600' : ''}`}>{r.available}</td>
                    <td className="td tabular-nums text-slate-500">{r.buffer}</td>
                    <td className="td tabular-nums font-semibold">{r.channelQuantity}</td>
                    <td className="td"><div className="flex flex-wrap gap-1">{(r.channels ?? []).map((c: any, i: number) => (
                      <span key={i} title={`${c.marketplace}${c.mode === 'mock' ? ' (mock)' : ''} · ${c.status} · pushed ${fmtDate(c.at, true)}`}>
                        <Badge tone={c.qty === r.channelQuantity ? 'green' : c.status !== 'published' ? 'slate' : 'amber'}>{c.marketplace}: {c.qty ?? '—'}</Badge>
                      </span>))}</div></td>
                    <td className="td text-right whitespace-nowrap">
                      {r.type !== 'bundle' && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setAdjust(r)}>Adjust</button>}
                      <button className="btn-ghost p-1.5" title="History" onClick={() => setHistory(r)}><History className="h-4 w-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
        </div>
      )}
      {adjust && <AdjustModal row={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); reload(); }} />}
      {history && <HistoryModal row={history} onClose={() => setHistory(null)} />}
    </>
  );
}

function AdjustModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'set' | 'delta'>('delta');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api('/inventory/adjust', { method: 'POST', json: { variantId: row.id, [mode]: Number(value), note: note || undefined } });
      toast('success', `Stock updated — syncing to ${row.channels?.length ?? 0} channel(s)`); onDone();
    } catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Adjust stock · ${row.sku}`} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || value === ''} onClick={save}>{busy && <Spinner />}Save</button></>}>
      <p className="mb-3 text-sm text-slate-500">On hand {row.onHand}, reserved {row.reserved}. Stock can&apos;t go below reserved units.</p>
      <div className="mb-3 flex gap-2">
        <button className={mode === 'delta' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('delta')}>Add / remove</button>
        <button className={mode === 'set' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('set')}>Set exact count</button>
      </div>
      <Field label={mode === 'delta' ? 'Change (e.g. 20 or -3)' : 'New on-hand quantity'}><input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></Field>
      <Field label="Note (optional)" className="mt-3"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Restock from supplier, damaged, stock count…" /></Field>
    </Modal>
  );
}

function HistoryModal({ row, onClose }: { row: any; onClose: () => void }) {
  const { data } = useApi(`/inventory/${row.id}/history`);
  return (
    <Modal open onClose={onClose} title={`Inventory history · ${row.sku}`} wide>
      {!data ? <Loading /> : <Table>
        <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Reason</th><th className="th">On hand Δ</th><th className="th">Reserved Δ</th><th className="th">After</th><th className="th">By / note</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{data.map((m: any) => (
          <tr key={m.id}><td className="td text-xs">{fmtDate(m.created_at, true)}</td><td className="td"><StatusBadge status={m.reason} /></td>
            <td className="td tabular-nums">{m.delta_on_hand ? (m.delta_on_hand > 0 ? `+${m.delta_on_hand}` : m.delta_on_hand) : ''}</td>
            <td className="td tabular-nums">{m.delta_reserved ? (m.delta_reserved > 0 ? `+${m.delta_reserved}` : m.delta_reserved) : ''}</td>
            <td className="td tabular-nums text-xs">{m.on_hand_after} / {m.reserved_after} res.</td>
            <td className="td whitespace-normal text-xs text-slate-500">{m.user_name ?? (m.ref_type === 'order' ? 'Order' : 'System')}{m.note ? ` — ${m.note}` : ''}</td></tr>
        ))}</tbody>
      </Table>}
    </Modal>
  );
}

function SyncLogs() {
  const [status, setStatus] = useState('');
  const { data } = useApi(`/inventory/sync-logs?pageSize=100${status ? `&status=${status}` : ''}`);
  return (
    <div className="card">
      <div className="border-b border-slate-200 p-3"><select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="success">Success</option><option value="failed">Failed</option></select></div>
      {!data ? <Loading /> : <Table>
        <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Channel</th><th className="th">Kind</th><th className="th">SKU</th><th className="th">Detail</th><th className="th">Result</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{data.map((s: any) => (
          <tr key={s.id}><td className="td text-xs">{fmtDate(s.created_at, true)}</td><td className="td">{s.marketplace && <MarketplaceTag code={s.marketplace} mode={s.mode} />}</td><td className="td">{s.kind}</td><td className="td">{s.sku ?? '—'}</td>
            <td className="td text-xs">{s.detail?.quantity !== undefined ? `qty → ${s.detail.quantity}` : s.detail?.externalId ?? ''}</td>
            <td className="td whitespace-normal"><StatusBadge status={s.status} />{s.error && <div className="text-xs text-rose-600">{s.error}</div>}</td></tr>
        ))}</tbody>
      </Table>}
    </div>
  );
}
export default function Page() { return <Suspense><Inventory /></Suspense>; }
