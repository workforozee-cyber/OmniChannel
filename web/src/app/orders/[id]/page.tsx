'use client';
import { AlertTriangle, ExternalLink, Truck } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorBox, Field, Loading, MarketplaceTag, PageHeader, Spinner, StatusBadge, Table, useApi, useConfirm, useToast } from '@/components/ui';
import { api, fmtDate, money } from '@/lib/api';

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { data: o, error, reload } = useApi(`/orders/${id}`);
  const [note, setNote] = useState('');
  const [trk, setTrk] = useState({ carrier: 'Royal Mail', trackingNumber: '' });
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!o) return <Loading />;
  const cur = o.currency;

  async function sendTracking() {
    if (!(await confirm('Mark as fulfilled?', <>Send tracking <b>{trk.carrier} {trk.trackingNumber}</b> to {o.marketplace}{o.mode === 'mock' ? ' (mock — nothing is sent)' : ''} and mark the order fulfilled. Reserved stock will be consumed.</>, { confirmLabel: 'Send & fulfil' }))) return;
    setBusy(true);
    try { await api(`/orders/${id}/tracking`, { method: 'POST', json: trk }); toast('success', 'Tracking sent; order fulfilled'); reload(); }
    catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title={`Order #${o.external_order_id}`} description={<span className="inline-flex items-center gap-2">Placed {fmtDate(o.order_date, true)} on <MarketplaceTag code={o.marketplace} mode={o.mode} account={o.account_name} /></span>}
        actions={<a className="btn-secondary" href={o.shipping.sellerPortalUrl} target="_blank" rel="noreferrer">Open in {o.marketplace} <ExternalLink className="h-4 w-4" /></a>} />
      {o.stock_conflict && <div className="mb-4 flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><AlertTriangle className="h-4 w-4 shrink-0" />This order asked for more units than were available when it arrived. Check stock before fulfilling, or cancel it on {o.marketplace}.</div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="card">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold">Items</div>
            <Table>
              <thead className="bg-slate-50"><tr><th className="th">Product</th><th className="th">SKU</th><th className="th">Qty</th><th className="th">Price</th><th className="th">Stock</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{o.items.map((i: any) => (
                <tr key={i.id}><td className="td"><div className="flex items-center gap-2">{i.image && <img src={i.image} alt="" className="h-8 w-8 rounded object-cover" />}{i.title}</div></td><td className="td">{i.sku}</td><td className="td">{i.quantity}</td><td className="td tabular-nums">{money(i.unit_price, cur)}</td><td className="td"><StatusBadge status={i.stock_state} /></td></tr>
              ))}</tbody>
            </Table>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-slate-200 p-4 text-sm sm:grid-cols-4">
              <dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{money(o.subtotal, cur)}</dd>
              <dt className="text-slate-500">Shipping</dt><dd className="tabular-nums">{money(o.shipping_cost, cur)}</dd>
              <dt className="text-slate-500">Tax</dt><dd className="tabular-nums">{money(o.tax, cur)}</dd>
              <dt className="text-slate-500">Marketplace fees</dt><dd className="tabular-nums">{o.fees == null ? 'Not reported' : money(o.fees, cur)}</dd>
              <dt className="text-slate-500">Refunds</dt><dd className="tabular-nums">{money(o.refunds, cur)}</dd>
              <dt className="font-semibold">Total</dt><dd className="font-semibold tabular-nums">{money(o.total, cur)}</dd>
            </dl>
          </div>
          <div className="card p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><Truck className="h-4 w-4" /> Shipping & fulfillment</h2>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><dt className="label">Provider</dt><dd>{o.shipping.provider ?? '—'}</dd></div>
              <div><dt className="label">Service</dt><dd>{o.shipping.service ?? '—'}</dd></div>
              <div><dt className="label">Tracking</dt><dd>{o.shipping.trackingNumber ?? '—'}</dd></div>
              <div><dt className="label">Label</dt><dd>{o.shipping.labelAvailable ? <a className="text-indigo-600" href={o.shipping.labelUrl}>Download</a> : 'Not available'}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-slate-500">{o.shipping.labelNote} <a className="text-indigo-600" href={o.shipping.sellerPortalUrl} target="_blank" rel="noreferrer">Open the order&apos;s fulfillment page →</a></p>
            {o.fulfillment_status !== 'fulfilled' && o.fulfillment_status !== 'cancelled' && o.shipping.canUploadTracking && (
              <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-4">
                <Field label="Carrier"><input className="input w-40" value={trk.carrier} onChange={(e) => setTrk({ ...trk, carrier: e.target.value })} /></Field>
                <Field label="Tracking number"><input className="input w-56" value={trk.trackingNumber} onChange={(e) => setTrk({ ...trk, trackingNumber: e.target.value })} /></Field>
                <button className="btn-primary" disabled={busy || trk.trackingNumber.length < 3} onClick={sendTracking}>{busy && <Spinner />}Add tracking & mark fulfilled</button>
              </div>
            )}
          </div>
          <div className="card p-4">
            <h2 className="mb-3 font-semibold">History</h2>
            <ol className="space-y-2 text-sm">{o.history.map((h: any, i: number) => (
              <li key={i} className="flex gap-3"><span className="w-28 shrink-0 text-xs text-slate-400">{fmtDate(h.created_at, true)}</span><span className={h.level === 'error' ? 'text-rose-600' : ''}>{h.message}</span></li>
            ))}</ol>
          </div>
        </div>
        <div className="space-y-6">
          <div className="card space-y-3 p-4 text-sm">
            <h2 className="font-semibold">Status</h2>
            <div className="flex justify-between"><span className="text-slate-500">Marketplace</span><span className="text-xs">{o.marketplace_status}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Payment</span><StatusBadge status={o.payment_status} /></div>
            <div className="flex justify-between"><span className="text-slate-500">Fulfillment</span><StatusBadge status={o.fulfillment_status} /></div>
            <Field label="Internal status">
              <select className="input" value={o.internal_status} disabled={o.internal_status === 'cancelled'} onChange={async (e) => { await api(`/orders/${id}/status`, { method: 'PATCH', json: { status: e.target.value } }); reload(); }}>
                {['new', 'processing', 'on_hold', 'shipped', 'completed', ...(o.internal_status === 'cancelled' ? ['cancelled'] : [])].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </Field>
          </div>
          <div className="card p-4 text-sm">
            <h2 className="mb-2 font-semibold">Customer</h2>
            <div>{o.customer_name ?? '—'}</div><div className="text-slate-500">{o.customer_email}</div>
            {o.ship_address && <div className="mt-2 text-slate-600">{[o.ship_address.address1 ?? o.ship_address.addressLine1, o.ship_address.city, o.ship_address.zip ?? o.ship_address.postalCode, o.ship_address.country ?? o.ship_address.countryCode].filter(Boolean).join(', ')}</div>}
          </div>
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Internal notes</h2>
            <ul className="mb-3 space-y-2 text-sm">{o.notes.map((n: any) => <li key={n.id} className="rounded-lg bg-slate-50 p-2"><div>{n.body}</div><div className="mt-1 text-xs text-slate-400">{n.user_name} · {fmtDate(n.created_at, true)}</div></li>)}</ul>
            <textarea className="input min-h-16" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Visible to your team only" />
            <button className="btn-secondary mt-2" disabled={!note.trim()} onClick={async () => { await api(`/orders/${id}/notes`, { method: 'POST', json: { body: note } }); setNote(''); reload(); }}>Add note</button>
          </div>
        </div>
      </div>
      {dialog}
    </>
  );
}
