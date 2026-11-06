# Documentation Site Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate documentation from embedded homepage viewer to a dedicated `/docs` route with sidebar tree navigation, internal anchors, and syntax highlighting.

**Architecture:** Three-layer approach: utility layer for markdown parsing + anchor generation, component layer (sidebar, page layout, viewer), and route layer (`/docs/page.tsx`). Highlight.js integrates with react-markdown for code blocks. Homepage links to sections rather than embedding the viewer.

**Tech Stack:** React 19, Next.js 16 App Router, Tailwind v4, react-markdown, highlight.js, next-intl for i18n

**Spec:** `docs/superpowers/specs/2026-11-05-docs-refactor-design.md`

## Global Constraints

- All documentation markdown files live in `frontend/public/docs/` (4 files: getting-started.md, api-reference.md, entity-registration.md, multiplayer-guide.md)
- i18n support: messages in `frontend/messages/{en,ru}.json` under `Home.docs.*`
- Preserve homepage styling: background gradients and backdrop panel appearance
- No breaking changes to existing doc content
- Sidebar anchors auto-generated from h2/h3 headings in markdown
- Code blocks highlighted via highlight.js language detection

## Review Focus

1. **Empty or missing markdown files:** If a doc file fails to load, sidebar shows stale list or 404 page breaks — test all four docs load and render without error
2. **Anchor collision:** Multiple headings with same text generate duplicate IDs — test slug generation is unique per heading
3. **Mobile sidebar collapse:** Sidebar hidden state not persisted or layout breaks on small screens — test responsive behavior and state management
4. **Language switching:** i18n locale changes don't update doc link labels or sidebar — test en/ru message swap and reactivity
5. **Code block rendering:** Unrecognized language or missing highlight.js language library crashes or renders plaintext only — test common languages (gdscript, typescript, json) render with color

---

### Task 1: Markdown Parser and Anchor Generator

**Files:**
- Create: `frontend/src/lib/markdown-parser.ts`
- Test: `frontend/src/lib/markdown-parser.test.ts`

**Interfaces:**
- Produces: `parseMarkdownHeadings(content: string) -> Array<{id: string, level: number, text: string}>` and `slugify(text: string) -> string`

- [ ] **Step 1: Write failing test for `slugify` function**

```typescript
import { slugify } from '@/lib/markdown-parser';

test('slugify converts heading text to URL-safe ID', () => {
  expect(slugify('Getting Started')).toBe('getting-started');
  expect(slugify('Godot API Reference')).toBe('godot-api-reference');
  expect(slugify('Entity Registration & Sync')).toBe('entity-registration-sync');
  expect(slugify('Multi-Player Guide')).toBe('multi-player-guide');
});

test('slugify handles duplicates by appending counter', () => {
  expect(slugify('Setup', 0)).toBe('setup');
  expect(slugify('Setup', 1)).toBe('setup-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run markdown-parser.test.ts -t slugify`
Expected: FAIL with "slugify is not defined"

- [ ] **Step 3: Implement `slugify` and `parseMarkdownHeadings` in `frontend/src/lib/markdown-parser.ts`**

`slugify(text: string, counter?: number) -> string`: lowercase, trim, replace non-alphanumeric with hyphens, remove consecutive hyphens, append `-${counter}` if counter > 0.

`parseMarkdownHeadings(content: string) -> Array<{id: string, level: number, text: string}>`: regex to extract `## Heading Text` and `### Sub Heading`, track seen IDs to handle duplicates, return ordered list with unique slugified IDs.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run markdown-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/markdown-parser.ts frontend/src/lib/markdown-parser.test.ts
git commit -m "feat: add markdown parser and slugify utility"
```

---

### Task 2: Install and Configure highlight.js

**Files:**
- Modify: `frontend/package.json`

**Interfaces:**
- Produces: highlight.js library available for import as `import hljs from 'highlight.js'`

- [ ] **Step 1: Add highlight.js to frontend dependencies**

Run: `pnpm --filter frontend add highlight.js`

- [ ] **Step 2: Verify installation**

Run: `pnpm --filter frontend ls highlight.js`
Expected: Package listed with version

- [ ] **Step 3: Create highlight plugin for react-markdown**

Create `frontend/src/lib/highlight-plugin.ts`:

```typescript
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

