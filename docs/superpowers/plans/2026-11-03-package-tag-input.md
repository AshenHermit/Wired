# Package Tag Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** При редактировании пакета предлагать теги, уже использованные в опубликованных пакетах workshop, и дать вводить их чипами.

**Architecture:** Новый публичный агрегирующий endpoint отдаёт частоты тегов по тем же строкам, что и каталог workshop. Фронтенд грузит их одним запросом с модульным кешем на 60 с, а самостоятельный `TagInput` (без новых зависимостей) показывает подсказки в Radix Popover и нормализует ввод по серверным правилам.

**Tech Stack:** NestJS + TypeORM raw SQL, shared TypeScript types, React 19, Radix Popover через `animate-ui`, Jest, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-03-package-tag-input-design.md`

## Global Constraints

- Новые npm-зависимости не добавлять.
- Формат тега на клиенте повторяет сервер: `/^[a-z0-9_-]{1,32}$/`, максимум 10 тегов; сервер остаётся источником истины.
- Подсказки — только теги пакетов, опубликованных в workshop (`p."roomId" IS NULL` + опубликованная ревизия).
- `GET workshop/tags` объявляется до `@Get(':id')`, иначе Nest разберёт `tags` как id.
- UI-тексты на русском; фронтенд — двойные кавычки, сервер — одинарные и trailing commas.
- Никакого поиска/фильтра по тегам в каталоге: только подсказки в редакторе.

## Review Focus

- Пользователь вводит невалидный тег (`Привет!`, 40 символов) и жмёт Enter — тег не добавляется, ввод остаётся в поле, показана подсказка формата.
- Клик по подсказке при непустом черновике добавляет ровно один тег (без двойного добавления из-за blur).
- Открытие редактора с существующими тегами и сохранение без правок отправляет тот же массив.
- Запрос подсказок упал или ещё грузится — поле продолжает работать как обычный ввод тегов.
- Дубликат или 11-й тег не добавляются и не отправляются на сервер.

---

### Task 1: Workshop tag aggregation API

**Files:**
- Modify: `packages/shared/src/api/types.ts` (рядом с `WorkshopListing`)
- Modify: `packages/server/src/scripting-packages/package-workshop.service.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts:98-116`
- Test: `packages/server/src/scripting-packages/package-workshop.service.spec.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.controller.spec.ts:619-749`

**Interfaces:**
- Consumes: `WORKSHOP_SELECT`-совместимые условия каталога, `parseOptionalNumber`.
- Produces: shared `WorkshopTagCount = { tag: string; count: number }`, `WorkshopTagListing = { items: WorkshopTagCount[]; total: number }`; `PackageWorkshopService.tags(query): Promise<WorkshopTagListing>`; `GET /scripting-packages/workshop/tags?q=&limit=&offset=`.

- [ ] **Step 1: Write the failing service tests**

Add to `describe('PackageWorkshopService')` in `package-workshop.service.spec.ts`:

```ts
it('normalizes the tag query and clamps pagination', async () => {
  const query = jest.fn(() => Promise.resolve([]));
  const service = makeService({ query });

  await service.tags({ q: '  HERO  ', limit: 500, offset: -3 });

  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('jsonb_array_elements_text'),
    ['%hero%', 200, 0],
  );
});

it('uses an empty tag pattern and the tag pagination defaults', async () => {
  const query = jest.fn(() => Promise.resolve([]));
  const service = makeService({ query });

  await expect(service.tags({})).resolves.toEqual({ items: [], total: 0 });

  expect(query).toHaveBeenCalledWith(expect.anything(), ['', 100, 0]);
});

it('maps tag counts and total from Postgres strings to numbers', async () => {
  const query = jest.fn(() =>
    Promise.resolve([{ tag: '2d', count: '3', total: '2' }]),
  );
  const service = makeService({ query });

  await expect(service.tags({})).resolves.toEqual({
    items: [{ tag: '2d', count: 3 }],
    total: 2,
  });
});

it('falls back to tag defaults for non-finite and fractional paging', async () => {
  const query = jest.fn(() => Promise.resolve([]));
  const service = makeService({ query });

  await service.tags({ limit: Number.NaN, offset: Number.NaN });
  expect(paramsOf(query)).toEqual(['', 100, 0]);

  await service.tags({ limit: 2.5, offset: 1.5 });
  expect(paramsOf(query, 1)).toEqual(['', 2, 1]);
});

