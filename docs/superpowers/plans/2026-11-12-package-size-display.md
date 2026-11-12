# Размер пакета в панели Packages — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показывать в карточке пакета на странице комнаты и в каталоге workshop размер последней опубликованной ревизии пакета в КБ или МБ.

**Architecture:** Сервер уже поднимает последние опубликованные ревизии вместе с `files` в `PackageSyncService.getStatuses`, а каталог workshop джойнит ту же ревизию в `WORKSHOP_SELECT`; в обоих местах сумма `files[].size` считается на сервере. Фронтенд копирует поле в `RoomPackageEntry` / `WorkshopPackageSummary` и рендерит его в строке метаданных карточки через маленький хелпер единиц и форматтер `next-intl`.

**Tech Stack:** NestJS 11 + TypeORM, Next.js 16 / React 19, next-intl 4, Jest (сервер), Vitest (фронтенд).

**Spec:** `docs/superpowers/specs/2026-11-12-package-size-display-design.md`

## Global Constraints

- Размер = сумма `files[].size` последней ревизии в статусе `published`; зависимости не включаются.
- `null` означает «опубликованных ревизий нет»; `0` — реальный размер пустого опубликованного пакета.
- Никаких изменений схемы БД, дополнительных запросов и чтения файлов/манифестов на клиенте.
- Единицы и разделители — только через i18n: ru `КБ`/`МБ`, en `KB`/`MB`; число форматирует `next-intl`.
- Пользовательские строки не хардкодятся в компонентах: только `frontend/messages/{ru,en}.json`.
- Сервер: Prettier single quotes + trailing commas. Фронтенд: double quotes.
- Поле `sizeBytes` аддитивное: остальные потребители `RoomPackagesStatus` его не читают.
- `WorkshopPackageSummary.sizeBytes` — всегда число: листинг содержит только ревизии со статусом `published`.
- Один и тот же хелпер и ключи `sizeKb`/`sizeMb` используются в комнате и workshop; отличаются только i18n-строки (в комнате с ведущей `·`).

## Review Focus

- Опубликованный пустой пакет (`0` байт) показывает `0 КБ`, а не скрывается как `null` — тест в Task 4.
- Порог 1 МиБ считается по байтам: `1 048 575` остаётся в КБ, `1 048 576` переключается на МБ — тест в Task 3.
- Локаль: ru — десятичная запятая и `КБ/МБ`, en — точка и `KB/MB` — тесты в Task 4.
- Если ревизия в редакторе и опубликованная ревизия различаются, размер относится к опубликованной — тест в Task 4.
- Каталог workshop показывает размер опубликованной ревизии, включая `0 КБ` для пустой, и на главной, и в диалоге комнаты (общий компонент) — тесты в Task 5.

---

### Task 1: Сервер отдаёт размер опубликованной ревизии

**Files:**
- Modify: `packages/shared/src/api/types.ts` (`PackageSyncStatus`, строки 406–416)
- Modify: `packages/server/src/godot-game/package-sync/status-reporter.ts:17-22`
- Modify: `packages/server/src/godot-game/package-sync/package-sync.service.ts:143-161`
- Test: `packages/server/src/godot-game/package-sync/package-sync.service.spec.ts`
- Test fixtures (только чтобы типы оставались зелёными): `packages/server/src/godot-game/game-room/game-room.service.spec.ts:67-87`, `frontend/src/app/room/[room_code]/_godot/GameTab.test.tsx:55-79`, `frontend/src/app/room/[room_code]/_godot/__tests__/GameProgressToast.integration.test.tsx:224-248`, `frontend/src/app/room/[room_code]/_godot/use-room-packages.test.tsx:280-302`

**Interfaces:**
- Consumes: ничего из предыдущих задач.
- Produces: `PackageSyncStatus.sizeBytes: number | null`; `StatusReporter.toStatus(pkg, roomId, revision, publishedAt): Omit<PackageSyncStatus, 'sizeBytes'>`.

- [ ] **Step 1: Добавить поле в общий тип**

В `PackageSyncStatus` после `revision` добавить:

