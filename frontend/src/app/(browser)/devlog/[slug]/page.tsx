import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import MarkdownRenderer from '@/components/docs/MarkdownRenderer';
import { getDevlogEntry, listDevlog } from '@/lib/content';

type DevlogEntryPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: DevlogEntryPageProps) {
  const { slug } = await params;
  const entry = await getDevlogEntry(slug);
  return entry ? { title: entry.title } : {};
}

export default async function DevlogEntryPage({
  params,
}: DevlogEntryPageProps) {
  const { slug } = await params;
  const [entry, entries, t] = await Promise.all([
    getDevlogEntry(slug),
    listDevlog(),
    getTranslations('Devlog'),
  ]);

  if (!entry) {
    notFound();
  }

  const index = entries.findIndex((item) => item.slug === entry.slug);
  const previous = index >= 0 ? entries[index + 1] : undefined;
  const next = index > 0 ? entries[index - 1] : undefined;

  return (
    <main className="min-h-screen w-screen py-16 px-16">
      <div className="w-full max-w-3xl mx-auto backdrop-blur-sm rounded-2xl bg-black/20 p-8">
        <Link
          href="/devlog"
          className="inline-block mb-6 text-sm text-foreground/70 hover:text-foreground transition"
        >
          {t('back')}
        </Link>

        <article>
          <div className="flex items-center gap-3 text-sm text-foreground/70 mb-3">
            <time dateTime={entry.date}>{entry.date}</time>
            <span
              className="rounded bg-foreground/10 px-2 py-0.5 text-xs"
              title={t('versionLabel')}
            >
              {entry.version}
            </span>
          </div>
          <h1 className="text-3xl font-bold mb-3">{entry.title}</h1>
          <p className="text-foreground/70 mb-6">{entry.summary}</p>
          <div className="prose dark:prose-invert max-w-none">
            <MarkdownRenderer content={entry.content} />
          </div>
        </article>

        {(previous || next) && (
          <nav className="mt-10 pt-6 border-t border-foreground/10 flex flex-wrap gap-4 justify-between">
            {previous ? (
              <Link
                href={`/devlog/${previous.slug}`}
                className="text-sm text-foreground/70 hover:text-foreground transition"
              >
                {t('prev')}: {previous.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={`/devlog/${next.slug}`}
                className="text-sm text-foreground/70 hover:text-foreground transition"
              >
                {t('next')}: {next.title}
              </Link>
            ) : null}
          </nav>
        )}
      </div>
    </main>
  );
}