it('treats a non-string tag query as absent', async () => {
  const query = jest.fn(() => Promise.resolve([]));
  const service = makeService({ query });

  await service.tags({ q: ['a', 'b'] as never });

  expect(paramsOf(query)).toEqual(['', 100, 0]);
});
```

- [ ] **Step 2: Run the service spec and verify it fails**

Run: `pnpm --filter server exec jest package-workshop.service.spec -t "tag"`
Expected: FAIL — `service.tags is not a function`.

- [ ] **Step 3: Add the shared types**

In `packages/shared/src/api/types.ts`, next to `WorkshopListing`:

```ts
export type WorkshopTagCount = {
  tag: string;
  count: number;
};

export type WorkshopTagListing = {
  items: WorkshopTagCount[];
  total: number;
};
```

- [ ] **Step 4: Implement the service aggregation**

In `package-workshop.service.ts`:

1. Add `WorkshopTagListing` to the `@wired-io/shared` import.
2. Add the SQL constant after `LOOKUP_SQL`:

```ts
const TAGS_SQL = `SELECT t.tag, COUNT(*)::int AS count, COUNT(*) OVER() AS total
FROM scripting_package p
JOIN LATERAL (
  SELECT 1 FROM scripting_package_revision
  WHERE "packageId" = p.id AND status = 'published'
    AND "publishedAt" IS NOT NULL
  LIMIT 1
) r ON TRUE
CROSS JOIN LATERAL jsonb_array_elements_text(p.tags) AS t(tag)
WHERE p."roomId" IS NULL AND ($1 = '' OR t.tag ILIKE $1)
GROUP BY t.tag
ORDER BY COUNT(*) DESC, t.tag ASC
LIMIT $2 OFFSET $3`;
```

3. Extract the normalization currently inside `list()` into a private method, so both endpoints share it exactly:

```ts
private normalizePaging(
  query: { q?: string; limit?: number; offset?: number },
  defaults: { limit: number; maxLimit: number },
): { pattern: string; limit: number; offset: number } {
  const q = (typeof query.q === 'string' ? query.q : '')
    .trim()
    .toLowerCase()
    .slice(0, 64);
  const limit = Number.isFinite(query.limit)
    ? Math.min(defaults.maxLimit, Math.max(1, Math.trunc(query.limit as number)))
    : defaults.limit;
  const offset = Number.isFinite(query.offset)
    ? Math.max(0, Math.trunc(query.offset as number))
    : 0;
  return { pattern: q ? `%${q}%` : '', limit, offset };
}
```

`list()` then starts with `const { pattern, limit, offset } = this.normalizePaging(query, { limit: 50, maxLimit: 100 });` — its behavior and tests stay unchanged.

4. Add the method after `lookup()`:

```ts
async tags(query: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkshopTagListing> {
  const { pattern, limit, offset } = this.normalizePaging(query, {
    limit: 100,
    maxLimit: 200,
  });
  const rows: { tag: string; count: string | number; total: string | number }[] =
    await this.packagesRepository.query(TAGS_SQL, [pattern, limit, offset]);
  return {
    items: rows.map((row) => ({ tag: row.tag, count: Number(row.count) })),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}
```

- [ ] **Step 5: Run the service spec and verify it passes**

Run: `pnpm --filter server exec jest package-workshop.service.spec`
Expected: PASS, включая прежние тесты `list()`.

- [ ] **Step 6: Write the failing route-order test**

In `scripting-packages.controller.spec.ts`, in `describe('ScriptingPackagesController slug route ordering')`, add a `listWorkshopTags` mock and provide it:

```ts
let listWorkshopTags: jest.Mock;
// in beforeAll:
listWorkshopTags = jest.fn(() => Promise.resolve({ items: [], total: 0 }));
// in the PackageWorkshopService provider:
useValue: { list: listWorkshop, lookup: lookupWorkshop, tags: listWorkshopTags },
```

Add after the lookup test:

```ts
it('serves workshop tags instead of falling through to :id', async () => {
  await request(app.getHttpServer())
    .get('/scripting-packages/workshop/tags?q=hero&limit=5&offset=10')
    .expect(200);

  expect(listWorkshopTags).toHaveBeenCalledWith({
    q: 'hero',
    limit: 5,
    offset: 10,
  });
  expect(findOne).not.toHaveBeenCalled();
});
```

- [ ] **Step 7: Run the controller spec and verify it fails**

Run: `pnpm --filter server exec jest scripting-packages.controller.spec -t "workshop tags"`
Expected: FAIL — 404 / `findOne` called instead of `listWorkshopTags`.

- [ ] **Step 8: Add the controller route**

In `scripting-packages.controller.ts`, directly after `@Get('workshop/lookup')` (and therefore still before `@Get(':id')`):

```ts
@ApiOkResponse({ description: 'Workshop tag usage' })
@Get('workshop/tags')
workshopTags(
  @Query('q') q?: string,
  @Query('limit') limit?: string,
  @Query('offset') offset?: string,
) {
  return this.workshopService.tags({
    q,
    limit: parseOptionalNumber(limit),
    offset: parseOptionalNumber(offset),
  });
}
```

- [ ] **Step 9: Verify server tests and types**

Run: `pnpm --filter server exec jest package-workshop.service.spec scripting-packages.controller.spec`
Expected: PASS.

Run: `pnpm --filter server check-types`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/api/types.ts packages/server/src/scripting-packages/package-workshop.service.ts packages/server/src/scripting-packages/package-workshop.service.spec.ts packages/server/src/scripting-packages/scripting-packages.controller.ts packages/server/src/scripting-packages/scripting-packages.controller.spec.ts
git commit -m "feat(server): add workshop tag suggestions endpoint"
```

---

### Task 2: Frontend workshop tags service and cached hook

**Files:**
- Modify: `frontend/src/api/services/scripting-packages.ts` (after `listWorkshopPackages`)
- Create: `frontend/src/components/packages/use-workshop-tags.ts`
- Test: `frontend/src/components/packages/use-workshop-tags.test.tsx`

**Interfaces:**
- Consumes: shared `WorkshopTagListing`, existing `apiClient.get`.
- Produces: `listWorkshopTags(params: { q?: string; limit?: number; offset?: number }): Promise<WorkshopTagListing>`; `useWorkshopTags(): { tags: WorkshopTagCount[]; loading: boolean }`; `resetWorkshopTagsCache(): void`; `WORKSHOP_TAGS_CACHE_TTL_MS = 60_000`.

- [ ] **Step 1: Write the failing hook tests**

Create `frontend/src/components/packages/use-workshop-tags.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listWorkshopTags } from "@/api/services/scripting-packages";
import {
  resetWorkshopTagsCache,
  useWorkshopTags,
} from "./use-workshop-tags";

vi.mock("@/api/services/scripting-packages", () => ({
  listWorkshopTags: vi.fn(),
}));

const listing = { items: [{ tag: "hero", count: 2 }], total: 1 };

beforeEach(() => {
  vi.useRealTimers();
  resetWorkshopTagsCache();
  vi.mocked(listWorkshopTags).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWorkshopTags", () => {
  it("requests every tag once and reuses the cache within the TTL", async () => {
    vi.mocked(listWorkshopTags).mockResolvedValue(listing);

    const first = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(first.result.current.tags).toEqual(listing.items));
    expect(listWorkshopTags).toHaveBeenCalledWith({ limit: 200 });
    first.unmount();

    const second = renderHook(() => useWorkshopTags());
    await waitFor(() =>
      expect(second.result.current.tags).toEqual(listing.items),
    );
    expect(listWorkshopTags).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent mounts into one request", async () => {
    let resolve!: (value: typeof listing) => void;
    vi.mocked(listWorkshopTags).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );

    const first = renderHook(() => useWorkshopTags());
    const second = renderHook(() => useWorkshopTags());
    expect(listWorkshopTags).toHaveBeenCalledTimes(1);

    resolve(listing);
    await waitFor(() => expect(first.result.current.tags).toEqual(listing.items));
    await waitFor(() =>
      expect(second.result.current.tags).toEqual(listing.items),
    );
  });

  it("refetches after the cache expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:00:00.000Z"));
    vi.mocked(listWorkshopTags).mockResolvedValue(listing);

    const first = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(first.result.current.tags).toEqual(listing.items));
    first.unmount();

    vi.setSystemTime(new Date("2026-11-03T00:01:01.000Z"));

    const second = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(listWorkshopTags).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(second.result.current.tags).toEqual(listing.items),
    );
  });

  it("caches a failed request as an empty list", async () => {
    vi.mocked(listWorkshopTags).mockRejectedValue(new Error("offline"));

    const first = renderHook(() => useWorkshopTags());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.tags).toEqual([]);
    first.unmount();

    renderHook(() => useWorkshopTags());
    await waitFor(() => expect(listWorkshopTags).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run the hook test and verify it fails**

Run: `pnpm --filter frontend exec vitest run use-workshop-tags`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the API service function**

In `scripting-packages.ts`, import `WorkshopTagListing`, then add after `listWorkshopPackages`:

```ts
export async function listWorkshopTags(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkshopTagListing> {
  return apiClient.get<
    WorkshopTagListing,
    { q?: string; limit?: number; offset?: number }
  >("scripting-packages/workshop/tags", params);
}
```

- [ ] **Step 4: Implement the cached hook**

Create `use-workshop-tags.ts`:

```ts
"use client";

import * as React from "react";
import { listWorkshopTags } from "@/api/services/scripting-packages";
import type { WorkshopTagCount } from "@wired-io/shared";

export const WORKSHOP_TAGS_CACHE_TTL_MS = 60_000;

let cache: { tags: WorkshopTagCount[]; expiresAt: number } | null = null;
let inFlight: Promise<WorkshopTagCount[]> | null = null;

function cacheIsFresh(): boolean {
  return cache !== null && cache.expiresAt > Date.now();
}

function loadWorkshopTags(): Promise<WorkshopTagCount[]> {
  if (cacheIsFresh()) return Promise.resolve(cache!.tags);
  if (inFlight) return inFlight;

  inFlight = listWorkshopTags({ limit: 200 })
    .then((listing) => {
      cache = {
        tags: listing.items,
        expiresAt: Date.now() + WORKSHOP_TAGS_CACHE_TTL_MS,
      };
      return listing.items;
    })
    .catch(() => {
      cache = {
        tags: [],
        expiresAt: Date.now() + WORKSHOP_TAGS_CACHE_TTL_MS,
      };
      return [];
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Test helper: forget the module cache between test cases. */
export function resetWorkshopTagsCache(): void {
  cache = null;
  inFlight = null;
}

export function useWorkshopTags(): {
  tags: WorkshopTagCount[];
  loading: boolean;
} {
  const [tags, setTags] = React.useState<WorkshopTagCount[]>(
    cacheIsFresh() ? cache!.tags : [],
  );
  const [loading, setLoading] = React.useState(!cacheIsFresh());

  React.useEffect(() => {
    let cancelled = false;
    if (cacheIsFresh()) {
      setTags(cache!.tags);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadWorkshopTags().then((next) => {
      if (cancelled) return;
      setTags(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tags, loading };
}
```

- [ ] **Step 5: Run the hook test and verify it passes**

Run: `pnpm --filter frontend exec vitest run use-workshop-tags`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/services/scripting-packages.ts frontend/src/components/packages/use-workshop-tags.ts frontend/src/components/packages/use-workshop-tags.test.tsx
git commit -m "feat(frontend): cache workshop tag suggestions"
```

---

### Task 3: TagInput component

**Files:**
- Modify: `frontend/src/components/animate-ui/components/radix/popover.tsx` (re-export `PopoverAnchor`)
- Create: `frontend/src/components/packages/tag-input.tsx`
- Test: `frontend/src/components/packages/tag-input.test.tsx`
- Possibly modify: `frontend/vitest.setup.ts` (jsdom shims, только если тесты упадут)

**Interfaces:**
- Consumes: `useWorkshopTags()`, `Popover`/`PopoverAnchor`/`PopoverContent`, `cn`.
- Produces: `<TagInput id?, value: string[], onChange(next: string[]), disabled?, max?, placeholder? />`; exported `TAG_PATTERN`, `MAX_TAGS = 10`.

- [ ] **Step 1: Write the failing component tests**

Create `frontend/src/components/packages/tag-input.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkshopTags } from "./use-workshop-tags";
import { TagInput } from "./tag-input";

vi.mock("./use-workshop-tags", () => ({
  useWorkshopTags: vi.fn(),
}));

function renderInput(value: string[] = []) {
  const onChange = vi.fn();
  render(<TagInput value={value} onChange={onChange} />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  return { onChange, input };
}

beforeEach(() => {
  vi.mocked(useWorkshopTags).mockReturnValue({
    tags: [
      { tag: "gameplay", count: 12 },
      { tag: "hero", count: 3 },
      { tag: "2d", count: 1 },
    ],
    loading: false,
  });
});

describe("TagInput", () => {
  it("adds a normalized tag on Enter", () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Newtag" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["newtag"]);
  });

  it("adds a tag on comma", () => {
    const { onChange, input } = renderInput();
    fireEvent.change(input, { target: { value: "hero" } });
    fireEvent.keyDown(input, { key: "," });
    expect(onChange).toHaveBeenCalledWith(["hero"]);
  });

  it("commits a valid draft on blur", () => {
    const { onChange, input } = renderInput();
    fireEvent.change(input, { target: { value: "newtag" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["newtag"]);
  });

  it("adds an existing suggestion on click with its frequency", async () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "game" } });
    const option = await screen.findByRole("option", { name: /gameplay/ });
    expect(option.textContent).toContain("12 пакетов");
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["gameplay"]);
  });

  it("moves the active option with the arrow keys", async () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /gameplay/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["hero"]);
  });

  it("offers to create an unknown tag", async () => {
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "roguelike" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Создать „roguelike“" }),
    );
    expect(onChange).toHaveBeenCalledWith(["roguelike"]);
  });

  it("keeps an invalid draft and shows the format hint", () => {
    const { onChange, input } = renderInput();
    fireEvent.change(input, { target: { value: "Привет!" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("Привет!");
    expect(
      screen.getByText("Латиница, цифры, _ и -, до 32 символов."),
    ).toBeTruthy();
  });

  it("ignores a duplicate tag", () => {
    const { onChange, input } = renderInput(["hero"]);
    fireEvent.change(input, { target: { value: "hero" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("caps the tag count", () => {
    const ten = Array.from({ length: 10 }, (_, index) => `tag${index}`);
    const { onChange, input } = renderInput(ten);
    fireEvent.change(input, { target: { value: "extra" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("Можно добавить не больше 10 тегов."),
    ).toBeTruthy();
  });

  it("removes the last tag on Backspace in an empty field", () => {
    const { onChange, input } = renderInput(["a", "b"]);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith(["a"]);
  });

  it("removes a tag with its button", () => {
    const { onChange } = renderInput(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "Удалить тег b" }));
    expect(onChange).toHaveBeenCalledWith(["a"]);
  });

  it("excludes selected tags from suggestions", async () => {
    const { input } = renderInput(["hero"]);
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /gameplay/ });
    expect(
      screen.queryByRole("option", { name: /^hero/ }),
    ).toBeNull();
  });

  it("shows loading text but still accepts free input", async () => {
    vi.mocked(useWorkshopTags).mockReturnValue({ tags: [], loading: true });
    const { onChange, input } = renderInput();
    fireEvent.focus(input);
    expect(screen.getByText("Загружаем теги…")).toBeTruthy();
    fireEvent.change(input, { target: { value: "custom" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["custom"]);
  });
});
```

- [ ] **Step 2: Run the component test and verify it fails**

Run: `pnpm --filter frontend exec vitest run tag-input`
Expected: FAIL — module not found.

- [ ] **Step 3: Re-export the Popover anchor**

In `frontend/src/components/animate-ui/components/radix/popover.tsx` add `PopoverAnchor as PopoverAnchorPrimitive` and `type PopoverAnchorProps` to the import from the primitives file, wrap it, and add both the component and the type to the export list:

```tsx
function PopoverAnchor(props: PopoverAnchorProps) {
  return <PopoverAnchorPrimitive {...props} />;
}
```

- [ ] **Step 4: Implement `TagInput`**

Create `tag-input.tsx` with the following contract:

```tsx
"use client";

import * as React from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/animate-ui/components/radix/popover";
import { cn } from "@/lib/utils";
import { useWorkshopTags } from "./use-workshop-tags";

export const TAG_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const MAX_TAGS = 10;

export function TagInput({
  id,
  value,
  onChange,
  disabled = false,
  max = MAX_TAGS,
  placeholder = "gameplay, hero",
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  max?: number;
  placeholder?: string;
}) { /* ... */ }
```

Behavior to implement exactly:

- Local state: `draft: string`, `error: "format" | "limit" | null`, `open: boolean`, `activeIndex: number`; `listId = React.useId()`.
- `commit(raw)`: normalize `raw.trim().toLowerCase()`; empty → clear draft; `!TAG_PATTERN.test` → `error="format"`, keep draft; already in `value` → clear draft, no `onChange`; `value.length >= max` → `error="limit"`, keep draft; otherwise `onChange([...value, normalized])`, clear draft/error.
- Enter: if the list is open and `options[activeIndex]` exists — select it, otherwise `commit(draft)`.
- `,`: `preventDefault()` + `commit(draft)` (never selects a suggestion).
- Backspace with empty draft and non-empty value: `onChange(value.slice(0, -1))`.
- Blur: `setOpen(false)` and commit a non-empty draft.
- Typing: set draft, clear `error`, `setOpen(true)`.
- Suggestions: filter hook `tags` by `tag.includes(draft.trim().toLowerCase())` and `!value.includes(tag)`, take 8. Add `{ tag: normalizedDraft, count: null }` as «Создать „tag“» when the draft is valid and is neither selected nor among the suggestions. Keep server order (frequency) — do not re-sort.
- Render frequency as `12 пакетов` with Russian plural forms (`1 пакет`, `2 пакета`, `5 пакетов`).
- Reset `activeIndex` to 0 when draft/value/open change.
- Container: `flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50`; `border-destructive` + ring when `error`, opacity when disabled.
- Chips: `rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground`, with `<button type="button" aria-label={`Удалить тег ${tag}`}>` (×), disabled with the field.
- Input inside `PopoverAnchor asChild`; `role="combobox"`, `aria-expanded={showList}`, `aria-controls={showList ? listId : undefined}`, `aria-autocomplete="list"`, `aria-activedescendant` pointing at the active option id, `autoComplete="off"`, `disabled`, `placeholder`, `className="min-w-24 flex-1 bg-transparent outline-none disabled:cursor-not-allowed"`.
- `showList = open && !disabled && (loading || options.length > 0)`; `Popover open={showList} onOpenChange={setOpen}`.
- ArrowDown/ArrowUp move `activeIndex` modulo `options.length`; Escape closes.
- `PopoverContent align="start" sideOffset={4} className="w-(--radix-popover-anchor-width) p-1"`; loading row text «Загружаем теги…»; list `role="listbox" id={listId}`; each option a `<button type="button" role="option" aria-selected={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => select(option.tag)}>` showing the tag and, when `count !== null`, the pluralized frequency.
- Selection helper: if `value.length >= max` set `error="limit"` and return; otherwise `onChange([...value, tag])`, clear draft, keep focus/popover open.

- [ ] **Step 5: Run the component test and fix jsdom gaps if any**

Run: `pnpm --filter frontend exec vitest run tag-input`
Expected: PASS.

If Radix/motion throws `ResizeObserver is not defined`, `Element.prototype.scrollIntoView is not a function`, or `hasPointerCapture`, add one-time no-op shims to `frontend/vitest.setup.ts` (guarded with `if (!globalThis.ResizeObserver)`), then rerun. Do not add these shims pre-emptively.

- [ ] **Step 6: Run types**

Run: `pnpm check-types:frontend`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/animate-ui/components/radix/popover.tsx frontend/src/components/packages/tag-input.tsx frontend/src/components/packages/tag-input.test.tsx frontend/vitest.setup.ts
git commit -m "feat(frontend): add tag input with workshop suggestions"
```

(Omit `vitest.setup.ts` from the commit if no shims were needed.)

---

### Task 4: Use TagInput in the package editor

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/package-edit-dialog.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/workshop-dialogs.tsx:39-45`
- Test: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`

**Interfaces:**
- Consumes: `TagInput` (`id`, `value: string[]`, `onChange`), `resetWorkshopTagsCache`.
- Produces: `updatePackageMetadata` receives `tags: string[]` directly, no `parseTags`.

- [ ] **Step 1: Update the dialog test setup and add a failing save test**

In `PackagesTab.test.tsx`:

1. Add `listWorkshopTags: vi.fn()` to the `vi.mock("@/api/services/scripting-packages")` factory.
2. Import `resetWorkshopTagsCache` from `@/components/packages/use-workshop-tags`.
3. In `beforeEach`, after `getScriptingPackage`:

```ts
vi.mocked(packagesApi.listWorkshopTags).mockResolvedValue({
  items: [],
  total: 0,
});
resetWorkshopTagsCache();
```

4. Add a test after "opens from the card menu and saves every field":

```tsx
it("adds a suggested tag to the saved metadata", async () => {
  vi.mocked(packagesApi.getScriptingPackage).mockResolvedValue(
    roomPackage({ description: "desc", tags: ["a"] }),
  );
  vi.mocked(packagesApi.listWorkshopTags).mockResolvedValue({
    items: [
      { tag: "gameplay", count: 4 },
      { tag: "a", count: 1 },
    ],
    total: 2,
  });
  const updatePackageMetadata = vi.fn().mockResolvedValue({} as never);
  render(
    <PackagesTab
      roomId={1}
      authorId={42}
      packages={controller({
        entries: [entry({ packageId: 7, slug: "hero", name: "Hero" })],
        updatePackageMetadata,
      })}
    />,
  );

  const menu = await openPackageActions();
  fireEvent.click(menu.getByRole("menuitem", { name: "Редактировать пакет" }));

  const tagsInput = await screen.findByLabelText("Теги");
  await waitFor(() => expect(tagsInput).toHaveProperty("disabled", false));
  fireEvent.focus(tagsInput);
  fireEvent.click(
    await screen.findByRole("option", { name: /gameplay/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

  await waitFor(() =>
    expect(updatePackageMetadata).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ tags: ["a", "gameplay"] }),
    ),
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter frontend exec vitest run PackagesTab -t "suggested tag"`
Expected: FAIL — «Теги» is still a plain `<Input>` and has no suggestion options.

- [ ] **Step 3: Convert the dialog state to `string[]`**

In `package-edit-dialog.tsx`:

1. Replace the import `import { parseTags } from "./workshop-dialogs";` with `import { TagInput } from "@/components/packages/tag-input";`.
2. `const [tags, setTags] = React.useState<string[]>([]);`
3. In the entry effect: `setTags(entry.tags);`
4. In the details effect: `setTags(pkg.tags ?? []);`
5. In `save`: `tags,` instead of `tags: parseTags(tags),`.

- [ ] **Step 4: Replace the tags input markup**

Replace the `<Input id="package-edit-tags" … />` block with:

```tsx
<TagInput
  id="package-edit-tags"
  value={tags}
  onChange={setTags}
  disabled={submitting || detailsState !== "ready"}
  placeholder="gameplay, hero"
/>
```

Replace the hint under it with:

```tsx
<p className="text-xs text-muted-foreground">
  Enter или запятая — добавить тег. До 10 тегов.
</p>
```

- [ ] **Step 5: Remove `parseTags`**

Delete the exported `parseTags` function and its doc comment from `workshop-dialogs.tsx`. Verify it has no remaining references:

Run: `rg "parseTags" frontend/src`
Expected: no matches.

- [ ] **Step 6: Run the dialog tests**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: PASS, включая прежний тест сохранения `tags: ["a", "b"]` без правок.

- [ ] **Step 7: Run the whole frontend suite and types**

Run: `pnpm --filter frontend test`
Expected: PASS.

Run: `pnpm check-types:frontend`
Expected: no errors.

- [ ] **Step 8: Manual check in the browser**

Start the two dev servers per AGENTS.md, open a room → Packages → «Редактировать пакет», then verify:

- suggestions appear on focus and filter while typing;
- a suggestion click adds one chip, not two;
- «Создать „…“» adds a new tag;
- invalid text is rejected with the format hint;
- popover is not clipped and does not close the dialog;
- saving persists the chips.

- [ ] **Step 9: Commit**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/package-edit-dialog.tsx" "frontend/src/app/room/[room_code]/(godot)/workshop-dialogs.tsx" "frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx"
git commit -m "feat(frontend): use suggested tags in package editor"
```

---

## Self-review notes

- Spec coverage: API aggregation (Task 1), shared types (Task 1), service + cache (Task 2), component/ARIA/keyboard (Task 3), dialog integration and removal of `parseTags` (Task 4), all test classes from the design.
- Type consistency: `WorkshopTagCount`/`WorkshopTagListing` are defined once in shared; `listWorkshopTags` returns the listing; `useWorkshopTags` exposes `{ tags, loading }`; `TagInput` consumes `string[]`.
- Review Focus tests live in Task 3 (invalid draft, click-once, duplicate, cap, loading/free input) and Task 4 (unchanged tags on save).