```ts
  /**
   * Sum of `files[].size` of the latest published revision of this package.
   * Dependencies are not included. `null` when no revision is published.
   */
  sizeBytes: number | null;
```

- [ ] **Step 2: Обновить типизированные фикстуры**

Добавить `sizeBytes: null,` рядом с `publishedAt` в четырёх фикстурах из списка Files (в `roomStatus` из `use-room-packages.test.tsx` — в объект, который возвращает `map`). Это механическая правка: поведение не меняется, но `tsc` снова проходит.

Run: `pnpm --filter server check-types` и `pnpm check-types:frontend`
Expected: обе команды завершаются без ошибок.

- [ ] **Step 3: Написать падающие тесты**

В `package-sync.service.spec.ts`:

1. Расширить тип `published` и хелпер `publishRevision`, чтобы ревизия несла файлы:

```ts
import type { PackageFileEntry } from '@wired-io/shared';

let published: Map<
  number,
  { revision: number; publishedAt: Date; files: PackageFileEntry[] }
>;

const publishRevision = (
  packageId: number,
  revision: number,
  publishedAt = new Date('2026-10-30T09:00:00.000Z'),
  files: PackageFileEntry[] = [],
): void => {
  published.set(packageId, { revision, publishedAt, files });
};
```

2. Мок `revisions.find` уже разворачивает `...entry`, поэтому `files` попадёт в строку автоматически.

3. Добавить тесты:

```ts
it('reports the total size of the latest published revision', async () => {
  publishRevision(42, 4, undefined, [
    { filepath: 'hero.gd', size: 1_500, sha256: 'a' },
    { filepath: 'hero.tscn', size: 2_000, sha256: 'b' },
  ]);

  const [status] = await service.getStatuses('7');

  expect(status.sizeBytes).toBe(3_500);
});

it('reports no size for a package without published revisions', async () => {
  published.delete(42);

  const [status] = await service.getStatuses('7');

  expect(status.sizeBytes).toBeNull();
});
```

Run: `pnpm --filter server exec jest package-sync.service.spec`
Expected: FAIL — `status.sizeBytes` равно `undefined`.

- [ ] **Step 4: Реализовать расчёт**

В `status-reporter.ts` заменить возвращаемый тип `toStatus` на `Omit<PackageSyncStatus, 'sizeBytes'>` (импорт типа остаётся нужен для `Omit`).

В `package-sync.service.ts`, `getStatuses`, обернуть вызов репортёра:

```ts
statuses.push({
  ...this.reporter.toStatus(
    pkg,
    roomId,
    revision?.revision ?? null,
    revision?.publishedAt ?? null,
  ),
  sizeBytes: revision
    ? revision.files.reduce((sum, file) => sum + file.size, 0)
    : null,
});
```

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter server exec jest package-sync.service.spec`
Expected: PASS, включая два новых теста.

Run: `pnpm --filter server test`
Expected: все серверные сьюты зелёные.

- [ ] **Step 6: Коммит**

```bash
git add packages/shared/src/api/types.ts \
  packages/server/src/godot-game/package-sync/status-reporter.ts \
  packages/server/src/godot-game/package-sync/package-sync.service.ts \
  packages/server/src/godot-game/package-sync/package-sync.service.spec.ts \
  packages/server/src/godot-game/game-room/game-room.service.spec.ts \
  "frontend/src/app/room/[room_code]/_godot/GameTab.test.tsx" \
  "frontend/src/app/room/[room_code]/_godot/__tests__/GameProgressToast.integration.test.tsx" \
  "frontend/src/app/room/[room_code]/_godot/use-room-packages.test.tsx"
git commit -m "feat(game): expose published package revision size in status"
```

---

### Task 2: Сервер отдаёт размер в каталоге workshop

**Files:**
- Modify: `packages/shared/src/api/types.ts` (`WorkshopPackageSummary`, строки 229–241)
- Modify: `packages/server/src/scripting-packages/workshop/package-workshop.service.ts` (`WORKSHOP_SELECT` 29–42, `WorkshopRow` 106–124, `toSummary` 489–512)
- Test: `packages/server/src/scripting-packages/workshop/package-workshop.service.spec.ts`

**Interfaces:**
- Consumes: `PackageFileEntry` из общего типа ревизии (менять не нужно).
- Produces: `WorkshopPackageSummary.sizeBytes: number`; `WorkshopRow.sizeBytes: string`.

- [ ] **Step 1: Добавить поле в общий тип**

В `WorkshopPackageSummary` после `updatedAt` (или рядом с `revision`) добавить:

```ts
  /**
   * Sum of `files[].size` of the listing's published revision. Dependencies
   * are not included.
   */
  sizeBytes: number;
