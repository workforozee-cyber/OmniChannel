'use client';
import { Suspense } from 'react';
import { OrdersTable } from '@/components/OrdersTable';
import { Badge, Loading, PageHeader, Table, useApi } from '@/components/ui';

export default function Shipping() {
  const { data } = useApi('/marketplaces/catalog');
  return (
    <>
      <PageHeader title="Shipping & Fulfillment" description="Orders waiting to ship, and what each marketplace lets you do from here." />
      <div className="card mb-6">
        <div className="border-b border-slate-200 px-4 py-3 font-semibold">Fulfillment options by marketplace</div>
        {!data ? <Loading /> : <Table>
          <thead className="bg-slate-50"><tr><th className="th">Marketplace</th><th className="th">Add tracking via API</th><th className="th">Buy labels via API</th><th className="th">Where labels are made</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.map((m: any) => (
            <tr key={m.code}>
              <td className="td font-medium">{m.name}</td>
              <td className="td"><Badge tone={m.capabilities.trackingUpload ? 'green' : 'slate'}>{m.capabilities.trackingUpload ? 'Yes' : 'No'}</Badge></td>
              <td className="td"><Badge tone={m.capabilities.labelPurchase ? 'blue' : 'slate'}>{m.capabilities.labelPurchase ? 'Supported by API (needs approval)' : 'No'}</Badge></td>
              <td className="td whitespace-normal text-xs text-slate-500">{m.capabilities.notes.find((n: string) => /label/i.test(n)) ?? '—'}</td>
            </tr>
          ))}</tbody>
        </Table>}
      </div>
      <h2 className="mb-3 font-semibold">Orders to fulfil</h2>
      <Suspense><OrdersTable shipping /></Suspense>
    </>
  );
}
