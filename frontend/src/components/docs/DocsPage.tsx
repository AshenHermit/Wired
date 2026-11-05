'use client';

import { useState, useEffect } from 'react';
import DocsSidebar from './DocsSidebar';
import MarkdownRenderer from './MarkdownRenderer';
import { loadDoc } from '@/lib/doc-loader';

interface DocsPageProps {
  initialDoc: string;
}

export default function DocsPage({ initialDoc }: DocsPageProps) {
  const [currentDoc, setCurrentDoc] = useState(initialDoc);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    
    loadDoc(currentDoc)
      .then(setContent)
      .catch(err => {
        console.error('Failed to load doc:', err);
        setError(`Failed to load documentation for ${currentDoc}`);
      })
      .finally(() => setLoading(false));
  }, [currentDoc]);

  return (
    <div className="flex h-screen bg-gradient-to-br from-background via-background to-foreground/5">
      <DocsSidebar currentDoc={currentDoc} onDocChange={setCurrentDoc} />
      
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto">
          {loading && (
            <div className="text-foreground/50">Loading documentation...</div>
          )}
          
          {error && (
            <div className="text-red-500 p-4 rounded bg-red-500/10 border border-red-500/20">
              {error}
            </div>
          )}
          
          {!loading && !error && content && (
            <div className="prose dark:prose-invert max-w-none">
              <MarkdownRenderer content={content} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
