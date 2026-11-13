# Вкладка «Для разработчиков» и dev log — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переименовать вкладку документации на главной в «Для разработчиков» и добавить ленту dev log, читаемую из markdown-файлов с YAML front matter.

**Architecture:** Контент живёт в `frontend/content/{docs,devlog}`, читается `node:fs` из серверного модуля `src/lib/content.ts` при каждом запросе (весь App Router уже динамический из-за локали в cookie). Страницы `/docs`, `/docs/<slug>`, `/devlog`, `/devlog/<slug>` рендерятся серверно; разметка — существующим клиентским `MarkdownRenderer`. Отдельный `prebuild`-скрипт валидирует контент до сборки.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), next-intl, `yaml`, `zod`, `tsx`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-13-for-developers-tab-devlog-design.md`

## Global Constraints

- Node >= 22; TypeScript strict; никаких новых рантайм-зависимостей кроме `yaml`; `tsx` — dev-зависимость.
- Контент только в `frontend/content/`; корневой `docs/` вырезан `.dockerignore` и для контента не годится.
- Все поля front matter обязательны: `title`, `date`, `summary`, `version`; `date` нормализуется к `YYYY-MM-DD`.
- Пользовательские строки — только через `frontend/messages/{en,ru}.json` (next-intl). Контент (документы, записи) — русский.
- Якоря заголовков — транслитерация кириллицы в латиницу (`Что такое пакет` → `chto-takoe-paket`), без внешних зависимостей.
- RSS не делать.
- Коммиты — Conventional Commits, после каждой задачи.
- Проверки: `pnpm --filter frontend check-types`, `pnpm --filter frontend lint`, `pnpm --filter frontend test`, `pnpm --filter frontend validate:content`, `pnpm --filter frontend build`.

## Review Focus

- Два файла с одинаковым slug (например `2026-11-10-x.md` и `2026-11-11-x.md`) — ссылки не должны молча указывать на одну запись: ожидается ошибка валидации.
- Файлы с CRLF (Windows checkout) — front matter обязан разбираться так же, как LF.
- `date: 2026-11-13` без кавычек YAML отдаёт как `Date`; ожидается `2026-11-13` без сдвига на соседний день.
- Заголовок из эмодзи/пунктуации — ожидается непустой якорь (`section`), а не `#`.
- Имя файла записи без префикса даты — ожидается ошибка валидации, а не запись с пустым/мусорным slug.
- Сборка (`pnpm --filter frontend build`) на битом контенте — ожидается падение до компиляции, с путём к файлу.

---

### Task 1: Транслитерация якорей

**Files:**
- Modify: `frontend/src/lib/markdown-parser.ts`
- Test: `frontend/src/lib/markdown-parser.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `slugify(text: string, counter?: number): string` — нижний регистр, транслитерация кириллицы, `[a-z0-9]`-группы через `-`, пустой результат → `section`, при `counter > 0` суффикс `-N`. `parseMarkdownHeadings(content: string): HeadingInfo[]` сохраняет сигнатуру, тип `HeadingInfo` (`{ id: string; level: number; text: string }`) становится экспортируемым.

- [ ] **Step 1: Дописать падающие тесты в `markdown-parser.test.ts`**

```ts
test('transliterates Cyrillic headings', () => {
  expect(slugify('Что такое пакет')).toBe('chto-takoe-paket');
  expect(slugify('Начало работы с пакетами Wired')).toBe(
    'nachalo-raboty-s-paketami-wired',
  );
  expect(slugify('Регистрация сущностей и контента')).toBe(
    'registratsiya-sushchnostey-i-kontenta',
  );
});

test('falls back to section for non-latin symbols', () => {
  expect(slugify('🎮')).toBe('section');
  expect(slugify('🎮', 1)).toBe('section-1');
});

