'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface DocsNavProps {
  activeDoc: string;
  onSelect: (docName: string) => void;
}

const DOCS = [
  { id: 'getting-started', label: 'docs.nav.gettingStarted' },
  { id: 'api-reference', label: 'docs.nav.apiReference' },
  { id: 'entity-registration', label: 'docs.nav.entityRegistration' },
  { id: 'multiplayer-guide', label: 'docs.nav.multiplayerGuide' },
];

export function DocsNav({ activeDoc, onSelect }: DocsNavProps) {
  const t = useTranslations();

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