```

- [ ] **Step 2: Обновить тестовую фикстуру и ожидания**

В `package-workshop.service.spec.ts`:

1. В локальный тип `WorkshopRow` добавить `sizeBytes: string;`.
2. В фикстуру `row` добавить `sizeBytes: "3500",`.
3. В тесте, который проверяет SQL листинга, добавить:

```ts
expect(sqlOf(query)).toContain("jsonb_array_elements(files)");
```

4. В полные `toEqual`-ожидания листинга и lookup добавить `sizeBytes: 3500` в каждый ожидаемый summary.

Run: `pnpm --filter server exec jest package-workshop.service.spec`
Expected: FAIL — в summary `sizeBytes` равно `undefined`, SQL не содержит сумму.

- [ ] **Step 3: Реализовать сумму в SQL и маппинг**

В `WORKSHOP_SELECT` расширить латеральный подзапрос:

```sql
       SELECT revision, "publishedAt",
              COALESCE((SELECT SUM((f->>'size')::bigint)
                        FROM jsonb_array_elements(files) AS f), 0) AS "sizeBytes"
       FROM scripting_package_revision
       WHERE "packageId" = p.id AND status = 'published'
         AND "publishedAt" IS NOT NULL
       ORDER BY revision DESC
       LIMIT 1
```

В `toSummary` добавить `sizeBytes: Number(row.sizeBytes)`. `LIST_SQL`, `LOOKUP_SQL` и `SUMMARY_SQL` собираются из `WORKSHOP_SELECT`, поэтому больше ничего менять не нужно.

- [ ] **Step 4: Прогнать тесты и типы**

Run: `pnpm --filter server exec jest package-workshop.service.spec`
Expected: PASS.

Run: `pnpm --filter server check-types`
Expected: без ошибок.

- [ ] **Step 5: Коммит**

```bash
git add packages/shared/src/api/types.ts \
  packages/server/src/scripting-packages/workshop/package-workshop.service.ts \
  packages/server/src/scripting-packages/workshop/package-workshop.service.spec.ts
git commit -m "feat(workshop): expose published revision size in workshop listings"
```

---

### Task 3: Хелпер единиц размера

**Files:**
- Create: `frontend/src/utils/format-file-size.ts`
- Test: `frontend/src/utils/format-file-size.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `formatFileSize(bytes: number): { value: number; unit: "kb" | "mb" }`; тип `FileSizeUnit = "kb" | "mb"`.

- [ ] **Step 1: Написать падающий тест**

```ts
import { describe, expect, it } from "vitest";
import { formatFileSize } from "./format-file-size";

describe("formatFileSize", () => {
  it("uses KB below one MiB", () => {
    expect(formatFileSize(900_000)).toEqual({
      value: 878.90625,
      unit: "kb",
    });
    expect(formatFileSize(1_048_575).unit).toBe("kb");
  });

  it("switches to MB from one MiB", () => {
    expect(formatFileSize(1_048_576)).toEqual({ value: 1, unit: "mb" });
    expect(formatFileSize(1_500_000).unit).toBe("mb");
  });

  it("keeps zero as a zero KB size", () => {
    expect(formatFileSize(0)).toEqual({ value: 0, unit: "kb" });
  });
});
```

Run: `pnpm --filter frontend exec vitest run format-file-size`
Expected: FAIL — модуль `./format-file-size` не найден.

- [ ] **Step 2: Реализовать хелпер**

