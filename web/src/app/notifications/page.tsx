'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Empty, Loading, PageHeader, useApi } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

const LINK: Record<string, (id: string) => string> = { order: (id) => `/orders/${id}`, listing: () => '/listings?status=failed', variant: () => '/inventory?stock=low', connection: () => '/marketplaces' };

export default function Notifications() {
  const [unread, setUnread] = useState(false);
  const { data, reload } = useApi(`/notifications?pageSize=100${unread ? '&unread=true' : ''}`);
  return (
    <>
      <PageHeader title="Notifications" description="Orders, stock alerts, failed listings, expired connections and sync errors."
        actions={<><button className="btn-secondary" onClick={() => setUnread(!unread)}>{unread ? 'Show all' : 'Unread only'}</button><button className="btn-secondary" onClick={async () => { await api('/notifications/read', { method: 'POST', json: {} }); reload(); }}>Mark all read</button></>} />
      <div className="card divide-y divide-slate-100">
        {!data ? <Loading /> : !data.length ? <Empty title="You're all caught up" /> : data.map((n: any) => (
          <div key={n.id} className={`flex items-start gap-3 px-4 py-3 ${n.read_at ? 'opacity-60' : ''}`}>
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.severity === 'error' ? 'bg-rose-500' : n.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500'}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{n.ref_type && LINK[n.ref_type] ? <Link href={LINK[n.ref_type](n.ref_id)} className="hover:underline">{n.title}</Link> : n.title}<Badge>{n.type.replace(/_/g, ' ')}</Badge></div>
              {n.body && <div className="text-sm text-slate-500">{n.body}</div>}
            </div>
            <div className="shrink-0 text-xs text-slate-400">{fmtDate(n.created_at, true)}</div>
            {!n.read_at && <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { await api('/notifications/read', { method: 'POST', json: { ids: [n.id] } }); reload(); }}>Mark read</button>}
          </div>
        ))}
      </div>
    </>
  );
}
