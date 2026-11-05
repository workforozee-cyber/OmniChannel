'use client';
import { CheckCircle2, Copy, Plus, RefreshCw, Trash2, XCircle, Zap } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Badge, ErrorBox, Field, Loading, MarketplaceTag, MockBadge, Modal, PageHeader, Spinner, StatusBadge, useApi, useConfirm, useToast } from '@/components/ui';
import { api, fmtDate, MP_NAME } from '@/lib/api';

function Marketplaces() {
  const sp = useSearchParams();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { data: catalog } = useApi('/marketplaces/catalog');
  const { data: conns, reload } = useApi('/marketplaces/connections');
  const [connect, setConnect] = useState<any>(null);
  const [settingsFor, setSettingsFor] = useState<any>(null);
  const [simulate, setSimulate] = useState<any>(null);
  useEffect(() => {
    if (sp.get('connected')) toast('success', `${MP_NAME[sp.get('connected')!]} connected`);
    if (sp.get('error')) toast('error', sp.get('error')!);
  }, [sp, toast]);
  if (!catalog || !conns) return <Loading />;

  async function disconnect(c: any) {
    if (!(await confirm('Disconnect account?', `Disconnect ${c.account_name}? Stored credentials are deleted and stock stops syncing to this channel. Listings on the marketplace are not removed.`, { danger: true, confirmLabel: 'Disconnect' }))) return;
    await api(`/marketplaces/connections/${c.id}`, { method: 'DELETE' }); toast('success', 'Disconnected'); reload();
  }
  async function syncNow(c: any) { await api(`/marketplaces/connections/${c.id}/sync`, { method: 'POST' }); toast('info', 'Order download and stock reconciliation queued'); reload(); }

  return (
    <>
      <PageHeader title="Marketplaces" description="Connect seller accounts with each marketplace's official sign-in. Secrets are encrypted and never shown again." />
      <div className="space-y-4">
        {catalog.map((m: any) => {
          const mine = conns.filter((c: any) => c.marketplace === m.code);
          const cap = m.capabilities;
          return (
            <div key={m.code} className="card">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><MarketplaceTag code={m.code} />
                    {cap.implementation === 'live' ? <Badge tone="green">Live integration</Badge> : <Badge tone="amber">Framework — use mock until credentials &amp; approval</Badge>}
                  </div>
                  <div className="mt-2 grid gap-x-6 gap-y-1 text-xs text-slate-500 sm:grid-cols-2">
                    <span>Auth: {cap.auth.replace('_', ' ')}</span><span>Orders: {cap.orderDetection}</span>
                    <span>Tracking upload: {cap.trackingUpload ? 'yes' : 'no'} · Labels via API: {cap.labelPurchase ? 'yes' : 'no'}</span><span>Pause: {cap.pauseListing.replace('_', ' ')}</span>
                  </div>
                  {cap.approval && <div className="mt-2 max-w-3xl rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900"><b>Approval needed:</b> {cap.approval}</div>}
                </div>
                <button className="btn-secondary shrink-0" onClick={() => setConnect(m)}><Plus className="h-4 w-4" /> Connect account</button>
              </div>
              {mine.length > 0 && <ul className="divide-y divide-slate-100">{mine.map((c: any) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">{c.status === 'connected' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-rose-500" />}{c.account_name}{c.mode === 'mock' && <MockBadge />}<StatusBadge status={c.status} /></div>
                    <div className="mt-0.5 text-xs text-slate-400">Last sync {fmtDate(c.last_sync_at, true)}{c.last_error && <span className="text-rose-600"> · {c.last_error}</span>}</div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {c.mode === 'mock' && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setSimulate(c)}><Zap className="h-3.5 w-3.5" /> Simulate order</button>}
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setSettingsFor(c)}>Settings</button>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => syncNow(c)}><RefreshCw className="h-3.5 w-3.5" /> Sync now</button>
                    {c.status === 'expired' && c.mode === 'live' && <button className="btn-primary px-2 py-1 text-xs" onClick={async () => { const r = await api(`/marketplaces/connections/${c.marketplace}/oauth`, { method: 'POST', json: { reconnectId: c.id, shop: c.account_name } }); window.location.href = r.url; }}>Reconnect</button>}
                    <button className="btn-ghost px-2 py-1 text-xs text-rose-600" onClick={() => disconnect(c)}><Trash2 className="h-3.5 w-3.5" /> Disconnect</button>
                  </div>
                </li>
              ))}</ul>}
            </div>
          );
        })}
      </div>
      {connect && <ConnectModal m={connect} onClose={() => setConnect(null)} onDone={() => { setConnect(null); reload(); }} />}
      {settingsFor && <SettingsModal c={settingsFor} onClose={() => setSettingsFor(null)} onDone={() => { setSettingsFor(null); reload(); }} />}
      {simulate && <SimulateModal c={simulate} onClose={() => setSimulate(null)} />}
      {dialog}
    </>
  );
}

