# Редактирование пакета: slug и метаданные — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разрешить менять slug пакета комнаты в любой момент (с переписыванием серверных байтов и папки в редакторе), убрать tombstone workshop-slug и собрать редактирование всех метаданных в один диалог.

**Architecture:** Переименование — часть существующего `PATCH /scripting-packages/:id`. `ScriptingPackagesService` выполняет его в одной транзакции под advisory-локами slug и блокировками публикации, переписывает `res://packages/<old>/` в своих published/draft-ревизиях и в published-ревизиях зависимых пакетов той же комнаты, обновляет `files`, чистит кэш резолвера и артефакты, оповещает рантаймы. Редактор переименовывает папку новой операцией моста (`rename`) сразу после PATCH. UI переносит метаданные из панели публикации в диалог «Редактировать пакет».

**Tech Stack:** NestJS 11 + TypeORM 0.3 / Postgres, Next.js 16 + React 19, Jest (сервер), Vitest + testing-library (фронтенд), GDScript-мост Godot 4.8.

**Spec:** `docs/superpowers/specs/2026-11-03-package-metadata-and-slug-editing-design.md`

## Global Constraints

- `DB_SYNC=1`, миграций нет; сущности/схему менять можно только так, чтобы старт сервера сам приводил БД в нужное состояние. Удалённая таблица `retired_package_slug` остаётся сиротой — это ожидаемо.
- `scripting_package_revision.files` — единственный манифест ревизии: после переписывания байтов `size` и `sha256` каждого изменённого файла обязаны совпадать с байтами на диске (редактор, sync и рантайм проверяют их жёстко).
- `artifactKey` зависит только от `(packageId, revision)`; после переписывания той же ревизии артефакт обязан быть удалён, иначе будет отдан старый контент.
- `PackageClosureResolver.fileBytes` кеширует байты в памяти — после переписывания кеш пакета обязан быть сброшен.
- У моста редактора нет rename; `collect`/`replace` теряют `.uid`/`.import`, поэтому папка переименовывается новой операцией GDScript.
- UI-копия и документация — на русском; идентификаторы, поля API и сообщения коммитов — на английском. Conventional Commits.
- Не коммитить `opencode.json` и `Текстовый документ.txt`.
- Node >= 22, pnpm 10.12.1; сервер запускается из `packages/server` (пути конфига резолвятся от cwd).

## Review Focus

- PATCH с `slug`, равным текущему: должен быть обычным обновлением метаданных — ни переписывания, ни инвалидации, ни оповещения.
- Draft без загруженных файлов: переименование проходит, `files` ревизии не меняется, каталог ревизии не создаётся.
- Пакет без единой published-ревизии: переименование проходит, список зависимых пуст, артефактов нет.
- Непустая папка целевого slug в редакторе после успешного PATCH: сервер остаётся переименованным, диалог предлагает повтор, данные не теряются.
- Переименование в slug, занятый глобальной workshop-записью: разрешено (область комнаты), публикация позже предложит fork.

Все пять пунктов закреплены тестами в задачах 6, 8, 9 и 10.

## File Structure

| Файл | Ответственность |
|---|---|
| `packages/server/src/scripting-packages/package-slug-rewrite.ts` (new) | Чистая функция замены `res://packages/<old>/` по расширениям; единственное место правила |
| `packages/server/src/scripting-packages/package-publish-lock.service.ts` (new) | Advisory-лок `wired.package-publish:<id>` + in-process набор `publishing` |
| `packages/server/src/scripting-packages/package-storage.service.ts` | Три фазы переписывания ревизии на диске |
| `packages/server/src/scripting-packages/scripting-packages.service.ts` | Оркестрация переименования и атомарный PATCH |
| `packages/server/src/scripting-packages/package-delivery.service.ts` | Инвалидация кэша резолвера и артефактов |
| `packages/server/src/scripting-packages/package-closure-resolver.ts` | Сброс `fileBytes` по пакету |
| `packages/server/src/godot-game/package-sync.service.ts` | `packagesChanged(ids)` — переотправка на той же ревизии |
| `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd` | `op_rename` — атомарное переименование папки |
| `packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd` | Регистрация операции `rename` |
| `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.ts` | `renamePackage(from, to)` |
| `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts` | Порядок PATCH → state → папка → rescan → refresh |
| `frontend/src/app/room/[room_code]/(godot)/package-edit-dialog.tsx` (new) | Единственная форма метаданных |
| `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx` | Read-only карточка, пункт меню, подсказка про глобальный slug |
| `frontend/src/app/room/[room_code]/(godot)/workshop-dialogs.tsx` | Публикация как предпросмотр без полей ввода |

---

### Task 1: Удалить tombstone workshop-slug

**Files:**
- Delete: `packages/server/src/database/entities/retired-package-slug.entity.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.module.ts`, `packages/server/src/godot-game/godot-game.module.ts`, `packages/server/src/database/entities/entities.metadata.spec.ts`, `packages/server/src/scripting-packages/scripting-packages.service.ts`, `packages/server/src/scripting-packages/package-workshop.service.ts`
- Modify: `frontend/src/api/services/scripting-packages.ts`, `frontend/src/components/packages/slug.ts`, `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`, `frontend/src/app/room/[room_code]/(godot)/workshop-dialogs.tsx`, `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`, `packages/server/src/scripting-packages/package-workshop.service.spec.ts`, `packages/server/src/database/entities/entities.metadata.spec.ts`, `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`, `frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx`

**Interfaces:**
- Produces: `PackageSlugAvailability = { slug: string; available: boolean; reason?: 'taken'; global: { available: boolean; reason?: 'taken' } }` (одинаково в сервисе и фронтенде); `ScriptingPackagesService.remove(id: number): Promise<void>` без опций; `rollbackCreatedPackage(packageId: number): Promise<void>`.
- Consumes: ничего из более поздних задач.

- [ ] **Step 1: Удалить сущность и её регистрации**

Удалить `retired-package-slug.entity.ts`; убрать импорт и элемент `TypeOrmModule.forFeature([...])` в `scripting-packages.module.ts` и `godot-game.module.ts`; убрать импорт и запись из списка в `entities.metadata.spec.ts`.

- [ ] **Step 2: Переписать серверные тесты под отсутствие tombstone**

В `scripting-packages.service.spec.ts`: удалить `reports a retired global slug as retired`, `rejects a global record with a retired slug and an actionable message`, `tombstones a deleted global package`, `does not tombstone a rolled-back global package when asked not to`, `does not tombstone a deleted room package`, `does not apply a global tombstone to a room slug`, `locks the global slug scope before tombstoning it`; убрать `retiredFindOne` из тест-даблов и третий аргумент во всех `new ScriptingPackagesService(...)`; удалить `retiredSlugsRepository` из провайдеров тестового модуля. Добавить:

```ts
it('reports a deleted global slug as available', async () => {
  packagesRepository.findOne.mockResolvedValue(null);
  await expect(service.checkSlugAvailability('hero')).resolves.toEqual({
    slug: 'hero',
    available: true,
    global: { available: true },
  });
  // Один запрос: живой строки нет — и больше ничего не проверяется.
  expect(packagesRepository.findOne).toHaveBeenCalledTimes(1);
});
```

В `package-workshop.service.spec.ts` заменить ожидание `[20, { tombstone: false }]` на `[20]` (тест `deletes a fresh record without retiring its slug when the copy fails` переименовать в `deletes a fresh record when the copy fails`).

- [ ] **Step 3: Запустить серверные тесты и убедиться, что они падают**

Run: `pnpm --filter server exec jest scripting-packages.service package-workshop.service entities.metadata`
Expected: FAIL — TS-ошибки `RetiredPackageSlug` и несовпадение аргументов конструктора.

