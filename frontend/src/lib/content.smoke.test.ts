import { expect, it } from 'vitest';
import { listDevlog, listDocs, validateContent } from './content';

it('ships valid content', async () => {
  expect(await validateContent()).toEqual([]);
  expect((await listDocs()).map((d) => d.slug)).toEqual([
    'getting-started',
    'api-reference',
    'entity-registration',
    'multiplayer-guide',
  ]);
  const devlog = await listDevlog();
  expect(devlog.length).toBeGreaterThanOrEqual(5);
  expect(devlog[0].date >= devlog[1].date).toBe(true);
  expect(devlog.every((e) => e.version && e.summary)).toBe(true);
});