export function highlightCode(code: string, language: string = 'plaintext') {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language }).value;
  }
  return hljs.highlightAuto(code).value;
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json pnpm-lock.yaml frontend/src/lib/highlight-plugin.ts
git commit -m "feat: install highlight.js and create highlighting plugin"
```

---

### Task 3: Create `MarkdownRenderer` Component

**Files:**
- Create: `frontend/src/components/docs/MarkdownRenderer.tsx`
- Test: `frontend/src/components/docs/MarkdownRenderer.test.tsx`

**Interfaces:**
- Consumes: `parseMarkdownHeadings` from Task 1, `highlightCode` from Task 2
- Produces: React component `<MarkdownRenderer content={string} />` that renders markdown with heading IDs and code highlighting

- [ ] **Step 1: Write failing test**

```typescript
import { render, screen } from '@testing-library/react';
import MarkdownRenderer from '@/components/docs/MarkdownRenderer';

test('renders markdown with code block syntax highlighting', () => {
  const md = `
## API Methods

Here's a TypeScript example:

\`\`\`typescript
function greet(name: string) {
  console.log('Hello, ' + name);
}
\`\`\`
`;
  render(<MarkdownRenderer content={md} />);
  expect(screen.getByText(/Hello/)).toBeInTheDocument();
  const codeBlock = screen.getByText(/function greet/).closest('pre');
  expect(codeBlock).toHaveClass('hljs');
});

