import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '@/components/Shell';
import { ToastProvider } from '@/components/ui';

export const metadata: Metadata = { title: 'OmniChannel — multi-channel commerce', description: 'Manage eBay, Amazon, Etsy, Walmart and Shopify from one dashboard' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><ToastProvider><Shell>{children}</Shell></ToastProvider></body>
    </html>
  );
}
