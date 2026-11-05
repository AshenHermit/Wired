'use client';

import ReactMarkdown from 'react-markdown';
import { parseMarkdownHeadings, slugify } from '@/lib/markdown-parser';
import { highlightCode } from '@/lib/highlight-plugin';

interface MarkdownRendererProps {
  content: string;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const headings = parseMarkdownHeadings(content);
  const headingMap = new Map(headings.map(h => [h.text, h.id]));

  return (
    <ReactMarkdown
      components={{
        h2: ({ children }) => {
          const text = String(children);
          const id = headingMap.get(text) || slugify(text);
          return <h2 id={id} className="text-2xl font-bold mt-6 mb-4">{children}</h2>;
        },
        h3: ({ children }) => {
          const text = String(children);
          const id = headingMap.get(text) || slugify(text);
          return <h3 id={id} className="text-xl font-semibold mt-4 mb-3">{children}</h3>;
        },
        p: ({ children }) => <p className="mb-4 leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-4 ml-2">{children}</ul>,
        li: ({ children }) => <li className="mb-2">{children}</li>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-4 ml-2">{children}</ol>,
        code: ({ children, className }) => {
          const language = className?.replace('language-', '') || 'plaintext';
          const code = String(children).trimEnd();
          
          // Check if this is an inline code or code block
          if (!className) {
            return <code className="bg-foreground/10 px-2 py-1 rounded text-sm font-mono">{children}</code>;
          }

          const highlighted = highlightCode(code, language);
          return (
            <pre className="hljs bg-foreground/5 border border-foreground/10 rounded p-4 mb-4 overflow-x-auto">
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          );
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-foreground/30 pl-4 py-2 mb-4 italic text-foreground/80">
            {children}
          </blockquote>
        ),
        a: ({ children, href }) => (
          <a href={href} className="text-blue-500 hover:text-blue-600 underline">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