function ConnectModal({ m, onClose, onDone }: { m: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [shop, setShop] = useState('');
  const [name, setName] = useState(`${m.name} store`);
  const [creds, setCreds] = useState({ clientId: '', clientSecret: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function live() {
    setErr(null); setBusy(true);
    try {
      if (m.capabilities.auth === 'client_credentials') {
        await api(`/marketplaces/connections/${m.code}/credentials`, { method: 'POST', json: { accountName: name, ...creds } }); toast('success', 'Credentials stored (encrypted)'); onDone();
      } else {
        const r = await api(`/marketplaces/connections/${m.code}/oauth`, { method: 'POST', json: m.code === 'shopify' ? { shop } : {} });
        window.location.href = r.url;
      }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function mock() {
    setBusy(true);
    try {
      await api('/marketplaces/connections/mock', { method: 'POST', json: { marketplace: m.code, accountName: name } }); toast('success', `${m.name} connected in mock mode`); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Connect ${m.name}`}>
      {err && <div className="mb-3"><ErrorBox error={err} /></div>}
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="mb-1 font-medium">Live connection</div>
          <p className="mb-3 text-sm text-slate-500">{m.capabilities.auth === 'client_credentials' ? 'Paste the API keys from your Walmart Seller Center. They are encrypted immediately and never displayed again.' : `You'll be sent to ${m.name} to sign in and approve access. We never see your password.`}</p>
          {m.code === 'shopify' && <Field label="Shop domain"><input className="input" placeholder="your-store.myshopify.com" value={shop} onChange={(e) => setShop(e.target.value.trim())} /></Field>}
          {m.capabilities.auth === 'client_credentials' && (<div className="space-y-2">
            <Field label="Account name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Client ID"><input className="input" value={creds.clientId} onChange={(e) => setCreds({ ...creds, clientId: e.target.value })} /></Field>
            <Field label="Client secret"><input className="input" type="password" autoComplete="off" value={creds.clientSecret} onChange={(e) => setCreds({ ...creds, clientSecret: e.target.value })} /></Field>
          </div>)}
          <button className="btn-primary mt-3" disabled={busy} onClick={live}>{busy && <Spinner />}{m.capabilities.auth === 'client_credentials' ? 'Save credentials' : `Continue to ${m.name}`}</button>
          {m.capabilities.implementation !== 'live' && <p className="mt-2 text-xs text-amber-700">This marketplace&apos;s live listing/stock calls aren&apos;t implemented yet, so a live connection can authenticate but won&apos;t sync. Use mock mode for now.</p>}
        </div>
        <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-4">
          <div className="mb-1 flex items-center gap-2 font-medium">Mock / sandbox connection <MockBadge /></div>
          <p className="mb-3 text-sm text-slate-600">Try the full workflow without real credentials. Uses {m.name}&apos;s real validation rules but never contacts {m.name}. Everything it creates is labelled MOCK.</p>
          <Field label="Account name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <button className="btn-secondary mt-3" disabled={busy} onClick={mock}>Connect in mock mode</button>
        </div>
      </div>
    </Modal>
  );
}

const SETTING_FIELDS: Record<string, [string, string][]> = {
  ebay: [['marketplaceId', 'eBay marketplace (e.g. EBAY_GB)'], ['merchantLocationKey', 'Merchant location key'], ['fulfillmentPolicyId', 'Fulfillment policy ID'], ['paymentPolicyId', 'Payment policy ID'], ['returnPolicyId', 'Return policy ID']],
  etsy: [['shippingProfileId', 'Default shipping profile ID']],
  shopify: [['locationId', 'Inventory location ID (auto-detected)']],
  amazon: [['marketplaceId', 'Amazon marketplace ID']], walmart: [],
};
function SettingsModal({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<any>({ ...c.settings });
  async function save() {
    try { await api(`/marketplaces/connections/${c.id}`, { method: 'PATCH', json: s }); toast('success', 'Saved'); onDone(); } catch (e: any) { toast('error', e.message); }
  }
  return (
    <Modal open onClose={onClose} title={`${c.account_name} settings`} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
      <div className="space-y-3">
        {(SETTING_FIELDS[c.marketplace] ?? []).map(([k, label]) => <Field key={k} label={label}><input className="input" value={s[k] ?? ''} onChange={(e) => setS({ ...s, [k]: e.target.value })} /></Field>)}
        <Field label="Webhook URL" hint="Register this with the marketplace if it isn't registered automatically">
          <div className="flex gap-1"><input className="input font-mono text-xs" readOnly value={c.webhookUrl} /><button className="btn-secondary px-2" onClick={() => { navigator.clipboard.writeText(c.webhookUrl); toast('info', 'Copied'); }}><Copy className="h-4 w-4" /></button></div>
        </Field>
        {c.mode === 'mock' && (<div className="rounded-lg border border-violet-200 p-3 text-sm">
          <div className="mb-2 font-medium">Failure simulation (mock only)</div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={!!s.mockFailInventory} onChange={(e) => setS({ ...s, mockFailInventory: e.target.checked })} /> Fail inventory updates</label>
          <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={!!s.mockFailPublish} onChange={(e) => setS({ ...s, mockFailPublish: e.target.checked })} /> Reject new listings</label>
        </div>)}
      </div>
    </Modal>
  );
}

function SimulateModal({ c, onClose }: { c: any; onClose: () => void }) {
  const toast = useToast();
  const [sku, setSku] = useState('MG-001');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { const r = await api(`/marketplaces/connections/${c.id}/mock-order`, { method: 'POST', json: { items: [{ sku, quantity: qty }] } }); toast('success', `Mock order created — stock deducted and synced to all channels`); onClose(); window.location.href = `/orders/${r.orderId}`; }
    catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Simulate a ${MP_NAME[c.marketplace]} order`} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={go}>{busy && <Spinner />}Create mock order</button></>}>
      <p className="mb-3 text-sm text-slate-500">Runs the same order pipeline as a real webhook: de-duplication, atomic stock reservation, then a quantity push to every connected channel. <MockBadge /></p>
      <div className="flex gap-2"><Field label="SKU" className="flex-1"><input className="input" value={sku} onChange={(e) => setSku(e.target.value)} /></Field><Field label="Quantity"><input className="input w-24" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></Field></div>
    </Modal>
  );
}
export default function Page() { return <Suspense><Marketplaces /></Suspense>; }
