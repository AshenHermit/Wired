# Documentation Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a documentation page on the frontend homepage that explains how to use the Wired Godot API with guides on basic usage, entity registration, and multiplayer examples.

**Architecture:** Documentation stored as markdown files in `frontend/public/docs/`, loaded dynamically and rendered using `react-markdown` with syntax highlighting. A navigation component organizes docs into sections (Getting Started, API Reference, Multiplayer Guide, Entity Registration). The docs tab in HomepageClient displays this content with a sidebar for section navigation.

**Tech Stack:** React 19, Next.js 16, react-markdown, next-intl for i18n, Tailwind CSS for styling, TypeScript.

**Spec:** User requirements for documentation page accessible from homepage tabs with markdown-based content about Godot API, basic examples, entity descriptions, and multiplayer patterns.

## Global Constraints

- UI copy must be internationalized via `frontend/messages/{en,ru}.json` using `next-intl`
- All markdown files stored in `frontend/public/docs/` (static, version-controlled)
- Components follow shadcn/ui + Tailwind patterns (existing in project)
- Documentation examples use TypeScript and GDScript (Godot scripting language)
- No new external dependencies beyond `react-markdown` (already implicit in Next ecosystem)

## Review Focus

1. **Markdown rendering XSS:** User-supplied or malicious markdown in doc files could inject scripts; `react-markdown` with safe defaults must be verified
2. **Missing sections:** API docs incomplete; users try to use unstated features or misunderstand entity registration flow
3. **Broken code examples:** Copy-paste from docs fails to run; users can't test examples locally
4. **Localization gaps:** Russian or English translations missing; UI shows untranslated keys
5. **Navigation confusion:** Users can't find relevant section; sidebar doesn't highlight active section or load wrong content

---

### Task 1: Create Documentation Markdown Files

**Files:**
- Create: `frontend/public/docs/getting-started.md`
- Create: `frontend/public/docs/api-reference.md`
- Create: `frontend/public/docs/multiplayer-guide.md`
- Create: `frontend/public/docs/entity-registration.md`

**Interfaces:**
- Produces: Four markdown files with documented sections on Godot API usage, examples, and patterns. Files are loaded by `doc-loader.ts` and rendered by `DocViewer.tsx`.

- [ ] **Step 1: Create `getting-started.md`**

Contains:
- Title: "Getting Started"
- Brief intro to Wired Godot API
- Simple example: creating a scene, registering an entity
- Link to next sections

```markdown
# Getting Started with Wired Godot API

Welcome to Wired! This guide will help you get started with the Godot API.

## Creating Your First Scene

Godot scenes are the foundation of your game. Here's a minimal example:

\`\`\`gdscript
extends Node
class_name MyFirstScene

func _ready():
    print("Scene loaded!")
\`\`\`

## Next Steps

Learn about [Entity Registration](entity-registration.md) to register game objects.
```

- [ ] **Step 2: Create `entity-registration.md`**

Contains:
- Title: "Entity Registration"
- What entities are (game objects that need network sync)
- How to register entities with Wired
- Example: registering a player character

```markdown
# Entity Registration

Entities are game objects that Wired synchronizes across clients. Learn how to register them.

## What is an Entity?

An entity represents any game object that multiple clients need to know about:
- Players
- NPCs
- Bullets
- Interactive objects

## Registering an Entity

Use the Wired API to register entities:

\`\`\`gdscript
extends Node
class_name Player

func _ready():
    # Register this node as an entity
    Wired.register_entity(self, "player")
\`\`\`

## See Also

- [Multiplayer Guide](multiplayer-guide.md) for network synchronization patterns
```

- [ ] **Step 3: Create `api-reference.md`**

Contains:
- Title: "API Reference"
- Core classes and methods
- Parameter descriptions and return types
- Examples for each major function

