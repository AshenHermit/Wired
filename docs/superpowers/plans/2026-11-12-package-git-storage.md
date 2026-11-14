# Git-хранилище пакетов: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить хранение опубликованных ревизий пакетов с полных каталогов на bare-репозиторий git на пакет, с дедупликацией блобов и инкрементальной загрузкой, не меняя публичный API и номера ревизий.

**Architecture:** Каждый пакет получает `<packagesFilesDir>/<packageId>/repo.git` (SHA-256). Публикация складывает staged-файлы в блобы, собирает дерево через временный index, создаёт коммит с `refs/pending/publish/<n>`, фиксирует строку в БД, затем одной транзакцией `update-ref` ставит тег `refs/tags/revisions/<n>`, двигает `main` и удаляет pending. Чтение идёт по `commitSha` (с откатом на тег и legacy-каталог) через `cat-file --batch`. Существующие пакеты конвертируются лениво при первой записи или CLI.

**Tech Stack:** NestJS 11, TypeORM/Postgres, Node 22 (`node:child_process`, `node:fs/promises`), системный git ≥ 2.29, Jest, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-package-git-storage-design.md`

## Global Constraints

- Node ≥ 22, TypeScript strict; серверный Prettier: одинарные кавычки, trailing comma.
- Новых зависимостей нет: git вызывается через `node:child_process`, объекты — через plumbing.
- Git ≥ 2.29 и `--object-format=sha256`; проверка версии на старте при включённом флаге.
- `DB_SYNC=1` без миграций: изменение схемы только аддитивное и nullable — одна колонка `commitSha varchar(64) NULL`.
- Лимиты пакета неизменны: 2000 файлов, 64 MiB на файл, 256 MiB на ревизию.
- Никакого checkout/archive/`git apply`; только plumbing, аргументы массивом.
- Серверные пути резолвятся от cwd; в тестах — только временные каталоги через стаб `AppConfigService`.
- Публичные идентификаторы не меняются: `revision` остаётся числом в путях/манифестах; `commitSha` наружу не отдаётся.
- Коммиты — Conventional Commits (`feat(server): …`, `test(server): …`).
- Документация и сообщения об ошибках для пользователя — по-русски, код и идентификаторы — по-английски.

## Review Focus

1. **Вложенные пути.** Дерево с `scripts/player.gd`, `assets/models/x.gltf` должно собираться и читаться без уплощения и без падений `mktree`.
2. **Сбой между pending-ref и коммитом БД.** Публикация и rewrite не должны оставлять сиротские теги, «вечно draft» строки или нечитаемый пакет; после рестарта всё должно доехать.
3. **Пропущенные при загрузке файлы.** Холодный индекс, удалённый-и-возвращённый файл, GC между `createDraft` и `publish` не должны давать частично опубликованную ревизию — только retryable 409.
4. **Гонки публикации/rewrite.** Два процесса на один пакет не должны перетирать теги и собирать артефакт из смешанного замыкания.
5. **Сосуществование legacy и git.** Пакет без `repo.git`, сконвертированный пакет при выключенном флаге и смешанное замыкание должны читаться и публиковаться, а `artifactKey` — не коллидировать.

---

## File Structure

**Создаются:**

- `packages/server/src/scripting-packages/storage/git/git-command.ts` — запуск git: env, таймаут, stdin/stdout, ошибки.
- `packages/server/src/scripting-packages/storage/git/git-command.spec.ts`
- `packages/server/src/scripting-packages/storage/git/package-git-repository.ts` — lifecycle репозитория, блобы, деревья, коммиты, ссылки, чтение, gc/fsck.
- `packages/server/src/scripting-packages/storage/git/package-git-repository.spec.ts`
- `packages/server/src/scripting-packages/storage/git/package-content-index.ts` — производный `sha256 → oid`.
- `packages/server/src/scripting-packages/storage/git/package-content-index.spec.ts`
- `packages/server/src/scripting-packages/storage/git/package-git-types.ts` — `GitAuthor`, `RefUpdate`, ошибки.
- `packages/server/src/scripting-packages/storage/package-git-storage.service.ts` — публикация/чтение/rewrite/migration/GC поверх репозитория и индекса.
- `packages/server/src/scripting-packages/storage/package-git-storage.service.spec.ts`
- `packages/server/src/scripting-packages/publish/package-git-reconcile.service.ts` — миринг pending-ссылок и promote draft-строк.
- `packages/server/src/scripting-packages/publish/package-git-reconcile.service.spec.ts`
- `packages/server/src/scripting-packages/publish/package-git-maintenance.service.ts` — плановый GC, fsck, экспорт.
- `packages/server/src/scripting-packages/publish/package-git-maintenance.service.spec.ts`
- `packages/server/src/scripts/packages-git.ts` — CLI `migrate|cleanup|gc|export|repair`.
- `packages/server/src/scripting-packages/testing/git-test-helpers.ts` — временный каталог и стаб конфига (вне `*.spec.ts`, чтобы не ловился Jest).

**Меняются:**

- `packages/server/src/config/config.ts`, `config.interface.ts` — флаг `WIRED_PACKAGE_GIT_STORAGE`.
- `packages/server/src/database/entities/scripting-package-revision.entity.ts` — `commitSha`.
- `packages/server/src/scripting-packages/storage/package-storage.service.ts` — фасад git/legacy, batch-чтение, stream.
- `packages/server/src/scripting-packages/publish/package-revisions.service.ts` — `missing`, publish через git, reconcile, миграция.
- `packages/server/src/scripting-packages/publish/package-closure-resolver.ts` — `commitSha`, batch, ключи артефактов.
- `packages/server/src/scripting-packages/delivery/package-delivery.service.ts` — `v3`, batch-чтение.
- `packages/server/src/scripting-packages/scripting-packages.service.ts` — rewrite через git.
- `packages/server/src/scripting-packages/scripting-packages.controller.ts` — стрим из сервиса.
- `packages/server/src/scripting-packages/scripting-packages.module.ts`, `delivery/package-delivery.module.ts` — провайдеры.
- `packages/shared/src/api/types.ts` — `PackageRevisionDraft`.
- `frontend/src/godot/bridge/package-sync.ts`, `frontend/src/api/services/scripting-packages.ts` — пропуск `missing`.
- `backend.Dockerfile`, `packages/server/package.json`, `AGENTS.md`, `.env.prod.example`.

---

### Task 1: Обёртка над git

**Files:**
- Create: `packages/server/src/scripting-packages/storage/git/git-command.ts`
- Create: `packages/server/src/scripting-packages/storage/git/package-git-types.ts`
- Test: `packages/server/src/scripting-packages/storage/git/git-command.spec.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `GitCommand.run(args: string[], options: GitRunOptions): Promise<Buffer>`, `GitCommand.stream(args: string[], options: GitStreamOptions): Readable`, `GitCommandError` с полями `{ args, code, stderr }`, `GitAuthor = { name: string; email: string }`.

- [ ] **Step 1: Написать падающий тест**

