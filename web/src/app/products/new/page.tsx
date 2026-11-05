'use client';
import { ProductEditor } from '@/components/ProductEditor';
import { PageHeader } from '@/components/ui';

export default function NewProduct() {
  return (<><PageHeader title="New product" description="Enter the details once. You'll choose where to publish after saving." /><ProductEditor /></>);
}
