# Workshop пакетов Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Публичная витрина workshop с поиском, публикация пакетов комнаты в workshop, fork с новым slug и добавление записи workshop в комнату как независимой копии.

**Architecture:** Workshop — это глобальные `ScriptingPackage` (`roomId = null`) с опубликованной ревизией. Копирование выполняет сервер: строка пакета + ревизия, байты копируются из published-каталога источника в draft-каталог цели и публикуются штатным `PackageStorageService.publishRevision`. Уникальность slug переносится с БД на сервис: область комнаты и глобальная область, резолв ссылок `res://packages/<slug>/…` идёт room-first.

**Tech Stack:** NestJS 11 + TypeORM/Postgres, Jest; Next.js 16 App Router, React 19, Tailwind v4, animate-ui (radix dialog/dropdown), Vitest + jsdom; shared-типы в `packages/shared`.

**Spec:** `docs/superpowers/specs/2026-11-03-package-workshop-design.md`

## Global Constraints

- Node >= 22, pnpm через corepack; сервер запускать/тестировать из `packages/server` (`cwd` определяет пути конфига).
- `DB_SYNC=1` и общая Postgres: схема меняется при старте, миграций нет. Снятие `unique` с `slug` — намеренное изменение схемы.
- Slug: `^(?=.*[a-z])[a-z0-9_]+$`, длина 1–64, не меняется после создания.
- Области slug: комната (`room:<id>`) и workshop (`global`); tombstone только для workshop.
- Теги: `^[a-z0-9_-]{1,32}$`, максимум 10, нижний регистр, без дублей.
- Workshop-лимиты: `q` ≤ 64 символов, `limit` 1–100 (по умолчанию 50), `offset` ≥ 0.
- Машинные коды ошибок: `invalid_slug`, `invalid_tags`, `slug_taken`, `slug_retired`, `package_room_required`, `package_not_in_room`, `package_not_published`, `package_not_in_workshop`, `package_dependency_not_global:<slug>`, `package_slug_shadowed:<slug>`, `workshop_slug_taken`.
- UI и docs — по-русски, UTF-8. Код, идентификаторы и пути — по-английски.
- Не использовать `rtenv`/прямой Emscripten FS: файлы пакета в редакторе идут только через bridge.
- Публикация не меняет пакет комнаты: метаданные и теги пишутся только в запись workshop.
- Каждая задача заканчивается коммитом; сообщения — Conventional Commits.

## Review Focus

1. Один и тот же slug в двух комнатах и в workshop: ссылка `res://packages/hero/…` в комнате B обязана резолвиться в пакет комнаты B, а не в глобальный и не в пакет комнаты A.
2. Публикация пакета, чей slug уже принадлежит другому автору: ровно `409 workshop_slug_taken` с чужим summary, без новой ревизии, без изменения метаданных чужой записи.
3. Копирование в комнату или fork, где slug уже занят: `409 slug_taken`, и после ошибки не остаётся ни строки пакета, ни ревизии, ни каталога.
4. Удаление записи workshop, на которую ссылаются комнатные копии: удаление не падает на FK, а `parentPackageId` у копий обнуляется; сами копии остаются рабочими.
5. Fork переписывает только собственные ссылки: `res://packages/hero/` заменяется, `res://packages/hero_controller/` — нет; остальные байты копируются без изменений.

---

### Task 1: Схема и общий контракт (tags, снятие unique)

**Files:**
- Modify: `packages/server/src/database/entities/scripting-package.entity.ts`
- Modify: `packages/server/src/scripting-packages/dto/create-scripting-package.dto.ts`
- Modify: `packages/server/src/scripting-packages/dto/update-scripting-package.dto.ts`
- Modify: `packages/shared/src/api/types.ts`
- Test: `packages/server/src/database/entities/entities.metadata.spec.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `ScriptingPackage.tags: string[]` (entity и shared), `CreateScriptingPackagePayload.tags?: string[]`, `UpdateScriptingPackagePayload.tags?: string[]`, `WorkshopPackageSummary`, `WorkshopListing`, `WorkshopPackageMetadata`, `WorkshopPublishResult`, `WorkshopForkPayload`, `RoomCopyPayload` в `@wired-io/shared`.

- [ ] **Step 1: Write the failing test**

В `packages/server/src/database/entities/entities.metadata.spec.ts` добавь проверки на метаданные `ScriptingPackage`:

```ts
const meta = dataSource.getMetadata(ScriptingPackage);
expect(meta.findColumnWithPropertyName('slug')!.isUnique).toBe(false);
const tags = meta.findColumnWithPropertyName('tags')!;
expect(tags.type).toBe('jsonb');
expect(String(tags.default)).toContain('[]');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec jest entities.metadata`
Expected: FAIL — `tags` is undefined / `slug.isUnique` is true.

- [ ] **Step 3: Implement the entity change**

В `scripting-package.entity.ts`:

```ts
@Column({ type: 'varchar', length: 64, nullable: true })
slug: string;

@ApiProperty({ description: 'Workshop tags', isArray: true })
@Column({ type: 'jsonb', default: [] })
tags: string[];
```

`tags` размести после `description`. Никаких других изменений в entity.

- [ ] **Step 4: Add tags to DTOs**

В `CreateScriptingPackageDto` и `UpdateScriptingPackageDto` добавь одинаковое необязательное поле:

```ts
@ApiProperty({ description: 'Workshop tags', required: false, type: [String] })
@IsOptional()
@IsArray()
@IsString({ each: true })
tags?: string[];
```

- [ ] **Step 5: Extend shared types**

В `packages/shared/src/api/types.ts` добавь `tags: string[]` в `ScriptingPackage`, `tags?: string[]` в `CreateScriptingPackagePayload` (он наследуется `UpdateScriptingPackagePayload`), и новые типы:

```ts
export type WorkshopPackageSummary = {
  id: number;
  slug: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  author?: User;
  revision: number;
  publishedAt: string;
  updatedAt: string;
};

export type WorkshopListing = { items: WorkshopPackageSummary[]; total: number };

export type WorkshopPackageMetadata = {
  name?: string;
  version?: string;
  description?: string;
  tags?: string[];
};

export type WorkshopPublishResult = {
  mode: 'created' | 'updated';
  package: WorkshopPackageSummary;
};

export type WorkshopForkPayload = { slug: string };
export type RoomCopyPayload = { roomId: number };
```

- [ ] **Step 6: Run tests and type checks**

Run: `pnpm --filter server exec jest entities.metadata && pnpm --filter server check-types && pnpm check-types:frontend`
Expected: PASS и оба `tsc --noEmit` без ошибок. Если `tsc` укажет фикстуры, конструирующие `ScriptingPackage` без `tags`, добавь в них `tags: []`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/database/entities/scripting-package.entity.ts \
  packages/server/src/scripting-packages/dto packages/shared/src/api/types.ts \
  packages/server/src/database/entities/entities.metadata.spec.ts
git commit -m "feat(shared): add package tags and workshop contract"
```

---

### Task 2: Областной индекс slug

**Files:**
- Modify: `packages/server/src/scripting-packages/package-slug-index.ts`
- Test: `packages/server/src/scripting-packages/package-slug-index.spec.ts`