```ts
// git-command.spec.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitCommand, GitCommandError } from './git-command';

describe('GitCommand', () => {
  let dir: string;
  const git = new GitCommand();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wired-git-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs git and returns stdout', async () => {
    const output = await git.run(['--version'], { cwd: dir });
    expect(output.toString()).toMatch(/^git version 2\./);
  });

  it('reports a non-zero exit with stderr', async () => {
    await expect(
      git.run(['rev-parse', '--verify', 'missing-ref'], { cwd: dir }),
    ).rejects.toBeInstanceOf(GitCommandError);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter server exec jest git-command.spec`
Expected: FAIL — `Cannot find module './git-command'`.

- [ ] **Step 3: Реализовать `GitCommand`**

```ts
export type GitRunOptions = {
  cwd: string;
  input?: Buffer | string;
  timeoutMs?: number;
  maxBuffer?: number;
};

export class GitCommand {
  run(args: string[], options: GitRunOptions): Promise<Buffer>;
  stream(args: string[], options: Omit<GitRunOptions, 'maxBuffer'>): Readable;
}
```

`spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })`, где env добавляет
`GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
`GIT_CONFIG_GLOBAL=<пустой файл в os.tmpdir()>`. Таймаут по умолчанию 30 000 мс,
`SIGKILL` по истечении, `maxBuffer` по умолчанию 256 MiB. `GitCommandError`
собирает `args`, `code` и `stderr` (обрезка до 4 KiB) — по нему потом мапятся 503/409.

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `pnpm --filter server exec jest git-command.spec`
Expected: PASS, 2 теста.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage/git/git-command.ts \
        packages/server/src/scripting-packages/storage/git/git-command.spec.ts \
        packages/server/src/scripting-packages/storage/git/package-git-types.ts
git commit -m "feat(server): add git command wrapper for package storage"
```

---

### Task 2: Lifecycle репозитория, флаг конфигурации, колонка `commitSha`

**Files:**
- Create: `packages/server/src/scripting-packages/storage/git/package-git-repository.ts`
- Create: `packages/server/src/scripting-packages/testing/git-test-helpers.ts`
- Modify: `packages/server/src/config/config.interface.ts` (секция `packages`)
- Modify: `packages/server/src/config/config.ts:65-71`
- Modify: `packages/server/src/database/entities/scripting-package-revision.entity.ts:50-53`
- Modify: `packages/server/src/scripting-packages/scripting-packages.module.ts:31-37`
- Modify: `packages/server/src/scripting-packages/delivery/package-delivery.module.ts:26-57`
- Test: `packages/server/src/scripting-packages/storage/git/package-git-repository.spec.ts`

**Interfaces:**
- Consumes: `GitCommand`.
- Produces: `PackageGitRepository` c `repoDir(packageId): string`, `hasRepo(packageId): Promise<boolean>`, `ensureRepo(packageId): Promise<void>`, `version(): Promise<{ major: number; minor: number; patch: number; raw: string }>`; геттер `enabled: boolean` из конфига.

- [ ] **Step 1: Написать падающий тест**

```ts
// package-git-repository.spec.ts
it('creates a bare sha256 repository once', async () => {
  const repo = makeRepository(); // AppConfigService-стаб с tmp packagesFilesDir и gitStorage: true
  await repo.ensureRepo(7);
  await repo.ensureRepo(7);
  const format = await repo.command.run(
    ['config', '--get', 'extensions.objectformat'],
    { cwd: repo.repoDir(7) },
  );
  expect(format.toString().trim()).toBe('sha256');
  const bare = await repo.command.run(['rev-parse', '--is-bare-repository'], {
    cwd: repo.repoDir(7),
  });
  expect(bare.toString().trim()).toBe('true');
  await expect(repo.hasRepo(7)).resolves.toBe(true);
});
```

`makeRepository()` кладётся в `testing/git-test-helpers.ts`: создаёт `mkdtemp`, отдаёт
`{ repo, root, cleanup }`, конфиг-стаб `{ storage: { packagesFilesDir: root }, packages: { gitStorage: true } }`.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter server exec jest package-git-repository.spec`
Expected: FAIL — модуль/класс не существует.

- [ ] **Step 3: Реализовать lifecycle и конфиг**

`config.ts` в `packages` добавляет `gitStorage: process.env.WIRED_PACKAGE_GIT_STORAGE === '1'`
(рядом с `readSecret`/`readTtlSec`). В интерфейс — `gitStorage: boolean`.

`ensureRepo`: `mkdir(packageRoot, {recursive:true})`; если `repo.git` нет —
`git init --bare --object-format=sha256 repo.git`, затем
`git config core.autocrlf false`, `core.symlinks false`, `core.fsmonitor false`,
`gc.auto 0`, `core.hooksPath <packageRoot>/tmp/hooks` (каталог создать).
`hasRepo` — `stat(path.join(packageRoot,'repo.git'))`. `onModuleInit` при
`enabled` проверяет `version()` и бросает `Error` с текстом
`git >= 2.29 is required for package storage` при меньшей версии.

В entity добавить:

```ts
@ApiProperty({ description: 'Commit of the published revision', nullable: true })
@Column({ type: 'varchar', length: 64, nullable: true, default: null })
commitSha: string | null;
```

Зарегистрировать `GitCommand` и `PackageGitRepository` в `ScriptingPackagesModule`
и `PackageDeliveryModule`. `PackageGitStorageService` подключится в Task 6.

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `pnpm --filter server exec jest package-git-repository.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage/git packages/server/src/scripting-packages/testing packages/server/src/config packages/server/src/database/entities/scripting-package-revision.entity.ts packages/server/src/scripting-packages/scripting-packages.module.ts packages/server/src/scripting-packages/delivery/package-delivery.module.ts
git commit -m "feat(server): add per-package bare git repository lifecycle"
```

---

### Task 3: Блобы, деревья и коммиты

**Files:**
- Modify: `packages/server/src/scripting-packages/storage/git/package-git-repository.ts`
- Create: `packages/server/src/scripting-packages/storage/git/package-git-repository.objects.spec.ts`

**Interfaces:**
- Consumes: `ensureRepo`, `GitCommand`.
- Produces:
  - `writeBlobs(packageId: number, files: Array<{ path: string; data: Buffer }>): Promise<Map<string, string>>`
  - `writeStagedBlobs(packageId: number, files: Array<{ path: string; absolute: string }>): Promise<Map<string, string>>`
  - `writeTree(packageId: number, entries: Array<{ path: string; oid: string }>): Promise<string>`
  - `createCommit(packageId, tree: string, parent: string | null, author: GitAuthor, message: string, date: Date): Promise<string>`
  - `listTree(packageId, commit: string): Promise<Map<string, string>>`
  - `objectExists(packageId, oids: string[]): Promise<Set<string>>`

- [ ] **Step 1: Написать падающие тесты**

```ts
it('builds a nested tree and deduplicates identical blobs', async () => {
  const repo = makeRepository();
  await repo.ensureRepo(1);
  const oids = await repo.writeBlobs(1, [
    { path: 'scripts/player.gd', data: Buffer.from('extends Node\n') },
    { path: 'assets/models/hero.gltf', data: Buffer.from('{}') },
    { path: 'copy.gltf', data: Buffer.from('{}') },
  ]);
  expect(oids.get('assets/models/hero.gltf')).toBe(oids.get('copy.gltf'));
  const tree = await repo.writeTree(
    1,
    [...oids].map(([p, oid]) => ({ path: p, oid })),
  );
  const files = await repo.listTree(1, tree);
  expect([...files.keys()].sort()).toEqual([
    'assets/models/hero.gltf',
    'copy.gltf',
    'scripts/player.gd',
  ]);
});

