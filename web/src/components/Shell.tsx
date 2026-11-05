'use client';
import clsx from 'clsx';
import {
  Activity, BarChart3, Bell, Boxes, LayoutDashboard, LogOut, Menu, Package, PoundSterling, Settings, ShoppingCart, Store, Tags, Truck, X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { api, getToken, setToken } from '@/lib/api';

const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/listings', label: 'Listings', icon: Tags },
  { href: '/inventory', label: 'Inventory', icon: Boxes },
  { href: '/orders', label: 'Orders', icon: ShoppingCart },
  { href: '/shipping', label: 'Shipping & Fulfillment', icon: Truck },
  { href: '/marketplaces', label: 'Marketplaces', icon: Store },
  { href: '/pricing', label: 'Pricing', icon: PoundSterling },
  { href: '/analytics', label: 'Analytics & Reports', icon: BarChart3 },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/activity', label: 'Activity Logs', icon: Activity },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<any>(null);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const isAuth = path === '/login';

  useEffect(() => {
    if (isAuth) return;
    if (!getToken()) { router.replace('/login'); return; }
    api('/auth/me').then(setMe).catch(() => {});
  }, [isAuth, router]);
  useEffect(() => {
    if (isAuth || !getToken()) return;
    const tick = () => api('/notifications/count').then((r) => setUnread(r.unread)).catch(() => {});
    tick(); const t = setInterval(tick, 20_000); return () => clearInterval(t);
  }, [isAuth, path]);
  useEffect(() => setOpen(false), [path]);

  if (isAuth) return <>{children}</>;
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 p-3">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} className={clsx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
          active(href) ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}>
          <Icon className="h-4 w-4 shrink-0" /><span className="flex-1">{label}</span>
          {href === '/notifications' && unread > 0 && <span className="rounded-full bg-rose-600 px-1.5 text-[10px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
        </Link>
      ))}
    </nav>
  );
  const brand = (
    <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-5">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">O</div>
      <span className="font-semibold tracking-tight text-slate-900">OmniChannel</span>
    </div>
  );
  const user = me && (
    <div className="border-t border-slate-200 p-3">
      <div className="px-2 text-sm font-medium text-slate-800">{me.user.name}</div>
      <div className="px-2 text-xs text-slate-500">{me.organization?.name} · {me.user.role}</div>
      <button className="btn-ghost mt-2 w-full justify-start" onClick={() => { setToken(null); router.push('/login'); }}><LogOut className="h-4 w-4" /> Sign out</button>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">{brand}{nav}{user}</aside>
      {open && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="flex h-full w-64 flex-col bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pr-3">{brand}<button className="btn-ghost p-1" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button></div>
            {nav}{user}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:hidden">
          <button className="btn-ghost p-1" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <span className="font-semibold">OmniChannel</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
