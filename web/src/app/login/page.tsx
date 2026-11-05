'use client';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { ErrorBox, Field, Spinner } from '@/components/ui';
import { api, setToken } from '@/lib/api';

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', name: '', organization: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const r = await api(`/auth/${mode}`, { method: 'POST', json: mode === 'login' ? { email: f.email, password: f.password } : f });
      setToken(r.token); router.push('/');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white">O</div>
          <span className="text-lg font-semibold">OmniChannel</span>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <h1 className="text-lg font-semibold">{mode === 'login' ? 'Sign in' : 'Create your workspace'}</h1>
          {err && <ErrorBox error={err} />}
          {mode === 'register' && (<>
            <Field label="Business name"><input className="input" required value={f.organization} onChange={set('organization')} /></Field>
            <Field label="Your name"><input className="input" required value={f.name} onChange={set('name')} /></Field>
          </>)}
          <Field label="Email"><input className="input" type="email" autoComplete="email" required value={f.email} onChange={set('email')} /></Field>
          <Field label="Password" hint={mode === 'register' ? 'At least 10 characters' : undefined}>
            <input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} value={f.password} onChange={set('password')} />
          </Field>
          <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner />}{mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <button type="button" className="w-full text-center text-sm text-indigo-600 hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'New here? Create a workspace' : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
