'use client';
import { useState } from 'react';
import { Badge, ErrorBox, Modal, Spinner, Table, useToast } from './ui';
import { api } from '@/lib/api';

/** Upload → preview & validation report → apply valid rows → error report. Nothing changes until "Apply". */
export function BulkImport({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [pv, setPv] = useState<any>(null);
  const [res, setRes] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reset = () => { setPv(null); setRes(null); setErr(null); };

  async function upload(f: File) {
    reset(); setBusy(true);
    const fd = new FormData(); fd.append('file', f);
    try { setPv(await api('/bulk/products/preview', { method: 'POST', body: fd })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true);
    try {
      const r = await api('/bulk/products/apply', { method: 'POST', json: { rows: pv.parsed } });
      setRes(r.results); toast('success', `${r.results.filter((x: any) => x.ok).length} rows applied`); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Bulk import products" wide
      footer={pv && !res ? <>
        <button className="btn-secondary" onClick={reset}>Choose another file</button>
        <button className="btn-primary" disabled={busy || pv.summary.create + pv.summary.update === 0} onClick={apply}>{busy && <Spinner />}Apply {pv.summary.create + pv.summary.update} valid row(s)</button>
      </> : undefined}>
      {err && <div className="mb-3"><ErrorBox error={err} /></div>}
      {!pv && (
        <div className="space-y-3 text-sm text-slate-600">
          <p>Upload a <b>.csv</b> or <b>.xlsx</b> file, one row per SKU. Rows that share a <code>parent_sku</code> become one product with variations. Existing SKUs are updated; new SKUs are created.</p>
          <p className="text-xs text-slate-500">Columns: parent_sku, sku, title, description, brand, manufacturer, category, tags (a|b), barcode, price, cost_price, min_price, max_price, quantity, weight_grams, color, size, material, image_urls (url1|url2), status. Tip: export first to get a template.</p>
          <input type="file" accept=".csv,.xlsx" className="block w-full text-sm" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          {busy && <div className="flex items-center gap-2"><Spinner /> Validating…</div>}
        </div>
      )}
      {pv && !res && (<>
        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          <Badge tone="green">{pv.summary.create} new</Badge><Badge tone="blue">{pv.summary.update} updates</Badge>
          <Badge tone={pv.summary.errors ? 'red' : 'slate'}>{pv.summary.errors} with errors (skipped)</Badge>
        </div>
        <Table>
          <thead className="bg-slate-50"><tr><th className="th">Row</th><th className="th">SKU</th><th className="th">Action</th><th className="th">Changes / issues</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {pv.rows.map((r: any) => (
              <tr key={r.row}>
                <td className="td text-slate-400">{r.row}</td><td className="td font-medium">{r.sku || '—'}</td>
                <td className="td"><Badge tone={r.errors.length ? 'red' : r.action === 'create' ? 'green' : r.action === 'update' ? 'blue' : 'slate'}>{r.errors.length ? 'error' : r.action}</Badge></td>
                <td className="td whitespace-normal text-xs">
                  {r.errors.map((e: string) => <div key={e} className="text-rose-600">{e}</div>)}
                  {r.warnings.map((e: string) => <div key={e} className="text-amber-600">{e}</div>)}
                  {Object.entries(r.changes).map(([k, [a, b]]: any) => <div key={k}>{k}: <span className="text-slate-400 line-through">{String(a ?? '—')}</span> → <b>{String(b)}</b></div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </>)}
      {res && (
        <Table>
          <thead className="bg-slate-50"><tr><th className="th">Row</th><th className="th">SKU</th><th className="th">Result</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{res.map((r, i) => (
            <tr key={i}><td className="td">{r.row}</td><td className="td">{r.sku}</td><td className="td whitespace-normal">{r.ok ? <Badge tone="green">Applied</Badge> : <span className="text-sm text-rose-600">{r.error}</span>}</td></tr>
          ))}</tbody>
        </Table>
      )}
    </Modal>
  );
}
