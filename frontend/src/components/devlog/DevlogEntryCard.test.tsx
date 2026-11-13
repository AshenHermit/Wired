import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '@/test/render-with-intl';
import DevlogEntryCard from './DevlogEntryCard';

it('renders date, version, summary and entry link', () => {
  render(
    <DevlogEntryCard
      entry={{
        slug: 'package-cache',
        title: 'Кеш ревизий пакетов',
        date: '2026-11-13',
        summary: 'Переиспользуем артефакт',
        version: '0.5.0',
      }}
    />,
  );
  expect(screen.getByRole('link').getAttribute('href')).toBe('/devlog/package-cache');
  expect(screen.getByText('Кеш ревизий пакетов')).toBeTruthy();
  expect(screen.getByText('Переиспользуем артефакт')).toBeTruthy();
  expect(screen.getByText('0.5.0')).toBeTruthy();
  expect(screen.getByText('2026-11-13')).toBeTruthy();
});