test('keeps Cyrillic anchors unique in parseMarkdownHeadings', () => {
  const headings = parseMarkdownHeadings('## Пакет\n## Пакет\n');
  expect(headings.map((h) => h.id)).toEqual(['paket', 'paket-1']);
});
```

- [ ] **Step 2: Прогнать тесты и убедиться, что новые падают**

Run: `pnpm --filter frontend exec vitest run markdown-parser`
Expected: FAIL — `chto-takoe-paket` получен `''`.

- [ ] **Step 3: Реализовать транслитерацию в `slugify`**

Таблица (нижний регистр, порядок важен — многосимвольные не нужны): `а→a, б→b, в→v, г→g, д→d, е→e, ё→e, ж→zh, з→z, и→i, й→y, к→k, л→l, м→m, н→n, о→o, п→p, р→r, с→s, т→t, у→u, ф→f, х→kh, ц→ts, ч→ch, ш→sh, щ→shch, ъ→'', ы→y, ь→'', э→e, ю→yu, я→ya`. Далее: `.toLowerCase()`, транслитерация посимвольно, `.replace(/[^a-z0-9]+/g, '-')`, обрезка дефисов; если пусто — `section`; суффикс при `counter > 0`. Существующее поведение для латиницы обязано сохраниться (тесты из шапки файла остаются зелёными).

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter frontend exec vitest run markdown-parser`
Expected: PASS, все тесты файла.

- [ ] **Step 5: Коммит**

```bash
git add frontend/src/lib/markdown-parser.ts frontend/src/lib/markdown-parser.test.ts
git commit -m "fix(frontend): transliterate cyrillic heading anchors"
```

---

### Task 2: Модуль чтения контента

**Files:**
- Create: `frontend/src/lib/content.ts`
- Test: `frontend/src/lib/content.test.ts`
- Modify: `frontend/package.json` (зависимость `yaml`)

**Interfaces:**
- Consumes: `slugify` из Task 1 не нужен.
- Produces:
  - `type DocMeta = { slug: string; title: string; order: number }`
  - `type Doc = DocMeta & { content: string }`
  - `type DevlogMeta = { slug: string; title: string; date: string; summary: string; version: string }`
  - `type DevlogEntry = DevlogMeta & { content: string }`
  - `parseDocFile(fileName: string, raw: string): Doc`
  - `parseDevlogFile(fileName: string, raw: string): DevlogEntry`
  - `readDocsDir(dir: string): Promise<Doc[]>`
  - `readDevlogDir(dir: string): Promise<DevlogEntry[]>`
  - `listDocs(): Promise<DocMeta[]>`, `getDoc(slug: string): Promise<Doc | null>`
  - `listDevlog(): Promise<DevlogMeta[]>`, `getDevlogEntry(slug: string): Promise<DevlogEntry | null>`, `latestDevlog(limit: number): Promise<DevlogMeta[]>`
  - `validateContent(): Promise<string[]>` — список проблем, пустой массив при успехе.
  - `CONTENT_ROOT: string` = `path.join(process.cwd(), 'content')`

- [ ] **Step 1: Установить зависимость**

Run: `pnpm --filter frontend add yaml`
Expected: `yaml` в `dependencies` фронтенда (не dev — образ ставит только prod).

- [ ] **Step 2: Написать падающие тесты разбора**

```ts
const DEVLOG = `---
title: Кеш пакетов
date: 2026-11-13
summary: Клиент переиспользует артефакт
version: 0.5.0
---

