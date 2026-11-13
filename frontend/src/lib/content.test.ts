import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseDocFile,
  parseDevlogFile,
  readDevlogDir,
  readDocsDir,
  validateContent,
} from '@/lib/content';

const DEVLOG = `---
title: Кеш пакетов
date: 2026-11-13
summary: Клиент переиспользует артефакт
version: 0.5.0
---

Текст записи.
`;

const DOC = `---
title: Начало работы
order: 1
---

Текст документа.
`;

it('parses devlog front matter and slug', () => {
  const entry = parseDevlogFile('2026-11-13-package-cache.md', DEVLOG);
  expect(entry).toEqual({
    slug: 'package-cache',
    title: 'Кеш пакетов',
    date: '2026-11-13',
    summary: 'Клиент переиспользует артефакт',
    version: '0.5.0',
    content: 'Текст записи.\n',
  });
});

it('normalizes yaml Date and CRLF line endings', () => {
  const raw = DEVLOG.replace(/\n/g, '\r\n');
  expect(parseDevlogFile('2026-11-13-a.md', raw).date).toBe('2026-11-13');
  expect(parseDevlogFile('2026-11-13-a.md', raw).content.trim()).toBe('Текст записи.');
});

it('rejects a devlog file name without a date prefix', () => {
  expect(() => parseDevlogFile('package-cache.md', DEVLOG)).toThrow(
    /package-cache\.md/,
  );
});

it('rejects missing summary and reports the file name', () => {
  const raw = DEVLOG.replace('summary: Клиент переиспользует артефакт\n', '');
  expect(() => parseDevlogFile('2026-11-13-a.md', raw)).toThrow(/summary/);
  expect(() => parseDevlogFile('2026-11-13-a.md', raw)).toThrow(/2026-11-13-a\.md/);
});

it('parses doc front matter and defaults order to zero', () => {
  expect(parseDocFile('getting-started.md', DOC)).toEqual({
    slug: 'getting-started',
    title: 'Начало работы',
    order: 1,
    content: 'Текст документа.\n',
  });
  expect(
    parseDocFile('api-reference.md', '---\ntitle: Справочник\n---\n\nТекст').order,
  ).toBe(0);
});

it('rejects doc front matter without a title', () => {
  expect(() => parseDocFile('broken.md', '---\norder: 1\n---\n\nТекст')).toThrow(
    /title/,
  );
  expect(() => parseDocFile('broken.md', '---\norder: 1\n---\n\nТекст')).toThrow(
    /broken\.md/,
  );
});

async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wired-content-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

it('sorts docs by order then title and skips underscore files', async () => {
  const dir = await makeDir({
    'b.md': '---\ntitle: Бета\norder: 1\n---\n\nB',
    'a.md': '---\ntitle: Альфа\norder: 2\n---\n\nA',
    '_template.md': '---\ntitle: Шаблон\n---\n\nT',
  });
  expect((await readDocsDir(dir)).map((d) => d.slug)).toEqual(['b', 'a']);
});

it('sorts devlog entries newest first', async () => {
  const dir = await makeDir({
    '2026-11-01-old.md':
      '---\ntitle: Old\ndate: 2026-11-01\nsummary: s\nversion: 0.4.0\n---\n\nO',
    '2026-11-12-new.md':
      '---\ntitle: New\ndate: 2026-11-12\nsummary: s\nversion: 0.4.0\n---\n\nN',
  });
  expect((await readDevlogDir(dir)).map((d) => d.slug)).toEqual(['new', 'old']);
});

it('reports duplicate slugs instead of silently shadowing', async () => {
  const dir = await makeDir({
    '2026-11-01-x.md':
      '---\ntitle: A\ndate: 2026-11-01\nsummary: s\nversion: 0.4.0\n---\n\nA',
    '2026-11-02-x.md':
      '---\ntitle: B\ndate: 2026-11-02\nsummary: s\nversion: 0.4.0\n---\n\nB',
  });
  await expect(readDevlogDir(dir)).rejects.toThrow(/duplicate slug: x/);
});

it('reports missing content directories instead of passing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wired-content-'));
  const issues = await validateContent(root);
  expect(issues).toContain('content/docs: directory is missing');
  expect(issues).toContain('content/devlog: directory is missing');
});

it('reports an empty docs directory', async () => {
  const root = await makeDir({});
  await fs.mkdir(path.join(root, 'docs'));
  await fs.mkdir(path.join(root, 'devlog'));
  const issues = await validateContent(root);
  expect(issues).toContain('content/docs: no markdown files found');
});