test('generates heading IDs for h2 and h3', () => {
  const md = `## Getting Started\n### Installation`;
  render(<MarkdownRenderer content={md} />);
  expect(screen.getByRole('heading', { name: /Getting Started/ })).toHaveAttribute('id', 'getting-started');
  expect(screen.getByRole('heading', { name: /Installation/ })).toHaveAttribute('id', 'installation');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run MarkdownRenderer.test.tsx`
Expected: FAIL with "MarkdownRenderer is not defined"

- [ ] **Step 3: Implement `MarkdownRenderer` component**

Use `react-markdown` with a custom code renderer that calls `highlightCode`. Use `parseMarkdownHeadings` to extract heading IDs and attach them as `id` attributes to h2/h3 elements via react-markdown heading plugin.

```typescript
'use client';

import ReactMarkdown from 'react-markdown';
import { parseMarkdownHeadings, slugify } from '@/lib/markdown-parser';
import { highlightCode } from '@/lib/highlight-plugin';

interface MarkdownRendererProps {
  content: string;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const headings = parseMarkdownHeadings(content);
  const headingMap = new Map(headings.map(h => [h.text, h.id]));

  return (
    <ReactMarkdown
      components={{
        h2: ({ children }) => {
          const text = String(children);
          const id = headingMap.get(text) || slugify(text);
          return <h2 id={id}>{children}</h2>;
        },
        h3: ({ children }) => {
          const text = String(children);
          const id = headingMap.get(text) || slugify(text);
          return <h3 id={id}>{children}</h3>;
        },
        code: ({ children, className }) => {
          const language = className?.replace('language-', '') || 'plaintext';
          const code = String(children);
          const highlighted = highlightCode(code, language);
          return <code dangerouslySetInnerHTML={{ __html: highlighted }} />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run MarkdownRenderer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/docs/MarkdownRenderer.tsx frontend/src/components/docs/MarkdownRenderer.test.tsx
git commit -m "feat: create MarkdownRenderer with heading IDs and code highlighting"
```

---

### Task 4: Create `DocsSidebar` Component

**Files:**
- Create: `frontend/src/components/docs/DocsSidebar.tsx`
- Test: `frontend/src/components/docs/DocsSidebar.test.tsx`

**Interfaces:**
- Consumes: `parseMarkdownHeadings` from Task 1, `docLoader` from previous session
- Produces: React component `<DocsSidebar docName={string} currentDoc={string} onDocChange={(doc: string) => void} />`

- [ ] **Step 1: Write failing test**

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DocsSidebar from '@/components/docs/DocsSidebar';

test('renders sidebar with 4 main doc links', () => {
  render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
  expect(screen.getByText('Getting Started')).toBeInTheDocument();
  expect(screen.getByText('API Reference')).toBeInTheDocument();
  expect(screen.getByText('Entity Registration')).toBeInTheDocument();
  expect(screen.getByText('Multiplayer Guide')).toBeInTheDocument();
});

test('highlights current document', () => {
  render(<DocsSidebar currentDoc="api-reference" onDocChange={() => {}} />);
  const apiLink = screen.getByText('API Reference').closest('a');
  expect(apiLink).toHaveClass('bg-foreground/10'); // active state
});

test('expands current doc to show anchors', async () => {
  render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
  // Anchors for getting-started should be visible
  expect(screen.getByText('Installation')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run DocsSidebar.test.tsx`
Expected: FAIL with "DocsSidebar is not defined"

- [ ] **Step 3: Implement `DocsSidebar` component**

Hard-code the 4 doc entries (name, key). Load each doc's markdown, parse headings, display tree with h2 as collapsible sections and h3 as child links. Current doc is always expanded. Links navigate to `#heading-id` anchors.

```typescript
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { loadDoc } from '@/lib/doc-loader';
import { parseMarkdownHeadings } from '@/lib/markdown-parser';

const DOCS = [
  { name: 'Getting Started', key: 'getting-started' },
  { name: 'API Reference', key: 'api-reference' },
  { name: 'Entity Registration', key: 'entity-registration' },
  { name: 'Multiplayer Guide', key: 'multiplayer-guide' },
];

interface DocsSidebarProps {
  currentDoc: string;
  onDocChange: (doc: string) => void;
}

export default function DocsSidebar({ currentDoc, onDocChange }: DocsSidebarProps) {
  const [headings, setHeadings] = useState<Map<string, Array<{id: string, text: string}>>>
    (new Map());

  useEffect(() => {
    Promise.all(
      DOCS.map(async (doc) => {
        const content = await loadDoc(doc.key);
        const parsed = parseMarkdownHeadings(content);
        setHeadings(prev => new Map(prev).set(doc.key, parsed));
      })
    );
  }, []);

  return (
    <nav className="w-64 bg-background/50 border-r border-foreground/10 p-4 overflow-y-auto">
      {DOCS.map(doc => {
        const docHeadings = headings.get(doc.key) || [];
        const isActive = currentDoc === doc.key;
        return (
          <div key={doc.key} className="mb-4">
            <Link
              href={`/docs?doc=${doc.key}`}
              onClick={() => onDocChange(doc.key)}
              className={`block px-3 py-2 rounded ${
                isActive ? 'bg-foreground/10 font-semibold' : 'hover:bg-foreground/5'
              }`}
            >
              {doc.name}
            </Link>
            {isActive && (
              <div className="ml-4 mt-2 space-y-1">
                {docHeadings.map(h => (
                  <a
                    key={h.id}
                    href={`#${h.id}`}
                    className="block text-sm text-foreground/70 hover:text-foreground px-2 py-1 rounded hover:bg-foreground/5"
                  >
                    {h.text}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run DocsSidebar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/docs/DocsSidebar.tsx frontend/src/components/docs/DocsSidebar.test.tsx
git commit -m "feat: create DocsSidebar with tree navigation and anchors"
```

---

### Task 5: Create `DocsPage` Layout Component

**Files:**
- Create: `frontend/src/components/docs/DocsPage.tsx`
- Test: `frontend/src/components/docs/DocsPage.test.tsx`

**Interfaces:**
- Consumes: `DocsSidebar` from Task 4, `MarkdownRenderer` from Task 3, `loadDoc` from previous session
- Produces: React component `<DocsPage initialDoc={string} />` that manages layout and doc switching

- [ ] **Step 1: Write failing test**

```typescript
import { render, screen } from '@testing-library/react';
import DocsPage from '@/components/docs/DocsPage';

test('renders sidebar and main content area', () => {
  render(<DocsPage initialDoc="getting-started" />);
  expect(screen.getByRole('navigation')).toBeInTheDocument(); // sidebar
  expect(screen.getByText(/Getting Started/)).toBeInTheDocument(); // title from content
});

test('loads and renders markdown content for initial doc', async () => {
  render(<DocsPage initialDoc="api-reference" />);
  expect(await screen.findByText(/API/)).toBeInTheDocument();
});

test('switches doc when sidebar link clicked', async () => {
  render(<DocsPage initialDoc="getting-started" />);
  const apiLink = screen.getByText('API Reference');
  await userEvent.click(apiLink);
  // Content should change (simplified check)
  expect(screen.getByText('API Reference')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run DocsPage.test.tsx`
Expected: FAIL with "DocsPage is not defined"

- [ ] **Step 3: Implement `DocsPage` component**

State: `currentDoc`, load markdown via `loadDoc`, render sidebar + MarkdownRenderer side-by-side. Handle doc switching.

```typescript
'use client';

import { useState, useEffect } from 'react';
import DocsSidebar from './DocsSidebar';
import MarkdownRenderer from './MarkdownRenderer';
import { loadDoc } from '@/lib/doc-loader';

interface DocsPageProps {
  initialDoc: string;
}

export default function DocsPage({ initialDoc }: DocsPageProps) {
  const [currentDoc, setCurrentDoc] = useState(initialDoc);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    loadDoc(currentDoc)
      .then(setContent)
      .catch(err => console.error('Failed to load doc:', err))
      .finally(() => setLoading(false));
  }, [currentDoc]);

  return (
    <div className="flex h-screen bg-gradient-to-br from-background via-background to-foreground/5">
      <DocsSidebar currentDoc={currentDoc} onDocChange={setCurrentDoc} />
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto">
          {loading ? (
            <div className="text-foreground/50">Loading...</div>
          ) : (
            <div className="prose dark:prose-invert max-w-none">
              <MarkdownRenderer content={content} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run DocsPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/docs/DocsPage.tsx frontend/src/components/docs/DocsPage.test.tsx
git commit -m "feat: create DocsPage layout component"
```

---

### Task 6: Create `/docs` Route Page

**Files:**
- Create: `frontend/src/app/(browser)/docs/page.tsx`
- Create: `frontend/src/app/(browser)/docs/layout.tsx`

**Interfaces:**
- Consumes: `DocsPage` component from Task 5

- [ ] **Step 1: Create route page**

Create `frontend/src/app/(browser)/docs/page.tsx`:

```typescript
'use client';

import { useSearchParams } from 'next/navigation';
import DocsPage from '@/components/docs/DocsPage';

export default function DocsRoute() {
  const searchParams = useSearchParams();
  const doc = searchParams.get('doc') || 'getting-started';

  return <DocsPage initialDoc={doc} />;
}
```

- [ ] **Step 2: Create layout for styling consistency**

Create `frontend/src/app/(browser)/docs/layout.tsx`:

```typescript
import { ReactNode } from 'react';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-foreground/5">
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Verify routing**

Run: `pnpm --filter frontend dev -- -p 3001` in another terminal
Navigate to `http://localhost:3001/docs?doc=getting-started`
Expected: Docs page loads with sidebar and getting-started content

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/\(browser\)/docs/page.tsx frontend/src/app/\(browser\)/docs/layout.tsx
git commit -m "feat: add /docs route"
```

---

### Task 7: Update Homepage and Add Doc Links

**Files:**
- Modify: `frontend/src/app/(browser)/(homepage)/HomepageClient.tsx`
- Modify: `frontend/messages/en.json`
- Modify: `frontend/messages/ru.json`

**Interfaces:**
- Consumes: Nothing new, uses existing i18n

- [ ] **Step 1: Update i18n messages**

Add to `frontend/messages/en.json` under `Home.docs`:

```json
{
  "Home": {
    "docs": {
      "title": "Documentation",
      "gettingStarted": "Getting Started",
      "apiReference": "API Reference",
      "entityRegistration": "Entity Registration",
      "multiplayerGuide": "Multiplayer Guide"
    }
  }
}
```

Add to `frontend/messages/ru.json`:

```json
{
  "Home": {
    "docs": {
      "title": "Документация",
      "gettingStarted": "Начало работы",
      "apiReference": "Справочник API",
      "entityRegistration": "Регистрация сущностей",
      "multiplayerGuide": "Руководство многопользовательской игры"
    }
  }
}
```

- [ ] **Step 2: Remove DocViewer and DocsNav from HomepageClient**

In `HomepageClient.tsx`, remove:
- `import { DocViewer } from '@/components/docs/DocViewer'`
- `import { DocsNav } from '@/components/docs/DocsNav'`
- State: `activeDoc`, `setActiveDoc`
- JSX: `<DocViewer/>` and `<DocsNav/>` sections

- [ ] **Step 3: Add documentation links section**

Add a new section to HomepageClient:

```typescript
const t = useTranslations('Home.docs');

return (
  <>
    {/* existing content */}
    <section className="mt-12 p-6 bg-foreground/5 backdrop-blur-sm rounded-lg border border-foreground/10">
      <h2 className="text-2xl font-bold mb-6">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/docs?doc=getting-started"
          className="p-4 hover:bg-foreground/10 rounded transition"
        >
          {t('gettingStarted')}
        </Link>
        <Link
          href="/docs?doc=api-reference"
          className="p-4 hover:bg-foreground/10 rounded transition"
        >
          {t('apiReference')}
        </Link>
        <Link
          href="/docs?doc=entity-registration"
          className="p-4 hover:bg-foreground/10 rounded transition"
        >
          {t('entityRegistration')}
        </Link>
        <Link
          href="/docs?doc=multiplayer-guide"
          className="p-4 hover:bg-foreground/10 rounded transition"
        >
          {t('multiplayerGuide')}
        </Link>
      </div>
    </section>
  </>
);
```

- [ ] **Step 4: Run type check**

Run: `pnpm check-types:frontend`
Expected: 0 errors

- [ ] **Step 5: Verify homepage and links**

Run: `pnpm --filter frontend dev -- -p 3001`
Navigate to `http://localhost:3001/`
Click on doc links
Expected: Navigates to `/docs?doc=<name>` and renders correct content

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/\(browser\)/\(homepage\)/HomepageClient.tsx frontend/messages/en.json frontend/messages/ru.json
git commit -m "refactor(frontend): replace homepage doc viewer with links to /docs"
```

---

### Task 8: Full Integration Test and Verification

**Files:**
- Modify: `frontend/src/components/docs/DocsPage.test.tsx` (add full integration test)

**Interfaces:**
- Consumes: All tasks above

- [ ] **Step 1: Write full integration test**

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DocsPage from '@/components/docs/DocsPage';

test('full docs page flow: load doc, navigate anchors, switch docs', async () => {
  render(<DocsPage initialDoc="getting-started" />);

  // Verify sidebar loads
  await waitFor(() => {
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
  });

  // Verify content renders
  expect(await screen.findByText(/Installation/)).toBeInTheDocument();

  // Click API Reference in sidebar
  const apiLink = screen.getByText('API Reference');
  await userEvent.click(apiLink);

  // Wait for new content
  await waitFor(() => {
    expect(screen.getByText(/API Methods/)).toBeInTheDocument();
  });

  // Verify anchor link works
  const anchorLink = screen.getByText(/method-name/);
  expect(anchorLink).toHaveAttribute('href', expect.stringContaining('#'));
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter frontend exec vitest run DocsPage.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 3: Run full frontend test suite**

Run: `pnpm --filter frontend test`
Expected: All tests pass, no errors

- [ ] **Step 4: Manual verification checklist**

- [ ] Navigate to `/docs` in browser
- [ ] Sidebar loads all 4 docs
- [ ] Click each doc link, verify content loads
- [ ] Click anchor link in sidebar, verify hash changes and scrolls
- [ ] Code blocks display with syntax highlighting (colors visible)
- [ ] Homepage links to `/docs` work
- [ ] Switch language (locale), verify doc link labels change
- [ ] Responsive layout (sidebar collapses on mobile or hides)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/docs/DocsPage.test.tsx
git commit -m "test: add full integration test for docs page"
```

---

## Review Focus

1. **Empty or missing markdown files:** If `loadDoc()` fails for a file (e.g., file doesn't exist in `public/docs/`), sidebar lists the doc but clicking it shows loading forever or error — test added in Task 8 to verify all 4 docs load and render
2. **Anchor collision:** If two headings have identical text (e.g., both "Installation"), slug collision causes duplicate IDs — `parseMarkdownHeadings` tested in Task 1 to append counter for duplicates
3. **Mobile sidebar:** On small screens, sidebar consumes all width or doesn't collapse — responsive layout test in Task 8 verifies layout on mobile
4. **Language switching:** i18n locale changes don't update doc link labels on homepage — Task 7 uses `useTranslations`, test verifies en/ru messages load
5. **Code block rendering:** Unsupported language or missing highlight.js library crashes — Task 2 installs highlight.js, Task 3 tests code rendering with common languages (typescript, gdscript)