```ts
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

export type FileSizeUnit = "kb" | "mb";

/** Splits a byte count into the unit the package card renders. */
export function formatFileSize(bytes: number): {
  value: number;
  unit: FileSizeUnit;
} {
  return bytes >= BYTES_PER_MB
    ? { value: bytes / BYTES_PER_MB, unit: "mb" }
    : { value: bytes / BYTES_PER_KB, unit: "kb" };
}
```

Округление не здесь: его делает `next-intl` при рендере.

- [ ] **Step 3: Прогнать тест**

Run: `pnpm --filter frontend exec vitest run format-file-size`
Expected: PASS.

- [ ] **Step 4: Коммит**

```bash
git add frontend/src/utils/format-file-size.ts frontend/src/utils/format-file-size.test.ts
git commit -m "feat(frontend): add file size unit helper"
```

---

### Task 4: Размер в карточке пакета

**Files:**
- Modify: `frontend/src/app/room/[room_code]/_godot/room-packages/model.ts:22-48,249-272`
- Modify: `frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx:4,254-305`
- Modify: `frontend/messages/ru.json` (блок `Packages.card`, строка 211)
- Modify: `frontend/messages/en.json` (блок `Packages.card`, строка 211)
- Test: `frontend/src/app/room/[room_code]/_godot/PackagesTab.test.tsx`

**Interfaces:**
- Consumes: `PackageSyncStatus.sizeBytes` из Task 1; `formatFileSize` из Task 3.
- Produces: поле `RoomPackageEntry.sizeBytes: number | null`; текст размера в строке метаданных карточки.

- [ ] **Step 1: Протянуть поле в модель**

В `RoomPackageEntry` после `publishedAt` добавить `sizeBytes: number | null;` с комментарием:

```ts
  /** Bytes of the latest published revision; `null` when none is published. */
  sizeBytes: number | null;
```

В `buildEntries`, в возвращаемый объект после `publishedAt`, добавить:

```ts
      sizeBytes: remoteState?.sizeBytes ?? null,
```

- [ ] **Step 2: Добавить строки в messages**

В оба файла, в `Packages.card` сразу после `"publishedMissing"`:

ru:

```json
      "sizeKb": "· {value} КБ",
      "sizeMb": "· {value} МБ",
```

en:

```json
      "sizeKb": "· {value} KB",
      "sizeMb": "· {value} MB",
```

- [ ] **Step 3: Отрендерить размер в карточке**

В `PackagesTab.tsx`:

- импорт: `import { useFormatter, useTranslations } from "next-intl";`
- импорт: `import { formatFileSize } from "@/utils/format-file-size";`
- в `PackageCard` рядом с `const t = useTranslations("Packages");` добавить `const numberFormat = useFormatter();`
- перед `return` вычислить:

```tsx
  const size =
    entry.sizeBytes === null ? null : formatFileSize(entry.sizeBytes);
```

- в строке метаданных сразу после `<span>` с опубликованной ревизией добавить:

```tsx
            {size && (
              <span>
                {t(size.unit === "kb" ? "card.sizeKb" : "card.sizeMb", {
                  value: numberFormat.number(size.value, {
                    maximumFractionDigits: 1,
                  }),
                })}
              </span>
            )}
```

`useAppMessage` уже называется `format` — новую переменную не называть `format`.

- [ ] **Step 4: Написать тесты карточки**

В `PackagesTab.test.tsx`:

1. В фабрику `entry()` после `publishedAt` добавить `sizeBytes: null,`.
2. Добавить тесты (по умолчанию `renderWithIntl` использует ru):