- [ ] **Step 4: Убрать tombstone из сервисов**

В `scripting-packages.service.ts`: удалить импорт `RetiredPackageSlug`, `PackageSlugAvailability.reason` сузить до `'taken'`, удалить инъекцию `retiredSlugsRepository`, из `checkSlugAvailability` убрать чтение tombstone (`scope = { available: true }` при отсутствии живой строки), из `insertPackage` убрать блок `if (scope === 'global') { ... slug_retired ... }`, у `remove` убрать параметр `options`, переменные `tombstone`/`scope` (advisory-лок оставить, но без tombstone-записи), обновить doc-комментарии. В `package-workshop.service.ts` вызывать `remove(createdId)` без опций, а `rollbackCreatedPackage` сделать без параметров.

- [ ] **Step 5: Запустить серверные тесты**

Run: `pnpm --filter server test`
Expected: PASS, набор зелёный (число тестов уменьшилось на удалённые).

- [ ] **Step 6: Убрать `retired` из фронтенда**

В `frontend/src/api/services/scripting-packages.ts` сузить `reason?: "taken"`; в `slug.ts` удалить `'retired'` из `SlugCheckState`, `SLUG_HINT.retired` и из списка destructive в `slugHintClass`; в `PackagesTab.tsx` заменить `setSlugState(result.reason === "retired" ? "retired" : "taken")` на `setSlugState("taken")`; в `workshop-dialogs.tsx` ничего не менять (там используется только `available`); в `use-room-packages.ts` удалить `case "slug_retired"` из `workshopErrorMessage`. В тестах удалить `explains that a retired slug cannot be reused` (`PackagesTab.test.tsx`) и `explains a retired workshop slug` (`use-room-packages.test.tsx`), поправить моки под суженный тип.

- [ ] **Step 7: Запустить фронтенд-тесты и типы**

Run: `pnpm --filter frontend exec vitest run PackagesTab use-room-packages`
Run: `pnpm check-types:frontend` и `pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(server): remove retired workshop slug tombstones"
```

---

### Task 2: Модуль замены slug-ссылок и трёхфазное переписывание ревизий

**Files:**
- Create: `packages/server/src/scripting-packages/package-slug-rewrite.ts`
- Create: `packages/server/src/scripting-packages/package-slug-rewrite.spec.ts`
- Modify: `packages/server/src/scripting-packages/package-storage.service.ts`, `packages/server/src/scripting-packages/package-storage.service.spec.ts`, `packages/server/src/scripting-packages/package-workshop.service.ts`
- Test: `package-storage.service.spec.ts`

**Interfaces:**
- Produces:
  - `SLUG_REWRITE_EXTENSIONS: ReadonlySet<string>` (`'.gd'`, `'.tscn'`, `'.tres'`, `'.import'`)
  - `rewriteSlugReferences(filepath: string, data: Buffer, fromSlug: string, toSlug: string): Buffer`
  - `type RevisionKind = 'published' | 'draft'`
  - `PackageStorageService.rewriteRevision(packageId: number, revision: number, kind: RevisionKind, transform: (filepath: string, data: Buffer) => Buffer): Promise<PackageFileEntry[] | null>`
  - `PackageStorageService.finishRewrite(packageId: number, revision: number, kind: RevisionKind): Promise<void>`
  - `PackageStorageService.abortRewrite(packageId: number, revision: number, kind: RevisionKind): Promise<void>`
- Consumes: `PackageFileEntry` из `@wired-io/shared`.

- [ ] **Step 1: Написать падающие тесты чистой функции**

`package-slug-rewrite.spec.ts`:

```ts
it('rewrites a whole-slug reference in a scene', () => {
  const input = Buffer.from('[node]\npath = "res://packages/hero/scenes/body.tscn"\n');
  expect(
    rewriteSlugReferences('scenes/level.tscn', input, 'hero', 'hero2').toString(),
  ).toContain('res://packages/hero2/scenes/body.tscn');
});

it('does not touch a longer slug that starts the same way', () => {
  const input = Buffer.from('res://packages/hero_2/body.tscn');
  expect(rewriteSlugReferences('a.gd', input, 'hero', 'hero2')).toEqual(input);
});

it('leaves binary files unchanged', () => {
  const input = Buffer.from('res://packages/hero/x.png', 'utf8');
  expect(rewriteSlugReferences('assets/x.png', input, 'hero', 'hero2')).toBe(input);
});

it('rewrites .import sidecars', () => {
  const input = Buffer.from('source_file="res://packages/hero/a.png"');
  expect(rewriteSlugReferences('a.png.import', input, 'hero', 'h2').toString()).toBe(
    'source_file="res://packages/h2/a.png"',
  );
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

Run: `pnpm --filter server exec jest package-slug-rewrite`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать функцию**

```ts
import { extname } from 'node:path';

export const SLUG_REWRITE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.gd', '.tscn', '.tres', '.import',
]);

export function rewriteSlugReferences(
  filepath: string, data: Buffer, fromSlug: string, toSlug: string,
): Buffer {
  if (!SLUG_REWRITE_EXTENSIONS.has(extname(filepath).toLowerCase())) return data;
  const from = `res://packages/${fromSlug}/`;
  const text = data.toString('utf8');
  const next = text.split(from).join(`res://packages/${toSlug}/`);
  return next === text ? data : Buffer.from(next, 'utf8');
}
```

В `package-workshop.service.ts` заменить тело `rewriteForkSlug` делегированием в `rewriteSlugReferences` (экспорт сохранить: на него опираются форк и его тесты).

- [ ] **Step 4: Написать падающие тесты трёх фаз**

В `package-storage.service.spec.ts` (временный `packagesFilesDir` как в существующих тестах):

```ts
it('rewrites a published revision and keeps a backup until finished', async () => {
  await storage.saveDraftFile(7, 1, 'a.gd', Buffer.from('res://packages/old/a.gd'));
  await storage.publishRevision(7, 1, [
    { filepath: 'a.gd', size: 24, sha256: sha256Hex(Buffer.from('res://packages/old/a.gd')) },
  ], async () => undefined);

  const files = await storage.rewriteRevision(7, 1, 'published', (filepath, data) =>
    rewriteSlugReferences(filepath, data, 'old', 'new'));

  expect(files).toEqual([
    { filepath: 'a.gd', size: 24, sha256: sha256Hex(Buffer.from('res://packages/new/a.gd')) },
  ]);
  expect(await storage.readPublishedFile(7, 1, 'a.gd')).toEqual(
    Buffer.from('res://packages/new/a.gd'),
  );
  await storage.finishRewrite(7, 1, 'published');
  expect(existsSync(path.join(storage.packageRootDir(7), 'revisions', '1.old'))).toBe(false);
});

it('returns null for a draft directory that was never uploaded', async () => {
  await expect(
    storage.rewriteRevision(7, 2, 'draft', (f, d) => d),
  ).resolves.toBeNull();
});

