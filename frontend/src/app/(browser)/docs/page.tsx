import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { listDocs } from '@/lib/content';

type DocsHubPageProps = {
  searchParams: Promise<{ doc?: string }>;
};

export default async function DocsHubPage({ searchParams }: DocsHubPageProps) {
  const { doc } = await searchParams;

  if (doc) {
    redirect(`/docs/${doc}`);
  }

  const [docs, t] = await Promise.all([listDocs(), getTranslations('Docs')]);

  return (
    <main className="min-h-screen w-screen py-16 px-16">
      <div className="w-full max-w-3xl mx-auto backdrop-blur-sm rounded-2xl bg-black/20 p-8">
        <Link
          href="/"
          className="inline-block mb-6 text-sm text-foreground/70 hover:text-foreground transition"
        >
          {t('back')}
        </Link>
        <h1 className="text-3xl font-bold mb-6">{t('hubTitle')}</h1>
        <div className="grid gap-3 sm:grid-cols-2">
          {docs.map((item) => (
            <Link
              key={item.slug}
              href={`/docs/${item.slug}`}
              className="p-4 rounded border border-foreground/10 hover:bg-foreground/5 transition"
            >
              <h2 className="font-semibold">{item.title}</h2>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
