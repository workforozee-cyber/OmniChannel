'use client';
import { History, Search } from 'lucide-react';
import { useState } from 'react';
import { Badge, Field, Loading, MarketplaceTag, Modal, PageHeader, Pagination, Spinner, Table, useApi, useToast } from '@/components/ui';
import { api, fmtDate, money } from '@/lib/api';

export default function Pricing() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [hist, setHist] = useState<any>(null);
  const { data, reload } = useApi(`/pricing?page=${page}&pageSize=25${search ? `&search=${encodeURIComponent(search)}` : ''}`);
  const { data: conns } = useApi('/marketplaces/connections');
  if (!data) return <Loading />;

  async function saveRule(cid: string, kind: string, value: number, active: boolean) {
    try { const r = await api(`/pricing/rules/${cid}`, { method: 'PUT', json: { kind, value, active } }); toast('success', `Rule saved; ${r.listingsQueued} listing(s) repriced`); reload(); }
    catch (e: any) { toast('error', e.message); }
  }

  return (
    <>
      <PageHeader title="Pricing" description="Master price per SKU, channel rules on top, and min/max protection on everything." />
      <div className="card mb-6 p-4">
        <h2 className="mb-1 font-semibold">Channel pricing rules</h2>
        <p className="mb-3 text-sm text-slate-500">Applied to listings that follow the master price. Listings with a fixed channel price are left alone.</p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {(conns ?? []).filter((c: any) => c.status === 'connected').map((c: any) => <RuleCard key={c.id} c={c} rule={data.rules.find((r: any) => r.connection_id === c.id)} onSave={saveRule} />)}
        </div>
      </div>
      <div className="card">
        <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
          <div className="relative min-w-56 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input className="input pl-8" placeholder="Search SKU or product" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
          <button className="btn-primary" disabled={!sel.length} onClick={() => setBulk(true)}>Bulk price update ({sel.length})</button>
        </div>
        <Table>
          <thead className="bg-slate-50"><tr>
            <th className="th w-8"><input type="checkbox" aria-label="Select all" checked={sel.length === data.rows.length && data.rows.length > 0} onChange={(e) => setSel(e.target.checked ? data.rows.map((r: any) => r.id) : [])} /></th>
            <th className="th">SKU</th><th className="th">Cost</th><th className="th">Master price</th><th className="th">Min / max</th><th className="th">Margin</th><th className="th">Live on channels</th><th className="th" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">{data.rows.map((r: any) => (
            <tr key={r.id} className="align-top">
              <td className="td"><input type="checkbox" aria-label="Select" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>
              <td className="td"><div className="font-medium">{r.sku}</div><div className="text-xs text-slate-500">{r.title}</div></td>
              <td className="td tabular-nums">{money(r.cost_price)}</td>
              <td className="td font-semibold tabular-nums">{money(r.price)}</td>
              <td className="td text-xs tabular-nums">{money(r.min_price)} / {money(r.max_price)}</td>
              <td className="td text-xs tabular-nums">{r.cost_price ? `${Math.round(((r.price - r.cost_price) / r.price) * 100)}%` : '—'}</td>
              <td className="td"><div className="flex flex-wrap gap-1">{r.channels.map((c: any) => (
                <span key={c.listingId} title={c.sync ? 'Follows master + rule' : 'Fixed channel price'}><Badge tone={c.sync ? 'blue' : 'violet'}>{c.marketplace}: {money(c.pushed)}{!c.sync && ' · fixed'}</Badge></span>
              ))}</div></td>
              <td className="td"><button className="btn-ghost p-1.5" title="Price history" onClick={() => setHist(r)}><History className="h-4 w-4" /></button></td>
            </tr>
          ))}</tbody>
        </Table>
        <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />
      </div>
      {bulk && <BulkModal ids={sel} onClose={() => setBulk(false)} onDone={() => { setBulk(false); setSel([]); reload(); }} />}
      {hist && <HistModal row={hist} onClose={() => setHist(null)} />}
    </>
  );
}

function RuleCard({ c, rule, onSave }: { c: any; rule: any; onSave: (cid: string, kind: string, value: number, active: boolean) => void }) {
  const [kind, setKind] = useState(rule?.kind ?? 'percent');
  const [value, setValue] = useState(String(rule?.value ?? 0));
  const [active, setActive] = useState(rule?.active ?? true);
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-2"><MarketplaceTag code={c.marketplace} mode={c.mode} /></div>
      <div className="flex items-end gap-2">
        <select className="input w-28" value={kind} onChange={(e) => setKind(e.target.value)}><option value="percent">± %</option><option value="fixed">± £</option></select>
        <input className="input w-24" type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />On</label>
        <button className="btn-secondary px-2 py-1.5 text-xs" onClick={() => onSave(c.id, kind, Number(value), active)}>Save</button>
      </div>
    </div>
  );
}

function BulkModal({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [op, setOp] = useState('percent');
  const [value, setValue] = useState('');
  const [pv, setPv] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({ variantIds: ids, op, value: Number(value) });
  async function preview() { setPv((await api('/pricing/bulk', { method: 'POST', json: { ...body(), dryRun: true } })).preview); }
  async function apply() {
    setBusy(true);
    try { const r = await api('/pricing/bulk', { method: 'POST', json: body() }); toast('success', `${r.updated} master price(s) updated; channels following master will sync`); onDone(); }
    catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Update ${ids.length} master price(s)`} footer={<><button className="btn-secondary" onClick={preview} disabled={value === ''}>Preview</button><button className="btn-primary" disabled={!pv || busy} onClick={apply}>{busy && <Spinner />}Apply</button></>}>
      <div className="flex gap-2">
        <Field label="Change"><select className="input" value={op} onChange={(e) => { setOp(e.target.value); setPv(null); }}><option value="percent">By percentage</option><option value="increase">Increase by amount</option><option value="decrease">Decrease by amount</option><option value="set">Set to</option></select></Field>
        <Field label={op === 'percent' ? '% (negative to reduce)' : 'Amount (£)'}><input className="input w-32" type="number" step="0.01" value={value} onChange={(e) => { setValue(e.target.value); setPv(null); }} /></Field>
      </div>
      {pv && <Table><thead><tr><th className="th">SKU</th><th className="th">Now</th><th className="th">New</th><th className="th" /></tr></thead><tbody>{pv.map((p) => (
        <tr key={p.variantId}><td className="td">{p.sku}</td><td className="td">{money(p.oldPrice)}</td><td className="td font-semibold">{money(p.newPrice)}</td><td className="td text-xs">{p.clamped && <Badge tone="amber">clamped by min/max</Badge>}{p.invalid && <Badge tone="red">invalid</Badge>}</td></tr>
      ))}</tbody></Table>}
    </Modal>
  );
}

function HistModal({ row, onClose }: { row: any; onClose: () => void }) {
  const { data } = useApi(`/pricing/${row.id}/history`);
  return (
    <Modal open onClose={onClose} title={`Price history · ${row.sku}`}>
      {!data ? <Loading /> : <Table><thead><tr><th className="th">When</th><th className="th">Change</th><th className="th">Reason</th></tr></thead><tbody>{data.map((h: any) => (
        <tr key={h.id}><td className="td text-xs">{fmtDate(h.created_at, true)}</td><td className="td tabular-nums">{money(h.old_price)} → <b>{money(h.new_price)}</b></td><td className="td text-xs">{h.reason.replace('_', ' ')}{h.listing_id ? ' (channel)' : ' (master)'}{h.user_name ? ` · ${h.user_name}` : ''}</td></tr>
      ))}</tbody></Table>}
    </Modal>
  );
}