it('restores the original bytes when the rewrite is aborted', async () => {
  // подготовить черновик, вызвать rewriteRevision, затем abortRewrite
  expect(await storage.readDraftFile(7, 3, 'a.gd')).toBe('res://packages/old/a.gd');
});
```

- [ ] **Step 5: Запустить тесты — должны упасть**

Run: `pnpm --filter server exec jest package-storage.service`
Expected: FAIL — методов нет.

- [ ] **Step 6: Реализовать три фазы**

Приватные хелперы: `revisionDir(packageId, revision, kind)` → `draftRevisionDir`/`publishedRevisionDir`; `rewriteDir(...)` = `<revisionDir>.rewrite`; `rewriteBackupDir(...)` = `<revisionDir>.old`.

`rewriteRevision`:
1. Если `!existsSync(dir)` → `null`.
2. Восстановить последствия прошлого краха: если `dir` нет, а `.old` есть — вернуть `.old` на место; если есть оба — удалить `.old` (прошлый коммит уже состоялся).
3. Удалить `.rewrite`, скопировать всё дерево `dir` → `.rewrite` (рекурсивно, с сохранением относительных путей).
4. Для каждого файла: прочитать, применить `transform`, записать обратно; собрать `{ filepath, size: data.byteLength, sha256: sha256Hex(data) }`, отсортировать по `filepath`.
5. `rename(dir, .old)`, затем `rename(.rewrite, dir)`; при ошибке второго шага вернуть `.old` обратно и бросить.

`finishRewrite` — `rm(.old, {recursive:true, force:true})`. `abortRewrite` — если `.old` есть: удалить `dir`, `rename(.old, dir)`; удалить `.rewrite`.

- [ ] **Step 7: Запустить тесты**

Run: `pnpm --filter server exec jest package-slug-rewrite package-storage.service package-workshop.service`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): rewrite package slug references on disk"
```

---

### Task 3: Вынести блокировки публикации в `PackagePublishLockService`

**Files:**
- Create: `packages/server/src/scripting-packages/package-publish-lock.service.ts`
- Create: `packages/server/src/scripting-packages/package-publish-lock.service.spec.ts`
- Modify: `packages/server/src/scripting-packages/package-revisions.service.ts`, `packages/server/src/scripting-packages/scripting-packages.module.ts`, `packages/server/src/scripting-packages/package-revisions.service.spec.ts`

**Interfaces:**
- Produces: `PackagePublishLockService.assertNotPublishing(packageId: number): Promise<void>`; `PackagePublishLockService.runWithPublishLocks<T>(packageIds: number[], fn: () => Promise<T>): Promise<T>`; провайдер экспортируется из `ScriptingPackagesModule`.
- Consumes: ничего.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('marks every package as publishing while the callback runs', async () => {
  const service = new PackagePublishLockService();
  await service.runWithPublishLocks([4, 2, 4], async () => {
    await expect(service.assertNotPublishing(2)).rejects.toThrow(/being published/);
    await expect(service.assertNotPublishing(4)).rejects.toThrow(/being published/);
  });
  await expect(service.assertNotPublishing(2)).resolves.toBeUndefined();
});

it('releases the in-process guard when the callback throws', async () => {
  const service = new PackagePublishLockService();
  await expect(service.runWithPublishLocks([1], async () => { throw new Error('boom'); }))
    .rejects.toThrow('boom');
  await expect(service.assertNotPublishing(1)).resolves.toBeUndefined();
});

it('takes advisory locks in ascending id order', async () => {
  // фейковый dataSource: createQueryRunner() -> { connect, query, release }
  await service.runWithPublishLocks([9, 4], async () => undefined);
  expect(query.mock.calls.map(([sql, params]) => params[0])).toEqual([
    'wired.package-publish:4',
    'wired.package-publish:9',
    'wired.package-publish:9',
    'wired.package-publish:4', // unlock в обратном порядке
  ]);
});

