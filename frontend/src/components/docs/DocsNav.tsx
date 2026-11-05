'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface DocsNavProps {
  activeDoc: string;
  onSelect: (docName: string) => void;
}

const DOCS = [
  { id: 'getting-started', label: 'docs.nav.gettingStarted' as const },
  { id: 'api-reference', label: 'docs.nav.apiReference' as const },
  { id: 'entity-registration', label: 'docs.nav.entityRegistration' as const },
  { id: 'multiplayer-guide', label: 'docs.nav.multiplayerGuide' as const },
];

export function DocsNav({ activeDoc, onSelect }: DocsNavProps) {
  const t = useTranslations('Home');

  return (
    <nav className="flex flex-col gap-2">
      {DOCS.map(({ id, label }) => (
        <Button
          key={id}
          variant={activeDoc === id ? 'default' : 'outline'}
          onClick={() => onSelect(id)}
          className="justify-start"
        >
          {t(label)}
        </Button>
      ))}
    </nav>
  );
}
