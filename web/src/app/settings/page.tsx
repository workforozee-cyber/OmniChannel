'use client';
import { useEffect, useState } from 'react';
import { Badge, Field, Loading, PageHeader, Spinner, Table, useApi, useToast } from '@/components/ui';
import { api } from '@/lib/api';

export default function Settings() {
  const toast = useToast();
  const { data, reload } = useApi('/settings');
  const { data: users, reload: reloadUsers } = useApi('/auth/users');
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [inv, setInv] = useState({ name: '', email: '', password: '', role: 'manager' });
  const [wh, setWh] = useState('');
  useEffect(() => { if (data) setF({ name: data.organization.name, currency: data.organization.currency, mode: data.organization.settings.safetyBuffer?.mode ?? 'units', value: data.organization.settings.safetyBuffer?.value ?? 0, low: data.organization.settings.lowStockThreshold ?? 5 }); }, [data]);
  if (!data || !f) return <Loading />;

  async function save() {
    setBusy(true);
    try {
      await api('/settings', { method: 'PATCH', json: { name: f.name, currency: f.currency, safetyBuffer: { mode: f.mode, value: Number(f.value) }, lowStockThreshold: Number(f.low) } });
      toast('success', 'Settings saved — channel quantities are being recalculated'); reload();
    } catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-4 p-5">
          <h2 className="font-semibold">Business</h2>
          <Field label="Business name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Currency"><select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'PKR'].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <h2 className="pt-2 font-semibold">Inventory protection</h2>
          <p className="text-sm text-slate-500">Safety buffer: stock you hold back from every marketplace. With 100 on hand and a buffer of 5, channels show 95. A per-SKU buffer on the product overrides this.</p>
          <div className="flex gap-2">
            <Field label="Buffer type"><select className="input" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="units">Units</option><option value="percent">% of on-hand</option></select></Field>
            <Field label={f.mode === 'units' ? 'Units' : 'Percent'}><input className="input w-28" type="number" min={0} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
            <Field label="Low-stock alert at"><input className="input w-28" type="number" min={0} value={f.low} onChange={(e) => setF({ ...f, low: e.target.value })} /></Field>
          </div>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save settings</button>
        </section>

        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="mb-1 font-semibold">Warehouses</h2>
            <p className="mb-3 text-sm text-slate-500">Orders reserve from the default warehouse first, then any other that can cover the full quantity.</p>
            <ul className="mb-3 space-y-1 text-sm">{data.warehouses.map((w: any) => <li key={w.id}>{w.name} {w.is_default && <Badge tone="blue">default</Badge>}</li>)}</ul>
            <div className="flex gap-2"><input className="input" placeholder="New warehouse name" value={wh} onChange={(e) => setWh(e.target.value)} />
              <button className="btn-secondary" disabled={!wh} onClick={async () => { try { await api('/warehouses', { method: 'POST', json: { name: wh } }); setWh(''); reload(); } catch (e: any) { toast('error', e.message); } }}>Add</button></div>
          </section>
          <section className="card p-5">
            <h2 className="mb-3 font-semibold">Team & roles</h2>
            {users && <Table><thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th></tr></thead><tbody>{users.map((u: any) => <tr key={u.id}><td className="td">{u.name}</td><td className="td">{u.email}</td><td className="td"><Badge>{u.role}</Badge></td></tr>)}</tbody></Table>}
            <p className="my-3 text-xs text-slate-500">Owner/Admin: everything incl. connections and settings · Manager: products, listings, stock, orders · Viewer: read-only.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="input" placeholder="Name" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} />
              <input className="input" placeholder="Email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
              <input className="input" placeholder="Temporary password (10+ chars)" type="password" value={inv.password} onChange={(e) => setInv({ ...inv, password: e.target.value })} />
              <select className="input" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}><option value="admin">Admin</option><option value="manager">Manager</option><option value="viewer">Viewer</option></select>
            </div>
            <button className="btn-secondary mt-2" onClick={async () => { try { await api('/auth/users', { method: 'POST', json: inv }); toast('success', 'User added'); setInv({ name: '', email: '', password: '', role: 'manager' }); reloadUsers(); } catch (e: any) { toast('error', e.message); } }}>Add user</button>
          </section>
        </div>
      </div>
    </>
  );
}