it('fails when another instance holds the publish lock', async () => {
  // query отвечает { locked: false } на pg_try_advisory_lock
  await expect(service.runWithPublishLocks([1], async () => undefined))
    .rejects.toThrow(/being published/);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter server exec jest package-publish-lock`
Expected: FAIL — сервиса нет.

- [ ] **Step 3: Реализовать сервис**

Перенести из `PackageRevisionsService` методы `publishLockKey`, `isPublishLockedElsewhere`, `acquirePublishLock`, `releasePublishLock`, `warnLockFailure` и поле `publishing`. `runWithPublishLocks`: `ids = [...new Set(packageIds)].sort((a, b) => a - b)`; для каждого `acquire` (ConflictException с тем же текстом `Package ${id} is being published, try again in a moment`), добавить в `publishing`; в `finally` — снять из набора и освободить в обратном порядке. Конструктор: `@Optional() @InjectDataSource() private readonly dataSource?: DataSource`.

- [ ] **Step 4: Перевести `PackageRevisionsService` на сервис**

Удалить поле `publishing` и приватные методы лока; инжектировать `PackagePublishLockService`; `createDraft`/`uploadFile` вызывают `await this.locks.assertNotPublishing(packageId)`; в `publish` и `publishCopiedRevision` обернуть блок `storage.publishRevision(...)` в `this.locks.runWithPublishLocks([packageId], async () => { ... })`. Поведение и тексты ошибок не меняются — существующие тесты `package-revisions.service.spec.ts` проходят без правок, кроме замены моков лока на реальный сервис без DataSource.

- [ ] **Step 5: Запустить тесты**

Run: `pnpm --filter server exec jest package-publish-lock package-revisions.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "refactor(server): extract package publish locks into a service"
```

---

### Task 4: Инвалидация кэшей и уведомление рантаймов

**Files:**
- Modify: `packages/server/src/scripting-packages/package-closure-resolver.ts`, `packages/server/src/scripting-packages/package-delivery.service.ts`, `packages/server/src/godot-game/package-sync.types.ts`, `packages/server/src/godot-game/package-sync.service.ts`
- Test: `packages/server/src/scripting-packages/package-closure-resolver.spec.ts`, `packages/server/src/scripting-packages/package-delivery.service.spec.ts`, `packages/server/src/godot-game/package-sync.service.spec.ts`

**Interfaces:**
- Produces:
  - `PackageClosureResolver.invalidatePackage(packageId: number): void`
  - `PackageDeliveryService.invalidateArtifacts(packageId: number): Promise<void>` — удаляет `<packageRoot>/runtime`
  - `PackageDeliveryService.invalidatePackage(packageId: number): Promise<void>` — `invalidateArtifacts` + `resolver.invalidatePackage`
  - `PackageRevisionDispatcher.packagesChanged(packageIds: number[]): Promise<void>`
  - `PackageSyncService.packagesChanged(packageIds: number[]): Promise<void>`
- Consumes: `readFileBytes`/`fileBytes` резолвера, `refreshDependent` синхронизации.

- [ ] **Step 1: Тесты инвалидации**

```ts
it('re-reads bytes after invalidatePackage', async () => {
  await resolver.resolve(5, 1, 7);
  resolver.invalidatePackage(5);
  await resolver.resolve(5, 1, 7);
  expect(storage.readPublishedFile).toHaveBeenCalledTimes(4); // 2 файла × 2 прохода
});

it('removes every runtime artifact of the package', async () => {
  await delivery.getRuntimeManifest(5, 1, 7);
  await delivery.invalidateArtifacts(5);
  expect(existsSync(path.join(storage.packageRootDir(5), 'runtime'))).toBe(false);
});

it('re-dispatches a changed package at the same revision', async () => {
  await sync.revisionPublished(5, 3);          // запись уже на ревизии 3
  await sync.packagesChanged([5, 5]);
  expect(storeRecordSpy).toHaveBeenCalledTimes(1); // не пропускает равную ревизию
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter server exec jest package-closure-resolver package-delivery.service package-sync.service`
Expected: FAIL — методов нет.

- [ ] **Step 3: Реализовать инвалидацию**

`invalidatePackage`: пройти по `this.fileBytes`, удалить ключи с префиксом `${packageId}:` и вычесть их размеры из `fileCacheBytes`. `invalidateArtifacts`: `rm(path.join(this.storage.packageRootDir(packageId), 'runtime'), { recursive: true, force: true })`. `invalidatePackage` у delivery вызывает оба.

- [ ] **Step 4: Реализовать `packagesChanged`**

В `package-sync.types.ts` добавить метод в интерфейс. В `PackageSyncService`:

```ts
async packagesChanged(packageIds: number[]): Promise<void> {
  const ids = [...new Set(packageIds)].sort((a, b) => a - b);
  if (ids.length === 0) return;
  const rows = await this.packages.find({ where: { id: In(ids) }, relations: { room: true } });
  const latest = await this.latestPublishedRevisions(ids);
  for (const pkg of rows) {
    const revision = latest.get(pkg.id);
    if (revision === undefined || !pkg.room || pkg.enabled === false) continue;
    await this.refreshDependent({ packageId: pkg.id, roomId: pkg.room.id, revision });
  }
}
```

`refreshDependent` уже переотправляет на той же ревизии — `dispatchOwnRevision` не используется намеренно.

- [ ] **Step 5: Запустить тесты**

Run: `pnpm --filter server exec jest package-closure-resolver package-delivery.service package-sync.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src
git commit -m "feat(server): invalidate package caches and notify runtimes"
```

---

### Task 5: Контракт PATCH и `excludeId` в проверке slug

**Files:**
- Modify: `packages/shared/src/api/types.ts`, `packages/server/src/scripting-packages/dto/update-scripting-package.dto.ts`, `packages/server/src/scripting-packages/scripting-packages.service.ts`, `packages/server/src/scripting-packages/scripting-packages.controller.ts`, `frontend/src/api/services/scripting-packages.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`, `packages/server/src/scripting-packages/scripting-packages.controller.spec.ts`

**Interfaces:**
- Produces: `UpdateScriptingPackagePayload = Partial<Omit<CreateScriptingPackagePayload, 'slug'>> & { enabled?: boolean; slug?: string; confirmSlugRename?: boolean }`; `UpdateScriptingPackageDto.slug?`, `.confirmSlugRename?`; `checkSlugAvailability(slug: string, roomId?: number, excludeId?: number)`; `checkPackageSlugAvailability(slug: string, roomId?: number, excludeId?: number)`; query-параметр `excludeId`.
- Consumes: `PackageSlugAvailability` из задачи 1.

- [ ] **Step 1: Тесты**

```ts
it('does not count the excluded package as the owner of its own slug', async () => {
  packagesRepository.findOne.mockResolvedValue({ id: 5, slug: 'hero' });
  await expect(service.checkSlugAvailability('hero', 3, 5)).resolves.toEqual({
    slug: 'hero', available: true, global: { available: false, reason: 'taken' },
  });
});

it('passes slug and confirmSlugRename to the service', async () => {
  await controller.update(5, { slug: 'hero2', confirmSlugRename: true }, { user } as never);
  expect(update).toHaveBeenCalledWith(5, { slug: 'hero2', confirmSlugRename: true });
});

it('passes excludeId from the query', async () => {
  await controller.slugAvailability('hero', 3, 5);
  expect(check).toHaveBeenCalledWith('hero', 3, 5);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter server exec jest scripting-packages.service scripting-packages.controller`
Expected: FAIL — лишние аргументы и отсутствующие поля.

- [ ] **Step 3: Реализовать контракт**

Shared-тип дополнить двумя полями (пересечение, а не замена `Omit`, чтобы `slug` появился только в update). В DTO:

```ts
@IsOptional() @IsString() slug?: string;              // нормализует сервис: invalid_slug
@IsOptional() @IsBoolean() confirmSlugRename?: boolean;
```

`checkSlugAvailability`: при `excludeId !== undefined` в оба `findOne` добавить `id: Not(excludeId)` (для room-запроса — вместе с `room: { id: roomId }`). Контроллер: `@Query('excludeId', new ParseIntPipe({ optional: true })) excludeId?: number` и передать третьим аргументом. Фронтенд-сервис: третий параметр и включение его в query только когда он задан.

- [ ] **Step 4: Запустить тесты и типы**

Run: `pnpm --filter server exec jest scripting-packages.service scripting-packages.controller`
Run: `pnpm build:shared && pnpm check-types:frontend && pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/server/src frontend/src/api
git commit -m "feat: accept slug and confirmSlugRename in package updates"
```

---

### Task 6: Переименование slug на сервере

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`, `packages/server/src/scripting-packages/scripting-packages.module.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`

**Interfaces:**
- Consumes: `rewriteSlugReferences` (задача 2), `PackagePublishLockService.runWithPublishLocks` (задача 3), `delivery.invalidatePackage` / `dispatcher.packagesChanged` (задача 4), `dto.slug` / `dto.confirmSlugRename` (задача 5).
- Produces: поведение `PATCH :id` с `slug`; коды ошибок `invalid_slug`, `slug_taken`, `slug_in_use_by_dependents` (+`reason:'dependents'`), `slug_not_editable`, `slug_rewrite_failed`.

- [ ] **Step 1: Написать падающие тесты переименования**

В `scripting-packages.service.spec.ts` (моки: `storage.rewriteRevision/finishRewrite/abortRewrite`, `delivery.findDependentRoomPackages/invalidatePackage`, `dispatcher.packagesChanged`, `revisionsRepository.find`, `packagesRepository.manager.transaction` = «выполнить колбэк с тем же репозиторием»):

```ts
it('renames a room package and rewrites its published revisions', async () => {
  const updated = await service.update(5, { slug: 'hero2' });
  expect(updated.slug).toBe('hero2');
  expect(storage.rewriteRevision).toHaveBeenCalledWith(5, 1, 'published', expect.any(Function));
  expect(delivery.invalidatePackage).toHaveBeenCalledWith(5);
  expect(dispatcher.packagesChanged).toHaveBeenCalledWith([5]);
});

it('rewrites published revisions of dependents after confirmation', async () => {
  delivery.findDependentRoomPackages.mockResolvedValue([{ packageId: 9, roomId: 3, revision: 2 }]);
  await expect(service.update(5, { slug: 'hero2' })).rejects.toMatchObject({
    response: { code: 'slug_in_use_by_dependents', reason: 'dependents',
      dependents: [{ packageId: 9, name: 'Level' }] },
  });
  expect(storage.rewriteRevision).not.toHaveBeenCalled();

  await service.update(5, { slug: 'hero2', confirmSlugRename: true, name: 'Hero' });
  expect(storage.rewriteRevision).toHaveBeenCalledWith(9, 1, 'published', expect.any(Function));
  expect(dispatcher.packagesChanged).toHaveBeenCalledWith([5, 9]);
});

it('refuses to rename a global package', async () => {
  packagesRepository.findOne.mockResolvedValue({ id: 5, slug: 'hero', room: null });
  await expect(service.update(5, { slug: 'hero2' })).rejects.toMatchObject({
    response: { code: 'slug_not_editable' },
  });
});

it('does not save anything when the target slug is taken', async () => {
  await expect(service.update(5, { slug: 'taken', name: 'New' })).rejects.toMatchObject({
    response: { code: 'slug_taken' },
  });
  expect(packagesRepository.save).not.toHaveBeenCalled();
  expect(storage.rewriteRevision).not.toHaveBeenCalled();
});

it('is a no-op when the slug did not change', async () => {
  await service.update(5, { slug: 'hero', name: 'New' });
  expect(storage.rewriteRevision).not.toHaveBeenCalled();
  expect(packagesRepository.save).toHaveBeenCalled();
});

it('renames a package whose draft was never uploaded', async () => {
  revisionsRepository.find.mockResolvedValue([
    { id: 11, revision: 2, status: 'draft', files: [{ filepath: 'a.gd', size: 1, sha256: 'x' }] },
  ]);
  storage.rewriteRevision.mockResolvedValue(null);
  await expect(service.update(5, { slug: 'hero2' })).resolves.toMatchObject({ slug: 'hero2' });
  expect(storage.rewriteRevision).toHaveBeenCalledWith(5, 2, 'draft', expect.any(Function));
  expect(storage.abortRewrite).not.toHaveBeenCalled();
});

it('renames a package without any revisions', async () => {
  revisionsRepository.find.mockResolvedValue([]);
  await expect(service.update(5, { slug: 'hero2' })).resolves.toMatchObject({ slug: 'hero2' });
  expect(storage.rewriteRevision).not.toHaveBeenCalled();
  expect(dispatcher.packagesChanged).not.toHaveBeenCalled();
});

it('allows a room slug that is already used by a workshop record', async () => {
  packagesRepository.manager.transaction.mockImplementation(async (run) => run(manager));
  await service.update(5, { slug: 'taken' }); // «taken» есть только глобально
  expect(packagesRepository.manager.query).not.toHaveBeenCalledWith(
    expect.stringContaining('global'), expect.anything(),
  );
  expect(packagesRepository.save).toHaveBeenCalled();
});

it('takes the two slug locks in lexicographic order', async () => {
  await service.update(5, { slug: 'aaa' });
  expect(manager.query.mock.calls.map(([, params]) => params[0])).toEqual([
    'package_slug:room:3:aaa', 'package_slug:room:3:hero',
  ]);
});

it('rolls the bytes back and reports slug_rewrite_failed', async () => {
  storage.rewriteRevision.mockRejectedValueOnce(new Error('disk'));
  await expect(service.update(5, { slug: 'hero2' })).rejects.toMatchObject({
    response: { code: 'slug_rewrite_failed' },
  });
  expect(packagesRepository.save).not.toHaveBeenCalled();
});

it('saves metadata in the same update as a confirmed rename', async () => {
  await service.update(5, { slug: 'hero2', name: 'H', version: '2.0', description: 'd', tags: ['a'] });
  const saved = packagesRepository.save.mock.calls[0][0];
  expect(saved).toMatchObject({ slug: 'hero2', name: 'H', version: '2.0', description: 'd', tags: ['a'] });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: FAIL — переименование не реализовано.

- [ ] **Step 3: Разделить `update` на два пути**

```ts
async update(id: number, dto: UpdateScriptingPackageDto): Promise<ScriptingPackage> {
  const pkg = await this.findOne(id);
  if (dto.slug !== undefined) {
    const next = this.normalizeSlug(dto.slug);
    if (next !== pkg.slug) return this.renameSlug(pkg, next, dto);
  }
  return this.applyUpdate(pkg, dto);
}
```

`applyUpdate(pkg, dto)` — текущее тело `update` (parentPackage, поля, enabled, save, dispatch, `findOne`). `normalizeSlug` вызывается до `findOne`? Нет: сначала `findOne`, чтобы 404 не превращался в 400 — порядок как выше.

Общий код путей вынести в один приватный метод, чтобы метаданные применялись одинаково:

```ts
/** Всё, что `applyUpdate` делает до сохранения: parentPackage, поля, enabled. */
private async preparePackageUpdate(
  pkg: ScriptingPackage,
  dto: UpdateScriptingPackageDto,
): Promise<boolean> /* вернул ли enabled изменившимся */ { ... }
```

`applyUpdate` = `preparePackageUpdate` + `save` + условный `packageEnabledChanged` + `findOne`. `renameSlug` вызывает `preparePackageUpdate` перед `save` внутри транзакции и повторяет `packageEnabledChanged` после коммита тем же условием. `slug` в `preparePackageUpdate` не присваивается.

- [ ] **Step 4: Реализовать `renameSlug`**

```ts
private async renameSlug(
  pkg: ScriptingPackage,
  nextSlug: string,
  dto: UpdateScriptingPackageDto,
): Promise<ScriptingPackage> {
  if (!pkg.room) {
    throw new BadRequestException({ code: 'slug_not_editable',
      message: 'Slug пакета workshop нельзя изменить: создайте новую запись' });
  }
  const roomId = pkg.room.id;
  const oldSlug = pkg.slug ?? String(pkg.id);
  const scope = `room:${roomId}`;
  const lockKeys = [`package_slug:${scope}:${oldSlug}`, `package_slug:${scope}:${nextSlug}`].sort();
  const prepared: Array<{ packageId: number; revision: number; kind: RevisionKind }> = [];
  let rewrittenIds: number[] = [];
  let enabledChanged = false;

  try {
    await this.packagesRepository.manager.transaction(async (manager) => {
      for (const key of lockKeys) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      }
      const live = await manager.getRepository(ScriptingPackage).findOne({
        where: { slug: nextSlug, room: { id: roomId } },
      });
      if (live && live.id !== pkg.id) {
        throw new ConflictException({ code: 'slug_taken', slug: nextSlug, message: 'Slug уже занят' });
      }
      const dependents = (await this.delivery?.findDependentRoomPackages(pkg.id)) ?? [];
      if (dependents.length > 0 && dto.confirmSlugRename !== true) {
        const rows = await manager.getRepository(ScriptingPackage).find({
          where: { id: In(dependents.map((d) => d.packageId)) },
        });
        throw new ConflictException({
          code: 'slug_in_use_by_dependents', reason: 'dependents',
          message: 'На пакет ссылаются другие пакеты',
          dependents: rows.map((row) => ({ packageId: row.id, name: row.name }))
            .sort((a, b) => a.packageId - b.packageId),
        });
      }

      await this.locks.runWithPublishLocks(
        [pkg.id, ...dependents.map((d) => d.packageId)],
        async () => {
          const revisions = manager.getRepository(ScriptingPackageRevision);
          const targets: Array<{ packageId: number; revision: number; kind: RevisionKind }> = [];
          for (const row of await revisions.find({ where: { package: { id: pkg.id } } })) {
            if (row.status === 'published') targets.push({ packageId: pkg.id, revision: row.revision, kind: 'published' });
            if (row.status === 'draft') targets.push({ packageId: pkg.id, revision: row.revision, kind: 'draft' });
          }
          for (const dependent of dependents) {
            for (const row of await revisions.find({
              where: { package: { id: dependent.packageId }, status: 'published' },
            })) {
              targets.push({ packageId: dependent.packageId, revision: row.revision, kind: 'published' });
            }
          }

          const transform = (filepath: string, data: Buffer) =>
            rewriteSlugReferences(filepath, data, oldSlug, nextSlug);
          const rewritten: Array<{ id: number; files: PackageFileEntry[] }> = [];
          for (const target of targets) {
            const files = await this.storage!.rewriteRevision(
              target.packageId, target.revision, target.kind, transform,
            );
            prepared.push(target);
            if (files) {
              const row = await revisions.findOneOrFail({
                where: { package: { id: target.packageId }, revision: target.revision },
              });
              if (target.kind === 'published') rewritten.push({ id: row.id, files });
            }
          }

          const changedEnabled = await this.preparePackageUpdate(pkg, dto);
          pkg.slug = nextSlug;
          await manager.getRepository(ScriptingPackage).save(pkg);
          for (const row of rewritten) {
            await manager.getRepository(ScriptingPackageRevision)
              .update({ id: row.id }, { files: row.files });
          }
          rewrittenIds = [...new Set(targets.map((t) => t.packageId))].sort((a, b) => a - b);
          enabledChanged = changedEnabled;
        },
      );
    });
  } catch (error) {
    for (const target of prepared.reverse()) {
      await this.storage?.abortRewrite(target.packageId, target.revision, target.kind)
        .catch((cause) => this.logger.warn(`rewrite abort failed: ${String(cause)}`));
    }
    if (error instanceof HttpException) throw error;
    this.logger.error(`Package ${pkg.id} slug rewrite failed: ${String(error)}`);
    throw new InternalServerErrorException({ code: 'slug_rewrite_failed',
      message: 'Не удалось переписать ссылки на пакет' });
  }

  for (const target of prepared) {
    await this.storage?.finishRewrite(target.packageId, target.revision, target.kind)
      .catch((cause) => this.logger.warn(`rewrite cleanup failed: ${String(cause)}`));
  }
  for (const packageId of rewrittenIds) {
    await this.delivery?.invalidatePackage(packageId)
      .catch((cause) => this.logger.warn(`artifact invalidation failed: ${String(cause)}`));
  }
  if (rewrittenIds.length > 0) {
    try {
      await this.dispatcher?.packagesChanged(rewrittenIds);
    } catch (cause) {
      this.logger.warn(`Package ${pkg.id} was renamed but its room was not notified: ${String(cause)}`);
    }
  }
  if (enabledChanged) {
    try {
      await this.dispatcher?.packageEnabledChanged(pkg.id);
    } catch (cause) {
      this.logger.warn(`Package ${pkg.id} was renamed but its room was not notified: ${String(cause)}`);
    }
  }
  return this.findOne(pkg.id);
}
```

Детали, которые нельзя оставить на догадку:
- `enabledChanged` объявить рядом с `prepared` (`let enabledChanged = false;`) и присвоить внутри транзакции.
- `.finishRewrite` вызывается для каждого элемента `prepared` после успешного коммита; ошибки только логируются.
- `In` и `HttpException` импортировать при необходимости; `RevisionKind` и `rewriteSlugReferences` — из задач 2; `this.locks` — новая инъекция `PackagePublishLockService` в конструктор (после `delivery`, `@Optional()` не нужен: модуль его предоставляет).
- Порядок `save` и `update`: сохранение пакета и `files` ревизий — в одной транзакции; `dispatcher`/`invalidate` — после неё.

- [ ] **Step 5: Зарегистрировать провайдер**

В `scripting-packages.module.ts` добавить `PackagePublishLockService` в `providers` и `exports`.

- [ ] **Step 6: Запустить тесты**

Run: `pnpm --filter server exec jest scripting-packages.service package-publish-lock`
Run: `pnpm --filter server test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): rename package slugs with reference rewriting"
```

---

### Task 7: Операция `rename` в мосте редактора

**Files:**
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd`, `packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd`, `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.ts`
- Test: `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.test.ts`

**Interfaces:**
- Produces: `PackageFileSystem.renamePackage(from: string, to: string): Promise<string[]>` (переписанные относительные пути); операция моста `"rename"` с параметрами `{ packageSlug, newSlug }`, ответ `{ rewritten: string[] }` или `{ error }`.
- Consumes: `_invalid_slug`, `_list_files`, `_remove_tree`, `is_valid_slug`, `package_dir`, `sync()`.

- [ ] **Step 1: Написать падающий тест обёртки**

```ts
it('renames a package directory through the bridge and syncs', async () => {
  bridge.call.mockResolvedValue({ rewritten: ['a.gd'] });
  await expect(files.renamePackage('hero', 'hero2')).resolves.toEqual(['a.gd']);
  expect(bridge.call).toHaveBeenCalledWith('rename', { packageSlug: 'hero', newSlug: 'hero2' });
  expect(bridge.call).toHaveBeenCalledWith('sync', {});
  expect(bridge.call).not.toHaveBeenCalledWith('rescan', expect.anything());
});

it('rejects invalid slugs before calling the bridge', async () => {
  await expect(files.renamePackage('Hero', 'hero2')).rejects.toThrow();
  expect(bridge.call).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs`
Expected: FAIL — `renamePackage` нет в типе.

- [ ] **Step 3: Реализовать `op_rename` в GDScript**

Добавить в `package_fs.gd` рядом с другими операциями:

```gdscript
## Moves a package directory to a new slug and rewrites the slug in its text
## files. `collect`/`replace` cannot do this: they drop `*.uid`/`*.import`.
static func op_rename(package_slug: String, new_slug: String) -> Dictionary:
	var invalid := _invalid_slug(package_slug)
	if invalid.is_empty():
		invalid = _invalid_slug(new_slug)
	if not invalid.is_empty():
		return {"error": invalid}
	if package_slug == new_slug:
		return {"rewritten": []}
	var old_dir := package_dir(package_slug)
	var new_dir := package_dir(new_slug)
	if not DirAccess.dir_exists_absolute(old_dir):
		return {"error": "slug_source_missing"}
	if DirAccess.dir_exists_absolute(new_dir):
		if not _list_files(new_dir).is_empty():
			return {"error": "slug_target_not_empty"}
		var remove_error := _remove_tree(new_dir)
		if remove_error != OK:
			return {"error": "не удалось удалить пустой каталог %s: %s" % [new_slug, error_string(remove_error)]}
	var rename_error := DirAccess.rename_absolute(old_dir, new_dir)
	if rename_error != OK:
		return {"error": "не удалось переименовать пакет %s: %s" % [package_slug, error_string(rename_error)]}

	var rewritten: Array[String] = []
	var from_prefix := "res://packages/%s/" % package_slug
	var to_prefix := "res://packages/%s/" % new_slug
	for rel_path: String in _list_files(new_dir):
		if not SLUG_REWRITE_EXTENSIONS.has(rel_path.get_extension()):
			continue
		var abs_path := new_dir.path_join(rel_path)
		var text := FileAccess.get_file_as_string(abs_path)
		if not text.contains(from_prefix):
			continue
		var file := FileAccess.open(abs_path, FileAccess.WRITE)
		if file == null:
			return {"error": "не удалось записать %s: %s" % [abs_path, error_string(FileAccess.get_open_error())]}
		file.store_string(text.replace(from_prefix, to_prefix))
		file.close()
		rewritten.append(rel_path)
	return {"rewritten": rewritten}
```

`SLUG_REWRITE_EXTENSIONS` объявить константой массива в начале файла: `const SLUG_REWRITE_EXTENSIONS := [".gd", ".tscn", ".tres", ".import"]` (Array.has, не Set).

- [ ] **Step 4: Зарегистрировать операцию**

В `plugin.gd`: добавить `"rename"` в `VALID_OPS` и ветку в `match`:

```gdscript
		"rename":
			var raw_new_slug: Variant = params.get("newSlug", "")
			if not raw_new_slug is String:
				_respond_error(request_id, "некорректный newSlug")
				return
			result = WiredPackageFs.op_rename(package_slug, str(raw_new_slug))
```

- [ ] **Step 5: Реализовать обёртку**

В `godot-packages-fs.ts`: добавить в тип `PackageFileSystem` метод `renamePackage(from: string, to: string): Promise<string[]>` и реализацию:

```ts
async renamePackage(from, to) {
  assertPackageSlug(from);
  assertPackageSlug(to);
  const { rewritten } = await bridge.call<{ rewritten: string[] }>("rename", {
    packageSlug: from,
    newSlug: to,
  });
  await sync();
  return rewritten;
},
```

- [ ] **Step 6: Запустить тесты и типы**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs`
Run: `pnpm check-types:frontend`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app packages/server/godot_project
git commit -m "feat(editor): rename package directories through the bridge"
```

---

### Task 8: Оркестрация переименования в `use-room-packages`

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`, `frontend/src/app/room/[room_code]/(godot)/packages.ts` (если здесь лежит тип `RoomPackageEntry`; иначе файл, где он объявлен — найти через `grep -n "RoomPackageEntry" frontend/src`)
- Test: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx`

**Interfaces:**
- Produces:
  - `RoomPackageEntry.description: string`, `.tags: string[]`
  - `RoomPackagesController.checkSlugAvailability(slug: string, targetRoomId?: number, excludeId?: number)`
  - `RoomPackagesController.updatePackageMetadata(packageId: number, patch: { name?: string; version?: string; slug?: string; description?: string; tags?: string[]; confirmSlugRename?: boolean }): Promise<ScriptingPackage>`
  - `RoomPackagesController.isPackageDirOccupied(slug: string): Promise<boolean>`
  - `RoomPackagesController.renamePackageDir(packageId: number, fromSlug: string, toSlug: string): Promise<void>`
  - `class SlugRenameDependentsError extends Error { dependents: Array<{ packageId: number; name: string }> }`
  - `class PackageDirectoryRenameError extends Error { packageId: number; fromSlug: string; toSlug: string }`
- Consumes: `renamePackage` (задача 7), `excludeId` (задача 5).

- [ ] **Step 1: Тесты**

```ts
it('renames the editor directory after a slug change and refreshes', async () => {
  await act(() => controller.updatePackageMetadata(5, { slug: 'hero2' }));
  expect(updateScriptingPackage).toHaveBeenCalledWith(5, { slug: 'hero2' });
  expect(files.renamePackage).toHaveBeenCalledWith('hero', 'hero2');
  expect(files.snapshot).toHaveBeenCalledWith('hero2'); // refresh идёт уже по новому slug
  expect(requestEditorRescan).toHaveBeenCalled();
});

it('keeps the baseline so the package does not show local changes', async () => {
  // baseline загружен, snapshot после переименования совпадает по путям/хешам
  expect(entry().status).toBe('loaded');
});

it('surfaces dependents so the dialog can confirm', async () => {
  updateScriptingPackage.mockRejectedValueOnce(apiError(409, {
    code: 'slug_in_use_by_dependents', reason: 'dependents',
    dependents: [{ packageId: 9, name: 'Level' }],
  }));
  await expect(controller.updatePackageMetadata(5, { slug: 'hero2' }))
    .rejects.toBeInstanceOf(SlugRenameDependentsError);
});

it('keeps the server rename when the directory move fails and retries idempotently', async () => {
  files.renamePackage.mockRejectedValueOnce(new Error('bridge'));
  await expect(controller.updatePackageMetadata(5, { slug: 'hero2' }))
    .rejects.toBeInstanceOf(PackageDirectoryRenameError);
  expect(updateScriptingPackage).toHaveBeenCalledTimes(1); // сервер не откатывается
  await controller.renamePackageDir(5, 'hero', 'hero2');
  expect(files.renamePackage).toHaveBeenCalledTimes(2);
});

it('refuses a slug whose folder already has files', async () => {
  files.exists.mockResolvedValue(true);
  files.snapshot.mockResolvedValue({ 'a.gd': 'hash' });
  await expect(controller.updatePackageMetadata(5, { slug: 'hero2' }))
    .rejects.toThrow('slug_dir_exists');
  expect(updateScriptingPackage).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: FAIL.

- [ ] **Step 3: Расширить `RoomPackageEntry` и reducer**

В `buildEntries` добавить `description: pkg.description`, `tags: pkg.tags ?? []`; в `case "updated"` копировать их вместе с `slug/name/version`. Проверить, что `packageFromStatus` уже отдаёт `description: ""`, `tags: []`.

- [ ] **Step 4: Реализовать оркестрацию**

`updatePackageMetadata`:
1. Нормализовать поля: `name`/`version`/`slug` — trim и непустые (`package_metadata_empty`), `description` — trim (может быть пустым), `tags` — как пришли; если ничего не задано — `package_metadata_empty`.
2. `const previousSlug = slugOf(packageId); const renaming = patch.slug !== undefined && patch.slug !== previousSlug;`
3. Если `renaming`: `if (await isPackageDirOccupied(patch.slug!)) throw new Error("slug_dir_exists")`.
4. `updateScriptingPackage(packageId, {...payload, confirmSlugRename})`; при ошибке с `code === 'slug_in_use_by_dependents'` бросить `SlugRenameDependentsError(dependents)`, иначе — `setAction` + `Error("Не удалось изменить данные пакета: ...")` как сейчас.
5. `dispatch({ type: "updated", package: updated }); createdSlugsRef.current.set(packageId, updated.slug);`
6. Если `renaming`: `requestEditorRescan()`; если `files.exists(previousSlug)` — `await files.renamePackage(previousSlug, updated.slug)`; ошибку обернуть в `PackageDirectoryRenameError` (кроме `EditorBridgeError` — его пробросить).
7. `setAction(packageId, { error: null }); await refresh(); return updated;`

`isPackageDirOccupied(slug)`: `!files` → `false`; `!(await files.exists(slug))` → `false`; иначе `Object.keys(await files.snapshot(slug)).length > 0`.

`renamePackageDir(packageId, fromSlug, toSlug)`: при наличии FS — если `!exists(toSlug)` и `exists(fromSlug)`, вызвать `renamePackage(fromSlug, toSlug)`; затем `requestEditorRescan()` и `await refresh()`. `packageId` участвует только в `setAction`.

`createPackage`: перенести `requireFileSystem` до запроса и добавить проверку занятости:

```ts
if (await occupiedByFiles(files, trimmedSlug)) {
  throw new Error(`В редакторе уже есть папка с slug ${trimmedSlug}; переименуйте или удалите её`);
}
```

- [ ] **Step 5: Запустить тесты**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app
git commit -m "feat(frontend): rename package directory after a slug change"
```

---

### Task 9: Диалог «Редактировать пакет» и read-only карточка

**Files:**
- Create: `frontend/src/app/room/[room_code]/(godot)/package-edit-dialog.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`
- Test: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`

**Interfaces:**
- Consumes: `packages.updatePackageMetadata`, `.checkSlugAvailability`, `.isPackageDirOccupied`, `.renamePackageDir`, `SlugRenameDependentsError`, `PackageDirectoryRenameError`, `SLUG_PATTERN`/`SLUG_MAX_LENGTH`/`SLUG_HINT`/`SlugCheckState`/`isSlugValid`/`slugHintClass`, `parseTags` (экспортировать из `workshop-dialogs.tsx`), `getScriptingPackage`.
- Produces: `<PackageEditDialog open onOpenChange entry packages />`.

- [ ] **Step 1: Тесты диалога**

```ts
it('opens from the card menu and saves every field', async () => {
  render(<PackagesTab ... />);
  await user.click(screen.getByRole('button', { name: 'Действия с пакетом' }));
  await user.click(screen.getByRole('menuitem', { name: 'Редактировать пакет' }));
  await user.clear(screen.getByLabelText('Slug'));
  await user.type(screen.getByLabelText('Slug'), 'hero2');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(updatePackageMetadata).toHaveBeenCalledWith(5, {
    name: 'Hero', version: '1.0', slug: 'hero2', description: 'desc', tags: ['a', 'b'],
  });
});

it('shows dependents and repeats the request with confirmation', async () => {
  updatePackageMetadata.mockRejectedValueOnce(
    new SlugRenameDependentsError([{ packageId: 9, name: 'Level' }]),
  );
  // открыть, поменять slug, сохранить
  expect(await screen.findByText('Level')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Переименовать и обновить ссылки' }));
  expect(updatePackageMetadata).toHaveBeenLastCalledWith(5, expect.objectContaining({
    slug: 'hero2', confirmSlugRename: true,
  }));
});

it('offers a retry when only the editor directory rename failed', async () => {
  updatePackageMetadata.mockRejectedValueOnce(
    new PackageDirectoryRenameError(5, 'hero', 'hero2'),
  );
  await user.click(await screen.findByRole('button', { name: 'Повторить переименование папки' }));
  expect(renamePackageDir).toHaveBeenCalledWith(5, 'hero', 'hero2');
});

it('shows the card metadata read-only', () => {
  expect(screen.queryByRole('button', { name: /изменить имя/i })).not.toBeInTheDocument();
  expect(screen.getByText('desc')).toBeInTheDocument();
  expect(screen.getByText('#hero')).toBeInTheDocument();
});

it('hints that a workshop slug is taken without blocking creation', async () => {
  // availability: { available: true, global: { available: false, reason: 'taken' } }
  expect(await screen.findByText(/при публикации будет предложен fork/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Создать пакет' })).toBeEnabled();
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: FAIL.

- [ ] **Step 3: Реализовать `PackageEditDialog`**

Состояние: `name/version/slug/description/tags`, `detailsState: 'loading'|'ready'|'error'`, `slugState: SlugCheckState`, `slugCheckAttempt`, `dependents: Array<{packageId,name}> | null`, `dirError: boolean`, `submitting`, `error`.

- При открытии: поля из `entry` (name/version/slug/description/tags), `dependents=null`, `dirError=false`; `getScriptingPackage(entry.packageId)` подтягивает description/tags (при ошибке — `detailsState='error'`, сохранение заблокировано, кнопка «Повторить»).
- Проверка slug: без запроса, если `slug === entry.slug` → `available`; иначе debounce `SLUG_CHECK_DEBOUNCE_MS` и `packages.checkSlugAvailability(slug, undefined, entry.packageId)`.
- Сохранение разрешено при `detailsState==='ready'`, `slugState==='available'`, непустых имени/версии.
- Submit: `packages.updatePackageMetadata(packageId, { name, version, slug, description, tags: parseTags(tags), ...(dependents ? { confirmSlugRename: true } : {}) })`; `onOpenChange(false)` при успехе; `SlugRenameDependentsError` → `setDependents(error.dependents)` и не закрывать; `PackageDirectoryRenameError` → `setDirError(true)` с кнопкой «Повторить переименование папки» (`renamePackageDir`) и текстом «Сервер уже переименован, папка в редакторе — нет»; прочее → `setError(message)`.
- Подсказка §7.6 внизу: «Публикация под новым slug создаст новую запись в workshop; старая останется, пока её не удалят.»

- [ ] **Step 4: Сделать карточку read-only и добавить пункт меню**

`PackageCard`: убрать `MetadataField` и компонент целиком; вывести `{entry.name}`, `{entry.version}`, `#{entry.slug}`, описание и теги (`entry.tags.join(", ")`, если непусто). Новый prop `onEdit`; перед «Опубликовать в workshop» добавить:

```tsx
<DropdownMenuItem disabled={disabled} onSelect={() => onEdit(entry)}>
  <PencilIcon className="size-4" />
  Редактировать пакет
</DropdownMenuItem>
```

В `PackagesTab`: `const [editEntry, setEditEntry] = React.useState<RoomPackageEntry | null>(null)` и `<PackageEditDialog open={editEntry !== null} entry={editEntry} packages={packages} onOpenChange={(open) => { if (!open) setEditEntry(null); }} />`.

- [ ] **Step 5: Запустить тесты и типы**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Run: `pnpm check-types:frontend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app
git commit -m "feat(frontend): edit package metadata in a dedicated dialog"
```

---

### Task 10: Публикация как предпросмотр

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/workshop-dialogs.tsx`, `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`
- Test: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`

**Interfaces:**
- Consumes: `entry.description`/`entry.tags` (задача 8), `getScriptingPackage`, `lookupWorkshopPackage`, `packages.publishToWorkshop(packageId)` без метаданных.
- Produces: обновлённый `WorkshopPublishDialog` без полей ввода; неблокирующая подсказка про занятый глобальный slug в диалоге создания.

- [ ] **Step 1: Тесты**

```ts
it('publishes without editing metadata', async () => {
  await user.click(screen.getByRole('menuitem', { name: 'Опубликовать в workshop' }));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Опубликовать' }));
  expect(publishToWorkshop).toHaveBeenCalledWith(5);
});
```

Плюс тест подсказки из задачи 9 (если он уже написан — не дублировать).

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: FAIL — в диалоге есть поля.

- [ ] **Step 3: Переписать `WorkshopPublishDialog` в предпросмотр**

Удалить `name/version/description/tags`, `editedRef`, `prefillPending` и `parseTags`-вызов. Оставить `lookup`, `existing`, `submitting`, `error`. При открытии: `lookupWorkshopPackage(slug)` + `getScriptingPackage(packageId)` (только для показа description/tags). Рендер: строки «Название / Slug / Версия / Описание / Теги» как текст. Submit: `await packages.publishToWorkshop(entry.packageId)`; `WorkshopSlugTakenError` обрабатывать как сейчас (показать fork-кнопку). `parseTags` оставить экспортированной — её использует диалог редактирования.

- [ ] **Step 4: Добавить подсказку про глобальный slug при создании**

В `PackagesTab` хранить `globalTaken` рядом с `slugState` (установить из `result.global.available === false` в эффекте проверки, сбрасывать при смене slug). Под полем slug, когда `slugState === 'available' && globalTaken`, вывести:

```tsx
<p className="text-xs text-muted-foreground">
  Slug занят в workshop — при публикации будет предложен fork.
</p>
```

`canCreate` от `globalTaken` не зависит.

- [ ] **Step 5: Запустить тесты**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app
git commit -m "feat(frontend): turn workshop publishing into a read-only preview"
```

---

### Task 11: Документация и финальные проверки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-02-package-slug-design.md`, `docs/superpowers/specs/2026-11-03-package-workshop-design.md`
- Test: полный прогон

**Interfaces:**
- Consumes: всё предыдущее.

- [ ] **Step 1: Пометить старые спеки**

В начало обоих файлов (после заголовка) добавить строку:

```markdown
> Частично отменён: см. `2026-11-03-package-metadata-and-slug-editing-design.md`
> (tombstone удалён, slug редактируется, метаданные вынесены из панели публикации).
```

- [ ] **Step 2: Полный прогон сервера**

Run: `pnpm --filter server test`
Run: `pnpm --filter server check-types`
Run: `pnpm --filter server lint`
Expected: тесты и типы зелёные; в lint нет новых ошибок (существующий шум `--fix` по спекам допустим, сверить с `git stash`-базой при сомнении).

- [ ] **Step 3: Полный прогон фронтенда**

Run: `pnpm --filter frontend test`
Run: `pnpm check-types:frontend`
Run: `pnpm --filter frontend lint`
Expected: тесты и типы зелёные; lint красный только на 7 ранее известных ошибках в нетронутых файлах.

- [ ] **Step 4: Сборка**

Run: `pnpm build:shared && pnpm --filter server build && pnpm --filter frontend build`
Expected: exit 0.

- [ ] **Step 5: Ручная проверка (обязательна — GDScript не покрыт юнит-тестами)**

1. Создать пакет, опубликовать (Emit), переименовать slug → папка в редакторе переименована, `res://packages/<new>/...` открываются, статус без «локальных изменений».
2. Переименовать пакет, на который ссылается другой пакет → предупреждение со списком; отмена оставляет всё как было; подтверждение переписывает ссылки, зависимый пакет продолжает работать в Game.
3. Удалить запись workshop и опубликовать пакет с тем же slug → публикация проходит (кейс `example_package`).
4. Открыть вкладку Game до и после переименования → рантайм подхватывает новый slug; артефакт пересобирается.
5. Создать пакет, у которого в редакторе уже есть непустая папка с этим slug → создание блокируется понятным сообщением.

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: note the superseded slug and workshop rules"
```
