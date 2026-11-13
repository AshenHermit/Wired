import Link from 'next/link';
import type { DocMeta } from '@/lib/content';
import type { HeadingInfo } from '@/lib/markdown-parser';

interface DocsSidebarProps {
  docs: DocMeta[];
  currentSlug: string;
  headings: HeadingInfo[];
}

export default function DocsSidebar({
  docs,
  currentSlug,
  headings,
}: DocsSidebarProps) {
  return (
    <nav className="w-64 shrink-0 bg-background/50 border-r border-foreground/10 p-4 overflow-y-auto">
      {docs.map((doc) => {
        const isActive = doc.slug === currentSlug;
        return (
          <div key={doc.slug} className="mb-4">
            <Link
              href={`/docs/${doc.slug}`}
              aria-current={isActive ? 'page' : undefined}
              className={`block px-3 py-2 rounded transition ${
                isActive ? 'bg-foreground/10 font-semibold' : 'hover:bg-foreground/5'
              }`}
            >
              {doc.title}
            </Link>
            {isActive && headings.length > 0 && (
              <div className="ml-4 mt-2 space-y-1">
                {headings.map((heading) => (
                  <a
                    key={heading.id}
                    href={`/docs/${currentSlug}#${heading.id}`}
                    className="block text-sm text-foreground/70 hover:text-foreground px-2 py-1 rounded hover:bg-foreground/5 transition"
                  >
                    {heading.text}
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