it('rejects symlinks in a tree', async () => {
  // собрать дерево с записью 120000 через update-index --cacheinfo
  await expect(repo.listTree(1, symlinkCommit)).rejects.toThrow(
    /non-regular tree entry/,
  );
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-repository.objects.spec`
Expected: FAIL — методов нет.

- [ ] **Step 3: Реализовать plumbing**

- `writeStagedBlobs`: пачки по 200 абсолютных путей на process,
  `git hash-object -w --stdin-paths`, oid-ы в порядке входа; проверка, что
  вернулся 64-символьный hex.
- `writeBlobs`: буферы писать в `<packageRoot>/tmp/blobs/<random>/<index>`,
  вызвать `writeStagedBlobs`, удалить временный каталог в `finally`.
- `writeTree`: `GIT_INDEX_FILE=<packageRoot>/tmp/index-<random>`; stdin для
  `git update-index -z --index-info` в формате
  `100644 blob <oid>\t<path>\0`; затем `git write-tree`; удалить index в `finally`.
- `createCommit`: env `GIT_AUTHOR_NAME/EMAIL/DATE`, `GIT_COMMITTER_*`,
  `git commit-tree <tree> [-p <parent>] -m <message>`.
- `listTree`: `git ls-tree -r -z --full-tree <commit>`, парсинг
  `<mode> <type> <oid>\t<path>\0`; режимы кроме `100644`/`040000` — ошибка
  `non-regular tree entry`; кэш `Map<`${packageId}:${commit}`, Map<string,string>>`
  с LRU на 50 записей; `applyRefUpdates` и `ensureRepo` очищают кэш пакета.
- `objectExists`: `git cat-file --batch-check` со всеми oid; отсутствующие
  строки `<oid> missing` не попадают в результат.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-repository.objects.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage/git
git commit -m "feat(server): write package blobs, trees and commits with git plumbing"
```

---

### Task 4: Ссылки, pending-транзакции, batch-чтение и GC

**Files:**
- Modify: `packages/server/src/scripting-packages/storage/git/package-git-repository.ts`
- Create: `packages/server/src/scripting-packages/storage/git/package-git-repository.refs.spec.ts`

**Interfaces:**
- Consumes: `writeBlobs`, `createCommit`.
- Produces:
  - `readRef(packageId, ref): Promise<string | null>`
  - `listRefs(packageId, prefix: string): Promise<Array<{ ref: string; oid: string }>>`
  - `applyRefUpdates(packageId, updates: RefUpdate[]): Promise<void>` где
    `RefUpdate = { ref: string; oid: string; expected?: string | null } | { ref: string; delete: true; expected: string }`
  - `forEachBlob(packageId, oids: string[], onBlob: (oid: string, data: Buffer) => void | Promise<void>): Promise<void>`
  - `openBlob(packageId, oid: string): Readable`
  - `commitDate(packageId, oid: string): Promise<Date>`
  - `gc(packageId, expire?: string): Promise<void>` (по умолчанию `2.weeks.ago`)
  - `fsck(packageId): Promise<void>`

- [ ] **Step 1: Написать падающие тесты**

```ts
it('creates, updates and deletes refs atomically', async () => {
  await repo.ensureRepo(1);
  const oid = commitWithFile('a.txt', 'a');
  await repo.applyRefUpdates(1, [
    { ref: 'refs/pending/publish/1', oid, expected: null },
  ]);
  expect(await repo.readRef(1, 'refs/pending/publish/1')).toBe(oid);
  await repo.applyRefUpdates(1, [
    { ref: 'refs/tags/revisions/1', oid, expected: null },
    { ref: 'refs/heads/main', oid, expected: null },
    { ref: 'refs/pending/publish/1', delete: true, expected: oid },
  ]);
  expect(await repo.readRef(1, 'refs/pending/publish/1')).toBeNull();
});

it('leaves all refs untouched when an expected value is stale', async () => {
  await expect(
    repo.applyRefUpdates(1, [
      { ref: 'refs/tags/revisions/2', oid: other, expected: null },
      { ref: 'refs/heads/main', oid: other, expected: 'deadbeef' },
    ]),
  ).rejects.toBeTruthy();
  expect(await repo.readRef(1, 'refs/tags/revisions/2')).toBeNull();
});

it('streams blobs in input order', async () => {
  const seen: string[] = [];
  await repo.forEachBlob(1, [oidA, oidB], (_oid, data) => {
    seen.push(data.toString());
  });
  expect(seen).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-repository.refs.spec`
Expected: FAIL — методов нет.

- [ ] **Step 3: Реализовать**

- `applyRefUpdates`: собрать stdin для `git update-ref --stdin`:
  `start`, затем `create <ref> <oid>` / `update <ref> <oid> <old>` /
  `delete <ref> <old>`, затем `prepare` и `commit`. Пустой `expected`
  (`null`) — это `create`, проверяющий отсутствие ref.
- `forEachBlob`: один `git cat-file --batch`, на каждый oid писать `<oid>\n`;
  читать заголовок `<oid> blob <size>\n`, затем ровно `size` байт и `\n`;
  строка `missing` — ошибка `package_storage_missing_object`.
- `openBlob`: `git cat-file blob <oid>`, вернуть stdout как `Readable`.
- `commitDate`: `git show -s --format=%cI <oid>`, вернуть `new Date(...)`.
- `gc`: `git repack -adq`, затем `git prune --expire=<expire>`.
- `fsck`: `git fsck --connectivity-only --no-progress`.
- `listRefs`: `git for-each-ref --format=%(refname) %(objectname) <prefix>`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-repository.refs.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage/git
git commit -m "feat(server): add atomic ref updates and batch blob reads"
```

---

### Task 5: Индекс содержимого `sha256 → oid`

**Files:**
- Create: `packages/server/src/scripting-packages/storage/git/package-content-index.ts`
- Test: `packages/server/src/scripting-packages/storage/git/package-content-index.spec.ts`

**Interfaces:**
- Consumes: `PackageGitRepository.listTree/objectExists`, `Repository<ScriptingPackageRevision>`.
- Produces:
  - `missing(packageId: number, files: PackageFileEntry[]): Promise<string[]>`
  - `resolveOids(packageId, files): Promise<Map<string, string>>` (filepath → oid)
  - `register(packageId, entries: Array<{ filepath: string; sha256: string; oid: string }>): void`
  - `invalidate(packageId: number): void`

- [ ] **Step 1: Написать падающие тесты**

```ts
it('reports only files whose content is absent', async () => {
  // ревизия 1: a.txt=sha(A), b.txt=sha(B), закоммичена с реальными блобами
  await expect(index.missing(1, [entry('a.txt', A), entry('b.txt', B)])).resolves.toEqual([]);
  await expect(
    index.missing(1, [entry('a.txt', A), entry('c.txt', C)]),
  ).resolves.toEqual(['c.txt']);
});

it('keeps a blob that was deleted in a later revision', async () => {
  // ревизия 1: old.txt; ревизия 2: old.txt удалён, но тег 1 жив
  await expect(index.missing(1, [entry('old.txt', OLD)])).resolves.toEqual([]);
});

it('drops index entries whose object disappeared', async () => {
  jest.spyOn(repo, 'objectExists').mockResolvedValue(new Set());
  await expect(index.missing(1, [entry('a.txt', A)])).resolves.toEqual(['a.txt']);
});

it('returns 409 semantics for unresolved oids', async () => {
  await expect(index.resolveOids(1, [entry('c.txt', C)])).rejects.toMatchObject({
    response: { code: 'package_storage_stale' },
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-content-index.spec`
Expected: FAIL — модуль не существует.

- [ ] **Step 3: Реализовать**

Кэш `Map<number, Promise<Map<string, string>>>`. Построение: все published-строки
пакета (`commitSha` или `refs/tags/revisions/<n>`), для каждой — `listTree`;
пары берутся только там, где `files[].filepath` есть в дереве, ключ —
`files[].sha256.toLowerCase()`, значение — oid из дерева. Одним
`objectExists` проверить все oid; отсутствующие выбросить. `missing` — пути, чей
sha256 не найден. `resolveOids` бросает
`new ConflictException({ code: 'package_storage_stale', message: 'Package files must be uploaded again' })`,
если хотя бы одного oid нет. `register` и `invalidate` работают с кэшем.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-content-index.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage/git
git commit -m "feat(server): index package file hashes to git blob ids"
```

---

### Task 6: Чтение через фасад, стрим в контроллере

**Files:**
- Create: `packages/server/src/scripting-packages/storage/package-git-storage.service.ts` (read-only часть)
- Modify: `packages/server/src/scripting-packages/storage/package-storage.service.ts:346-380`
- Modify: `packages/server/src/scripting-packages/publish/package-revisions.service.ts:663-689`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts:196-218`
- Test: `packages/server/src/scripting-packages/storage/package-git-storage.service.spec.ts`

**Interfaces:**
- Consumes: `PackageGitRepository`, `PackageContentIndex`.
- Produces:
  - `PackageGitStorageService.isGitPackage(packageId): Promise<boolean>`
  - `resolveCommit(packageId, revision, commitSha: string | null): Promise<string | null>`
  - `readFile(packageId, revision, filepath, commitSha): Promise<Buffer>`
  - `readFiles(packageId, revision, filepaths: string[], commitSha): Promise<Map<string, Buffer>>`
  - `readTextFiles(...): Promise<Map<string, string>>`
  - `openFile(packageId, revision, filepath, commitSha): Promise<Readable>` (размер берётся из манифеста в фасаде)
  - В фасаде: `readPublishedFiles`, `readPublishedTextFiles`, `resolvePublishedFile → { stream, size }`.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('reads a git revision by commit sha', async () => {
  // опубликовать один файл через repo+index (хелпер publishOne)
  const data = await storage.readPublishedFile(1, 1, 'scripts/player.gd', commit);
  expect(data.toString()).toBe('extends Node\n');
});

it('falls back to the legacy directory without a repo', async () => {
  await writeLegacyFile(root, 2, 4, 'a.txt', 'legacy');
  await expect(
    storage.readPublishedFile(2, 4, 'a.txt', null),
  ).resolves.toEqual(Buffer.from('legacy'));
});

it('returns a stream with the declared size', async () => {
  const file = await storage.resolvePublishedFile(1, 1, 'scripts/player.gd', commit);
  expect(file.size).toBe(13);
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe('extends Node\n');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-storage.service.spec`
Expected: FAIL — сервиса нет, тип возврата старый.

- [ ] **Step 3: Реализовать**

`PackageGitStorageService`:
- `isGitPackage` → `repo.hasRepo`.
- `resolveCommit`: если репозитория нет — `null`; если `commitSha` задан и
  `objectExists` его подтверждает — он; иначе `readRef('refs/tags/revisions/<n>')`;
  если и его нет — `null`.
- `readFiles`: `listTree` → выбрать oid по путям → один `forEachBlob`; вернуть
  Map в порядке входных путей; отсутствующий путь — `NotFoundException`.
- `openFile`: размер из `listTree`? Размера там нет — размер берётся из манифеста
  в `PackageStorageService`; `openFile` возвращает только поток, фасад
  подставляет `entry.size`.

Фасад `PackageStorageService` получает `PackageGitStorageService` и:
- если `resolveCommit(...)` вернул oid — работает через git, иначе через
  `revisions/<n>` (текущий код);
- `resolvePublishedFile` всегда возвращает `{ stream, size }`: legacy —
  `createReadStream(path)`, git — `openFile`, размер из манифеста;
- `readPublishedFiles` группирует по ревизии (вызывается по одной) и делает один
  batch; `readPublishedTextFiles` декодирует UTF-8.

`PackageRevisionsService.readPublishedFile/resolvePublishedFile` читают строку
(`findRevision`/`assertPublishedFile` возвращает row) и передают `row.commitSha`.
Контроллер использует `file.stream` без `createReadStream`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-storage.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage packages/server/src/scripting-packages/publish/package-revisions.service.ts packages/server/src/scripting-packages/scripting-packages.controller.ts
git commit -m "feat(server): serve package files from git with legacy fallback"
```

---

### Task 7: Публикация в git, `missing`, идемпотентность

**Files:**
- Modify: `packages/server/src/scripting-packages/storage/package-git-storage.service.ts`
- Modify: `packages/server/src/scripting-packages/storage/package-storage.service.ts:239-344`
- Modify: `packages/server/src/scripting-packages/publish/package-revisions.service.ts:80-195`
- Modify: `packages/shared/src/api/types.ts:36-43,89-91`
- Test: `packages/server/src/scripting-packages/storage/package-git-storage.service.spec.ts`
- Test: `packages/server/src/scripting-packages/publish/package-revisions.service.spec.ts`

**Interfaces:**
- Consumes: Task 5, Task 6.
- Produces:
  - `PackageGitStorageService.missingFiles(packageId, files): Promise<string[]>`
  - `PackageGitStorageService.publish(input: { packageId; revision; declared; stagedDir; author: GitAuthor; commitDb: (commitSha: string) => Promise<void> }): Promise<string>`
  - `PackageStorageService.publishRevision(..., commit: (commitSha: string | null) => Promise<void>, author: GitAuthor | null)`
  - `PackageRevisionDraft = PackageRevision & { missing: string[] }` в `@wired-io/shared`.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('uploads nothing on an unchanged second publish', async () => {
  await publishRevision(1, filesA);
  const draft = await revisions.createDraft(1, { files: filesA });
  expect(draft.missing).toEqual([]);
  await revisions.publish(1, draft.revision);
  expect(repo.writeStagedBlobs).not.toHaveBeenCalled(); // spy
});

it('accepts a subset of staged files and reuses indexed blobs', async () => {
  await publishRevision(1, filesA);
  const draft = await revisions.createDraft(1, { files: [...filesA, fileB] });
  expect(draft.missing).toEqual(['b.txt']);
  await revisions.uploadFile(1, draft.revision, 'b.txt', B);
  await revisions.publish(1, draft.revision);
  const tree = await repo.listTree(1, await repo.readRef(1, tag(2)));
  expect([...tree.keys()].sort()).toEqual(['a.txt', 'b.txt']);
});

it('rejects a stale skipped blob with 409', async () => {
  jest.spyOn(index, 'resolveOids').mockRejectedValue(staleConflict());
  await expect(revisions.publish(1, 2)).rejects.toMatchObject({
    response: { code: 'package_storage_stale' },
  });
  expect(await repo.readRef(1, tag(2))).toBeNull();
});

it('keeps a pending ref when ref promotion fails after the DB commit', async () => {
  jest.spyOn(repo, 'applyRefUpdates').mockRejectedValueOnce(new Error('ref failed'));
  await revisions.publish(1, 2);
  expect(await repo.readRef(1, 'refs/pending/publish/2')).toBeTruthy();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-storage.service.spec package-revisions.service.spec`
Expected: FAIL — `missing` отсутствует, публикация требует полный staging.

- [ ] **Step 3: Реализовать**

- `missingFiles`: репозиторий есть → `index.missing`; репозитория нет, флаг
  включён → все пути (пакет будет сконвертирован при публикации); иначе `[]`.
- `publish`:
  1. `ensureRepo`; `assertStagedSubset(stagedDir, declared)` — каждый staged-файл
     объявлен, размер и sha256 совпадают; пустой staging допустим, если все
     файлы уже в индексе.
  2. staged → `writeStagedBlobs`; остальные → `index.resolveOids`.
  3. `writeTree`, parent = `commitSha` предыдущей published-строки (или
     `readRef(tag)`), `createCommit`.
  4. `applyRefUpdates([{ ref: pendingRef, oid, expected: null }])`.
  5. `commitDb(commitSha)` — реализуется через
     `revisionsRepository.manager.transaction(...)`.
  6. `applyRefUpdates([{tag, oid, expected:null}, {main, oid, expected: parent}, {pending, delete, expected: oid}])`;
     `main` при `parent === null` — `create`, иначе `update`.
  7. `index.register`; удалить staging.
  Ошибка шага 6 — лог + возврат oid (pending остаётся); ошибка 5 — удалить
  pending и пробросить.
- `PackageStorageService.publishRevision`: выбрать git-путь
  (`hasRepo || config.packages.gitStorage`), иначе legacy; в git-пути не звать
  строгий `assertMatchesManifest`.
- `PackageRevisionsService.createDraft`: вернуть `{...revision, missing}`;
  `publish` прокидывает `author` (имя/email автора пакета, fallback
  `wired`/`packages@wired.local`) и `commitSha` в `save`.
- `toRevision` не меняется; тип возврата `createDraft` — `PackageRevisionDraft`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-storage.service.spec package-revisions.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage packages/server/src/scripting-packages/publish packages/shared/src/api/types.ts
git commit -m "feat(server): publish package revisions into git with incremental upload"
```

---

### Task 8: Восстановление pending-ссылок

**Files:**
- Create: `packages/server/src/scripting-packages/publish/package-git-reconcile.service.ts`
- Modify: `packages/server/src/scripting-packages/publish/package-revisions.service.ts:80-116,711-724`
- Test: `packages/server/src/scripting-packages/publish/package-git-reconcile.service.spec.ts`

**Interfaces:**
- Consumes: `PackageGitRepository`, `Repository<ScriptingPackageRevision>`.
- Produces: `PackageGitReconcileService.reconcilePackage(packageId: number): Promise<void>`, вызывается из `PackageRevisionsService.createDraft`, `publish`, `migratePackage` и GC.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('finishes refs for a published row whose pending ref exists', async () => {
  const oid = commitA;
  await repo.applyRefUpdates(id, [{ ref: pending, oid, expected: null }]);
  await rows.update({ id: row.id }, { status: 'published', commitSha: oid });
  await reconcile.reconcilePackage(id);
  expect(await repo.readRef(id, 'refs/tags/revisions/3')).toBe(oid);
  expect(await repo.readRef(id, 'refs/heads/main')).toBe(oid);
  expect(await repo.readRef(id, pending)).toBeNull();
});

it('drops a pending ref when its row stayed draft', async () => {
  await repo.applyRefUpdates(id, [{ ref: pending, oid, expected: null }]);
  await reconcile.reconcilePackage(id);
  expect(await repo.readRef(id, pending)).toBeNull();
  expect(await repo.readRef(id, 'refs/tags/revisions/3')).toBeNull();
});

it('promotes a draft row that already has a published tag', async () => {
  await repo.applyRefUpdates(id, [{ ref: tag, oid, expected: null }]);
  await reconcile.reconcilePackage(id);
  const row = await rows.findOneByOrFail({ id: row.id });
  expect(row.status).toBe('published');
  expect(row.commitSha).toBe(oid);
});

it('is idempotent', async () => {
  await reconcile.reconcilePackage(id);
  await expect(reconcile.reconcilePackage(id)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-reconcile.service.spec`
Expected: FAIL — сервиса нет.

- [ ] **Step 3: Реализовать**

`reconcilePackage`: `listRefs('refs/pending/')`; для каждой ссылки распарсить
`<kind>/<n>`; загрузить строку; если `published && commitSha === oid` — поставить
тег и `main` (ожидаемые старые значения из `readRef`), удалить pending одной
транзакцией; иначе удалить pending. Затем для draft-строк с существующим тегом —
promote: `status='published'`, `commitSha=tagOid`,
`publishedAt=commitDate`, save. `createDraft` вызывает reconcile **до**
`discardDrafts`; `publish` — до проверки статуса, чтобы draft-строка с тегом
стала published, а не была отклонена.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-reconcile.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/publish/package-git-reconcile.service.ts packages/server/src/scripting-packages/publish/package-git-reconcile.service.spec.ts packages/server/src/scripting-packages/publish/package-revisions.service.ts
git commit -m "feat(server): reconcile unfinished git publication refs"
```

---

### Task 9: Замыкание, batch-чтение и ключи артефактов

**Files:**
- Modify: `packages/server/src/scripting-packages/publish/package-closure-resolver.ts:26-60,272-326,328-381,399-470,478-496,505-560,605-655`
- Modify: `packages/server/src/scripting-packages/delivery/package-delivery.service.ts:58-59`
- Test: `packages/server/src/scripting-packages/publish/package-closure-resolver.spec.ts`
- Test: `packages/server/src/scripting-packages/delivery/package-delivery.service.spec.ts`

**Interfaces:**
- Consumes: `PackageStorageService.readPublishedFiles/readPublishedTextFiles`.
- Produces: `LoadedRevision.commitSha: string | null`, `ResolvedClosure.commitByPackage: Map<number, string | null>`, `computeArtifactKeys(revisionByPackage, referencesByPackage, commitByPackage)`, `ARTIFACT_FORMAT_VERSION = 'v3'`.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('reads a revision in one batch', async () => {
  const spy = jest.spyOn(storage, 'readPublishedFiles');
  await resolver.resolve(1, 3, 10);
  expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // root + максимум одна зависимость
  expect(spy.mock.calls[0][2].length).toBeGreaterThan(1);
});

it('keys artifacts by commit sha', () => {
  const keys = resolver.computeArtifactKeys(
    new Map([[1, 2]]), new Map([[1, new Set([1])]]), new Map([[1, 'abc']]),
  );
  expect(keys.get(1)).not.toBe(
    resolver.computeArtifactKeys(
      new Map([[1, 2]]), new Map([[1, new Set([1])]]), new Map([[1, 'def']]),
    ).get(1),
  );
});

it('keeps legacy keys stable', () => {
  expect(
    resolver.computeArtifactKeys(
      new Map([[1, 2]]), new Map([[1, new Set([1])]]), new Map([[1, null]]),
    ).get(1),
  ).toBe(
    resolver.computeArtifactKeys(
      new Map([[1, 2]]), new Map([[1, new Set([1])]]), new Map([[1, null]]),
    ).get(1),
  );
});

it('builds artifacts under v3', async () => {
  const manifest = await delivery.getRuntimeManifest(1, 1, 10);
  expect(manifest.artifactKey).toMatch(/^[0-9a-f]{64}$/);
  expect(artifactDir).toContain(path.join('runtime', 'v3'));
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-closure-resolver.spec package-delivery.service.spec`
Expected: FAIL — сигнатуры и версия каталога старые.

- [ ] **Step 3: Реализовать**

- `LoadedRevision` получает `commitSha` из `row.commitSha`.
- `ClosureBuilder` ведёт `commitByPackage` и возвращает его в `ResolvedClosure`.
- `computeArtifactKeys`: payload `[id, commitSha ?? `legacy:${revision}`]`.
- `readRevision`: собрать пути (root — все файлы; зависимость — только текстовые),
  вызвать `storage.readPublishedFiles(packageId, revision, paths, commitSha)` один
  раз; положить в `fileBytes` с тем же лимитом `maxFileCacheBytes`;
  `readFileBytes` остаётся для кэш-хитов. `collectRevisionReferences` использует
  прогретый кэш и не ходит в storage повторно.
- Delivery: `ARTIFACT_FORMAT_VERSION = 'v3'`; `invalidateArtifacts` уже удаляет
  весь `runtime`, поэтому `v2` не остаётся.
- Обновить вызовы `computeArtifactKeys` и типы в тестах.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-closure-resolver.spec package-delivery.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/publish/package-closure-resolver.ts packages/server/src/scripting-packages/delivery packages/server/src/scripting-packages/publish/*.spec.ts packages/server/src/scripting-packages/delivery/*.spec.ts
git commit -m "feat(server): batch package reads and key artifacts by commit"
```

---

### Task 10: Копирование и пины без пофайловых чтений

**Files:**
- Modify: `packages/server/src/scripting-packages/publish/package-revisions.service.ts:211-322,324-460,519-610`
- Test: `packages/server/src/scripting-packages/publish/package-revisions.service.spec.ts`
- Test: `packages/server/src/scripting-packages/workshop/package-workshop.service.spec.ts`

**Interfaces:**
- Consumes: `readPublishedFiles`, `readPublishedTextFiles`, `LoadedRevision.commitSha`.
- Produces: `loadReferencedPackageIds(..., readText: (packageId, revision, commitSha, paths) => Promise<Map<string,string>>)` и batch-версия `recordPinnedDependencies`.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('copies a source revision with one batch read', async () => {
  const spy = jest.spyOn(storage, 'readPublishedFiles');
  await revisions.publishCopiedRevision({ sourcePackageId: 1, targetPackageId: 2 });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][2]).toEqual(['a.txt', 'b.txt']);
});

it('reads dependency text files in one batch per revision', async () => {
  const spy = jest.spyOn(storage, 'readPublishedTextFiles');
  await revisions.publish(1, 2);
  expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-revisions.service.spec package-workshop.service.spec`
Expected: FAIL — чтения пофайловые.

- [ ] **Step 3: Реализовать**

- `publishCopiedRevision`: `const sourceData = await storage.readPublishedFiles(sourcePackageId, source.revision, source.files.map(f => f.filepath), source.commitSha)`; трансформация из Map.
- `recordPinnedDependencies`: собрать для каждой зависимости один список
  текстовых путей и вызвать `readPublishedTextFiles` один раз на ревизию.
- `assertNoDisabledRoomDependency`/`assertNoRoomDependency`: та же batch-функция.
- `resolveReferences` принимает reader с `commitSha`; `loadReferencedPackageIds`
  получает `commitSha` из строки.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-revisions.service.spec package-workshop.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/publish packages/server/src/scripting-packages/workshop
git commit -m "refactor(server): batch package reads in copy and pin flows"
```

---

### Task 11: Переименование slug через git

**Files:**
- Modify: `packages/server/src/scripting-packages/storage/package-storage.service.ts:37-62,416-544`
- Modify: `packages/server/src/scripting-packages/storage/package-git-storage.service.ts` (rewrite-часть)
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts:726-860`
- Test: `packages/server/src/scripting-packages/storage/package-git-storage.service.spec.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`

**Interfaces:**
- Consumes: `PackageGitRepository`, `readFiles`, `writeBlobs`, `writeTree`, `createCommit`, `applyRefUpdates`.
- Produces: `RevisionTarget.commitSha?: string | null`, `RevisionRewrite.results[].commitSha?: string | null`; `beginRewrite` пишет pending-ссылки `refs/pending/rewrite/<n>`.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('rewrites published revisions as new commits and moves tags', async () => {
  // пакет 1: ревизии 1..2 с res://packages/old/...
  const rewrite = await storage.beginRewrite(
    [
      { packageId: 1, revision: 1, kind: 'published', commitSha: tag1 },
      { packageId: 1, revision: 2, kind: 'published', commitSha: tag2 },
    ],
    (filepath, data) => replaceSlug(data),
  );
  expect(rewrite.results.every((r) => r.commitSha)).toBe(true);
  await rewrite.commit();
  const files = await storage.readFiles(
    1,
    2,
    ['main.tscn'],
    await repo.readRef(1, tag(2)),
  );
  expect(files.get('main.tscn')!.toString()).toContain('packages/new/');
  expect(await repo.readRef(1, 'refs/tags/revisions/1')).not.toBe(tag1);
});

it('restores the tags when the database transaction fails', async () => {
  const rewrite = await storage.beginRewrite(targets, transform);
  await rewrite.abort();
  expect(await repo.readRef(1, 'refs/tags/revisions/1')).toBe(tag1);
});

it('updates files and commitSha in the slug rename flow', async () => {
  await packages.update(1, { slug: 'new' }); // при room-пакете
  const row = await revisions.findOneByOrFail({ package: { id: 1 }, revision: 1 });
  expect(row.files[0].sha256).toBe(sha256OfRewritten);
  expect(row.commitSha).toBe(newCommit);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-storage.service.spec scripting-packages.service.spec`
Expected: FAIL — rewrite копирует каталоги и не трогает git.

- [ ] **Step 3: Реализовать**

- `beginRewrite`: для `kind === 'published' && (commitSha || repo)` — прочитать все
  файлы коммита batch-ом, применить transform, записать блобы, собрать дерево и
  коммит (parent — предыдущая published-ревизия), создать pending
  `refs/pending/rewrite/<n>`; вернуть `{ files, commitSha }`. Для draft —
  текущий каталоговый rewrite.
- `commit()`: одна `applyRefUpdates` на все git-цели: теги, `main` (самый новый
  коммит), удаление pending; затем удалить legacy-бэкапы.
- `abort()`: удалить pending-ссылки; объекты соберёт GC; каталоги черновиков
  восстановить как сейчас.
- `rewriteRevisionsAndSwapSlug`: в `revisions.update` писать `{ files, commitSha }`
  из результата; для draft `commitSha` остаётся `null`.
- `invalidatePackage`/`packagesChanged` не трогать.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-storage.service.spec scripting-packages.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/storage packages/server/src/scripting-packages/scripting-packages.service.ts packages/server/src/scripting-packages/scripting-packages.service.spec.ts
git commit -m "feat(server): rewrite published revisions as git commits on slug rename"
```

---

### Task 12: Миграция legacy-пакетов и очистка

**Files:**
- Modify: `packages/server/src/scripting-packages/storage/package-git-storage.service.ts`
- Modify: `packages/server/src/scripting-packages/publish/package-revisions.service.ts`
- Create: `packages/server/src/scripts/packages-git.ts`
- Modify: `packages/server/package.json:8-30`
- Test: `packages/server/src/scripting-packages/storage/package-git-storage.service.spec.ts`

**Interfaces:**
- Consumes: legacy `listPublishedFiles/readPublishedFile`, git write-ops.
- Produces:
  - `PackageGitStorageService.migratePackage(packageId, rows: Array<{ revision: number; files: PackageFileEntry[]; publishedAt: Date | null }>): Promise<Map<number, string>>`
  - `PackageGitStorageService.cleanupLegacyRevisions(packageId, rows): Promise<number>`
  - `PackageRevisionsService.migratePackage(packageId): Promise<number>`
  - CLI `packages-git.ts` с командами `migrate|cleanup|gc|export|repair`.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('converts legacy revisions into a linear history', async () => {
  // revisions/1 и /2 с файлами и строками БД
  const commits = await storage.migratePackage(1, rows);
  expect(commits.size).toBe(2);
  expect(await repo.readRef(1, tag(1))).toBe(commits.get(1));
  expect(await repo.readRef(1, tag(2))).toBe(commits.get(2));
  const second = await repo.listTree(1, commits.get(2)!);
  expect(second.has('scripts/player.gd')).toBe(true);
  await expect(storage.readPublishedFile(1, 2, 'scripts/player.gd', commits.get(2)!))
    .resolves.toBeInstanceOf(Buffer);
});

it('keeps legacy directories until cleanup', async () => {
  await storage.migratePackage(1, rows);
  expect(existsSync(legacyDir(1, 1))).toBe(true);
  const removed = await storage.cleanupLegacyRevisions(1, rowsWithCommit);
  expect(removed).toBe(2);
  expect(existsSync(legacyDir(1, 1))).toBe(false);
});

it('refuses cleanup while a row has no commit', async () => {
  await expect(
    storage.cleanupLegacyRevisions(1, [{ revision: 1, files: [], publishedAt: null, commitSha: null }]),
  ).rejects.toThrow(/not converted/);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-storage.service.spec`
Expected: FAIL — методов миграции нет.

- [ ] **Step 3: Реализовать**

- `migratePackage`: `ensureRepo`; для строк по возрастанию: сверить каталог с
  манифестом (`sha256File`), `writeStagedBlobs`, `writeTree`, `createCommit`
  (parent — предыдущий коммит), `applyRefUpdates` (тег + `main`); вернуть Map.
  Страховка: перед началом `reconcilePackage`, после — `index.invalidate`.
- `cleanupLegacyRevisions`: если у какой-то строки нет `commitSha` — ошибка;
  `rm -rf revisions/<n>` для каждой; вернуть число.
- `PackageRevisionsService.migratePackage`: под `runWithPublishLocks`, reconcile,
  rows published without `commitSha`, storage.migratePackage, транзакция
  `update({id}, {commitSha})`, `index.invalidate` через storage.
- В `publish`: если флаг включён, репозитория нет и есть published rows —
  сначала `migratePackageLocked` (приватный вариант без захвата lock, вызывается
  внутри уже взятого `runWithPublishLocks`). `createDraft` не мигрирует: при
  отсутствии репозитория и включённом флаге `missingFiles` возвращает все пути,
  и публикация конвертирует пакет.
- CLI: `NestFactory.createApplicationContext(AppModule)`, `process.argv[2]`,
  `process.exitCode = 1` при ошибке. Команды:
  `migrate [--all|--package <id>]`, `cleanup [--all|--package <id>]`,
  `gc [--all|--package <id>]`, `export [--all|--package <id>]`,
  `repair [--all|--package <id>]`.
- `package.json`:
  `"packages:git": "node dist/server/src/scripts/packages-git.js"`,
  `"packages:git-migrate": "node dist/server/src/scripts/packages-git.js migrate"`,
  `"packages:git-cleanup": "... cleanup"`, `"packages:git-maintenance": "... gc"`,
  `"packages:git-export": "... export"`, `"packages:git-repair": "... repair"`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-storage.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages packages/server/src/scripts packages/server/package.json
git commit -m "feat(server): migrate legacy package revisions into git"
```

---

### Task 13: GC, fsck, экспорт и плановое обслуживание

**Files:**
- Create: `packages/server/src/scripting-packages/publish/package-git-maintenance.service.ts`
- Modify: `packages/server/src/scripts/packages-git.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.module.ts`
- Test: `packages/server/src/scripting-packages/publish/package-git-maintenance.service.spec.ts`

**Interfaces:**
- Consumes: `PackageGitStorageService`, `PackageGitReconcileService`, `PackageGitRepository`.
- Produces:
  - `maintainPackage(packageId: number): Promise<void>` — reconcile, `fsck`, `gc`.
  - `exportPackage(packageId: number): Promise<number>` — разложить published-ревизии обратно в `revisions/<n>/`.
  - `repairPackage(packageId: number): Promise<void>` — `fsck`, затем promote/починка по тегам.
  - `onModuleInit` — `setInterval(..., WIRED_PACKAGE_GIT_GC_INTERVAL_MS ?? 24h).unref()` при включённом флаге.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('prunes unreachable objects after reconcile', async () => {
  // pending на коммит без строки; конфиг с gcExpire='now'
  await maintenance.maintainPackage(1);
  expect(await repo.readRef(1, pending)).toBeNull();
  await expect(repo.objectExists(1, [orphanOid])).resolves.toEqual(new Set());
});

it('exports published revisions back to directories', async () => {
  const count = await maintenance.exportPackage(1);
  expect(count).toBe(2);
  expect(await readFile(legacyDir(1, 2), 'utf8')).toBe('...');
});

it('does not start the interval when git storage is disabled', () => {
  expect(setIntervalSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest package-git-maintenance.service.spec`
Expected: FAIL — сервиса нет.

- [ ] **Step 3: Реализовать**

- `maintainPackage`: reconcile; `fsck` (ошибку логировать, не бросать); `gc(expire)`
  где expire из `WIRED_PACKAGE_GIT_GC_EXPIRE ?? '2.weeks.ago'`.
- `exportPackage`: для каждой published-строки с `commitSha` прочитать все файлы
  batch-ом и записать в `revisions/<n>/`, сверив sha256 с манифестом; вернуть
  число.
- `repairPackage`: `fsck`; для published-строк без тега — создать тег из
  `commitSha`; для draft-строк с тегом — promote через reconcile.
- `onModuleInit`: если `config.packages.gitStorage` — интервал, `unref()`;
  в тестах флаг выключен.
- CLI `gc|export|repair` вызывает соответствующие методы по пакетам
  (`--all` — все id с `repo.git`).

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter server exec jest package-git-maintenance.service.spec`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/src/scripting-packages/publish packages/server/src/scripts packages/server/src/scripting-packages/scripting-packages.module.ts
git commit -m "feat(server): add git maintenance, export and repair commands"
```

---

### Task 14: Инкрементальная загрузка во фронтенде

**Files:**
- Modify: `packages/shared/src/api/types.ts` (готово в Task 7)
- Modify: `frontend/src/api/services/scripting-packages.ts:142-150`
- Modify: `frontend/src/godot/bridge/package-sync.ts:30-63`
- Test: `frontend/src/godot/bridge/package-sync.test.ts`

**Interfaces:**
- Consumes: `PackageRevisionDraft.missing`.
- Produces: `publishPackageFiles` возвращает `{ revision, uploaded: number }`, где `uploaded` — число реально залитых файлов; `missing` отсутствует → заливаются все.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('uploads only missing files', async () => {
  vi.mocked(createPackageRevision).mockResolvedValue({
    ...draft, missing: ['b.txt'],
  });
  const result = await publishPackageFiles(1, 'pkg', fs);
  expect(uploadRevisionFileAsUint8Array).toHaveBeenCalledTimes(1);
  expect(uploadRevisionFileAsUint8Array).toHaveBeenCalledWith(
    1, 1, expect.objectContaining({ filepath: 'b.txt' }), expect.anything(),
  );
  expect(result.uploaded).toBe(1);
});

it('uploads everything when missing is absent', async () => {
  vi.mocked(createPackageRevision).mockResolvedValue({ ...draft } as PackageRevision);
  await publishPackageFiles(1, 'pkg', fs);
  expect(uploadRevisionFileAsUint8Array).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter frontend exec vitest run package-sync`
Expected: FAIL — заливаются все файлы.

- [ ] **Step 3: Реализовать**

`createPackageRevision` типизировать как `PackageRevisionDraft`.
`publishPackageFiles`: `const missing = draft.missing ? new Set(draft.missing) : null;`
цикл пропускает файлы вне `missing`; прогресс — `uploaded/total` по missing-файлам;
`uploaded` — счётчик залитых. Комментарий: `missing` приходит только с git-пути,
старый сервер поля не присылает.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter frontend exec vitest run package-sync`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend/src/godot/bridge/package-sync.ts frontend/src/godot/bridge/package-sync.test.ts frontend/src/api/services/scripting-packages.ts packages/shared/src/api/types.ts
git commit -m "feat(frontend): upload only package files missing on the server"
```

---

### Task 15: Docker, документация и полная проверка

**Files:**
- Modify: `backend.Dockerfile:63-82`
- Modify: `.env.prod.example` (добавить `WIRED_PACKAGE_GIT_STORAGE=0`)
- Modify: `AGENTS.md` (раздел архитектуры про пакеты)
- Modify: `packages/server/src/config/config.ts` (комментарий к флагу)

**Interfaces:**
- Consumes: всё выше.
- Produces: рабочий образ с git и документация для выката/отката.

- [ ] **Step 1: Добавить git в финальную стадию образа**

В `final` перед `COPY --from=prod-deps`:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Обновить документацию**

В `AGENTS.md` заменить абзац про хранение ревизий: один bare-репозиторий на
пакет, SHA-256, теги `revisions/<n>`, pending-ссылки, индекс `sha256→oid`,
флаг `WIRED_PACKAGE_GIT_STORAGE`, CLI `packages:git-*`, `artifactKey` по
commit sha и `runtime/v3`. В `.env.prod.example` — строка
`WIRED_PACKAGE_GIT_STORAGE=0` с комментарием о выкате.

- [ ] **Step 3: Прогнать типы и тесты сервера**

Run:
```bash
pnpm --filter server check-types
pnpm --filter server test
```
Expected: `tsc` без ошибок; Jest — все suites зелёные, включая новые
git-спеки и `room-runtime.integration` skipped.

- [ ] **Step 4: Прогнать фронтенд и линт**

Run:
```bash
pnpm check-types:frontend
pnpm --filter frontend test
pnpm --filter server lint
```
Expected: без ошибок; lint правит форматирование.

- [ ] **Step 5: Ручная проверка на dev**

1. `WIRED_PACKAGE_GIT_STORAGE=1 pnpm dev:server`.
2. Опубликовать пакет дважды, изменив один файл.
3. Проверить `git --git-dir=<packagesFilesDir>/<id>/repo.git log --oneline` —
   два коммита, второй — только с изменённым блобом.
4. `git --git-dir=... cat-file --batch-check --batch-all-objects | wc -l` —
   число объектов не удвоилось.
5. Переименовать slug пакета в комнате и убедиться, что теги съехали на новые
   коммиты, а Game-таб собрал `runtime/v3`.

- [ ] **Step 6: Коммит**

```bash
git add backend.Dockerfile .env.prod.example AGENTS.md packages/server/src/config/config.ts
git commit -m "chore: install git in backend image and document git package storage"
```