Текст записи.
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
```

- [ ] **Step 3: Прогнать — падает**

Run: `pnpm --filter frontend exec vitest run content`
Expected: FAIL — модуль не существует.

- [ ] **Step 4: Реализовать `content.ts` (разбор)**

Front matter: `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/`, тело — остаток без ведущих переводов строки. Схемы `zod`: документ — `title: z.string().min(1)`, `order: z.number().int().optional()`; запись — `title`, `summary` (min 1), `version` (`/^\d+\.\d+\.\d+$/`), `date` — `z.union([z.string(), z.date()])`, наружу строка `YYYY-MM-DD` (`Date` → `toISOString().slice(0, 10)`; строка должна совпасть с `/^\d{4}-\d{2}-\d{2}$/`). Имя записи — `/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/`, иначе ошибка с именем файла. Ошибки — `throw new Error(\`${fileName}: ${message}\`)`.

- [ ] **Step 5: Прогнать тесты разбора**

Run: `pnpm --filter frontend exec vitest run content`
Expected: PASS.

- [ ] **Step 6: Дописать падающие тесты каталогов**

```ts
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
    '2026-11-01-old.md': '---\ntitle: Old\ndate: 2026-11-01\nsummary: s\nversion: 0.4.0\n---\n\nO',
    '2026-11-12-new.md': '---\ntitle: New\ndate: 2026-11-12\nsummary: s\nversion: 0.4.0\n---\n\nN',
  });
  expect((await readDevlogDir(dir)).map((d) => d.slug)).toEqual(['new', 'old']);
});

it('reports duplicate slugs instead of silently shadowing', async () => {
  const dir = await makeDir({
    '2026-11-01-x.md': '---\ntitle: A\ndate: 2026-11-01\nsummary: s\nversion: 0.4.0\n---\n\nA',
    '2026-11-02-x.md': '---\ntitle: B\ndate: 2026-11-02\nsummary: s\nversion: 0.4.0\n---\n\nB',
  });
  await expect(readDevlogDir(dir)).rejects.toThrow(/duplicate slug: x/);
});
```

- [ ] **Step 7: Реализовать чтение каталогов и публичные хелперы**

`readDir` читает `*.md`, сортирует по имени для детерминизма до сортировки; `_`-файлы игнорируются; дубли slug — ошибка `duplicate slug: <slug>`. `readDocsDir` — сортировка по `order`, затем `title` через `localeCompare('ru')`. `readDevlogDir` — по `date` по убыванию, при равенстве `title`. `latestDevlog(limit)` — срез `listDevlog()`. `getDoc`/`getDevlogEntry` — поиск по slug, `null` если нет. `validateContent()` собирает ошибки по каждому каталогу и файлу в массив строк, не бросая.

- [ ] **Step 8: Прогнать тесты и типы**

Run: `pnpm --filter frontend exec vitest run content` и `pnpm --filter frontend check-types`
Expected: PASS, ошибок типов нет.

- [ ] **Step 9: Коммит**

```bash
git add frontend/package.json frontend/src/lib/content.ts frontend/src/lib/content.test.ts ../../pnpm-lock.yaml
git commit -m "feat(frontend): read docs and devlog content from markdown"
```

---

### Task 3: Контент — документы, записи, шаблон

**Files:**
- Create: `frontend/content/docs/getting-started.md`, `api-reference.md`, `entity-registration.md`, `multiplayer-guide.md`
- Create: `frontend/content/devlog/2026-11-08-.md` … (5 файлов, имена ниже)
- Create: `frontend/content/devlog/_template.md`
- Test: `frontend/src/lib/content.smoke.test.ts`

**Interfaces:**
- Consumes: `validateContent`, `listDocs`, `listDevlog` из Task 2.
- Produces: каталог контента с 4 документами и 5 записями; `validateContent()` → `[]`.

- [ ] **Step 1: Перенести документы**

Скопировать тело каждого файла из `frontend/public/docs/<name>.md` (пока не удаляя оригиналы), убрать строку H1, добавить front matter с `title` из этого H1 и `order`:

| файл | title | order |
|---|---|---|
| getting-started | Начало работы с пакетами Wired | 1 |
| api-reference | Справочник API Wired | 2 |
| entity-registration | Регистрация сущностей и контента | 3 |
| multiplayer-guide | Сетевое руководство Wired | 4 |

- [ ] **Step 2: Создать пять записей**

Общие правила: тело 3–6 коротких абзацев или списков на русском, факты — из указанных коммитов (`git show <hash> --stat`), без выдуманных чисел.

| файл | title | date | version | summary |
|---|---|---|---|---|
| `2026-11-08-package-upload-skip.md` | Загружаем только недостающие файлы | 2026-11-08 | 0.4.0 | Публикация пакета больше не отправляет на сервер файлы, которые там уже есть |
| `2026-11-11-package-git-storage.md` | Ревизии пакетов в git-хранилище | 2026-11-11 | 0.4.0 | Каждая ревизия пакета — коммит в отдельном bare-репозитории, чтение идёт по `commitSha` |
| `2026-11-12-package-git-tools.md` | Обслуживание git-хранилища пакетов | 2026-11-12 | 0.4.1 | Появились команды миграции, очистки, экспорта, обслуживания и починки хранилища |
| `2026-11-13-package-cache.md` | Кеш ревизий пакетов в Game tab | 2026-11-13 | 0.5.0 | Повторный запуск игры переиспользует уже скачанный артефакт того же `artifactKey` |
| `2026-11-13-package-progress.md` | Прогресс применения пакетов в Game tab | 2026-11-13 | 0.5.0 | Видно, насколько рантайм и клиенты применили опубликованные ревизии |

- [ ] **Step 3: Создать `_template.md`**

```markdown
---
title: Короткий заголовок записи
date: 2026-01-01
summary: Одно предложение о том, что изменилось и зачем
version: 0.0.0
---

Что изменилось и почему. Ссылки на документы — обычным markdown.

- пункт;
- пункт.
```

- [ ] **Step 4: Написать smoke-тест**

```ts
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
```

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter frontend exec vitest run content`
Expected: PASS (smoke + юнит-тесты Task 2).

- [ ] **Step 6: Коммит**

```bash
git add frontend/content frontend/src/lib/content.smoke.test.ts
git commit -m "content: add package docs and first devlog entries"
```

---

### Task 4: Маршруты документации

**Files:**
- Create: `frontend/src/app/(browser)/docs/page.tsx` (замена), `frontend/src/app/(browser)/docs/[slug]/page.tsx`
- Rewrite: `frontend/src/components/docs/DocsSidebar.tsx`
- Delete: `frontend/src/lib/doc-loader.ts`, `frontend/src/lib/doc-loader.test.ts`, `frontend/src/components/docs/DocsPage.tsx`, `DocsPage.test.tsx`, `DocsSidebar.test.tsx`, `DocViewer.tsx`, `DocViewer.test.tsx`, `DocsNav.tsx`, `frontend/public/docs/`
- Test: `frontend/src/components/docs/DocsSidebar.test.tsx`
- Modify: `frontend/messages/en.json`, `frontend/messages/ru.json` (namespace `Docs`)

**Interfaces:**
- Consumes: `listDocs`, `getDoc`, `DocMeta`, `Doc` из Task 2; `parseMarkdownHeadings` из Task 1.
- Produces: `/docs`, `/docs/<slug>`; `DocsSidebar({ docs, currentSlug, headings }: { docs: DocMeta[]; currentSlug: string; headings: HeadingInfo[] })`; ключи сообщений `Docs.hubTitle`, `Docs.back`.

- [ ] **Step 1: Написать падающий тест `DocsSidebar`**

```tsx
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
```

- [ ] **Step 2: Прогнать — падает**

Run: `pnpm --filter frontend exec vitest run DocsSidebar`
Expected: FAIL — старый компонент ждёт `currentDoc`/`onDocChange`.

- [ ] **Step 3: Переписать `DocsSidebar` под пропсы**

Серверный компонент без состояния: `<Link href={\`/docs/${doc.slug}\`}>` с подсветкой активного (`aria-current="page"`), под активным — ссылки `<a href={\`/docs/${currentSlug}#${h.id}\`}>` для переданных headings. Внешний вид — как у текущего (`w-64`, `bg-background/50`, `border-r`).

- [ ] **Step 4: Создать `/docs/[slug]`**

Async-серверный компонент: `params: Promise<{ slug: string }>`, `getDoc(slug)` → `notFound()` при `null`; `listDocs()` для сайдбара; `generateMetadata` возвращает `title` из front matter. Разметка повторяет текущий `DocsPage`: `main.h-screen`, панель `backdrop-blur-sm rounded-2xl bg-black/20`, сайдбар + `prose` с `MarkdownRenderer`, вверху ссылка на `/docs`.

- [ ] **Step 5: Создать `/docs` (хаб) с редиректом**

`searchParams: Promise<{ doc?: string }>`; при `doc` — `redirect(\`/docs/${doc}\`)`. Иначе — сетка карточек документов из `listDocs()` со ссылками `/docs/<slug>` и заголовком `Docs.hubTitle`.

- [ ] **Step 6: Удалить старую реализацию и `public/docs`**

Удалить перечисленные файлы; убедиться, что `grep -r "doc-loader\|DocsPage\|DocViewer" frontend/src` пуст.

- [ ] **Step 7: Добавить сообщения `Docs`**

`en`: `hubTitle: "Documentation"`, `back: "Back to home"`. `ru`: `"Документация"`, `"На главную"`. Проверить, что JSON в обоих файлах валиден.

- [ ] **Step 8: Прогнать тесты, типы, сборку**

Run: `pnpm --filter frontend test` (без новых падений), `pnpm --filter frontend check-types`, `pnpm --filter frontend build`
Expected: PASS; в логе сборки есть маршруты `/docs` и `/docs/[slug]`.

- [ ] **Step 9: Коммит**

```bash
git add -A frontend
git commit -m "feat(frontend): server-rendered docs routes from content dir"
```

---

### Task 5: Маршруты dev log

**Files:**
- Create: `frontend/src/app/(browser)/devlog/page.tsx`, `frontend/src/app/(browser)/devlog/[slug]/page.tsx`
- Create: `frontend/src/components/devlog/DevlogEntryCard.tsx`, `DevlogEntryCard.test.tsx`
- Modify: `frontend/messages/en.json`, `frontend/messages/ru.json` (namespace `Devlog`)

**Interfaces:**
- Consumes: `listDevlog`, `getDevlogEntry`, `DevlogMeta` из Task 2.
- Produces: `/devlog`, `/devlog/<slug>`; `DevlogEntryCard({ entry }: { entry: DevlogMeta })` — ссылка на `/devlog/<slug>` с датой, `v<version>`, заголовком и summary. Ключи: `Devlog.title`, `Devlog.back`, `Devlog.empty`, `Devlog.versionLabel`, `Devlog.prev`, `Devlog.next`, `Devlog.notFound`.

- [ ] **Step 1: Падающий тест карточки**

```tsx
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
```

- [ ] **Step 2: Прогнать — падает**

Run: `pnpm --filter frontend exec vitest run DevlogEntryCard`
Expected: FAIL — компонента нет.

- [ ] **Step 3: Реализовать карточку и страницы**

Карточка — `<Link>` + `<article>`: дата (`<time dateTime={entry.date}>`), бейдж версии (фон `bg-foreground/10`, `text-xs`), `h3` с заголовком, `p` с summary; подписи через `useTranslations('Devlog')`. Лента `/devlog`: заголовок, `DevlogEntryCard` для каждого элемента `listDevlog()`, пустое состояние `Devlog.empty`. Запись `/devlog/[slug]`: `notFound()` при отсутствии, `MarkdownRenderer`, ссылка назад на `/devlog`, ссылки на соседние записи (по индексу в `listDevlog()`; подписи `Devlog.prev`/`Devlog.next`).

- [ ] **Step 4: Добавить ключи сообщений в оба файла**

`en`: `title: "Dev log"`, `back: "All updates"`, `empty: "No entries yet"`, `versionLabel: "Version"`, `prev: "Previous entry"`, `next: "Next entry"`, `notFound: "Entry not found"`. `ru`: `"Dev log"`, `"Все обновления"`, `"Записей пока нет"`, `"Версия"`, `"Предыдущая запись"`, `"Следующая запись"`, `"Запись не найдена"`.

- [ ] **Step 5: Прогнать тесты, типы, сборку**

Run: `pnpm --filter frontend exec vitest run DevlogEntryCard`, `pnpm --filter frontend check-types`, `pnpm --filter frontend build`
Expected: PASS; в списке маршрутов есть `/devlog` и `/devlog/[slug]`.

- [ ] **Step 6: Коммит**

```bash
git add -A frontend
git commit -m "feat(frontend): add devlog feed and entry pages"
```

---

### Task 6: Вкладка «Для разработчиков» на главной

**Files:**
- Create: `frontend/src/components/docs/ForDevelopersTab.tsx`, `ForDevelopersTab.test.tsx`
- Modify: `frontend/src/app/(browser)/(homepage)/page.tsx`, `frontend/src/app/(browser)/(homepage)/HomepageClient.tsx`
- Modify: `frontend/messages/en.json`, `frontend/messages/ru.json`

**Interfaces:**
- Consumes: `listDocs`, `latestDevlog`, `DocMeta`, `DevlogMeta` из Task 2; `DevlogEntryCard` из Task 5.
- Produces: `ForDevelopersTab({ docs, latest }: { docs: DocMeta[]; latest: DevlogMeta[] })`; `HomepageClient({ docs, latest }: { docs: DocMeta[]; latest: DevlogMeta[] })`.

- [ ] **Step 1: Падающий тест вкладки**

```tsx
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
  expect(screen.getByRole('link', { name: 'Начало работы' }).getAttribute('href')).toBe(
    '/docs/getting-started',
  );
  expect(screen.getByRole('link', { name: 'Все обновления' }).getAttribute('href')).toBe(
    '/devlog',
  );
  expect(screen.getByText('Кеш ревизий')).toBeTruthy();
});
```

- [ ] **Step 2: Прогнать — падает**

Run: `pnpm --filter frontend exec vitest run ForDevelopersTab`
Expected: FAIL — компонента нет.

- [ ] **Step 3: Реализовать `ForDevelopersTab`**

Пропсы `docs`/`latest`; сетка карточек документов (стиль текущих ссылок: `p-4 rounded border border-foreground/10 hover:bg-foreground/5`), блок «последние обновления» с `DevlogEntryCard` и ссылкой на `/devlog` (`Home.docs.devlog.all`), пустое состояние `Home.docs.devlog.empty`, блок issues — существующая разметка и ссылка `https://github.com/AshenHermit/Wired/issues/new`.

- [ ] **Step 4: Подключить к главной**

`(homepage)/page.tsx`: `export default async function Home()` — `Promise.all([listDocs(), latestDevlog(3)])`, передать в `<HomepageClient docs={docs} latest={latest} />`. `HomepageClient` принимает пропсы и рендерит `<ForDevelopersTab …/>` внутри `TabsContent value="docs"`; захардкоженные четыре ссылки и `Home.docs.nav.*` удалить.

- [ ] **Step 5: Обновить сообщения**

`en`: `Home.tabs.docs: "For Developers"`, `Home.docs.title: "For Developers"`, `Home.docs.description` — про документацию и изменения платформы; `Home.docs.devlog.title: "Latest updates"`, `.all: "All updates"`, `.empty: "No entries yet"`. `ru`: `"Для разработчиков"`, заголовок и описание по-русски, `"Последние обновления"`, `"Все обновления"`, `"Записей пока нет"`. Ключ `Home.docs.nav` удалить в обоих файлах.

- [ ] **Step 6: Прогнать тесты, типы, сборку**

Run: `pnpm --filter frontend test`, `pnpm --filter frontend check-types`, `pnpm --filter frontend build`
Expected: PASS; главная рендерится без обращения к `public/docs`.

- [ ] **Step 7: Коммит**

```bash
git add -A frontend
git commit -m "feat(frontend): rename docs tab to for developers and show devlog"
```

---

### Task 7: Валидация контента на сборке, CI и документация

**Files:**
- Create: `frontend/scripts/validate-content.ts`
- Modify: `frontend/package.json` (скрипты `validate:content`, `prebuild`; dev-зависимость `tsx`)
- Modify: `.github/workflows/deploy.yml`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `validateContent()` из Task 2.
- Produces: npm-скрипт `validate:content`, автоматический `prebuild`.

- [ ] **Step 1: Установить `tsx` и добавить скрипты**

Run: `pnpm --filter frontend add -D tsx`
В `frontend/package.json`: `"validate:content": "tsx scripts/validate-content.ts"`, `"prebuild": "pnpm validate:content"`.

- [ ] **Step 2: Написать скрипт**

`scripts/validate-content.ts`: импорт `validateContent` относительным путём (`../src/lib/content`), `const issues = await validateContent()`; при непустом массиве — `console.error` по строке на проблему и `process.exit(1)`; иначе `console.log('content ok')`.

- [ ] **Step 3: Проверить успех и падение**

Run: `pnpm --filter frontend validate:content` → `content ok`.
Затем временно испортить одну запись (удалить `summary:`), снова прогнать → exit 1 с именем файла; вернуть файл.

- [ ] **Step 4: Добавить шаг в CI**

В `.github/workflows/deploy.yml`, в job `verify`, после `pnpm --filter frontend test` — шаг с `name: Validate content` и `run: pnpm --filter frontend validate:content`.

- [ ] **Step 5: Обновить `AGENTS.md`**

В разделе repo map указать `frontend/content/{docs,devlog}` как источник документации и dev log; в Commands — `pnpm --filter frontend validate:content` с пометкой «падает на битом front matter, запускается автоматически в `prebuild`».

- [ ] **Step 6: Финальная проверка**

Run: `pnpm --filter frontend check-types && pnpm --filter frontend lint && pnpm --filter frontend test && pnpm --filter frontend build`
Expected: всё зелёное; `prebuild` печатает `content ok` перед сборкой.

- [ ] **Step 7: Коммит**

```bash
git add frontend/package.json frontend/scripts .github/workflows/deploy.yml AGENTS.md pnpm-lock.yaml
git commit -m "chore: validate content before frontend build"
```

---

## Ручная приёмка

- Главная: вкладка называется «Для разработчиков», карточки ведут на `/docs/<slug>`, три записи ведут на `/devlog/<slug>`, «Все обновления» — на `/devlog`.
- `/docs/getting-started`: сайдбар перечисляет 4 документа, якоря кликаются и ведут на `#chto-takoe-paket` и т.п.
- `/docs?doc=getting-started` редиректит на `/docs/getting-started`.
- `/devlog`: пять записей, новые сверху; запись открывается, соседние ссылки работают.
- Переключение локали на `en` меняет подписи, но не тексты документов и записей.
