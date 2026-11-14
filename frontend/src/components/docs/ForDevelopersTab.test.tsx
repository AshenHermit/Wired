import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '@/test/render-with-intl';
import ForDevelopersTab from './ForDevelopersTab';

it('lists docs, latest entries and links to the full feed', () => {
  render(
    <ForDevelopersTab
      docs={[{ slug: 'getting-started', title: 'Начало работы', order: 1 }]}
      latest={[
        {
          slug: 'package-cache',
          title: 'Кеш ревизий',
          date: '2026-11-13',
          summary: 'Переиспользуем артефакт',
          version: '0.5.0',
        },
      ]}
    />,
  );
  expect(
    screen.getByRole('link', { name: 'Начало работы' }).getAttribute('href'),
  ).toBe('/docs/getting-started');
  expect(
    screen.getByRole('link', { name: 'Все обновления' }).getAttribute('href'),
  ).toBe('/devlog');
  expect(screen.getByText('Кеш ревизий')).toBeTruthy();
});