```markdown
# Wired API Reference

Core API methods for Godot development.

## Wired Class

### Methods

#### `register_entity(node: Node, entity_type: String) -> void`

Registers a node as a network entity.

**Parameters:**
- `node`: The Node to register
- `entity_type`: Type identifier (e.g., "player", "npc")

**Example:**
\`\`\`gdscript
Wired.register_entity(self, "player")
\`\`\`

#### `send_message(channel: String, data: Dictionary) -> void`

Sends a message to other clients on a channel.

**Parameters:**
- `channel`: Message channel name
- `data`: Dictionary payload

**Example:**
\`\`\`gdscript
Wired.send_message("chat", {"text": "Hello!"})
\`\`\`
```

- [ ] **Step 4: Create `multiplayer-guide.md`**

Contains:
- Title: "Multiplayer Guide"
- Synchronizing entity state
- Handling player input in multiplayer
- Managing connections and disconnections
- Example: synchronized player movement

```markdown
# Multiplayer Guide

Build multiplayer games with Wired.

## Synchronizing State

Entities automatically sync their transform and properties:

\`\`\`gdscript
extends Node3D
class_name MultiplayerCharacter

@export var speed = 5.0

func _process(delta):
    var input = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
    position += Vector3(input.x, 0, input.y) * speed * delta
    # Position is automatically synced to other players
\`\`\`

## Handling Connections

React to player join/leave events:

\`\`\`gdscript
func _ready():
    Wired.player_joined.connect(_on_player_joined)
    Wired.player_left.connect(_on_player_left)

func _on_player_joined(player_id: String):
    print("Player joined: ", player_id)

func _on_player_left(player_id: String):
    print("Player left: ", player_id)
\`\`\`
```

- [ ] **Step 5: Verify markdown syntax and commit**

Run: `git add frontend/public/docs/*.md`
Expected: All four files present in `frontend/public/docs/`

---

### Task 2: Create Doc Loader Utility

**Files:**
- Create: `frontend/src/lib/doc-loader.ts`

**Interfaces:**
- Produces: Async function `loadDoc(docName: string) -> Promise<string>` that fetches markdown content from `frontend/public/docs/`. Returns raw markdown string for rendering.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/doc-loader.test.ts`:

```typescript
import { loadDoc } from './doc-loader';

