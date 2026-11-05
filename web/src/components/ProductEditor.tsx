'use client';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorBox, Field, Spinner, useToast } from './ui';
import { api } from '@/lib/api';

const emptyVariant = () => ({ sku: '', barcode: '', options: {} as Record<string, string>, price: '', costPrice: '', minPrice: '', maxPrice: '', weightGrams: '', dimensions: { lengthCm: '', widthCm: '', heightCm: '' }, initialStock: '0', safetyBuffer: '', lowStockThreshold: '' });

export function toForm(p: any) {
  return {
    type: p.type, title: p.title, description: p.description ?? '', brand: p.brand ?? '', manufacturer: p.manufacturer ?? '', category: p.category ?? '',
    tags: (p.tags ?? []).join(', '), status: p.status, images: (p.images ?? []).map((i: any) => i.url).join('\n'), videos: (p.videos ?? []).map((v: any) => v.url).join('\n'),
    attributes: p.attributes ?? {}, shipping: p.shipping ?? {}, supplier: p.supplier ?? {},
    variants: p.variants.map((v: any) => ({
      id: v.id, sku: v.sku, barcode: v.barcode ?? '', options: v.options ?? {}, price: String(v.price ?? ''), costPrice: v.cost_price ?? '', minPrice: v.min_price ?? '', maxPrice: v.max_price ?? '',
      weightGrams: v.weight_grams ?? '', dimensions: v.dimensions ?? { lengthCm: '', widthCm: '', heightCm: '' }, safetyBuffer: v.safety_buffer ?? '', lowStockThreshold: v.low_stock_threshold ?? '',
      components: v.components?.map((c: any) => ({ variantId: c.component_variant_id, quantity: c.quantity })),
    })),
  };
}

const n = (v: any) => (v === '' || v == null ? null : Number(v));
function toPayload(f: any) {
  const dims = (d: any) => (d && (d.lengthCm || d.widthCm || d.heightCm) ? { lengthCm: Number(d.lengthCm) || 0, widthCm: Number(d.widthCm) || 0, heightCm: Number(d.heightCm) || 0 } : null);
  return {
    type: f.type, title: f.title, description: f.description, brand: f.brand || null, manufacturer: f.manufacturer || null, category: f.category || null,
    tags: f.tags.split(',').map((t: string) => t.trim()).filter(Boolean), status: f.status,
    images: f.images.split('\n').map((u: string) => u.trim()).filter(Boolean).map((url: string) => ({ url })),
    videos: f.videos.split('\n').map((u: string) => u.trim()).filter(Boolean).map((url: string) => ({ url })),
    attributes: f.attributes, shipping: f.shipping, supplier: f.supplier?.name ? f.supplier : null,
    variants: f.variants.map((v: any) => ({
      ...(v.id && { id: v.id }), sku: v.sku.trim(), barcode: v.barcode || null,
      options: Object.fromEntries(Object.entries(v.options).filter(([, x]) => x)), price: Number(v.price || 0), costPrice: n(v.costPrice), minPrice: n(v.minPrice), maxPrice: n(v.maxPrice),
      weightGrams: n(v.weightGrams), dimensions: dims(v.dimensions), safetyBuffer: n(v.safetyBuffer), lowStockThreshold: n(v.lowStockThreshold),
      ...(!v.id && { initialStock: Number(v.initialStock || 0) }), ...(v.components && { components: v.components }),
    })),
  };
}

