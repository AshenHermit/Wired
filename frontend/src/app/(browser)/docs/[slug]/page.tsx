import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import DocsSidebar from '@/components/docs/DocsSidebar';
import MarkdownRenderer from '@/components/docs/MarkdownRenderer';
import { getDoc, listDocs } from '@/lib/content';
import { parseMarkdownHeadings } from '@/lib/markdown-parser';

type DocPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: DocPageProps) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  return doc ? { title: doc.title } : {};
}

export default async function DocPage({ params }: DocPageProps) {
  const { slug } = await params;
  const [doc, docs, t] = await Promise.all([
    getDoc(slug),
    listDocs(),
    getTranslations('Docs'),
  ]);

  if (!doc) {
    notFound();
  }

  const headings = parseMarkdownHeadings(doc.content);

  return (
    <main className="h-screen w-screen py-16 px-16">
      <div className="flex w-full h-full backdrop-blur-sm rounded-2xl overflow-hidden bg-black/20">
        <DocsSidebar
          docs={docs}
          currentSlug={doc.slug}
          headings={headings}
        />

        <main className="flex-1 overflow-y-auto p-8">
          <div className="w-full mx-auto">
            <Link
              href="/docs"
              className="inline-block mb-6 text-sm text-foreground/70 hover:text-foreground transition"
            >
              {t('back')}
            </Link>
            <h1 className="text-3xl font-bold mb-6">{doc.title}</h1>
            <div className="prose dark:prose-invert max-w-none">
              <MarkdownRenderer content={doc.content} />
            </div>
          </div>
        </main>
      </div>
    </main>
  );
}
