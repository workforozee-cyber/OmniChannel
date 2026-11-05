'use client';
import { Suspense } from 'react';
import { OrdersTable } from '@/components/OrdersTable';
import { PageHeader } from '@/components/ui';

export default function Page() {
  return (<><PageHeader title="Orders" description="Every order from every marketplace, in one place." /><Suspense><OrdersTable /></Suspense></>);
}
