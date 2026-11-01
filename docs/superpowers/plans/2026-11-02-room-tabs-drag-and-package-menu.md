# Перетаскиваемая панель табов и меню действий пакета — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать панель Editor/Packages/Game перетаскиваемой за грип с клампом по краям окна и сохранением позиции в браузере, а четыре второстепенные кнопки пакета перенести в animate-ui dropdown-menu.

**Architecture:** Отдельный хук `useDraggablePanel` держит позицию панели, слушает pointer events на грипе и `resize`, клампит чистую функцию `clampPanelPosition` и пишет `{x, y}` в `localStorage`. Панель рендерится `fixed` с `transform: translate3d`. В `PackagesTab` кнопки карточки заменяются на `DropdownMenuTrigger` + `DropdownMenuContent/DropdownMenuItem` из animate-ui.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind v4, animate-ui (radix primitives), Vitest + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-02-room-tabs-drag-and-package-menu-design.md`

## Global Constraints

- Изменения только во `frontend/`; API, DTO, `packages/shared` не трогаем.
- Новых npm-зависимостей не добавляем: используются уже установленные `radix-ui`, `motion`, `lucide-react`.
- Ключ хранения позиции: `wired.room-tabs.position.v1`, значение — JSON `{"x":number,"y":number}`.
- Позиция общая для браузера, не per-room.
- Копирайтинг UI — русский, UTF-8, как в соседних файлах.
- Conventional Commits, сообщения на английском, как в истории репозитория.
- Команды запускать из корня репозитория через pnpm-фильтры.

## Review Focus

- Сохранённая позиция из окна большего размера на новом окне не должна оказаться за экраном — кламп при восстановлении.
- Уменьшение окна при панели у правого/нижнего края не должно прятать её — пересчёт на `resize`.
- Очень узкое окно (панель шире viewport) не должно уводить панель в отрицательные координаты — `x = 0`.
- Битый или отсутствующий `localStorage` не должен ломать рендер — fallback к начальной позиции.
- Перенос действий в меню не должен менять их поведение: те же disabled-условия, подтверждения и вызовы контроллера.

---

### Task 1: Хук перетаскивания и чистая функция клампа

**Files:**
- Create: `frontend/src/app/room/[room_code]/(godot)/use-draggable-panel.ts`
- Test: `frontend/src/app/room/[room_code]/(godot)/use-draggable-panel.test.tsx`

**Interfaces:**
- Consumes: ничего из предыдущих задач.
- Produces:
  - `export const ROOM_TABS_POSITION_KEY = "wired.room-tabs.position.v1"`
  - `export type PanelSize = { width: number; height: number }`
  - `export type PanelPosition = { x: number; y: number }`
  - `export function clampPanelPosition(input: { x: number; y: number; panel: PanelSize; viewport: PanelSize; margin?: number }): PanelPosition`
  - `export function useDraggablePanel(input: { storageKey: string; initialPosition: (viewport: PanelSize) => PanelPosition; margin?: number }): { panelRef: React.RefObject<HTMLDivElement | null>; gripProps: { onPointerDown: React.PointerEventHandler<HTMLButtonElement>; onPointerMove: React.PointerEventHandler<HTMLButtonElement>; onPointerUp: React.PointerEventHandler<HTMLButtonElement>; onPointerCancel: React.PointerEventHandler<HTMLButtonElement>; onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>; style: React.CSSProperties }; position: PanelPosition | null; isDragging: boolean; style: React.CSSProperties }`

- [ ] **Step 1: Написать падающие тесты**

`use-draggable-panel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import {
  ROOM_TABS_POSITION_KEY,
  clampPanelPosition,
  useDraggablePanel,
} from "./use-draggable-panel";

const panel = { width: 200, height: 36 };

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setViewport(1000, 800);
  localStorage.clear();
  rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      ...panel,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: panel.width,
      bottom: panel.height,
      toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
  rectSpy.mockRestore();
});

function Harness({ initial }: { initial?: (v: { width: number; height: number }) => { x: number; y: number } }) {
  const { panelRef, style } = useDraggablePanel({
    storageKey: ROOM_TABS_POSITION_KEY,
    initialPosition: initial ?? (() => ({ x: 0, y: 0 })),
  });
  return <div data-testid="panel" ref={panelRef} style={style} />;
}