```tsx
it("shows the published revision size in megabytes", () => {
  render(
    <PackagesTab
      onRoomSaved={vi.fn()}
      room={roomFixture()}
      roomId={1}
      canCreatePackages
      canManagePackages
      viewerId={42}
      packages={controller({ entries: [entry({ sizeBytes: 1_468_006 })] })}
    />,
  );

  expect(screen.getByText("· 1,4 МБ")).toBeTruthy();
});

it("shows the published revision size in kilobytes", () => {
  render(
    <PackagesTab
      onRoomSaved={vi.fn()}
      room={roomFixture()}
      roomId={1}
      canCreatePackages
      canManagePackages
      viewerId={42}
      packages={controller({ entries: [entry({ sizeBytes: 512_000 })] })}
    />,
  );

  expect(screen.getByText("· 500 КБ")).toBeTruthy();
});

it("shows zero size for an empty published revision", () => {
  render(
    <PackagesTab
      onRoomSaved={vi.fn()}
      room={roomFixture()}
      roomId={1}
      canCreatePackages
      canManagePackages
      viewerId={42}
      packages={controller({ entries: [entry({ sizeBytes: 0 })] })}
    />,
  );

  expect(screen.getByText("· 0 КБ")).toBeTruthy();
});

it("hides the size when no revision is published", () => {
  render(
    <PackagesTab
      onRoomSaved={vi.fn()}
      room={roomFixture()}
      roomId={1}
      canCreatePackages
      canManagePackages
      viewerId={42}
      packages={controller({
        entries: [entry({ sizeBytes: null, publishedRevision: null })],
      })}
    />,
  );

  expect(screen.queryByText(/КБ|МБ/)).toBeNull();
});

it("formats the size for the active locale", () => {
  render(
    <PackagesTab
      onRoomSaved={vi.fn()}
      room={roomFixture()}
      roomId={1}
      canCreatePackages
      canManagePackages
      viewerId={42}
      packages={controller({ entries: [entry({ sizeBytes: 1_468_006 })] })}
    />,
    { locale: "en" },
  );

  expect(screen.getByText("· 1.4 MB")).toBeTruthy();
});

it("uses the published size when the editor holds another revision", () => {
  render(
    <PackagesTab
      onRoomSaved={vi.fn()}
      room={roomFixture()}
      roomId={1}
      canCreatePackages
      canManagePackages
      viewerId={42}
      packages={controller({
        entries: [
          entry({
            sizeBytes: 700_000,
            publishedRevision: 4,
            loadedRevision: 2,
          }),
        ],
      })}
    />,
  );

  expect(screen.getByText("· 683,6 КБ")).toBeTruthy();
});

it("keeps the size of a disabled package", () => {
  render(
    <PackagesTab
      onRoomSaved={vi.fn()}
      room={roomFixture()}
      roomId={1}
      canCreatePackages
      canManagePackages
      viewerId={42}
      packages={controller({
        entries: [entry({ sizeBytes: 512_000, enabled: false })],
      })}
    />,
  );

  expect(screen.getByText("· 500 КБ")).toBeTruthy();
});
```

- [ ] **Step 5: Прогнать тесты, типы и линт**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: PASS.

Run: `pnpm check-types:frontend`
Expected: без ошибок.

Run: `pnpm --filter frontend lint`
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add "frontend/src/app/room/[room_code]/_godot/room-packages/model.ts" \
  "frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx" \
  "frontend/src/app/room/[room_code]/_godot/PackagesTab.test.tsx" \
  frontend/messages/ru.json frontend/messages/en.json
git commit -m "feat(game): show package revision size in the Packages panel"
```

---

### Task 5: Размер в каталоге workshop

**Files:**
- Modify: `frontend/src/components/packages/WorkshopBrowser.tsx:5,124-188`
- Modify: `frontend/messages/ru.json` (блок `Workshop`, строка 122)
- Modify: `frontend/messages/en.json` (блок `Workshop`, строка 122)
- Test: `frontend/src/components/packages/WorkshopBrowser.test.tsx`
- Test fixtures (только чтобы типы оставались зелёными): `frontend/src/app/room/[room_code]/_godot/PackagesTab.test.tsx:112-132`, `frontend/src/app/room/[room_code]/_godot/use-room-packages.test.tsx:233-254`

**Interfaces:**
- Consumes: `WorkshopPackageSummary.sizeBytes` из Task 2; `formatFileSize` из Task 3.
- Produces: размер в строке метаданных `WorkshopPackageCard`; это же отображение получают главная страница и диалог комнаты, потому что компонент общий.

- [ ] **Step 1: Добавить строки в messages**

В оба файла, в блок `Workshop` (без ведущей точки, элементы строки разделены `gap`):

ru:

```json
      "sizeKb": "{value} КБ",
      "sizeMb": "{value} МБ",
```

en:

```json
      "sizeKb": "{value} KB",
      "sizeMb": "{value} MB",