**Interfaces:**
- Consumes: `Repository<ScriptingPackage>`.
- Produces:
  - `interface PackageSlugIndex { byId: Map<number, { slug: string; roomId: number | null }>; byRoomSlug: Map<string, number>; byGlobalSlug: Map<string, number> }`
  - `loadPackageSlugIndex(repository: Pick<Repository<ScriptingPackage>, 'find'>): Promise<PackageSlugIndex>`
  - `resolvePackageTarget(target: string, index: PackageSlugIndex, roomId: number | null): number | null`
  - `slugForPackage(packageId: number, index: PackageSlugIndex): string` (без изменений)

- [ ] **Step 1: Write the failing tests**

В `package-slug-index.spec.ts` замени/дополни кейсы:

```ts
const index = {
  byId: new Map([[1, { slug: 'hero', roomId: 5 }], [2, { slug: 'hero', roomId: 6 }], [3, { slug: 'hero', roomId: null }], [4, { slug: 'lib', roomId: null }]]),
  byRoomSlug: new Map([['5:hero', 1], ['6:hero', 2]]),
  byGlobalSlug: new Map([['hero', 3], ['lib', 4]]),
};

it('prefers the room package over a global one with the same slug', () => {
  expect(resolvePackageTarget('hero', index, 5)).toBe(1);
  expect(resolvePackageTarget('hero', index, 6)).toBe(2);
});

it('does not resolve another room package', () => {
  expect(resolvePackageTarget('hero', index, 7)).toBe(3);
});

it('resolves a global slug when the room has no such slug', () => {
  expect(resolvePackageTarget('lib', index, 5)).toBe(4);
});

it('keeps numeric targets as ids', () => {
  expect(resolvePackageTarget('42', index, 5)).toBe(42);
});

it('loads the room id for every row', async () => {
  const repo = { find: jest.fn(async () => [{ id: 1, slug: 'hero', room: { id: 5 } }, { id: 2, slug: 'lib', room: null }]) };
  const loaded = await loadPackageSlugIndex(repo as never);
  expect(loaded.byId.get(1)).toEqual({ slug: 'hero', roomId: 5 });
  expect(loaded.byRoomSlug.get('5:hero')).toBe(1);
  expect(loaded.byGlobalSlug.get('lib')).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec jest package-slug-index`
Expected: FAIL — старый индекс не имеет `byRoomSlug`, `resolvePackageTarget` принимает 2 аргумента.

- [ ] **Step 3: Implement the scoped index**

`loadPackageSlugIndex` загружает `{ select: { id: true, slug: true }, relations: { room: true } }`; для каждой строки со slug:
- `byId.set(id, { slug, roomId: row.room?.id ?? null })`
- `roomId === null` → `byGlobalSlug.set(slug, id)`
- иначе → `byRoomSlug.set(`${roomId}:${slug}`, id)`

`resolvePackageTarget`: numeric → `Number(target)`; иначе при `roomId !== null` сначала `byRoomSlug`, затем `byGlobalSlug`; `null` → только `byGlobalSlug`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server exec jest package-slug-index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/package-slug-index.ts packages/server/src/scripting-packages/package-slug-index.spec.ts
git commit -m "feat(server): scope package slug index by room"
```

---

### Task 3: Room-scoped резолв ссылок и защита от теней

**Files:**
- Modify: `packages/server/src/scripting-packages/package-runtime-references.ts`
- Modify: `packages/server/src/scripting-packages/package-revisions.service.ts`
- Modify: `packages/server/src/scripting-packages/package-closure-resolver.ts`
- Modify: `packages/server/src/scripting-packages/package-delivery.service.ts`
- Test: `packages/server/src/scripting-packages/package-runtime-references.spec.ts`

**Interfaces:**
- Consumes: `PackageSlugIndex`, `resolvePackageTarget(target, index, roomId)` из Task 2.
- Produces:
  - `resolvePackageReferences(refs, index, roomId: number | null)`
  - `buildSceneDependencies(packageId, files, dependencies, index, roomId: number | null)`
  - `rewritePackageReferences(text, options)` — сигнатура та же, внутри строит областной индекс по `options.roomId`
  - `assertUniquePackageSlugs(slugByPackage: ReadonlyMap<number, string>): void` — бросает `Error('package_slug_shadowed:<slug>')`

- [ ] **Step 1: Write the failing tests**

В `package-runtime-references.spec.ts`:

```ts
it('resolves a reference in the room namespace first', () => {
  const index: PackageSlugIndex = {
    byId: new Map(),
    byRoomSlug: new Map([['5:hero', 1]]),
    byGlobalSlug: new Map([['hero', 3]]),
  };
  expect(resolvePackageReferences(collectRawPackageReferences('preload("res://packages/hero/main.gd")'), index, 5).resolved)
    .toEqual([{ packageId: 1, filepath: 'main.gd' }]);
  expect(resolvePackageReferences(collectRawPackageReferences('preload("res://packages/hero/main.gd")'), index, 6).resolved)
    .toEqual([{ packageId: 3, filepath: 'main.gd' }]);
});

it('rewrites references inside the artifact room namespace', () => {
  const text = 'const X = preload("res://packages/hero/main.gd")';
  const rewritten = rewritePackageReferences(text, {
    roomId: 5,
    revisionByPackage: new Map([[1, 2]]),
    artifactKeyByPackage: new Map([[1, 'abc']]),
    slugByPackage: new Map([[1, 'hero']]),
  });
  expect(rewritten).toContain('user://wired/rooms/5/packages/hero/2-abc/main.gd');
});

it('rejects two packages with the same slug in one closure', () => {
  expect(() => assertUniquePackageSlugs(new Map([[1, 'hero'], [3, 'hero']])))
    .toThrow('package_slug_shadowed:hero');
});
```

Дополнительно в `package-closure-resolver.spec.ts` добавь кейс: комната 5 содержит пакет `hero` (id 1) и глобальный `hero` (id 3); ревизия комнатного пакета ссылается на `res://packages/hero/lib.gd` → в замыкании `revisionByPackage` содержит 1, а не 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec jest package-runtime-references package-closure-resolver`
Expected: FAIL — нет аргумента `roomId`, нет `assertUniquePackageSlugs`.

- [ ] **Step 3: Thread the room scope through reference functions**

- `resolvePackageReferences(refs, index, roomId)` → `resolvePackageTarget(ref.target, index, roomId)`.
- `collectReferences(text, index, roomId)` и `parsePackagePath(raw, index, roomId)` — внутренние, добавь параметр.
- `buildSceneDependencies(..., index, roomId)` → `collectReferences(..., roomId)`.
- `rewritePackageReferences`: внутри `const index: PackageSlugIndex = { byId: new Map([...slugByPackage].map(([id, slug]) => [id, { slug, roomId: options.roomId }])), byRoomSlug: new Map([...slugByPackage].map(([id, slug]) => [`${options.roomId}:${slug}`, id])), byGlobalSlug: new Map([...slugByPackage].map(([id, slug]) => [slug, id])) }`; вызов `resolvePackageTarget(target, index, options.roomId)`.
- Добавь `assertUniquePackageSlugs`: `const seen = new Map<string, number>();` при повторе slug — `throw new Error(`package_slug_shadowed:${slug}`)`.

- [ ] **Step 4: Update every call site**

