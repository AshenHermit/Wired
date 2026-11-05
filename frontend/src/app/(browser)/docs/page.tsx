'use client';

import { useSearchParams } from 'next/navigation';
import DocsPage from '@/components/docs/DocsPage';

export default function DocsRoute() {
  const searchParams = useSearchParams();
  const doc = searchParams.get('doc') || 'getting-started';

  return <DocsPage initialDoc={doc} />;
}
