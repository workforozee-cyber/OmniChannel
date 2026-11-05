'use client';
import { useState } from 'react';
import { Field, MarketplaceTag, Modal, Spinner, useToast } from './ui';
import { api } from '@/lib/api';

/**
 * Per-channel customisation. A field left blank follows the master product.
 * Filled fields are frozen for this channel; master edits won't overwrite them until "Re-sync from master".
 */
export function ListingCustomizer({ listing, conn, product, onClose, onSaved }: { listing: any; conn: any; product: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const ov = listing.overrides ?? {};
  const [title, setTitle] = useState(ov.title ?? '');
  const [description, setDescription] = useState(ov.description ?? '');
  const [images, setImages] = useState((ov.images ?? []).map((i: any) => i.url).join('\n'));
  const [category, setCategory] = useState(ov.category ?? '');
  const [syncPrice, setSyncPrice] = useState<boolean>(listing.sync_price_with_master);
  const [price, setPrice] = useState(listing.price_override ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const overrides: any = {
        title: title || null, description: description || null, category: category || null,
        images: images.trim() ? images.split('\n').filter(Boolean).map((url: string) => ({ url: url.trim() })) : null,
      };
      await api(`/listings/${listing.id}`, { method: 'PATCH', json: { overrides, syncPriceWithMaster: syncPrice, ...(!syncPrice && price !== '' ? { priceOverride: Number(price) } : {}) } });
      toast('success', 'Channel customisation saved'); onSaved();
    } catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }
  async function resync() {
    await api(`/listings/${listing.id}/sync-from-master`, { method: 'POST', json: { fields: ['title', 'description', 'images', 'category', 'price'] } });
    toast('success', 'This channel now follows the master product again'); onSaved();
  }

  return (
    <Modal open onClose={onClose} title="Customise for this channel" wide
      footer={<><button className="btn-ghost mr-auto" onClick={resync}>Re-sync everything from master</button><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save</button></>}>
      <div className="mb-4"><MarketplaceTag code={conn.marketplace} mode={conn.mode} account={conn.account_name} /></div>
      <p className="mb-4 text-sm text-slate-500">Leave a field empty to use the master value. Customised values are kept even when you edit the master product.</p>
      <div className="grid gap-4">
        <Field label="Title" hint={`Master: ${product.title}`}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={product.title} /></Field>
        <Field label="Description"><textarea className="input min-h-24" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={product.description} /></Field>
        <Field label="Images (one URL per line)"><textarea className="input min-h-16 font-mono text-xs" value={images} onChange={(e) => setImages(e.target.value)} placeholder="Uses master images" /></Field>
        <Field label="Category"><input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={product.category ?? ''} /></Field>
        <div className="rounded-lg border border-slate-200 p-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={syncPrice} onChange={(e) => setSyncPrice(e.target.checked)} /> Follow master price (plus this channel&apos;s pricing rule)</label>
          {!syncPrice && <Field label="Fixed price for this channel" className="mt-3"><input className="input w-40" type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>}
        </div>
      </div>
    </Modal>
  );
}
