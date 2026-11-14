import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function DevlogEntryNotFound() {
  const t = await getTranslations('Devlog');

  return (
    <main className="min-h-screen w-screen py-16 px-16">
      <div className="w-full max-w-3xl mx-auto backdrop-blur-sm rounded-2xl bg-black/20 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">{t('notFound')}</h1>
        <Link href="/devlog" className="text-[#ff617b] hover:underline">
          {t('back')}
        </Link>
      </div>
    </main>
  );
}