export function ProductEditor({ initial, productId, onSaved }: { initial?: any; productId?: string; onSaved?: (p: any) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState<any>(initial ?? { type: 'simple', title: '', description: '', brand: '', manufacturer: '', category: '', tags: '', status: 'active', images: '', videos: '', attributes: {}, shipping: {}, supplier: {}, variants: [emptyVariant()] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const setV = (i: number, k: string, v: any) => setF((x: any) => ({ ...x, variants: x.variants.map((vv: any, j: number) => (j === i ? { ...vv, [k]: v } : vv)) }));
  const setAttr = (mp: string | null, k: string, v: any) => setF((x: any) => mp
    ? { ...x, attributes: { ...x.attributes, [mp]: { ...(x.attributes[mp] ?? {}), [k]: v } } }
    : { ...x, attributes: { ...x.attributes, [k]: v } });
  const a = (mp: string, k: string) => f.attributes?.[mp]?.[k] ?? '';

  async function save() {
    setBusy(true); setErr(null);
    try {
      const body = toPayload(f);
      const p = productId ? await api(`/products/${productId}`, { method: 'PUT', json: body }) : await api('/products', { method: 'POST', json: body });
      toast('success', productId ? 'Product saved — channels that follow the master will update' : 'Product created');
      if (productId) onSaved?.(p); else router.push(`/products/${p.id}`);
    } catch (e: any) { setErr(e.message); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setBusy(false); }
  }

  const variable = f.type === 'variable';
  return (
    <div className="space-y-6">
      {err && <ErrorBox error={err} />}
      <section className="card grid gap-4 p-5 md:grid-cols-2">
        <h2 className="font-semibold md:col-span-2">Product information</h2>
        <Field label="Product title" className="md:col-span-2"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Electric Money Gun" /></Field>
        <Field label="Description" className="md:col-span-2"><textarea className="input min-h-28" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Product type">
          <select className="input" value={f.type} disabled={!!productId} onChange={(e) => set('type', e.target.value)}>
            <option value="simple">Simple (one SKU)</option><option value="variable">Variable (colours / sizes)</option><option value="bundle">Bundle / kit</option>
          </select>
        </Field>
        <Field label="Status"><select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}><option value="active">Active</option><option value="draft">Draft</option></select></Field>
        <Field label="Brand"><input className="input" value={f.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
        <Field label="Manufacturer"><input className="input" value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
        <Field label="Category"><input className="input" value={f.category} onChange={(e) => set('category', e.target.value)} /></Field>
        <Field label="Tags" hint="Comma separated"><input className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} /></Field>
        <Field label="Image URLs" hint="One per line; first is the main image" className="md:col-span-2"><textarea className="input min-h-20 font-mono text-xs" value={f.images} onChange={(e) => set('images', e.target.value)} /></Field>
        {f.images.trim() && <div className="flex gap-2 md:col-span-2">{f.images.split('\n').filter(Boolean).slice(0, 8).map((u: string) => <img key={u} src={u.trim()} alt="" className="h-16 w-16 rounded-md border border-slate-200 object-cover" />)}</div>}
        <Field label="Video URLs (where supported)" className="md:col-span-2"><textarea className="input min-h-12 font-mono text-xs" value={f.videos} onChange={(e) => set('videos', e.target.value)} /></Field>
        <Field label="Condition"><select className="input" value={f.attributes.condition ?? ''} onChange={(e) => setAttr(null, 'condition', e.target.value)}><option value="">—</option><option value="NEW">New</option><option value="USED_EXCELLENT">Used – excellent</option><option value="USED_GOOD">Used – good</option></select></Field>
        <Field label="Material"><input className="input" value={f.attributes.material ?? ''} onChange={(e) => setAttr(null, 'material', e.target.value)} /></Field>
      </section>

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{variable ? 'Variations' : f.type === 'bundle' ? 'Bundle SKU' : 'SKU, pricing & stock'}</h2>
          {variable && <button className="btn-secondary" onClick={() => set('variants', [...f.variants, emptyVariant()])}><Plus className="h-4 w-4" /> Add variation</button>}
        </div>
        <div className="space-y-4">
          {f.variants.map((v: any, i: number) => (
            <div key={v.id ?? i} className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-6">
              <Field label="SKU"><input className="input" value={v.sku} onChange={(e) => setV(i, 'sku', e.target.value)} /></Field>
              <Field label="Barcode (UPC/EAN)"><input className="input" value={v.barcode} onChange={(e) => setV(i, 'barcode', e.target.value)} /></Field>
              {variable && (['color', 'size', 'material'] as const).map((o) => (
                <Field key={o} label={o}><input className="input" value={v.options[o] ?? ''} onChange={(e) => setV(i, 'options', { ...v.options, [o]: e.target.value })} /></Field>
              ))}
              <Field label="Selling price"><input className="input" type="number" step="0.01" value={v.price} onChange={(e) => setV(i, 'price', e.target.value)} /></Field>
              <Field label="Purchase cost"><input className="input" type="number" step="0.01" value={v.costPrice} onChange={(e) => setV(i, 'costPrice', e.target.value)} /></Field>
              <Field label="Min price" hint="Price protection"><input className="input" type="number" step="0.01" value={v.minPrice} onChange={(e) => setV(i, 'minPrice', e.target.value)} /></Field>
              <Field label="Max price"><input className="input" type="number" step="0.01" value={v.maxPrice} onChange={(e) => setV(i, 'maxPrice', e.target.value)} /></Field>
              <Field label="Weight (g)"><input className="input" type="number" value={v.weightGrams} onChange={(e) => setV(i, 'weightGrams', e.target.value)} /></Field>
              <Field label="L × W × H (cm)">
                <div className="flex gap-1">{(['lengthCm', 'widthCm', 'heightCm'] as const).map((d) => <input key={d} className="input px-2" type="number" value={v.dimensions?.[d] ?? ''} onChange={(e) => setV(i, 'dimensions', { ...v.dimensions, [d]: e.target.value })} />)}</div>
              </Field>
              {!v.id && f.type !== 'bundle' && <Field label="Opening stock"><input className="input" type="number" min={0} value={v.initialStock} onChange={(e) => setV(i, 'initialStock', e.target.value)} /></Field>}
              <Field label="Safety buffer" hint="Units held back"><input className="input" type="number" min={0} value={v.safetyBuffer} onChange={(e) => setV(i, 'safetyBuffer', e.target.value)} placeholder="Org default" /></Field>
              <Field label="Low-stock alert at"><input className="input" type="number" min={0} value={v.lowStockThreshold} onChange={(e) => setV(i, 'lowStockThreshold', e.target.value)} placeholder="Org default" /></Field>
              {f.type === 'bundle' && <BundleComponents value={v.components ?? []} onChange={(c) => setV(i, 'components', c)} />}
              {variable && f.variants.length > 1 && <div className="flex items-end"><button className="btn-ghost text-rose-600" onClick={() => set('variants', f.variants.filter((_: any, j: number) => j !== i))}><Trash2 className="h-4 w-4" /> Remove</button></div>}
            </div>
          ))}
        </div>
      </section>

      <section className="card grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-4">
        <h2 className="font-semibold md:col-span-2 lg:col-span-4">Marketplace-specific attributes</h2>
        <p className="-mt-2 text-sm text-slate-500 md:col-span-2 lg:col-span-4">Fields each marketplace requires. Missing ones are reported per channel when you publish — nothing else is blocked.</p>
        <Field label="eBay category ID"><input className="input" value={a('ebay', 'categoryId')} onChange={(e) => setAttr('ebay', 'categoryId', e.target.value)} /></Field>
        <Field label="Amazon product type"><input className="input" value={a('amazon', 'productType')} onChange={(e) => setAttr('amazon', 'productType', e.target.value)} placeholder="e.g. TOY_FIGURE" /></Field>
        <Field label="Amazon condition"><input className="input" value={a('amazon', 'condition')} onChange={(e) => setAttr('amazon', 'condition', e.target.value)} placeholder="new_new" /></Field>
        <Field label="Amazon bullet points" hint="One per line"><textarea className="input min-h-10" value={(f.attributes.amazon?.bulletPoints ?? []).join('\n')} onChange={(e) => setAttr('amazon', 'bulletPoints', e.target.value.split('\n').filter(Boolean))} /></Field>
        <Field label="Etsy taxonomy ID"><input className="input" type="number" value={a('etsy', 'taxonomyId')} onChange={(e) => setAttr('etsy', 'taxonomyId', e.target.value ? Number(e.target.value) : '')} /></Field>
        <Field label="Etsy: who made it"><select className="input" value={a('etsy', 'whoMade')} onChange={(e) => setAttr('etsy', 'whoMade', e.target.value)}><option value="">—</option><option value="i_did">I did</option><option value="someone_else">Someone else</option><option value="collective">A member of my shop</option></select></Field>
        <Field label="Etsy: when made"><input className="input" value={a('etsy', 'whenMade')} onChange={(e) => setAttr('etsy', 'whenMade', e.target.value)} placeholder="made_to_order / 2020_2026" /></Field>
        <Field label="Etsy: craft supply?"><select className="input" value={a('etsy', 'isSupply') === '' ? '' : String(a('etsy', 'isSupply'))} onChange={(e) => setAttr('etsy', 'isSupply', e.target.value === '' ? '' : e.target.value === 'true')}><option value="">—</option><option value="false">No, finished product</option><option value="true">Yes, a supply</option></select></Field>
        <Field label="Walmart product type"><input className="input" value={a('walmart', 'productType')} onChange={(e) => setAttr('walmart', 'productType', e.target.value)} /></Field>
      </section>

      <section className="card grid gap-4 p-5 md:grid-cols-3">
        <h2 className="font-semibold md:col-span-3">Shipping & supplier</h2>
        <Field label="Handling time (days)"><input className="input" type="number" value={f.shipping.handlingDays ?? ''} onChange={(e) => set('shipping', { ...f.shipping, handlingDays: Number(e.target.value) })} /></Field>
        <Field label="Shipping profile / notes"><input className="input" value={f.shipping.profile ?? ''} onChange={(e) => set('shipping', { ...f.shipping, profile: e.target.value })} /></Field>
        <div />
        <Field label="Supplier"><input className="input" value={f.supplier?.name ?? ''} onChange={(e) => set('supplier', { ...f.supplier, name: e.target.value })} /></Field>
        <Field label="Supplier SKU"><input className="input" value={f.supplier?.sku ?? ''} onChange={(e) => set('supplier', { ...f.supplier, sku: e.target.value })} /></Field>
        <Field label="Lead time (days)"><input className="input" type="number" value={f.supplier?.leadTimeDays ?? ''} onChange={(e) => set('supplier', { ...f.supplier, leadTimeDays: Number(e.target.value) })} /></Field>
      </section>

      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-slate-200 bg-white/90 p-4 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <button className="btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}{productId ? 'Save changes' : 'Create product'}</button>
      </div>
    </div>
  );
}

function BundleComponents({ value, onChange }: { value: { variantId: string; quantity: number }[]; onChange: (v: any[]) => void }) {
  const [search, setSearch] = useState('');
  const [opts, setOpts] = useState<any[]>([]);
  const find = async (s: string) => { setSearch(s); if (s.length > 1) setOpts((await api(`/inventory?search=${encodeURIComponent(s)}&pageSize=8`)).rows); };
  return (
    <div className="sm:col-span-2 lg:col-span-6">
      <span className="label">Components</span>
      {value.map((c, i) => (
        <div key={c.variantId} className="mb-1 flex items-center gap-2 text-sm">
          <code className="rounded bg-slate-100 px-1.5">{c.variantId.slice(0, 8)}</code> ×
          <input className="input w-20" type="number" min={1} value={c.quantity} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
          <button className="btn-ghost p-1 text-rose-600" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      <input className="input" placeholder="Search SKU to add a component…" value={search} onChange={(e) => find(e.target.value)} />
      {opts.length > 0 && <div className="mt-1 rounded-lg border border-slate-200">{opts.map((o) => (
        <button key={o.id} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50" onClick={() => { onChange([...value, { variantId: o.id, quantity: 1 }]); setOpts([]); setSearch(''); }}>{o.sku} — {o.title}</button>
      ))}</div>}
    </div>
  );
}
