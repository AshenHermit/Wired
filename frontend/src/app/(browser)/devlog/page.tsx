import { getTranslations } from 'next-intl/server';
import DevlogEntryCard from '@/components/devlog/DevlogEntryCard';
import { listDevlog } from '@/lib/content';

export default async function DevlogPage() {
  const [entries, t] = await Promise.all([
    listDevlog(),
    getTranslations('Devlog'),
  ]);

  return (
    <main className="min-h-screen w-screen py-16 px-16">
      <div className="w-full max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">{t('title')}</h1>
        {entries.length === 0 ? (
          <p className="text-foreground/70">{t('empty')}</p>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <DevlogEntryCard key={entry.slug} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