```

- [ ] **Step 2: Отрендерить размер в карточке каталога**

В `WorkshopBrowser.tsx`:

- импорт: `import { useFormatter, useLocale, useTranslations } from "next-intl";`
- импорт: `import { formatFileSize } from "@/utils/format-file-size";`
- в `WorkshopPackageCard` рядом с `const locale = useLocale();` добавить `const numberFormat = useFormatter();`
- после `const preview = item.previewImage;` вычислить:

```tsx
  const size = formatFileSize(item.sizeBytes);
```

- в строке метаданных сразу после `<span>` с ревизией добавить:

```tsx
            <span>
              {t(size.unit === "kb" ? "sizeKb" : "sizeMb", {
                value: numberFormat.number(size.value, {
                  maximumFractionDigits: 1,
                }),
              })}
            </span>
```

`t` здесь уже `useTranslations("Workshop")`, поэтому ключи без префикса `card.`.

- [ ] **Step 3: Обновить фикстуры**

В `WorkshopBrowser.test.tsx` в фабрику `workshopPackage()` добавить `sizeBytes: 0,`. В `workshopPackage()` из `PackagesTab.test.tsx` и `use-room-packages.test.tsx` тоже добавить `sizeBytes: 0,`.

- [ ] **Step 4: Написать тесты**

В `WorkshopBrowser.test.tsx`:

```tsx
it("shows the published revision size", async () => {
  vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
    items: [workshopPackage({ sizeBytes: 1_468_006 })],
    total: 1,
  });

  render(<WorkshopBrowser />);

  expect(await screen.findByText("1,4 МБ")).toBeTruthy();
});

it("shows zero size for an empty published revision", async () => {
  vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
    items: [workshopPackage({ sizeBytes: 0 })],
    total: 1,
  });

  render(<WorkshopBrowser />);

  expect(await screen.findByText("0 КБ")).toBeTruthy();
});

it("formats the size for the active locale", async () => {
  vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
    items: [workshopPackage({ sizeBytes: 1_468_006 })],
    total: 1,
  });

  render(<WorkshopBrowser />, { locale: "en" });

  expect(await screen.findByText("1.4 MB")).toBeTruthy();
});
```

- [ ] **Step 5: Прогнать тесты, типы и линт**

Run: `pnpm --filter frontend exec vitest run WorkshopBrowser`
Expected: PASS.

Run: `pnpm --filter frontend exec vitest run PackagesTab use-room-packages`
Expected: PASS (фикстуры обновлены, поведение не изменилось).

Run: `pnpm check-types:frontend`
Expected: без ошибок.

Run: `pnpm --filter frontend lint`
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add frontend/src/components/packages/WorkshopBrowser.tsx \
  frontend/src/components/packages/WorkshopBrowser.test.tsx \
  "frontend/src/app/room/[room_code]/_godot/PackagesTab.test.tsx" \
  "frontend/src/app/room/[room_code]/_godot/use-room-packages.test.tsx" \
  frontend/messages/ru.json frontend/messages/en.json
git commit -m "feat(workshop): show package revision size in the workshop catalog"
```

---

## Self-review

- **Spec coverage:** `sizeBytes` в статусе комнаты (Task 1), `sizeBytes` в листинге workshop (Task 2), единицы/порог КБ-МБ (Task 3), карточка комнаты и i18n (Task 4), карточка каталога (Task 5), тесты сервера/утилиты/обеих карточек — по спеке. Форматирование локали — Task 4 и Task 5.
- **Type consistency:** `PackageSyncStatus.sizeBytes` — `number | null`; `WorkshopPackageSummary.sizeBytes` — `number`; `formatFileSize` возвращает `{ value, unit }` с `unit: "kb" | "mb"`; `toStatus` возвращает `Omit<PackageSyncStatus, 'sizeBytes'>`; `WorkshopRow.sizeBytes` — `string`, в summary попадает `Number(...)`.
- **Пропорция:** пять небольших тасков, код в плане — сигнатуры, SQL-фрагмент, тестовые ассерты и один неочевидный рендер; остальное оставлено исполнителю.
