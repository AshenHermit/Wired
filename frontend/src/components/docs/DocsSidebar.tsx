'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { loadDoc } from '@/lib/doc-loader';
import { parseMarkdownHeadings } from '@/lib/markdown-parser';

const DOCS = [
  { name: 'Getting Started', key: 'getting-started' },
  { name: 'API Reference', key: 'api-reference' },
  { name: 'Entity Registration', key: 'entity-registration' },
  { name: 'Multiplayer Guide', key: 'multiplayer-guide' },
];

interface DocsSidebarProps {
  currentDoc: string;
  onDocChange: (doc: string) => void;
}

export default function DocsSidebar({ currentDoc, onDocChange }: DocsSidebarProps) {
  const [headings, setHeadings] = useState<Map<string, Array<{id: string, text: string}>>>(
    new Map()
  );
  const [loadingDocs, setLoadingDocs] = useState(true);

  useEffect(() => {
    const loadAllHeadings = async () => {
      const headingMap = new Map<string, Array<{id: string, text: string}>>();
      
      for (const doc of DOCS) {
        try {
          const content = await loadDoc(doc.key);
          const parsed = parseMarkdownHeadings(content);
          headingMap.set(doc.key, parsed);
        } catch (err) {
          console.error(`Failed to load headings for ${doc.key}:`, err);
          headingMap.set(doc.key, []);
        }
      }
      
      setHeadings(headingMap);
      setLoadingDocs(false);
    };

    loadAllHeadings();
  }, []);

  if (loadingDocs) {
    return <nav className="w-64 bg-background/50 border-r border-foreground/10 p-4">Loading...</nav>;
  }

  return (
    <nav className="w-64 bg-background/50 border-r border-foreground/10 p-4 overflow-y-auto">
      {DOCS.map(doc => {
        const docHeadings = headings.get(doc.key) || [];
        const isActive = currentDoc === doc.key;
        return (
          <div key={doc.key} className="mb-4">
            <Link
              href={`/docs?doc=${doc.key}`}
              onClick={(e) => {
                e.preventDefault();
                onDocChange(doc.key);
              }}
              className={`block px-3 py-2 rounded transition ${
                isActive ? 'bg-foreground/10 font-semibold' : 'hover:bg-foreground/5'
              }`}
            >
              {doc.name}
            </Link>
            {isActive && (
              <div className="ml-4 mt-2 space-y-1">
                {docHeadings.map(h => (
                  <a
                    key={h.id}
                    href={`#${h.id}`}
                    className="block text-sm text-foreground/70 hover:text-foreground px-2 py-1 rounded hover:bg-foreground/5 transition"
                  >
                    {h.text}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