describe('loadDoc', () => {
  it('should load markdown file by name', async () => {
    const content = await loadDoc('getting-started');
    expect(content).toContain('Getting Started');
  });

  it('should throw error for non-existent doc', async () => {
    await expect(loadDoc('non-existent')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run doc-loader.test.ts`
Expected: FAIL with "loadDoc is not defined"

- [ ] **Step 3: Implement `loadDoc(docName: string) -> Promise<string>` in `frontend/src/lib/doc-loader.ts`**

Function fetches from `/docs/{docName}.md`, validates response status, and returns text. If fetch fails or file not found (404), throw error with descriptive message. Use `fetch` API available in Next.js.

```typescript
export async function loadDoc(docName: string): Promise<string> {
  const response = await fetch(`/docs/${docName}.md`);
  if (!response.ok) {
    throw new Error(`Failed to load documentation: ${docName}`);
  }
  return response.text();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run doc-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/doc-loader.ts frontend/src/lib/doc-loader.test.ts
git commit -m "feat(docs): add doc-loader utility for fetching markdown"
```

---

### Task 3: Create DocViewer Component

**Files:**
- Create: `frontend/src/components/docs/DocViewer.tsx`
- Create: `frontend/src/components/docs/DocViewer.test.tsx`

**Interfaces:**
- Consumes: `loadDoc(docName: string) -> Promise<string>` from Task 2
- Produces: `<DocViewer docName={string} />` component that fetches and renders markdown with heading-based outline

- [ ] **Step 1: Write the failing test**

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import { DocViewer } from './DocViewer';

// Mock loadDoc
jest.mock('@/lib/doc-loader', () => ({
  loadDoc: jest.fn().mockResolvedValue('# Test\n\nContent'),
}));

describe('DocViewer', () => {
  it('should render markdown content', async () => {
    render(<DocViewer docName="getting-started" />);
    await waitFor(() => {
      expect(screen.getByText(/content/i)).toBeInTheDocument();
    });
  });

  it('should display error on load failure', async () => {
    jest.mocked(loadDoc).mockRejectedValueOnce(new Error('Not found'));
    render(<DocViewer docName="invalid" />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run DocViewer.test.tsx`
Expected: FAIL with component not rendering

- [ ] **Step 3: Implement `<DocViewer docName={string} />` component**

Use `react-markdown` to render fetched content. Handle loading and error states. Wrap code blocks in `<pre>` with syntax highlighting classes (Tailwind). Extract headings for outline. Component is client-side (`"use client"`).

```typescript
'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { loadDoc } from '@/lib/doc-loader';

export function DocViewer({ docName }: { docName: string }) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDoc(docName)
      .then(setContent)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [docName]);

  if (loading) return <div>Loading documentation...</div>;
  if (error) return <div className="text-red-500">Failed to load: {error}</div>;

  return (
    <div className="prose prose-sm max-w-2xl">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run DocViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/docs/DocViewer.tsx frontend/src/components/docs/DocViewer.test.tsx
git commit -m "feat(docs): add DocViewer component for rendering markdown"
```

---

### Task 4: Create DocsNav Component

**Files:**
- Create: `frontend/src/components/docs/DocsNav.tsx`

**Interfaces:**
- Produces: `<DocsNav activeDoc={string} onSelect={(docName: string) => void} />` component displaying navigation list of documentation sections

- [ ] **Step 1: Implement `<DocsNav />` component**

Display list of doc sections: "Getting Started", "API Reference", "Entity Registration", "Multiplayer Guide". Highlight active section. Use `useTranslations` for i18n keys `docs.nav.gettingStarted`, etc. Use shadcn Button or Link component.

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/docs/DocsNav.tsx
git commit -m "feat(docs): add DocsNav component for section navigation"
```

---

### Task 5: Update HomepageClient Docs Tab

**Files:**
- Modify: `frontend/src/app/(browser)/(homepage)/HomepageClient.tsx`
- Modify: `frontend/messages/en.json`
- Modify: `frontend/messages/ru.json`

**Interfaces:**
- Consumes: `<DocViewer />`, `<DocsNav />` from Tasks 3–4
- Produces: Populated docs tab in HomepageClient with state management for active doc

- [ ] **Step 1: Add i18n messages**

In `frontend/messages/en.json`, add under `Home` key:

```json
"docs.title": "Documentation",
"docs.description": "Learn how to use Wired Godot API",
"docs.nav.gettingStarted": "Getting Started",
"docs.nav.apiReference": "API Reference",
"docs.nav.entityRegistration": "Entity Registration",
"docs.nav.multiplayerGuide": "Multiplayer Guide"
```

In `frontend/messages/ru.json`, add under `Home` key (example translations):

```json
"docs.title": "Документация",
"docs.description": "Узнайте, как использовать Godot API Wired",
"docs.nav.gettingStarted": "Начало работы",
"docs.nav.apiReference": "Справка по API",
"docs.nav.entityRegistration": "Регистрация сущностей",
"docs.nav.multiplayerGuide": "Мультиплеер"
```

- [ ] **Step 2: Update HomepageClient to use DocViewer and DocsNav**

Modify the docs tab (`TabsContent value="docs"`) to:
- Import `DocViewer` and `DocsNav`
- Add state `const [activeDoc, setActiveDoc] = useState('getting-started')`
- Render `<DocsNav activeDoc={activeDoc} onSelect={setActiveDoc} />`
- Render `<DocViewer docName={activeDoc} />` beside nav

Layout: Two-column grid with nav (width-1/4) and viewer (width-3/4).

```typescript
// In HomepageClient.tsx

import { DocViewer } from '@/components/docs/DocViewer';
import { DocsNav } from '@/components/docs/DocsNav';

// Inside return, update the docs TabsContent:

<TabsContent value="docs" className="flex flex-col gap-6 w-full">
  <CardHeader>
    <CardTitle>{t("docs.title")}</CardTitle>
    <CardDescription>{t("docs.description")}</CardDescription>
  </CardHeader>
  <CardContent className="grid gap-6 grid-cols-4">
    <div>
      <DocsNav activeDoc={activeDoc} onSelect={setActiveDoc} />
    </div>
    <div className="col-span-3">
      <DocViewer docName={activeDoc} />
    </div>
  </CardContent>
</TabsContent>
```

Also add `const [activeDoc, setActiveDoc] = useState('getting-started')` near the top of `HomepageClient`.

- [ ] **Step 3: Verify i18n messages are valid JSON**

Run: `jq empty frontend/messages/en.json frontend/messages/ru.json`
Expected: No output (valid JSON)

- [ ] **Step 4: Run frontend dev and test docs tab loads**

Run: `pnpm --filter frontend dev -- -p 3001` (in background)
Expected: Frontend starts on localhost:3001

Navigate to home → Docs tab. Should show nav with 4 sections and content below.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/(browser)/(homepage)/HomepageClient.tsx frontend/messages/en.json frontend/messages/ru.json
git commit -m "feat(docs): integrate DocViewer and DocsNav into homepage docs tab"
```

---

### Task 6: Add react-markdown Dependency (if not present)

**Files:**
- Modify: `frontend/package.json`

**Interfaces:**
- Produces: `react-markdown` added to dependencies

- [ ] **Step 1: Check if react-markdown exists**

Run: `grep react-markdown frontend/package.json`
Expected: Either found or not found

- [ ] **Step 2: If not found, add react-markdown**

Run: `pnpm --filter frontend add react-markdown`
Expected: Package added to package.json

- [ ] **Step 3: Verify install**

Run: `ls frontend/node_modules/react-markdown`
Expected: Directory exists

- [ ] **Step 4: Commit if new**

```bash
git add frontend/package.json
git commit -m "chore(frontend): add react-markdown dependency"
```

---

### Task 7: Full Integration Test and Verification

**Files:**
- No new files; existing components tested end-to-end

**Interfaces:**
- Verifies: All tasks produce a working docs tab with navigation, content loading, and i18n

- [ ] **Step 1: Type-check frontend**

Run: `pnpm --filter frontend check-types`
Expected: No type errors

- [ ] **Step 2: Lint frontend docs code**

Run: `pnpm --filter frontend lint`
Expected: No linting errors in docs components

- [ ] **Step 3: Run frontend tests**

Run: `pnpm --filter frontend test`
Expected: All doc-related tests pass (doc-loader, DocViewer)

- [ ] **Step 4: Run dev server and manual test**

Start: `pnpm --filter frontend dev -- -p 3001`
- Navigate to homepage
- Click "Docs" tab
- Verify nav shows all 4 sections
- Click each section; docs should load and display without errors
- Verify English and Russian text matches i18n

- [ ] **Step 5: Verify markdown renders correctly**

Check in browser DevTools that markdown headings, code blocks, and links render as expected (no raw markdown syntax visible).

- [ ] **Step 6: Commit integration test results**

```bash
git commit -m "docs: verify docs tab integration and rendering"
```

---

## Summary

This plan creates a fully functional documentation page integrated into the homepage. The implementation is modular: markdown files can be edited independently, components are testable and reusable, and internationalization allows for multi-language support. The docs tab appears alongside existing tabs (rooms, packages, controls) and provides users with API guidance, examples, and multiplayer patterns.

**Files Modified/Created:**
- `frontend/public/docs/getting-started.md` (new)
- `frontend/public/docs/api-reference.md` (new)
- `frontend/public/docs/multiplayer-guide.md` (new)
- `frontend/public/docs/entity-registration.md` (new)
- `frontend/src/lib/doc-loader.ts` (new)
- `frontend/src/components/docs/DocViewer.tsx` (new)
- `frontend/src/components/docs/DocsNav.tsx` (new)
- `frontend/src/app/(browser)/(homepage)/HomepageClient.tsx` (modified)
- `frontend/messages/en.json` (modified)
- `frontend/messages/ru.json` (modified)
- `frontend/package.json` (modified, if react-markdown added)

**Dependencies:** `react-markdown` (check if already present)
