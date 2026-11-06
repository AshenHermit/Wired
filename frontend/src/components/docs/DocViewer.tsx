'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { loadDoc } from '@/lib/doc-loader';

export function DocViewer({ docName }: { docName: string }) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent('');

    loadDoc(docName)
      .then(setContent)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [docName]);

  if (loading) return <div>Loading documentation...</div>;
  if (error) return <div className="text-red-500">Failed to load: {error}</div>;

  return (
    <div className="prose prose-sm max-w-4xl dark:prose-invert">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