describe("clampPanelPosition", () => {
  it("keeps a position inside the viewport", () => {
    expect(
      clampPanelPosition({ x: 100, y: 50, panel, viewport: { width: 1000, height: 800 } }),
    ).toEqual({ x: 100, y: 50 });
  });

  it("stops at the left and top edges", () => {
    expect(
      clampPanelPosition({ x: -40, y: -10, panel, viewport: { width: 1000, height: 800 } }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("stops at the right and bottom edges", () => {
    expect(
      clampPanelPosition({ x: 5000, y: 5000, panel, viewport: { width: 1000, height: 800 } }),
    ).toEqual({ x: 800, y: 764 });
  });

  it("pins a panel wider than the viewport to the left edge", () => {
    expect(
      clampPanelPosition({ x: 300, y: 10, panel, viewport: { width: 150, height: 100 } }),
    ).toEqual({ x: 0, y: 10 });
  });

  it("honours the margin on every edge", () => {
    expect(
      clampPanelPosition({ x: -50, y: 5000, panel, viewport: { width: 1000, height: 800 }, margin: 8 }),
    ).toEqual({ x: 8, y: 756 });
  });
});

describe("useDraggablePanel", () => {
  it("restores a stored position clamped to the current viewport", () => {
    localStorage.setItem(
      ROOM_TABS_POSITION_KEY,
      JSON.stringify({ x: 5000, y: -40 }),
    );
    render(<Harness />);
    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(800px, 0px, 0px)",
    );
  });

  it("falls back to the initial position and drops corrupt storage", () => {
    localStorage.setItem(ROOM_TABS_POSITION_KEY, "{oops");
    render(<Harness initial={() => ({ x: 100, y: 20 })} />);
    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(100px, 20px, 0px)",
    );
    expect(localStorage.getItem(ROOM_TABS_POSITION_KEY)).toBeNull();
  });

  it("re-clamps when the window shrinks", async () => {
    localStorage.setItem(
      ROOM_TABS_POSITION_KEY,
      JSON.stringify({ x: 800, y: 0 }),
    );
    render(<Harness />);
    setViewport(600, 800);
    fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(400px, 0px, 0px)",
    );
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter frontend exec vitest run use-draggable-panel`
Expected: FAIL — модуль `./use-draggable-panel` не найден.

- [ ] **Step 3: Реализовать хук**

`use-draggable-panel.ts` (client-only файл, как соседние хуки):

- `clampPanelPosition` — единственная математика: `min = margin`, `maxX = Math.max(min, viewport.width - panel.width - margin)`, `maxY` аналогично, `Math.min(Math.max(x, min), maxX)`.
- `useDraggablePanel`:
  - `useIsomorphicLayoutEffect` (константа `typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect`).
  - `useLayoutEffect` при монтировании: читает `localStorage[storageKey]`, `JSON.parse` в `try/catch`, принимает только конечные `x`/`y`, иначе удаляет ключ; берёт размер панели из `panelRef.current.getBoundingClientRect()`, viewport из `window.innerWidth/innerHeight`, клампит и ставит в state.
  - `useEffect` на `resize`: пересчитывает кламп из текущего `position` и актуальных размеров, сохраняет в `localStorage`.
  - `pointerdown`: `event.currentTarget.setPointerCapture?.(event.pointerId)`, `event.preventDefault()`, сохраняет в refs `startPointer` и `startPosition`, `setIsDragging(true)`.
  - `pointermove` при активном pointer id: `next = { x: startPosition.x + (event.clientX - startPointer.x), y: ... }`, клампит по размерам панели/viewport, пишет в state (без сохранения на каждом движении).
  - `pointerup`/`pointercancel`: отпускает capture (если есть), сохраняет `{x, y}` в `localStorage`, `setIsDragging(false)`.
  - `keydown`: стрелки двигают на 10px, с `event.shiftKey` — на 1px; `preventDefault()`, клампит и сохраняет.
  - `gripProps.style = { touchAction: "none" }`; `style = { transform: translate3d(x, y, 0), visibility: position ? "visible" : "hidden" }`.
  - `positionRef` синхронизирован с state, чтобы обработчики читали актуальную позицию.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter frontend exec vitest run use-draggable-panel`
Expected: PASS, 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/use-draggable-panel.ts" "frontend/src/app/room/[room_code]/(godot)/use-draggable-panel.test.tsx"
git commit -m "feat(frontend): add draggable room tabs panel hook"
```

---

### Task 2: Подключить перетаскивание к панели табов

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/RoomPageClient.tsx`
- Test: нет отдельного теста; проверка типов, линт и ручной сценарий.

**Interfaces:**
- Consumes: `ROOM_TABS_POSITION_KEY`, `useDraggablePanel` из Task 1.
- Produces: панель с грипом для последующих ручных проверок; других задач не касается.

- [ ] **Step 1: Заменить обёртку панели**

Было:

```tsx
<div className="absolute top-0 left-[52%] z-10">
  <TabsList>...</TabsList>
</div>
```

Станет:

```tsx
const { panelRef, gripProps, style, isDragging } = useDraggablePanel({
  storageKey: ROOM_TABS_POSITION_KEY,
  initialPosition: (viewport) => ({ x: Math.round(viewport.width * 0.52), y: 0 }),
});
...
<div
  ref={panelRef}
  className="fixed left-0 top-0 z-10 flex h-9 w-fit items-center gap-1"
  style={style}
>
  <button
    type="button"
    aria-label="Перетащить панель"
    title="Перетащить панель"
    {...gripProps}
    className={`inline-flex h-9 w-7 items-center justify-center rounded-md border border-input bg-muted text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
  >
    <GripVerticalIcon className="size-4" />
  </button>
  <TabsList>...</TabsList>
</div>
```

Импорты: `GripVerticalIcon` из `lucide-react`, хук и константа из `./use-draggable-panel`. Внутренности `TabsList`/`TabsTrigger` не меняются. Хук вызывается до `return` в `GodotRoomPageClient`.

- [ ] **Step 2: Проверить типы и линт**

Run: `pnpm check-types:frontend`
Expected: без ошибок.

Run: `pnpm --filter frontend lint`
Expected: без ошибок.

- [ ] **Step 3: Ручная проверка в dev-сервере**

Run: `pnpm --filter frontend dev -- -p 3001` (backend уже запущен отдельно, либо только страница комнаты).
Checklist: грип тащит панель; табы переключаются; панель упирается во все четыре края; перезагрузка возвращает позицию; сужение окна не прячет панель.

- [ ] **Step 4: Коммит**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/RoomPageClient.tsx"
git commit -m "feat(frontend): make room tabs panel draggable"
```

---

### Task 3: Добавить animate-ui dropdown-menu

**Files:**
- Create: `frontend/src/components/animate-ui/primitives/radix/dropdown-menu.tsx`
- Create: `frontend/src/components/animate-ui/components/radix/dropdown-menu.tsx`
- Create: `frontend/src/hooks/use-data-state.tsx` (если CLI не создаст)
- Modify (возможно): `frontend/src/hooks/use-controlled-state.tsx` — только если CLI перезапишет иначе; содержимое должно остаться совместимым.

**Interfaces:**
- Consumes: реестр `@animate-ui` из `frontend/components.json`.
- Produces: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`, `DropdownMenuItemProps` (с `variant?: 'default' | 'destructive'`).

- [ ] **Step 1: Установить компонент из реестра**

Run из `frontend/`:

```bash
pnpm dlx shadcn@latest add @animate-ui/components-radix-dropdown-menu --yes
```

Ожидаемо: созданы `components/animate-ui/components/radix/dropdown-menu.tsx`, `components/animate-ui/primitives/radix/dropdown-menu.tsx`, `hooks/use-data-state.tsx`.

Если CLI не разрешает зависимость `@animate-ui/v1/primitives-radix-dropdown-menu` — скачать `https://animate-ui.com/r/v1/primitives-radix-dropdown-menu.json`, `https://animate-ui.com/r/components-radix-dropdown-menu.json`, `https://animate-ui.com/r/hooks-use-data-state.json` и записать поля `files[].content` в те же пути, сохранив импорты `@/components/...`, `@/hooks/...`, `@/lib/...`.

- [ ] **Step 2: Проверить типы и линт**

Run: `pnpm check-types:frontend`
Expected: без ошибок.

Run: `pnpm --filter frontend lint`
Expected: без новых ошибок (сгенерированные animate-ui файлы могут иметь свои правила — не подавлять ошибки, а поправить импорты/форматирование).

- [ ] **Step 3: Коммит**

```bash
git add frontend/src/components/animate-ui frontend/src/hooks
git commit -m "chore(frontend): add animate-ui dropdown menu"
```

---

### Task 4: Перенести действия пакета в меню

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`
- Test: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`

**Interfaces:**
- Consumes: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator` из Task 3; `RoomPackageEntry` и обработчики `onDownload/onRemove/onToggle/onDelete` из существующего `PackageCard`.
- Produces: карточка с меню; внешние пропсы `PackageCard` не меняются.

- [ ] **Step 1: Обновить тесты под меню**

В `PackagesTab.test.tsx` добавить helper рядом с `controller`:

```tsx
async function openPackageActions() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Действия с пакетом" }),
    { button: 0 },
  );
  const menu = await screen.findByRole("menu");
  return within(menu);
}
```

Заменить клики по кнопкам:

- строка ~141 и ~167 (`скачать в редактор`): `const menu = await openPackageActions(); fireEvent.click(menu.getByRole("menuitem", { name: /скачать в редактор/i }));`
- строка ~190 (`убрать из редактора`): то же через `menuitem`.
- строка ~334 (`удалить из комнаты`): то же через `menuitem` с `variant="destructive"`-пунктом.

Добавить тест:

```tsx
it("keeps Emit and Использовать каталог outside the actions menu", () => {
  render(
    <PackagesTab
      packages={controller({ entries: [entry({ loaded: false, localChanges: ["a.gd"] })] })}
      authorId={1}
    />,
  );
  expect(screen.getByRole("button", { name: /emit/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /использовать каталог/i })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /скачать в редактор/i }),
  ).toBeNull();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: FAIL — кнопки «Действия с пакетом» нет, пункты меню не найдены.

- [ ] **Step 3: Переделать `PackageCard`**

В блоке действий (сейчас строки 253–343) оставить:

- «Использовать каталог» — без изменений;
- «Emit» — без изменений (включая `Loader2Icon`);
- затем меню:

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="Действия с пакетом"
      title="Действия с пакетом"
    >
      <MoreHorizontalIcon className="size-4" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end" className="w-56">
    <DropdownMenuItem
      disabled={disabled || entry.publishedRevision === null}
      onSelect={() => onDownload(entry)}
    >
      <DownloadIcon className="size-4" />
      Скачать в редактор
    </DropdownMenuItem>
    {entry.inEditor && (
      <DropdownMenuItem disabled={disabled} onSelect={() => onRemove(entry)}>
        <Trash2Icon className="size-4" />
        Убрать из редактора
      </DropdownMenuItem>
    )}
    <DropdownMenuItem disabled={disabled} onSelect={() => onToggle(entry)}>
      <PowerIcon className="size-4" />
      {entry.enabled ? "Отключить" : "Включить"}
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem
      variant="destructive"
      disabled={disabled}
      onSelect={() => onDelete(entry)}
    >
      <Trash2Icon className="size-4" />
      Удалить из комнаты
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Импорты: `MoreHorizontalIcon` из `lucide-react`, dropdown-компоненты из `@/components/animate-ui/components/radix/dropdown-menu`. `disabled` остаётся `!packages.fsReady || action.busy`. Обработчики и подтверждения не меняются.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: PASS.

Run: `pnpm --filter frontend test`
Expected: все файлы PASS.

Run: `pnpm check-types:frontend`
Expected: без ошибок.

Run: `pnpm --filter frontend lint`
Expected: без ошибок.

- [ ] **Step 5: Коммит**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx" "frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx"
git commit -m "feat(frontend): move package actions into dropdown menu"
```

---

## Финальная проверка

- [ ] `pnpm check-types:frontend`
- [ ] `pnpm --filter frontend lint`
- [ ] `pnpm --filter frontend test`
- [ ] Ручной сценарий: перетащить панель в каждый угол, обновить страницу, сузить окно; открыть меню пакета и проверить все четыре действия и их подтверждения.
