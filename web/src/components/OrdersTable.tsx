'use client';
import { AlertTriangle, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Empty, ErrorBox, Loading, MarketplaceTag, Pagination, StatusBadge, Table, useApi } from './ui';
import { fmtDate, MARKETPLACES, money, MP_NAME } from '@/lib/api';

export function OrdersTable({ shipping = false }: { shipping?: boolean }) {
  const sp = useSearchParams();
  const [page, setPage] = useState(1);
  const [f, setF] = useState<Record<string, string>>({
    marketplace: '', status: sp.get('status') ?? '', fulfillment: sp.get('fulfillment') ?? (shipping ? 'unfulfilled' : ''), from: '', to: '',
    sku: '', customer: '', shippingMethod: '', search: '', conflict: sp.get('conflict') ?? '',
  });
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); setPage(1); };
  const qs = new URLSearchParams({ page: String(page), pageSize: '25', ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
  const { data, error, loading } = useApi(`/orders?${qs}`);

  return (
    <div className="card">
      <div className="grid gap-2 border-b border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative lg:col-span-2"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input className="input pl-8" placeholder="Order ID or customer" value={f.search} onChange={set('search')} /></div>
        <select className="input" value={f.marketplace} onChange={set('marketplace')}><option value="">All marketplaces</option>{MARKETPLACES.map((m) => <option key={m} value={m}>{MP_NAME[m]}</option>)}</select>
        <select className="input" value={f.status} onChange={set('status')}><option value="">Any order status</option>{['new', 'processing', 'on_hold', 'shipped', 'completed', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
        <select className="input" value={f.fulfillment} onChange={set('fulfillment')}><option value="">Any fulfillment</option>{['unfulfilled', 'partial', 'fulfilled', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <input className="input" type="date" aria-label="From date" value={f.from} onChange={set('from')} />
        <input className="input" type="date" aria-label="To date" value={f.to} onChange={set('to')} />
        <input className="input" placeholder="SKU" value={f.sku} onChange={set('sku')} />
        <input className="input" placeholder="Customer" value={f.customer} onChange={set('customer')} />
        <input className="input" placeholder="Shipping method" value={f.shippingMethod} onChange={set('shippingMethod')} />
      </div>
      {error && <div className="p-3"><ErrorBox error={error} /></div>}
      {loading && !data ? <Loading /> : !data?.rows.length ? <Empty title="No orders match these filters" /> : (
        <Table>
          <thead className="bg-slate-50"><tr>
            <th className="th">Order</th><th className="th">Marketplace</th><th className="th">Customer</th><th className="th">Date</th><th className="th">Items</th>
            <th className="th">Total</th><th className="th">Shipping</th><th className="th">Status</th><th className="th">Payment</th><th className="th">Fulfillment</th><th className="th">Tracking</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.map((o: any) => (
              <tr key={o.id} className="hover:bg-slate-50">
                <td className="td"><Link href={`/orders/${o.id}`} className="font-medium text-indigo-600 hover:underline">#{o.external_order_id}</Link>{o.stock_conflict && <span title="Ordered more than was in stock"><AlertTriangle className="ml-1 inline h-4 w-4 text-rose-500" /></span>}</td>
                <td className="td"><MarketplaceTag code={o.marketplace} mode={o.mode} /></td>
                <td className="td">{o.customer_name ?? '—'}</td>
                <td className="td text-xs text-slate-500">{fmtDate(o.order_date, true)}</td>
                <td className="td text-xs">{(o.items ?? []).map((i: any) => <div key={i.sku}>{i.quantity}× {i.sku}</div>)}</td>
                <td className="td tabular-nums">{money(o.total, o.currency)}</td>
                <td className="td text-xs">{money(o.shipping_cost, o.currency)}<div className="text-slate-400">{o.shipping_method}</div></td>
                <td className="td"><StatusBadge status={o.internal_status} /></td>
                <td className="td"><StatusBadge status={o.payment_status} /></td>
                <td className="td"><StatusBadge status={o.fulfillment_status} /></td>
                <td className="td text-xs">{o.tracking_number ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
    </div>
  );
}

