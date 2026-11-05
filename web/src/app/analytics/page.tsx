'use client';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Field, Loading, PageHeader, Stat, Table, useApi } from '@/components/ui';
import { MARKETPLACES, money, MP_NAME } from '@/lib/api';

// Brand-neutral categorical palette, one fixed colour per marketplace so charts stay consistent.
const COLORS: Record<string, string> = { ebay: '#4f46e5', amazon: '#0891b2', etsy: '#ea580c', walmart: '#16a34a', shopify: '#db2777' };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function Analytics() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [mp, setMp] = useState('');
  const [gran, setGran] = useState<'day' | 'month'>('day');
  const { data } = useApi(`/analytics/sales?from=${from}&to=${to}&granularity=${gran}${mp ? `&marketplace=${mp}` : ''}`);
  const { data: inv } = useApi('/analytics/inventory-value');

  const series = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, any>();
    for (const r of data.series) {
      const k = r.bucket.slice(0, gran === 'day' ? 10 : 7);
      const row = m.get(k) ?? { bucket: k };
      row[r.marketplace] = Number(r.gross); m.set(k, row);
    }
    return Array.from(m.values());
  }, [data, gran]);

  if (!data) return <Loading />;
  const s = data.summary;
  const shown = mp ? [mp] : MARKETPLACES.filter((m) => data.byMarketplace.some((b: any) => b.marketplace === m));

  return (
    <>
      <PageHeader title="Analytics & Reports" description="Gross sales, refunds, fees and estimated profit — kept separate." />
      <div className="card mb-6 flex flex-wrap items-end gap-3 p-3">
        <Field label="From"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Marketplace"><select className="input" value={mp} onChange={(e) => setMp(e.target.value)}><option value="">All</option>{MARKETPLACES.map((m) => <option key={m} value={m}>{MP_NAME[m]}</option>)}</select></Field>
        <Field label="Group by"><select className="input" value={gran} onChange={(e) => setGran(e.target.value as any)}><option value="day">Day</option><option value="month">Month</option></select></Field>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Orders" value={s.orders} />
        <Stat label="Gross sales" value={money(s.gross)} />
        <Stat label="Refunds" value={money(s.refunds)} tone={s.refunds ? 'red' : undefined} />
        <Stat label="Marketplace fees" value={s.fees == null ? 'Unknown' : money(s.fees)} sub={s.orders_missing_fees ? `${s.orders_missing_fees} order(s) without fee data` : 'Reported by marketplaces'} />
        <Stat label="Cost of goods" value={money(s.cogs)} sub={s.cogs_complete ? undefined : 'Some SKUs missing cost'} />
        <Stat label="Estimated profit" value={money(s.estimated_profit)} tone={s.estimated_profit >= 0 ? 'green' : 'red'} sub={s.profit_is_partial ? 'Estimate — some fee/cost data missing' : 'Gross − refunds − fees − shipping − tax − COGS'} />
      </div>

      <div className="card mt-6 p-4">
        <h2 className="mb-3 font-semibold">{gran === 'day' ? 'Daily' : 'Monthly'} sales by marketplace</h2>
        <div className="h-72"><ResponsiveContainer>
          <LineChart data={series} margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v) => (gran === 'day' ? v.slice(5) : v)} />
            <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v) => `£${v}`} />
            <Tooltip formatter={(v: any) => money(v)} /><Legend />
            {shown.map((m) => <Line key={m} type="monotone" dataKey={m} name={MP_NAME[m]} stroke={COLORS[m]} strokeWidth={2} dot={false} connectNulls />)}
          </LineChart>
        </ResponsiveContainer></div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 font-semibold">Revenue & orders by marketplace</h2>
          <div className="h-64"><ResponsiveContainer>
            <BarChart data={data.byMarketplace.map((b: any) => ({ name: MP_NAME[b.marketplace], Revenue: Number(b.gross), Orders: b.orders }))}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis yAxisId="l" tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v) => `£${v}`} />
              <YAxis yAxisId="r" orientation="right" tickLine={false} axisLine={false} fontSize={11} />
              <Tooltip formatter={(v: any, n: any) => (n === 'Revenue' ? money(v) : v)} /><Legend />
              <Bar yAxisId="l" dataKey="Revenue" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="r" dataKey="Orders" fill="#94a3b8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer></div>
          <Table><thead><tr><th className="th">Marketplace</th><th className="th">Orders</th><th className="th">Gross</th><th className="th">Refunds</th><th className="th">Fees</th></tr></thead><tbody>
            {data.byMarketplace.map((b: any) => <tr key={b.marketplace}><td className="td">{MP_NAME[b.marketplace]}</td><td className="td">{b.orders}</td><td className="td">{money(b.gross)}</td><td className="td">{money(b.refunds)}</td><td className="td">{b.fees == null ? '—' : money(b.fees)}</td></tr>)}
          </tbody></Table>
        </div>
        <div className="space-y-6">
          <div className="card">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold">Best-selling products</div>
            <Table><thead><tr><th className="th">SKU</th><th className="th">Units</th><th className="th">Revenue</th></tr></thead><tbody>
              {data.bestSellers.map((b: any) => <tr key={b.sku}><td className="td"><div className="font-medium">{b.sku}</div><div className="text-xs text-slate-500">{b.title}</div></td><td className="td tabular-nums">{b.units}</td><td className="td tabular-nums">{money(b.revenue)}</td></tr>)}
            </tbody></Table>
          </div>
          {inv && <div className="grid grid-cols-3 gap-3">
            <Stat label="Units in stock" value={inv.units} />
            <Stat label="Inventory at cost" value={money(inv.at_cost)} sub={inv.skus_missing_cost ? `${inv.skus_missing_cost} SKU(s) without cost` : undefined} />
            <Stat label="At retail" value={money(inv.at_retail)} />
          </div>}
        </div>
      </div>
    </>
  );
}
