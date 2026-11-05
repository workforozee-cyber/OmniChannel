'use client';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ErrorBox, Loading, MarketplaceTag, PageHeader, Stat, StatusBadge, useApi } from '@/components/ui';
import { fmtDate, money, MP_NAME } from '@/lib/api';

export default function Dashboard() {
  const { data: d, error } = useApi('/analytics/dashboard');
  const { data: s } = useApi('/analytics/sales');
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const byMp = (s?.byMarketplace ?? []).map((m: any) => ({ name: MP_NAME[m.marketplace], Revenue: Number(m.gross), Orders: m.orders }));

  return (
    <>
      <PageHeader title="Dashboard" description="Your whole business across every channel." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total orders" value={d.total_orders} />
        <Stat label="Total revenue" value={money(d.total_revenue)} sub="Gross, excl. cancelled" />
        <Stat label="Products" value={d.total_products} />
        <Stat label="Active listings" value={d.active_listings} />
        <Link href="/orders?status=new"><Stat label="Pending orders" value={d.pending_orders} tone={d.pending_orders ? 'amber' : undefined} /></Link>
        <Link href="/orders?fulfillment=unfulfilled"><Stat label="Unfulfilled" value={d.unfulfilled_orders} tone={d.unfulfilled_orders ? 'amber' : undefined} /></Link>
        <Link href="/inventory?stock=low"><Stat label="Low stock" value={d.low_stock_products} tone={d.low_stock_products ? 'amber' : undefined} /></Link>
        <Link href="/inventory?stock=out"><Stat label="Out of stock" value={d.out_of_stock_products} tone={d.out_of_stock_products ? 'red' : undefined} /></Link>
        <Link href="/listings?status=failed"><Stat label="Failed / incomplete listings" value={d.failed_listings} tone={d.failed_listings ? 'red' : undefined} /></Link>
        <Link href="/activity?level=error"><Stat label="Failed syncs (24h)" value={d.failed_syncs_24h} tone={d.failed_syncs_24h ? 'red' : 'green'} /></Link>
        <Link href="/orders?conflict=true"><Stat label="Stock conflicts" value={d.stock_conflicts} tone={d.stock_conflicts ? 'red' : 'green'} sub="Orders that exceeded stock" /></Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Revenue by marketplace</h2><span className="text-xs text-slate-500">Last 30 days</span></div>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={byMp} margin={{ left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => `£${v}`} />
                <Tooltip formatter={(v: any, n: any) => (n === 'Revenue' ? money(v) : v)} />
                <Bar dataKey="Revenue" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><h2 className="font-semibold">Marketplace connections</h2><Link href="/marketplaces" className="text-sm text-indigo-600">Manage</Link></div>
          <ul className="divide-y divide-slate-100">
            {d.connections.map((c: any) => (
              <li key={c.id} className="flex items-center justify-between px-4 py-2.5">
                <div><MarketplaceTag code={c.marketplace} mode={c.mode} /><div className="text-xs text-slate-400">Synced {fmtDate(c.last_sync_at, true)}</div></div>
                <StatusBadge status={c.status} />
              </li>
            ))}
            {!d.connections.length && <li className="p-4 text-sm text-slate-500">No marketplaces connected yet. <Link className="text-indigo-600" href="/marketplaces">Connect one</Link>.</li>}
          </ul>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <StockList title="Low stock" rows={d.lowStock} tone="amber" />
        <StockList title="Out of stock" rows={d.outOfStock} tone="red" />
      </div>
    </>
  );
}

function StockList({ title, rows, tone }: { title: string; rows: any[]; tone: 'amber' | 'red' }) {
  return (
    <div className="card">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold">{title}</div>
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <Link href={`/products/${r.product_id}`} className="hover:underline"><span className="font-medium">{r.title}</span> <span className="text-slate-400">{r.sku}</span></Link>
            <span className={tone === 'red' ? 'font-semibold text-rose-600' : 'font-semibold text-amber-600'}>{r.available}</span>
          </li>
        ))}
        {!rows.length && <li className="px-4 py-3 text-sm text-slate-500">Nothing here.</li>}
      </ul>
    </div>
  );
}
