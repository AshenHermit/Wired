import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '@/test/render-with-intl';
import DocsSidebar from './DocsSidebar';

it('links every doc and anchors the current one', () => {
  render(
    <DocsSidebar
      docs={[
        { slug: 'getting-started', title: 'Начало работы', order: 1 },
        { slug: 'api-reference', title: 'Справочник API', order: 2 },
      ]}
      currentSlug="api-reference"
      headings={[{ id: 'chto-takoe-paket', level: 2, text: 'Что такое пакет' }]}
    />,
  );
  expect(screen.getByRole('link', { name: 'Начало работы' })).toHaveProperty(
    'href',
    'http://localhost:3000/docs/getting-started',
  );
  expect(screen.getByRole('link', { name: 'Что такое пакет' })).toHaveProperty(
    'href',
    'http://localhost:3000/docs/api-reference#chto-takoe-paket',
  );
});
