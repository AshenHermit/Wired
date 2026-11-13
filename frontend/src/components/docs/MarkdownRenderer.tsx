'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { nextHeadingId } from '@/lib/markdown-parser';
import { highlightCode } from '@/lib/highlight-plugin';

interface MarkdownRendererProps {
  content: string;
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

function nodeText(node: MarkdownNode | undefined): string {
  if (!node) {
    return '';
  }
  if (node.type === 'text') {
    return node.value ?? '';
  }
  return node.children?.map(nodeText).join('') ?? '';
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const usedIds = new Set<string>();

  const headingId = (node: MarkdownNode | undefined, children: unknown) => {
    const text = nodeText(node) || String(children);
    const id = nextHeadingId(text, usedIds);
    usedIds.add(id);
    return id;
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children, node }) => {
          const id = headingId(node, children);
          return <h2 id={id} className="text-2xl font-bold mt-6 mb-4">{children}</h2>;
        },
        h3: ({ children, node }) => {
          const id = headingId(node, children);
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
        table: ({ children }) => (
          <div className="overflow-x-auto mb-4">
            <table className="min-w-full border border-foreground/10 rounded">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-foreground/5">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-foreground/10">{children}</tr>,
        th: ({ children }) => <th className="px-4 py-2 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="px-4 py-2">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