- `package-revisions.service.ts`: `resolveReferences(text, index, roomId)`; в `assertNoDisabledRoomDependency` загрузи пакет **до** цикла по файлам и вычисли `const scopeRoomId = pkg.room?.id ?? null;`; передай его в `resolveReferences`. В `publish()` загрузи пакет один раз (`const pkg = await this.packagesService.findOne(packageId);`) и передай `pkg.room?.id ?? null` параметром `scopeRoomId` в `recordPinnedDependencies(packageId, revision, row.files, scopeRoomId)`; сама функция использует его в `resolveReferences(text, index, scopeRoomId)`.
- `package-closure-resolver.ts`: в `resolve()` передавай `roomId` аргумента `resolve()` в `resolvePackageReferences`; в `collectRevisionReferences(packageId, entry, slugIndex)` передавай `entry.roomId ?? null` (поле уже есть в `LatestPublishedRevision`).
- `package-delivery.service.ts`: `toSlugIndex(slugByPackage, roomId)` возвращает `byRoomSlug` с ключами `${roomId}:${slug}` + `byGlobalSlug`; в `buildArtifact` (единственный вызов `buildSceneDependencies`, строка ~424) передай `roomId`; перед записью файлов вызови `assertUniquePackageSlugs(slugByPackage)` и оберни в `try/catch`, перебрасывая `BadRequestException((error as Error).message)` (как уже сделано в `rewriteText`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter server exec jest package-runtime-references package-closure-resolver package-delivery package-revisions && pnpm --filter server check-types`
Expected: PASS, `tsc` чистый.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): resolve package references in the room namespace"
```

---

### Task 4: Сервис: области slug, обязательная комната, теги, удаление детей

**Files:**
- Create: `packages/server/src/scripting-packages/package-tags.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`
- Test: `packages/server/src/scripting-packages/package-tags.spec.ts`

**Interfaces:**
- Consumes: `PackageSlugIndex` (Task 2), DTO `tags` (Task 1).
- Produces:
  - `normalizeTags(input: string[]): string[]` в `package-tags.ts` (бросает `BadRequestException({ code: 'invalid_tags', tag })`)
  - `ScriptingPackagesService.checkSlugAvailability(slug: string, roomId?: number): Promise<PackageSlugAvailability>`
  - `ScriptingPackagesService.create(dto, user)` — требует `roomId`
  - `ScriptingPackagesService.createGlobalRecord(input: { slug: string; name: string; version: string; description: string; tags: string[]; author: User }): Promise<ScriptingPackage>`
  - `ScriptingPackagesService.normalizeSlug(slug: string): string` становится `public`

- [ ] **Step 1: Write the failing tests**

В `scripting-packages.service.spec.ts`:

```ts
it('rejects a duplicate slug inside the same room', async () => {
  // live findOne в комнате возвращает существующий пакет
  await expect(service.create(dto, user)).rejects.toMatchObject({
    response: { code: 'slug_taken', slug: 'hero' },
  });
});

it('allows the same slug in two different rooms', async () => {
  // живой конфликт ищется только по room.id: для комнаты 6 findOne → null
  await expect(service.create({ ...dto, roomId: 6 }, user)).resolves.toBeDefined();
});

it('rejects public creation without a room', async () => {
  await expect(service.create({ slug: 'hero', name: 'Hero', version: '1' } as never, user as never))
    .rejects.toMatchObject({ response: { code: 'package_room_required' } });
});

it('checks availability in the requested room and reports the global scope', async () => {
  // room-пакет hero, глобального нет
  expect(await service.checkSlugAvailability('hero', 5)).toEqual({
    slug: 'hero', available: false, reason: 'taken',
    global: { available: true },
  });
});

it('does not tombstone a deleted room package', async () => {
  const retiredSave = jest.fn();
  // manager.getRepository(RetiredPackageSlug).save = retiredSave; pkg.room = { id: 5 }
  await service.remove(10);
  expect(retiredSave).not.toHaveBeenCalled();
});

it('tombstones a deleted global package', async () => {
  const retiredSave = jest.fn(async (_entity: unknown, value: unknown) => value);
  // pkg.room = null
  await service.remove(10);
  expect(retiredSave).toHaveBeenCalledWith(RetiredPackageSlug, { slug: 'hero', packageId: 10 });
});

it('clears parentPackageId of children before deleting', async () => {
  await service.remove(10);
  expect(manager.query).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE scripting_package SET "parentPackageId" = NULL'),
    [10],
  );
});
```

В `package-tags.spec.ts`:

```ts
expect(normalizeTags([' Hero ', 'hero', '2D', 'a_b-c'])).toEqual(['hero', '2d', 'a_b-c']);
expect(() => normalizeTags(['плохой'])).toThrow();
expect(() => normalizeTags(Array.from({ length: 11 }, (_, i) => `t${i}`))).toThrow();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec jest scripting-packages.service package-tags`
Expected: FAIL.

- [ ] **Step 3: Implement `package-tags.ts`**

```ts
const TAG_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const MAX_PACKAGE_TAGS = 10;

export function normalizeTags(input: string[]): string[] {
  const result: string[] = [];
  for (const raw of input ?? []) {
    const tag = String(raw).trim().toLowerCase();
    if (!TAG_PATTERN.test(tag)) {
      throw new BadRequestException({ code: 'invalid_tags', tag: raw });
    }
    if (!result.includes(tag)) result.push(tag);
  }
  if (result.length > MAX_PACKAGE_TAGS) {
    throw new BadRequestException({ code: 'invalid_tags', tag: result[MAX_PACKAGE_TAGS] });
  }
  return result;
}
```

- [ ] **Step 4: Implement slug scoping in the service**

`checkSlugAvailability(slug, roomId?)`: нормализуй; глобальная занятость `findOne({ where: { slug, room: IsNull() } })`, tombstone; при `roomId` — `findOne({ where: { slug, room: { id: roomId } } })`; верни `{ slug, available, reason?, global: { available: globalAvailable, reason: globalReason } }`. В комнате `reason` — только `taken`.

Приватный `insertPackage(params: { slug, data, author, room, parentPackage, scope: { roomId: number } | 'global' })`:
- ключ блокировки `package_slug:${scope === 'global' ? 'global' : `room:${scope.roomId}`}:${slug}`;
- live-проверка в области (`{ slug, room: { id } }` или `{ slug, room: IsNull() }`);
- tombstone — только `'global'`;
- `tags` уже нормализованы вызывающим.

`create(dto, user)`:
- `if (!dto.roomId) throw new BadRequestException({ code: 'package_room_required', message: 'Пакет можно создать только в комнате' })`;
- `data.tags = normalizeTags(dto.tags ?? [])`;
- замени инлайн-транзакцию на `insertPackage({ ..., scope: { roomId } })`.

`createGlobalRecord(input)`: `insertPackage({ slug: normalizeSlug(input.slug), data: { name, version, description, tags: normalizeTags(input.tags) }, author: input.author, room: undefined, parentPackage: undefined, scope: 'global' })` и верни `findOne(id)`.

`update()`: `if (dto.tags !== undefined) pkg.tags = normalizeTags(dto.tags);`

`remove()`:
- перед `manager.delete` выполни `await manager.query('UPDATE scripting_package SET "parentPackageId" = NULL WHERE "parentPackageId" = $1', [id])`;
- `const scope = pkg.room ? `room:${pkg.room.id}` : 'global'` — используй в ключе advisory-lock;
- `RetiredPackageSlug` сохраняй только при `scope === 'global'`.

- [ ] **Step 5: Update the controller**

```ts
@Get('slug-availability')
slugAvailability(
  @Query('slug') slug: string,
  @Query('roomId', new ParseIntPipe({ optional: true })) roomId?: number,
) {
  return this.packagesService.checkSlugAvailability(slug, roomId);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter server exec jest scripting-packages.service package-tags scripting-packages.controller && pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): scope package slugs to rooms and workshop"
```

---

### Task 5: Права публикации и запрет ревизий у глобальных пакетов

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.controller.spec.ts`

**Interfaces:**
- Consumes: существующий `assertPackageEditing`.
- Produces: `ScriptingPackagesService.assertPackagePublishing(user: User, packageId: number): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('lets a room contributor publish a revision', async () => {
  const service = makeService({ id: 10, author: { id: 1 }, contributors: [], room: { id: 5, author: { id: 3 }, contributors: [{ id: 2 }] } });
  await expect(service.assertPackagePublishing({ id: 2 } as never, 10)).resolves.toBeUndefined();
});

it('rejects revision endpoints for a global package', async () => {
  const service = makeService({ id: 10, author: { id: 1 }, contributors: [], room: null });
  await expect(service.assertPackagePublishing({ id: 1 } as never, 10))
    .rejects.toMatchObject({ response: { code: 'package_not_in_room' } });
});

it('keeps PATCH/DELETE closed to room contributors', async () => {
  await expect(service.assertPackageEditing({ id: 2 } as never, 10)).rejects.toBeInstanceOf(ForbiddenException);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: FAIL — метода нет.

- [ ] **Step 3: Implement the two gates**

```ts
async assertPackagePublishing(user: User, packageId: number): Promise<void> {
  const pkg = await this.packagesRepository.findOne({
    where: { id: packageId },
    relations: ['author', 'contributors', 'room', 'room.author', 'room.contributors'],
  });
  if (!pkg) throw new NotFoundException(`ScriptingPackage with id=${packageId} not found`);
  const isAuthor = pkg.author?.id === user.id;
  const isContributor = pkg.contributors?.some((c) => c.id === user.id) ?? false;
  const isRoomMember = Boolean(pkg.room) && (
    pkg.room!.author?.id === user.id ||
    (pkg.room!.contributors?.some((c) => c.id === user.id) ?? false)
  );
  if (!isAuthor && !isContributor && !isRoomMember) {
    throw new ForbiddenException('You are not allowed to publish this package');
  }
  if (!pkg.room) {
    throw new ConflictException({ code: 'package_not_in_room', message: 'Workshop packages cannot receive revisions directly' });
  }
}
```

`assertPackageEditing` оставь без изменения поведения (автор пакета, контрибьютор пакета, автор комнаты).

- [ ] **Step 4: Switch the revision routes**

В контроллере замени `assertPackageEditing` на `assertPackagePublishing` в:
- `POST :id/revisions`,
- `POST :id/revisions/:revision/files/*path`,
- `POST :id/revisions/:revision/publish`,
- `GET :id/revisions` при `includeDrafts`.

`PATCH :id` и `DELETE :id` остаются на `assertPackageEditing`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter server exec jest scripting-packages`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): split publishing rights and block global revisions"
```

---

### Task 6: Серверное копирование ревизий

**Files:**
- Modify: `packages/server/src/scripting-packages/package-revisions.service.ts`
- Test: `packages/server/src/scripting-packages/package-revisions.service.spec.ts`

**Interfaces:**
- Consumes: `PackageStorageService.{readPublishedFile, saveDraftFile, publishRevision, readPinnedDependencies, writePinnedDependencies}`, `sha256Hex` из `./package-hash`, `scopeRoomId`-резолв из Task 3.
- Produces: `PackageRevisionsService.publishCopiedRevision(args: { sourcePackageId: number; targetPackageId: number; transformFile?: (filepath: string, data: Buffer) => Buffer }): Promise<PackageRevision>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('copies the latest published revision as revision 1', async () => {
  // source revision 4 с файлами a.gd (sha X) и b.bin
  // ожидать: revisionsRepository.save с { revision: 1, status: 'draft' },
  // saveDraftFile для каждого файла, publishRevision(target, 1, files, commit),
  // затем запись pins и dispatch.
});

it('applies transformFile and recomputes sha256', async () => {
  // transform заменит "res://packages/old/" на "res://packages/new/"
  // ожидать: declared entry.sha256 !== исходному, size соответствует новым байтам.
});

it('rejects a global target that references a room package', async () => {
  // scopeRoomId === null, индекс резолвит slug в пакет с room !== null
  // ожидать BadRequestException('package_dependency_not_global:hero')
});

it('removes the revision row when publishing the copied bytes fails', async () => {
  // storage.publishRevision бросает → revisionsRepository.delete вызван
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec jest package-revisions.service`
Expected: FAIL — метода нет.

- [ ] **Step 3: Implement `publishCopiedRevision`**

```ts
async publishCopiedRevision(args: {
  sourcePackageId: number;
  targetPackageId: number;
  transformFile?: (filepath: string, data: Buffer) => Buffer;
}): Promise<PackageRevision>
```

Алгоритм:
1. Найди последнюю published-ревизию источника (`order: { revision: 'DESC' }`) — иначе `ConflictException({ code: 'package_not_published' })`.
2. `const target = await this.packagesService.findOne(targetPackageId); const scopeRoomId = target.room?.id ?? null;`
3. Для каждого `entry` источника: `readPublishedFile(sourcePackageId, sourceRev, entry.filepath)`, применить `transformFile`, `size = data.byteLength`, `sha256 = sha256Hex(data)`; собери `PackageFileEntry[]`.
4. `const revision = ((await this.revisionsRepository.maximum('revision', { package: { id: targetPackageId } })) ?? 0) + 1;`
5. Создай и сохрани строку `{ package: { id: targetPackageId }, revision, status: 'draft', files, publishedAt: null }`; сохрани возвращённую сущность в `saved`.
6. `saveDraftFile(targetPackageId, revision, filepath, data)` для каждого файла.
7. Валидация зависимостей:
   - `scopeRoomId === null` → собери ссылки через `resolvePackageReferences(..., index, null)` по draft-файлам; для каждого id загрузи пакет с `relations: { room: true }`; если `pkg.room` не null → `BadRequestException(`package_dependency_not_global:${pkg.slug}`)`;
   - иначе → `await this.assertNoDisabledRoomDependency(targetPackageId, revision, files)`.
8. `acquirePublishLock` + `publishing.add` + `storage.publishRevision(targetPackageId, revision, files, commit)` (commit: `status='published'`, `publishedAt = new Date()`), в `finally` освободи lock.
9. При ошибке шагов 5–8: `await this.revisionsRepository.delete(saved.id)` и пробрось ошибку.
10. `await this.recordPinnedDependencies(targetPackageId, revision, files, scopeRoomId); await this.dispatchPublished(targetPackageId, revision);`
11. Верни `toRevision(saved, targetPackageId)`.

В `publish()` параметр `scopeRoomId` для `recordPinnedDependencies` уже добавлен в Task 3 — используй ту же сигнатуру, ничего не дублируй.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server exec jest package-revisions.service && pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/package-revisions.service.ts packages/server/src/scripting-packages/package-revisions.service.spec.ts
git commit -m "feat(server): copy published package revisions"
```

---

### Task 7: Витрина workshop: список, поиск, lookup

**Files:**
- Create: `packages/server/src/scripting-packages/package-workshop.service.ts`
- Create: `packages/server/src/scripting-packages/package-workshop.service.spec.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.module.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts`

**Interfaces:**
- Consumes: `Repository<ScriptingPackage>`, shared `WorkshopListing`, `WorkshopPackageSummary`.
- Produces:
  - `PackageWorkshopService.list(query: { q?: string; limit?: number; offset?: number }): Promise<WorkshopListing>`
  - `PackageWorkshopService.lookup(slug: string): Promise<{ package: WorkshopPackageSummary | null }>`

- [ ] **Step 1: Write the failing tests**

```ts
it('normalizes the query and clamps pagination', async () => {
  const query = jest.fn(async () => []);
  const service = makeService({ query });
  await service.list({ q: '  HERO  ', limit: 500, offset: -3 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), ['%hero%', 100, 0]);
});

it('maps a row into a workshop summary with a full author', async () => {
  const query = jest.fn(async () => [{
    id: 1, slug: 'hero', name: 'Hero', version: '1.0', description: 'd', tags: ['2d'],
    authorId: 7, authorName: 'Ann', authorEmail: 'a@b.c', authorPicture: 'p', authorService: 'google',
    revision: 3, publishedAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'), total: '1',
  }]);
  const result = await makeService({ query }).list({});
  expect(result.total).toBe(1);
  expect(result.items[0]).toEqual({ id: 1, slug: 'hero', tags: ['2d'], revision: 3, publishedAt: '2026-01-01T00:00:00.000Z', author: { id: 7, name: 'Ann', email: 'a@b.c', picture: 'p', service: 'google' }, /* ... */ });
});

it('returns null from lookup when the slug is not published', async () => {
  expect(await makeService({ query: jest.fn(async () => []) }).lookup('hero')).toEqual({ package: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec jest package-workshop`
Expected: FAIL — файла нет.

- [ ] **Step 3: Implement the listing SQL**

Используй `packagesRepository.query` с параметрами (`$1..$3`), как в §8.6 спецификации:

```sql
SELECT p.id, p.slug, p.name, p.version, p.description, p.tags,
       a.id AS "authorId", a.name AS "authorName", a.email AS "authorEmail",
       a.picture AS "authorPicture", a.service AS "authorService",
       r.revision, r."publishedAt", p."updatedAt",
       COUNT(*) OVER() AS total
FROM scripting_package p
LEFT JOIN "user" a ON a.id = p."authorId"
JOIN LATERAL (
  SELECT revision, "publishedAt" FROM scripting_package_revision
  WHERE "packageId" = p.id AND status = 'published'
  ORDER BY revision DESC LIMIT 1
) r ON TRUE
WHERE p."roomId" IS NULL
  AND ($1 = '' OR p.name ILIKE $1 OR p.slug ILIKE $1 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p.tags) AS t(tag) WHERE t.tag ILIKE $1))
ORDER BY r."publishedAt" DESC, p.id DESC
LIMIT $2 OFFSET $3
```

- `q` → `trim().toLowerCase().slice(0, 64)`; `pattern = q ? `%${q}%` : ''`.
- `limit = Math.min(100, Math.max(1, limit ?? 50))`, `offset = Math.max(0, offset ?? 0)`.
- `total = rows[0] ? Number(rows[0].total) : 0`.
- `publishedAt`/`updatedAt` → `.toISOString()`.
- `author` включай только если `authorId !== null`, поля: `id, name, email, picture, service`.
- `lookup(slug)`: тот же SELECT с `WHERE p."roomId" IS NULL AND p.slug = $1` и `LIMIT 1`; верни `{ package: summary ?? null }`. Нормализуй slug через `packagesService.normalizeSlug(slug)`.

- [ ] **Step 4: Wire the module and routes**

`scripting-packages.module.ts`: добавь `PackageWorkshopService` в `providers`.

Контроллер — маршруты **до** `@Get(':id')`:

```ts
@Get('workshop')
workshop(
  @Query('q') q?: string,
  @Query('limit') limit?: string,
  @Query('offset') offset?: string,
) {
  return this.workshop.list({
    q,
    limit: limit === undefined ? undefined : Number(limit),
    offset: offset === undefined ? undefined : Number(offset),
  });
}

@Get('workshop/lookup')
workshopLookup(@Query('slug') slug: string) {
  return this.workshop.lookup(slug);
}
```

Добавь `package-workshop.service` в конструктор контроллера.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter server exec jest package-workshop && pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): add workshop listing and lookup"
```

---

### Task 8: Публикация в workshop, fork и добавление в комнату

**Files:**
- Modify: `packages/server/src/scripting-packages/package-workshop.service.ts`
- Create: `packages/server/src/scripting-packages/dto/workshop.dto.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts`
- Test: `packages/server/src/scripting-packages/package-workshop.service.spec.ts`

**Interfaces:**
- Consumes: `ScriptingPackagesService.{findOne, create, createGlobalRecord, normalizeSlug, assertPackagePublishing}`, `PackageRevisionsService.publishCopiedRevision` (Task 6), `normalizeTags` (Task 4).
- Produces:
  - `PackageWorkshopService.publishToWorkshop(packageId: number, user: User, metadata?: WorkshopPackageMetadata): Promise<WorkshopPublishResult>`
  - `PackageWorkshopService.forkToWorkshop(packageId: number, user: User, newSlug: string): Promise<ScriptingPackage>`
  - `PackageWorkshopService.addToRoom(workshopPackageId: number, roomId: number, user: User): Promise<ScriptingPackage>`

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a global record with the published snapshot', async () => {
  // room pkg slug hero, published revision 2, автор — текущий пользователь
  // ожидать: createGlobalRecord({ slug: 'hero', tags: [...], author }), publishCopiedRevision({ sourcePackageId, targetPackageId }), mode 'created'
});

it('updates the record when the caller is its author', async () => {
  // глобальная запись hero с author.id === user.id
  // ожидать: mode 'updated', новая ревизия у существующей записи, метаданные обновлены
});

it('refuses to overwrite another author record', async () => {
  // глобальная запись hero с другим автором
  // ожидать: 409 { code: 'workshop_slug_taken', workshopPackage: { id, slug } }, publishCopiedRevision не вызван
});

it('rejects publishing a package without a published revision', async () => {
  // ожидать 409 { code: 'package_not_published' }
});

it('forks with a new slug and keeps the parent', async () => {
  // исходный пакет: slug hero, parentPackage { id: 40 }, room 5
  // ожидать: create({ slug: 'hero2', parentPackageId: 40, roomId: 5 }), transform переписал self-ссылки
});

it('rewrites only whole-slug self references', () => {
  const data = Buffer.from('res://packages/hero/main.gd res://packages/hero_controller/x.gd');
  const out = rewriteForkSlug('main.gd', data, 'hero', 'hero2').toString('utf8');
  expect(out).toContain('res://packages/hero2/main.gd');
  expect(out).toContain('res://packages/hero_controller/x.gd');
  expect(rewriteForkSlug('main.bin', data, 'hero', 'hero2')).toBe(data);
});

it('rejects a fork slug taken in the room or globally', async () => {
  // ожидать 409 { code: 'slug_taken' }
});

it('removes the created package when the copy fails', async () => {
  // publishCopiedRevision бросает → packagesService.remove(created.id) вызван
});

it('adds a workshop record as an independent room copy', async () => {
  // ожидать: create({ slug, parentPackageId: source.id, roomId, authorId: user.id }), publishCopiedRevision без transform
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec jest package-workshop`
Expected: FAIL.

- [ ] **Step 3: Implement the three flows**

Приватные помощники в `PackageWorkshopService`:

```ts
private async loadPublishablePackage(packageId: number, user: User): Promise<ScriptingPackage>
// findOne с relations ['author','room','room.author','room.contributors']
// !pkg.room → ConflictException({ code: 'package_not_in_room' })
// user не автор и не контрибьютор комнаты → ForbiddenException

private async latestPublishedRevision(packageId: number): Promise<ScriptingPackageRevision>
// findOne({ where: { package: { id }, status: 'published' }, order: { revision: 'DESC' } })
// null → ConflictException({ code: 'package_not_published' })

private async findGlobalBySlug(slug: string): Promise<ScriptingPackage | null>
// findOne({ where: { slug, room: IsNull() }, relations: ['author'] })

private async summaryById(id: number): Promise<WorkshopPackageSummary>
// тот же SELECT, что в list(), но WHERE p.id = $1 LIMIT 1
```

`publishToWorkshop`:
1. `pkg = await loadPublishablePackage(packageId, user)`; `source = await latestPublishedRevision(packageId)`.
2. `existing = await findGlobalBySlug(pkg.slug)`.
3. Если `existing && existing.author?.id !== user.id` → `ConflictException({ code: 'workshop_slug_taken', slug: pkg.slug, workshopPackage: await this.summaryById(existing.id) })`.
4. Метаданные: `name = metadata.name ?? pkg.name`, `version = metadata.version ?? pkg.version`, `description = metadata.description ?? pkg.description`, `tags = normalizeTags(metadata.tags ?? pkg.tags ?? [])`.
5. `existing` нет → `created = await packagesService.createGlobalRecord({ slug: pkg.slug, name, version, description, tags, author: user })`; `target = created`; иначе `await packagesService.update(existing.id, { name, version, description, tags })`; `target = existing`.
6. `try { await revisionsService.publishCopiedRevision({ sourcePackageId: packageId, targetPackageId: target.id }) } catch (e) { if (created) await packagesService.remove(created.id); throw e; }`
7. `return { mode: created ? 'created' : 'updated', package: await this.summaryById(target.id) }`.

`forkToWorkshop`:
1. `pkg = await loadPublishablePackage(packageId, user)`; `await latestPublishedRevision(packageId)`.
2. `const newSlug = packagesService.normalizeSlug(newSlugRaw)`.
3. `available = await packagesService.checkSlugAvailability(newSlug, pkg.room!.id)`; если `!available.available || !available.global.available` → `ConflictException({ code: 'slug_taken', slug: newSlug })`.
4. `created = await packagesService.create({ slug: newSlug, name: pkg.name, version: pkg.version, description: pkg.description, tags: pkg.tags, authorId: user.id, roomId: pkg.room!.id, ...(pkg.parentPackage ? { parentPackageId: pkg.parentPackage.id } : {}) }, user)`.
5. `try { await revisionsService.publishCopiedRevision({ sourcePackageId: packageId, targetPackageId: created.id, transformFile: (filepath, data) => rewriteForkSlug(filepath, data, pkg.slug, newSlug) }) } catch (e) { await packagesService.remove(created.id); throw e; }`
6. `return packagesService.findOne(created.id)`.

`rewriteForkSlug` (в том же файле, экспортируй для теста):

```ts
const FORK_TEXT_EXTENSIONS = new Set(['.gd', '.tscn', '.tres', '.import']);

export function rewriteForkSlug(
  filepath: string,
  data: Buffer,
  oldSlug: string,
  newSlug: string,
): Buffer {
  const ext = path.posix.extname(filepath).toLowerCase();
  if (!FORK_TEXT_EXTENSIONS.has(ext)) return data;
  const text = data.toString('utf8');
  const needle = `res://packages/${oldSlug}/`;
  if (!text.includes(needle)) return data;
  return Buffer.from(text.split(needle).join(`res://packages/${newSlug}/`), 'utf8');
}
```

`addToRoom`:
1. `source = await packagesService.findOne(workshopPackageId)`; `if (source.room) throw BadRequestException({ code: 'package_not_in_workshop' })`; `await latestPublishedRevision(workshopPackageId)`.
2. `created = await packagesService.create({ slug: source.slug, name: source.name, version: source.version, description: source.description, tags: source.tags, authorId: user.id, roomId, parentPackageId: source.id }, user)` — `create` сам проверит права на комнату и занятость slug (409 `slug_taken`).
3. `try { await revisionsService.publishCopiedRevision({ sourcePackageId: workshopPackageId, targetPackageId: created.id }) } catch (e) { await packagesService.remove(created.id); throw e; }`
4. `return packagesService.findOne(created.id)`.

- [ ] **Step 4: Add DTOs and routes**

`dto/workshop.dto.ts`:

```ts
export class WorkshopPublishDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() version?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}
export class WorkshopForkDto {
  @IsString() @MaxLength(64) @Matches(/^(?=.*[a-z])[a-z0-9_]+$/) slug: string;
}
export class RoomCopyDto {
  @IsInt() roomId: number;
}
```

Контроллер (все с `@UseAuthGuard()`):

```ts
@Post(':id/workshop')
publishToWorkshop(@Req() req: AuthenticatedRequest, @Param('id', ParseIntPipe) id: number, @Body() dto: WorkshopPublishDto) {
  return this.workshop.publishToWorkshop(id, req.user, dto);
}

@Post(':id/workshop-fork')
forkToWorkshop(@Req() req: AuthenticatedRequest, @Param('id', ParseIntPipe) id: number, @Body() dto: WorkshopForkDto) {
  return this.workshop.forkToWorkshop(id, req.user, dto.slug);
}

@Post(':id/room-copy')
copyToRoom(@Req() req: AuthenticatedRequest, @Param('id', ParseIntPipe) id: number, @Body() dto: RoomCopyDto) {
  return this.workshop.addToRoom(id, dto.roomId, req.user);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter server exec jest package-workshop scripting-packages && pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): publish, fork and add workshop packages"
```

---

### Task 9: Frontend API, витрина и главная страница

**Files:**
- Modify: `frontend/src/api/services/scripting-packages.ts`
- Create: `frontend/src/components/packages/slug.ts`
- Create: `frontend/src/components/packages/use-workshop-packages.ts`
- Create: `frontend/src/components/packages/workshop-browser.tsx`
- Create: `frontend/src/components/packages/workshop-browser.test.tsx`
- Modify: `frontend/src/app/(browser)/(homepage)/homepage-client.tsx`

**Interfaces:**
- Consumes: shared `WorkshopListing`, `WorkshopPackageSummary`, `WorkshopPublishResult`, `WorkshopPackageMetadata`.
- Produces:
  - `listWorkshopPackages(params: { q?: string; limit?: number; offset?: number }): Promise<WorkshopListing>`
  - `lookupWorkshopPackage(slug: string): Promise<WorkshopPackageSummary | null>`
  - `publishPackageToWorkshop(id: number, metadata: WorkshopPackageMetadata): Promise<WorkshopPublishResult>`
  - `forkPackageToWorkshop(id: number, slug: string): Promise<ScriptingPackage>`
  - `copyWorkshopPackageToRoom(id: number, roomId: number): Promise<ScriptingPackage>`
  - `checkPackageSlugAvailability(slug: string, roomId?: number): Promise<PackageSlugAvailability>` с полем `global: { available: boolean; reason?: 'taken' | 'retired' }`
  - `frontend/src/components/packages/slug.ts`: `SLUG_PATTERN`, `SLUG_MAX_LENGTH`, `SLUG_CHECK_DEBOUNCE_MS`, `SlugCheckState`, `SLUG_HINT`, `isSlugValid`
  - `<WorkshopBrowser onSelect? selectLabel? busyId? />`

- [ ] **Step 1: Write the failing component test**

`workshop-browser.test.tsx` (Vitest + jsdom, mock `@/api/services/scripting-packages`):

```tsx
it('renders workshop packages and the author', async () => { /* mock list → одна запись; findByText('Hero'), findByText('#hero') */ });
it('debounces the search and sends the query', async () => { /* type into getByLabelText('Поиск пакетов'); advance 300ms; expect list called with { q: 'hero', limit: 50, offset: 0 } */ });
it('calls onSelect with the chosen package', async () => { /* click 'Добавить' → onSelect с id */ });
it('shows the empty and error states', async () => { /* пустой ответ → 'В workshop пока нет пакетов'; reject → 'Повторить' */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run workshop-browser`
Expected: FAIL — модулей нет.

- [ ] **Step 3: Add the API functions**

Дополни `scripting-packages.ts`:

```ts
export type PackageSlugAvailability = {
  slug: string;
  available: boolean;
  reason?: "taken" | "retired";
  global: { available: boolean; reason?: "taken" | "retired" };
};

export async function checkPackageSlugAvailability(slug: string, roomId?: number) {
  return apiClient.get<PackageSlugAvailability, { slug: string; roomId?: number }>(
    "scripting-packages/slug-availability",
    { slug, ...(roomId === undefined ? {} : { roomId }) }
  );
}

export async function listWorkshopPackages(params: { q?: string; limit?: number; offset?: number }) {
  return apiClient.get<WorkshopListing, { q?: string; limit?: number; offset?: number }>(
    "scripting-packages/workshop",
    params
  );
}

export async function lookupWorkshopPackage(slug: string) {
  const result = await apiClient.get<{ package: WorkshopPackageSummary | null }, { slug: string }>(
    "scripting-packages/workshop/lookup",
    { slug }
  );
  return result.package;
}

export async function publishPackageToWorkshop(id: number, metadata: WorkshopPackageMetadata) {
  return apiClient.post<WorkshopPublishResult, WorkshopPackageMetadata>(
    `scripting-packages/${id}/workshop`,
    metadata
  );
}

export async function forkPackageToWorkshop(id: number, slug: string) {
  return apiClient.post<ScriptingPackage, { slug: string }>(
    `scripting-packages/${id}/workshop-fork`,
    { slug }
  );
}

export async function copyWorkshopPackageToRoom(id: number, roomId: number) {
  return apiClient.post<ScriptingPackage, { roomId: number }>(
    `scripting-packages/${id}/room-copy`,
    { roomId }
  );
}
```

- [ ] **Step 4: Implement `slug.ts` and the hook**

`slug.ts` — перенос констант из `PackagesTab.tsx` (`SLUG_PATTERN`, `SLUG_MAX_LENGTH`, `SLUG_CHECK_DEBOUNCE_MS`, `SlugCheckState`, `SLUG_HINT`, `isSlugValid`, `slugHintClass`).

`use-workshop-packages.ts`:

```ts
export function useWorkshopPackages() {
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<WorkshopPackageSummary[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async (q: string, offset: number) => { /* listWorkshopPackages({ q, limit: 50, offset }) */ }, []);
  // debounce 300мс на query, сброс offset на 0; loadMore() грузит offset = items.length
  return { query, setQuery, items, total, loading, error, reload, loadMore, hasMore: items.length < total };
}
```

- [ ] **Step 5: Implement `workshop-browser.tsx`**

- `"use client"`.
- Поиск: `Input` + `SearchIcon` + кнопка очистки (`aria-label="Очистить поиск"`), `aria-label="Поиск пакетов"`, placeholder «Поиск по названию, slug или тегу».
- Карточка: `rounded-lg border border-border bg-card p-4`, имя, `#slug` моноширинным, версия, автор, `revision`, дата (`new Date(publishedAt).toLocaleDateString("ru-RU")`), описание `line-clamp-2`, теги чипами.
- `onSelect` рендерит `Button size="sm"` с `selectLabel ?? "Добавить"`, disabled при `busyId === item.id`, внутри спиннер.
- Состояния: загрузка — `Loader2Icon animate-spin`; пусто — «В workshop пока нет пакетов» / «Ничего не найдено по запросу «<q>»»; ошибка — текст + `Button variant="outline"` «Повторить».
- «Показать ещё» при `hasMore`.

- [ ] **Step 6: Wire the homepage**

В `homepage-client.tsx`: импорт `WorkshopBrowser`, замени `CardContent` вкладки `packages` на `<CardContent className="grid gap-6"><WorkshopBrowser /></CardContent>`; `CardTitle` → «Workshop», `CardDescription` → «Пакеты сообщества. Ищите по названию, slug или тегу».

- [ ] **Step 7: Run tests and type checks**

Run: `pnpm --filter frontend exec vitest run workshop-browser && pnpm check-types:frontend && pnpm --filter frontend lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/services/scripting-packages.ts frontend/src/components/packages frontend/src/app/"(browser)"/"(homepage)"/homepage-client.tsx
git commit -m "feat(frontend): add workshop browser and homepage tab"
```

---

### Task 10: Панель пакетов: кнопка Workshop, публикация и fork

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`
- Create: `frontend/src/app/room/[room_code]/(godot)/workshop-dialogs.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx`

**Interfaces:**
- Consumes: API-функции и `WorkshopBrowser` (Task 9), `slug.ts`, `RoomPackagesController`, `downloadPackage`.
- Produces:
  - `WorkshopSlugTakenError extends Error { slug: string; workshopPackage: WorkshopPackageSummary }`
  - `RoomPackagesController.addFromWorkshop(workshopPackageId: number): Promise<ScriptingPackage>`
  - `RoomPackagesController.publishToWorkshop(packageId: number, metadata?: WorkshopPackageMetadata): Promise<WorkshopPublishResult>`
  - `RoomPackagesController.forkWorkshopPackage(packageId: number, slug: string): Promise<ScriptingPackage>`
  - Компоненты `WorkshopBrowserDialog`, `WorkshopPublishDialog`, `WorkshopForkDialog` из `workshop-dialogs.tsx`

- [ ] **Step 1: Write the failing hook tests**

```ts
it('adds a workshop package, downloads it and refreshes', async () => {
  // mock copyWorkshopPackageToRoom → pkg; ожидать dispatch created, list status refresh, downloadPackage(newId)
});
it('publishes to the workshop without touching the room package', async () => {
  // mock publishPackageToWorkshop → { mode: 'updated', package }
  // ожидать notice и отсутствие files.write
});
it('throws WorkshopSlugTakenError on 409 workshop_slug_taken', async () => {
  // mock reject с { response: { data: { code: 'workshop_slug_taken', slug, workshopPackage } } }
  // ожидать instanceOf WorkshopSlugTakenError с полями
});
it('forks with a new slug and downloads the copy', async () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: FAIL.

- [ ] **Step 3: Implement the controller actions**

- `WorkshopSlugTakenError` рядом с `LocalChangesError`.
- `checkSlugAvailability(slug)` → `(slug, roomId)`.
- `addFromWorkshop`:
  ```ts
  const created = await copyWorkshopPackageToRoom(workshopPackageId, roomId);
  dispatch({ type: "created", package: created });
  setAction(created.id, { notice: "Пакет добавлен в комнату" });
  await refresh();
  await downloadPackage(created.id).catch(() => undefined);
  return created;
  ```
  Размести после `downloadPackage`, чтобы вызывать его напрямую.
- `publishToWorkshop`: `const result = await publishPackageToWorkshop(packageId, metadata ?? {})`; `setAction(packageId, { notice: result.mode === 'created' ? 'Пакет опубликован в workshop' : 'Публикация в workshop обновлена' })`; вернуть результат. Ошибку 409 с `code === 'workshop_slug_taken'` преобразуй в `WorkshopSlugTakenError`, остальные — в `Error` с текстом.
- `forkWorkshopPackage`: `const created = await forkPackageToWorkshop(packageId, slug)`; `dispatch({type:'created', package: created})`; notice «Форк создан: <slug>. Опубликуйте его в workshop отдельно»; `await refresh()`; `await downloadPackage(created.id).catch(() => undefined)`; вернуть.
- Добавь три метода в тип `RoomPackagesController` и в возвращаемый объект.

- [ ] **Step 4: Implement the dialogs**

`workshop-dialogs.tsx` (`"use client"`):

```tsx
export function WorkshopBrowserDialog({ open, onOpenChange, packages, busyId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packages: RoomPackagesController;
  busyId: number | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Workshop</DialogTitle>
          <DialogDescription>Пакеты сообщества. Добавление создаст копию в этой комнате.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <WorkshopBrowser
            busyId={busyId}
            onSelect={(pkg) => { void packages.addFromWorkshop(pkg.id); }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

`WorkshopPublishDialog({ open, onOpenChange, entry, packages, authorId })`:
- поля `name`, `version`, `description`, `tags` (строка через запятую, split(/[,\s]+/) и фильтр пустых);
- при открытии `lookupWorkshopPackage(entry.slug)` в `useEffect` с флагом отмены;
- статус: нет записи → «Будет создана новая запись в workshop»; `existing.author?.id === authorId` → «Публикация обновится»; иначе «Slug занят: <author.name>» и primary «Создать fork» (вызывает `onFork()`);
- submit → `packages.publishToWorkshop(entry.packageId, { name, version, description, tags })`; `WorkshopSlugTakenError` → переключить диалог в состояние «slug занят» (без закрытия);
- ошибка показывается в блоке `border-destructive/30 bg-destructive/10`.

`WorkshopForkDialog({ open, onOpenChange, entry, roomId, packages })`:
- поле «Новый slug», lowercase, `isSlugValid`;
- debounce-проверка `packages.checkSlugAvailability(slug, roomId)` → подсказка `SLUG_HINT`; кнопка активна только при `available.available && available.global.available`;
- submit → `packages.forkWorkshopPackage(entry.packageId, slug)` → `onOpenChange(false)`.

- [ ] **Step 5: Wire `PackagesTab.tsx`**

- Удали локальные `SLUG_PATTERN`, `SLUG_MAX_LENGTH`, `SLUG_CHECK_DEBOUNCE_MS`, `SlugCheckState`, `SLUG_HINT`, `isSlugValid`, `slugHintClass`; импортируй из `@/components/packages/slug`.
- `checkSlugAvailability(trimmed)` → `packages.checkSlugAvailability(trimmed, roomId)`; добавь проп `roomId` в `PackagesTab` (из `RoomPageClient`: `room.id`).
- В шапке перед «Создать пакет»:

```tsx
<Button type="button" size="sm" variant="outline" onClick={() => setWorkshopOpen(true)}>
  <StoreIcon className="size-4" />
  Workshop
</Button>
```

- В меню `PackageCard` перед `DropdownMenuSeparator`:

```tsx
<DropdownMenuItem
  disabled={disabled || !authorId || entry.publishedRevision === null}
  onSelect={() => onPublishToWorkshop(entry)}
  title={entry.publishedRevision === null ? "Сначала опубликуйте пакет через Emit" : undefined}
>
  <StoreIcon className="size-4" />
  Опубликовать в workshop
</DropdownMenuItem>
```

- Состояние: `workshopOpen`, `publishEntry`, `forkEntry`; `busyId` — `entry.packageId` из `packages.actions`, у которого `busy`.
- Размонтируй диалоги в конце панели рядом с `{dialog}`.
- `RoomPageClient.tsx`: передай `roomId={room.id}` в `<PackagesTab ... />`; `PackageCard` получает `roomId` пропом для fork-диалога.

- [ ] **Step 6: Update the panel tests**

В `PackagesTab.test.tsx`: добавь в фабрику контроллера `addFromWorkshop`, `publishToWorkshop`, `forkWorkshopPackage` (jest/vitest mocks) и `roomId`; проверь:
- кнопка «Workshop» открывает диалог;
- пункт «Опубликовать в workshop» отсутствует/disabled без опубликованной ревизии;
- публикация с занятым чужим slug показывает «Создать fork» и открывает fork-диалог.

- [ ] **Step 7: Run the frontend suite**

Run: `pnpm --filter frontend test && pnpm check-types:frontend && pnpm --filter frontend lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/room
git commit -m "feat(frontend): publish and fork packages in the workshop"
```

---

### Task 11: Финальная проверка

**Files:**
- Modify: `docs/superpowers/specs/2026-11-03-package-workshop-design.md` (только если реализация отступила от спеки — зафиксировать отступление)

- [ ] **Step 1: Run the full server suite**

Run: `pnpm --filter server test`
Expected: все suites PASS (включая новые), `room-runtime.integration` skipped.

- [ ] **Step 2: Run the full frontend suite and builds**

Run: `pnpm --filter frontend test && pnpm check-types:frontend && pnpm --filter server check-types && pnpm --filter server lint && pnpm --filter frontend lint`
Expected: PASS.

- [ ] **Step 3: Verify the schema change on a real boot**

Run: `pnpm dev:server` (нужен `packages/server/.env` и Postgres)
Expected: сервер стартует без `package_slug_backfill_incomplete`; в логах нет ошибок синхронизации. После старта `\d scripting_package` не содержит уникального индекса по `slug` и содержит `tags jsonb not null default '[]'`.

- [ ] **Step 4: Manual integration pass (spec §9)**

Опубликовать пакет комнаты и увидеть его на главной; найти по имени, slug и тегу. Добавить запись workshop в другую комнату, проверить `parentPackage`, каталог `packages/<slug>` и файлы в редакторе. Изменить комнатную копию и убедиться, что запись workshop не изменилась; опубликовать обновление автором и увидеть новую ревизию. Вторым пользователем получить fork и проверить переписанные ссылки и работу сцены. Удалить запись workshop и убедиться, что комнатные копии продолжают работать.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: verify workshop package flow"
```
