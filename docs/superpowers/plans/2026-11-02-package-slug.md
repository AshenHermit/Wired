# Package Slug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-supplied, globally unique package `slug` that names package folders in the Godot editor and runtime, while keeping the numeric `id` as API/state identity, and add package metadata editing plus modal package creation in the Packages tab.

**Architecture:** Approach A from the design: numeric `id` remains identity in API routes, runtime state, snapshots, registry and dependencies. `slug` is a stable path alias stored on the package, carried by manifests, and used as the editor/runtime folder name. References are parsed as raw targets and resolved as numeric id for digit-only targets, otherwise by slug. Server storage/artifact directories stay numeric; artifact format becomes `v2` so pre-slug cached manifests are never served. Deleted slugs are retired with a tombstone table.

**Tech Stack:** NestJS 11 + TypeORM/Postgres (`DB_SYNC=1`), shared TypeScript contracts, Next.js 16/React 19/Vitest, Godot 4.8-beta2 GDScript editor bridge and runtime, Jest server tests, headless Godot smoke tests.

**Spec:** `docs/superpowers/specs/2026-11-02-package-slug-design.md`

## Global Constraints

- New slug regex: `^(?=.*[a-z])[a-z0-9_]+$`; length 1–64; at least one lowercase latin letter; pure numeric new slugs rejected.
- Path-validation regex: `^[a-z0-9_]+$`; length 1–64. Numeric legacy slugs are allowed on this path.
- Slug is user-supplied at creation, immutable afterwards, globally unique, and never reusable after deletion.
- Existing packages are backfilled with `slug = id::text` at server startup. Their numeric folder and numeric references must keep working.
- Missing `slug` in a manifest is an error: no `str(id)` fallback.
- Numeric `id` remains identity for API routes, runtime state, snapshots, registry, scene-dependency keys and `PackageRuntimeDependency`. Do not key those by slug.
- Server storage and artifact directories stay numeric: `<packagesFilesDir>/<id>/...`. Editor and runtime folders use slug.
- Artifact format version is `v2`; old `runtime/v1` directories are ignored, not migrated.
- Single local server instance is assumed; no rolling-deploy null-slug repair is required.
- Frontend API calls stay browser-only through `client-api.ts`; no server-side fetching.
- UI copy stays Russian; match UTF-8. Server code uses single quotes and trailing commas.
- Conventional Commits for every commit.

## Review Focus

- **Unsafe slug input** (`..`, `/`, uppercase, empty) must never escape `res://packages` or `user://.../packages`, and must not collapse a package path to the packages root.
- **Legacy numeric package/reference** (`slug = "42"`, `res://packages/42/...`) must keep resolving to the same package after the change.
- **Unknown slug vs known-but-unpublished package** must produce distinct, actionable errors rather than silently creating an id-0 dependency.
- **Pre-slug `runtime/v1` artifact** with no `slug` must never be served as a cache hit after deploy.
- **Deleted slug reuse and stale local folders** must not make a recreated package appear superseded or mix files.

---

### Task 1: Shared contracts, package entity, slug DTO, retired-slug entity

**Files:**
- Modify: `packages/shared/src/api/types.ts`
- Modify: `packages/server/src/database/entities/scripting-package.entity.ts`
- Create: `packages/server/src/database/entities/retired-package-slug.entity.ts`
- Modify: `packages/server/src/database/entities/entities.metadata.spec.ts`
- Modify: `packages/server/src/scripting-packages/dto/create-scripting-package.dto.ts`
- Create: `packages/server/src/scripting-packages/dto/create-scripting-package.dto.spec.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.module.ts`
- Modify: `packages/server/src/godot-game/godot-game.module.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ScriptingPackage.slug: string`; `CreateScriptingPackagePayload.slug: string`; `ScriptingPackage.slug` entity column; `RetiredPackageSlug { slug: string; packageId: number; retiredAt: Date }`. Manifest/status fields arrive in Task 5, together with their producers.

- [ ] **Step 1: Write the failing DTO test**

Create `create-scripting-package.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateScriptingPackageDto } from './create-scripting-package.dto';

async function slugErrors(slug: unknown) {
  const dto = plainToInstance(CreateScriptingPackageDto, {
    name: 'Hero',
    version: '0.1.0',
    slug,
  });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'slug');
}

describe('CreateScriptingPackageDto slug', () => {
  it.each(['hero', 'hero_controller', 'h2', 'a_b_c'])(
    'accepts %s',
    async (slug) => {
      expect(await slugErrors(slug)).toHaveLength(0);
    },
  );

  it.each([
    '',
    '123',
    'Hero',
    'hero-controller',
    'hero controller',
    'héro',
    'a'.repeat(65),
  ])('rejects %s', async (slug) => {
    expect(await slugErrors(slug)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the DTO test and verify it fails**

Run: `pnpm --filter server exec jest create-scripting-package.dto`
Expected: FAIL because `CreateScriptingPackageDto` has no `slug` validation.

- [ ] **Step 3: Add the shared fields and entity columns**

In `packages/shared/src/api/types.ts` add `slug: string` to `ScriptingPackage` and `CreateScriptingPackagePayload`. Because `UpdateScriptingPackagePayload` is currently `Partial<CreateScriptingPackagePayload> & { enabled?: boolean }`, change it to `Partial<Omit<CreateScriptingPackagePayload, 'slug'>> & { enabled?: boolean }` so the update type cannot carry a slug. Do **not** add slug to `PackageManifest`, `PackageRuntimeManifest`, `PackageSyncStatus`, or `PackageRuntimeDependency` here: Task 5 adds the manifest/status fields together with their producers.

In `scripting-package.entity.ts` add:

```ts
@Column({ type: 'varchar', length: 64, unique: true, nullable: true })
slug: string;
```

`nullable: true` is required because `DB_SYNC=1` adds the column to a non-empty table; the service guarantees a value.

Create `retired-package-slug.entity.ts`:

```ts
@Entity('retired_package_slug')
export class RetiredPackageSlug {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ type: 'int' })
  packageId: number;

  @CreateDateColumn()
  retiredAt: Date;
}
```

Register it in `TypeOrmModule.forFeature([...])` in both `scripting-packages.module.ts` and `godot-game.module.ts`, and include it in the `entities` list in `entities.metadata.spec.ts`.

In `create-scripting-package.dto.ts` add:

```ts
@IsString()
@MaxLength(64)
@Matches(/^(?=.*[a-z])[a-z0-9_]+$/, {
  message:
    'slug must contain lowercase latin letters, digits or _, and at least one letter',
})
slug: string;
```

- [ ] **Step 4: Run the focused tests and metadata check**

Run: `pnpm --filter server exec jest create-scripting-package.dto entities.metadata`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/types.ts packages/server/src/database/entities packages/server/src/scripting-packages/dto packages/server/src/scripting-packages/scripting-packages.module.ts packages/server/src/godot-game/godot-game.module.ts
git commit -m "feat: add package slug contracts and schema"
```

---

### Task 2: Slug lifecycle — backfill, availability, create, delete tombstones

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1's `ScriptingPackage.slug`, `RetiredPackageSlug`, and `CreateScriptingPackageDto.slug`.
- Produces:
  - `checkSlugAvailability(slug: string): Promise<{ slug: string; available: boolean; reason?: 'taken' | 'retired' }>`
  - `GET /scripting-packages/slug-availability?slug=...` returning `{ slug, available, reason? }`
  - `create()` rejects live with `409 slug_taken` and retired with `409 slug_retired`
  - `remove(id)` writes a tombstone before deleting the package
  - startup backfill `UPDATE scripting_package SET slug = id::text WHERE slug IS NULL`

- [ ] **Step 1: Write failing service tests**

In `scripting-packages.service.spec.ts` add a `describe('slug lifecycle')` with these assertions:

```ts
it('backfills null slugs from the numeric id', async () => {
  const query = jest.fn(async () => []);
  const service = makeSlugService({ query });
  await service.onApplicationBootstrap();
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE scripting_package'),
  );
});

it('reports a live slug as taken', async () => {
  const service = makeSlugService({
    findOne: jest.fn(async () => ({ id: 7, slug: 'hero' })),
  });
  await expect(service.checkSlugAvailability('hero')).resolves.toEqual({
    slug: 'hero',
    available: false,
    reason: 'taken',
  });
});

it('reports a retired slug as retired', async () => {
  const service = makeSlugService({
    findOne: jest.fn(async () => null),
    retiredFindOne: jest.fn(async () => ({ slug: 'hero', packageId: 7 })),
  });
  await expect(service.checkSlugAvailability('hero')).resolves.toEqual({
    slug: 'hero',
    available: false,
    reason: 'retired',
  });
});

it('rejects creation with a retired slug', async () => {
  const service = makeSlugService({
    retiredFindOne: jest.fn(async () => ({ slug: 'hero', packageId: 7 })),
  });
  await expect(
    service.create(
      { name: 'Hero', version: '0.1.0', slug: 'hero', authorId: 1 },
      { id: 1 } as never,
    ),
  ).rejects.toMatchObject({ status: 409 });
});

it('maps a unique violation to slug_taken', async () => {
  const service = makeSlugService({
    save: jest.fn(async () => {
      throw { code: '23505' };
    }),
  });
  await expect(
    service.create(
      { name: 'Hero', version: '0.1.0', slug: 'hero', authorId: 1 },
      { id: 1 } as never,
    ),
  ).rejects.toMatchObject({ status: 409, response: { code: 'slug_taken' } });
});

it('tombstones the slug before deleting the package', async () => {
  const manager = makeTransactionManager();
  const service = makeSlugService({ manager });
  await service.remove(7);
  expect(manager.save).toHaveBeenCalledWith(
    RetiredPackageSlug,
    expect.objectContaining({ slug: 'hero', packageId: 7 }),
  );
  expect(manager.delete).toHaveBeenCalledWith(ScriptingPackage, 7);
});
```

`makeSlugService` should pass `packagesRepository`, `roomsRepository` and the retired repository into the new constructor; `manager` should expose `query`, `findOne`, `save`, `delete` and be returned by `manager.transaction`.

- [ ] **Step 2: Run the service test and verify it fails**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: FAIL because the methods and constructor dependencies do not exist.

- [ ] **Step 3: Implement backfill, availability, create and remove**

In `ScriptingPackagesService`:

- implement `OnApplicationBootstrap` and run the idempotent backfill through `this.packagesRepository.query(...)` with `UPDATE ... RETURNING id`. Log the number of returned rows.
- add `@InjectRepository(RetiredPackageSlug) private readonly retiredSlugsRepository: Repository<RetiredPackageSlug>` to the constructor.
- `checkSlugAvailability(slug)` validates the create regex, trims, then checks live package and retired tombstone. Invalid slug throws `BadRequestException('invalid_slug')`.
- `create()` wraps checks and save in `this.packagesRepository.manager.transaction(async (manager) => { ... })`:
  - `SELECT pg_advisory_xact_lock(hashtext($1))` with `package_slug:<slug>`;
  - re-check live and retired inside the lock;
  - save through `manager.getRepository(ScriptingPackage)`;
  - map Postgres `23505` to `ConflictException({ code: 'slug_taken', slug })`.
- `remove()` uses one transaction: load the package, check enabled dependents as today, `manager.save(RetiredPackageSlug, { slug: pkg.slug, packageId: id })`, `manager.delete(ScriptingPackage, id)`, then run the existing storage removal and dispatcher outside the transaction so rows are gone even if disk cleanup fails. If the package has no slug (should be impossible after backfill), use `String(id)`.

- [ ] **Step 4: Add the availability endpoint before `:id`**

In `scripting-packages.controller.ts` add, above `@Get(':id')`:

```ts
@UseAuthGuard()
@Get('slug-availability')
slugAvailability(@Query('slug') slug: string) {
  return this.packagesService.checkSlugAvailability(slug);
}
```

Add controller tests: `slug-availability` delegates to the service; `:id` still parses numeric ids; the availability route is declared before `:id` (assert the metadata/order or simply that `GET slug-availability` does not call `findOne`).

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter server exec jest scripting-packages.service scripting-packages.controller`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(server): enforce package slug lifecycle"
```

---

### Task 3: Slug index and raw reference parsing

**Files:**
- Create: `packages/server/src/scripting-packages/package-slug-index.ts`
- Create: `packages/server/src/scripting-packages/package-slug-index.spec.ts`
- Modify: `packages/server/src/scripting-packages/package-runtime-references.ts`
- Modify: `packages/server/src/scripting-packages/package-runtime-references.spec.ts`

**Interfaces:**
- Consumes: Task 1's `ScriptingPackage.slug`.
- Produces:
  - `PackageSlugIndex { bySlug: Map<string, number>; byId: Map<number, string> }`
  - `loadPackageSlugIndex(repository: Pick<Repository<ScriptingPackage>, 'find'>): Promise<PackageSlugIndex>`
  - `resolvePackageTarget(target: string, index: PackageSlugIndex): number | null`
  - `slugForPackage(packageId: number, index: PackageSlugIndex): string`
  - `RawPackageFileReference { target: string; filepath: string }`
  - `collectRawPackageReferences(text: string): RawPackageFileReference[]`
  - `resolvePackageReferences(refs: RawPackageFileReference[], index: PackageSlugIndex): { resolved: PackageFileReference[]; unknown: string[] }`

  This task deliberately leaves the existing `collectPackageReferences`, `rewritePackageReferences` and `buildSceneDependencies` signatures untouched so the server still compiles; Task 4 migrates the callers and removes the numeric-only collector, Task 5 changes rewriting and scene dependencies.

- [ ] **Step 1: Write failing slug-index tests**

In `package-slug-index.spec.ts`:

```ts
it('resolves digit-only targets as numeric ids', () => {
  const index = {
    bySlug: new Map([['42', 99]]),
    byId: new Map([[42, 'legacy']]),
  };
  expect(resolvePackageTarget('42', index)).toBe(42);
});

it('resolves non-numeric targets by slug', () => {
  const index = {
    bySlug: new Map([['hero_controller', 9]]),
    byId: new Map([[9, 'hero_controller']]),
  };
  expect(resolvePackageTarget('hero_controller', index)).toBe(9);
});

it('returns null for an unknown slug', () => {
  expect(
    resolvePackageTarget('missing', { bySlug: new Map(), byId: new Map() }),
  ).toBeNull();
});

it('loads id and slug maps from the repository', async () => {
  const repo = {
    find: jest.fn(async () => [
      { id: 1, slug: 'one' },
      { id: 2, slug: 'two' },
    ]),
  };
  const index = await loadPackageSlugIndex(repo);
  expect(index.bySlug.get('two')).toBe(2);
  expect(index.byId.get(1)).toBe('one');
});
```

- [ ] **Step 2: Write failing reference tests**

Update `package-runtime-references.spec.ts`:

```ts
it('collects a slug reference as a raw target', () => {
  expect(
    collectRawPackageReferences('path="res://packages/hero/scene.tscn"'),
  ).toEqual([{ target: 'hero', filepath: 'scene.tscn' }]);
});

it('collects a legacy numeric reference as a raw target', () => {
  expect(
    collectRawPackageReferences('path="res://packages/42/scene.tscn"'),
  ).toEqual([{ target: '42', filepath: 'scene.tscn' }]);
});

it('rejects uppercase and hyphenated targets', () => {
  expect(
    collectRawPackageReferences('path="res://packages/Hero/scene.tscn"'),
  ).toEqual([]);
  expect(
    collectRawPackageReferences('path="res://packages/hero-one/scene.tscn"'),
  ).toEqual([]);
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm --filter server exec jest package-slug-index package-runtime-references`
Expected: FAIL because the new module and raw target API do not exist.

- [ ] **Step 4: Implement the slug index and reference API**

- `loadPackageSlugIndex` calls `repository.find({ select: { id: true, slug: true } })`, skips null slugs, fills both maps.
- `resolvePackageTarget` uses `/^\d+$/` first, then `bySlug.get(target) ?? null`.
- `slugForPackage` throws `Error('package_slug_missing:<id>')` when absent.
- Add a second raw-reference regex capturing `([a-z0-9_]+)` and implement `collectRawPackageReferences`; do not change the existing numeric-only `collectPackageReferences` yet.
- `collectRawPackageReferences` returns raw refs, dedupes by `${target}:${filepath}`, preserves comment and safe-path handling.
- `resolvePackageReferences` resolves each raw ref and returns `{ resolved: PackageFileReference[]; unknown: string[] }`, so callers can raise `package_dependency_unknown_slug:<slug>`. Do not update call sites in this task.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter server exec jest package-slug-index package-runtime-references`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages/package-slug-index.ts packages/server/src/scripting-packages/package-slug-index.spec.ts packages/server/src/scripting-packages/package-runtime-references.ts packages/server/src/scripting-packages/package-runtime-references.spec.ts
git commit -m "feat(server): resolve package references by id or slug"
```

---

### Task 4: Closure resolver, reverse scan and publish-time dependency checks

**Files:**
- Modify: `packages/server/src/scripting-packages/package-closure-resolver.ts`
- Modify: `packages/server/src/scripting-packages/package-closure-resolver.spec.ts`
- Modify: `packages/server/src/scripting-packages/package-runtime-references.ts`
- Modify: `packages/server/src/scripting-packages/package-runtime-references.spec.ts`
- Modify: `packages/server/src/scripting-packages/package-revisions.service.ts`
- Modify: `packages/server/src/scripting-packages/package-revisions.service.spec.ts`
- Modify: `packages/server/src/scripting-packages/package-delivery.service.ts` (constructor wiring only)

**Interfaces:**
- Consumes: Task 3's `PackageSlugIndex`, `loadPackageSlugIndex`, `collectRawPackageReferences`, `resolvePackageReferences`, `slugForPackage`.
- Produces:
  - `PackageClosureResolver(revisionsRepository, storage, packagesRepository)`
  - `ResolvedClosure.slugByPackage: Map<number, string>`
  - `LoadedRevision.slug: string`
  - unknown slug → `BadRequestException('package_dependency_unknown_slug:<slug>')`
  - known slug with no published revision → existing `package_dependency_unpublished`
  - `assertDependenciesEnabled` and `recordPinnedDependencies` resolve both id and slug refs
  - the old numeric-only `collectPackageReferences` is removed; every caller uses `collectRawPackageReferences` + `resolvePackageReferences`

- [ ] **Step 1: Write failing resolver tests**

In `package-closure-resolver.spec.ts`:

```ts
it('resolves a dependency reference written with a slug', async () => {
  const resolver = makeResolver({
    packages: [
      { id: 7, slug: 'root' },
      { id: 9, slug: 'hero' },
    ],
    published: [7, 9],
  });
  const closure = await resolver.resolve(7, 1, 3);
  expect(closure.directDependencyIds).toEqual([9]);
  expect(closure.slugByPackage.get(9)).toBe('hero');
});

it('still resolves a legacy numeric reference', async () => {
  const resolver = makeResolver({ packages: [{ id: 7, slug: '7' }, { id: 9, slug: 'hero' }], published: [7, 9] });
  const closure = await resolver.resolve(7, 1, 3);
  expect(closure.directDependencyIds).toEqual([9]);
});

it('distinguishes an unknown slug from an unpublished package', async () => {
  const unknown = makeResolver({ packages: [{ id: 7, slug: 'root' }] });
  await expect(unknown.resolve(7, 1, 3)).rejects.toThrow(
    'package_dependency_unknown_slug:missing',
  );

  const unpublished = makeResolver({
    packages: [{ id: 7, slug: 'root' }, { id: 9, slug: 'hero' }],
    published: [7],
  });
  await expect(unpublished.resolve(7, 1, 3)).rejects.toThrow(
    'package_dependency_unpublished',
  );
});
```

Also add a reverse-scan test: a package with a slug reference is returned by `findDependentRoomPackages`.

- [ ] **Step 2: Run the resolver test and verify it fails**

Run: `pnpm --filter server exec jest package-closure-resolver`
Expected: FAIL because the resolver has no slug index.

- [ ] **Step 3: Implement slug-aware closure resolution**

- Add the third constructor parameter `packagesRepository`.
- Add a private `loadSlugIndex()` that loads fresh per resolve/scan operation (the resolver instance is long-lived, so do not cache it forever); replace every `collectPackageReferences` caller with `collectRawPackageReferences` + `resolvePackageReferences`.
- Include `slug` when loading revision rows and in `ResolvedClosure.slugByPackage`.
- In `resolve()`, if a raw slug does not resolve, throw `BadRequestException('package_dependency_unknown_slug:<slug>')`; if it resolves but has no published revision, keep `package_dependency_unpublished`.
- `collectRevisionReferences` and `buildReverseReferenceGraph` resolve raw refs. If an unknown slug is found during a global reverse scan, skip that edge and log it; the publish-time resolver is the authoritative error.
- Delete the old numeric-only `collectPackageReferences` and its now-unused numeric regex once all callers are migrated.
- Update the existing `collectPackageReferences` tests to `collectRawPackageReferences` + `resolvePackageReferences`; keep the unsafe-path and comment cases.
- Update `PackageDeliveryService` constructor call to `new PackageClosureResolver(revisionsRepository, storage, packagesRepository)`.

- [ ] **Step 4: Update publish-time checks**

In `PackageRevisionsService`, add a private `slugIndex()` using `loadPackageSlugIndex(this.packagesRepository)` when available, and use `collectRawPackageReferences` + `resolvePackageReferences` in:

- `assertDependenciesEnabled`;
- `recordPinnedDependencies`.

Numeric references behave as before. Unknown slug during publish throws 400 `package_dependency_unknown_slug:<slug>`.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter server exec jest package-closure-resolver package-revisions.service package-delivery.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages/package-closure-resolver.ts packages/server/src/scripting-packages/package-closure-resolver.spec.ts packages/server/src/scripting-packages/package-runtime-references.ts packages/server/src/scripting-packages/package-runtime-references.spec.ts packages/server/src/scripting-packages/package-revisions.service.ts packages/server/src/scripting-packages/package-revisions.service.spec.ts packages/server/src/scripting-packages/package-delivery.service.ts
git commit -m "feat(server): resolve dependency closures by slug"
```

---

### Task 5: Artifact format v2, manifest slug, status slug

**Files:**
- Modify: `packages/shared/src/api/types.ts`
- Modify: `packages/server/src/scripting-packages/package-delivery.service.ts`
- Modify: `packages/server/src/scripting-packages/package-delivery.service.spec.ts`
- Modify: `packages/server/src/scripting-packages/package-revisions.service.ts`
- Modify: `packages/server/src/scripting-packages/package-revisions.service.spec.ts`
- Modify: `packages/server/src/godot-game/status-reporter.ts`
- Modify: `packages/server/src/godot-game/package-sync.service.spec.ts`

**Interfaces:**
- Consumes: Task 4's `ResolvedClosure.slugByPackage`; Task 3's `PackageSlugIndex` and `resolvePackageReferences`.
- Produces:
  - `ARTIFACT_FORMAT_VERSION = 'v2'`
  - artifact path `<packagesFilesDir>/<id>/runtime/v2/<roomId>/<revision>/<artifactKey>/`
  - `PackageManifest.slug` and `PackageRuntimeManifest.slug`
  - `PackageSyncStatus.slug`
  - `rewritePackageReferences(text, { ..., slugByPackage })` targets `user://wired/rooms/<room>/packages/<slug>/<revision>-<artifactKey>/<rest>`
  - `buildSceneDependencies(packageId, files, dependencies, index)` still keys by `"<id>:<path>"`

- [ ] **Step 1: Write failing delivery/manifest tests**

In `package-delivery.service.spec.ts`:

```ts
it('writes the package slug into the runtime manifest', async () => {
  const manifest = await delivery.getRuntimeManifest(7, 1, 3);
  expect(manifest.slug).toBe('hero');
});

it('builds artifacts under runtime/v2', async () => {
  const artifact = await (delivery as any).buildArtifact(7, 1, 3);
  expect(artifact.dir).toContain(path.join('runtime', 'v2'));
});

it('does not serve a v1 cached manifest without slug', async () => {
  await writeOldV1ManifestFixture();
  const manifest = await delivery.getRuntimeManifest(7, 1, 3);
  expect(manifest.slug).toBe('hero');
  expect(manifestPath()).toContain(path.join('runtime', 'v2'));
});
```

In `package-runtime-references.spec.ts` add:

```ts
it('rewrites a reference into the slug runtime directory', () => {
  const text = 'path="res://packages/42/scene.tscn"';
  const rewritten = rewritePackageReferences(text, {
    roomId: 3,
    revisionByPackage: new Map([[42, 2]]),
    artifactKeyByPackage: new Map([[42, 'a'.repeat(64)]]),
    slugByPackage: new Map([[42, 'hero']]),
  });
  expect(rewritten).toContain(
    `user://wired/rooms/3/packages/hero/2-${'a'.repeat(64)}/scene.tscn`,
  );
});

it('builds scene dependencies through the slug index', () => {
  const index = {
    bySlug: new Map([['hero', 9]]),
    byId: new Map([[9, 'hero']]),
  };
  expect(
    buildSceneDependencies(7, rootFiles, dependencyFiles, index),
  ).toEqual({ 'scenes/main.tscn': ['9:scenes/hero.tscn'] });
});
```

In `package-revisions.service.spec.ts` assert `getManifest()` and `getManifestForRevision()` include the package slug.

In `package-sync.service.spec.ts` assert `getStatuses()` returns `slug: 'hero'` for the package.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm --filter server exec jest package-delivery.service package-revisions.service package-sync.service`
Expected: FAIL because manifests and status lack slug and paths still use `v1`.

- [ ] **Step 3: Implement v2 artifacts and slug propagation**

- Add `slug: string` to `PackageManifest`, `PackageRuntimeManifest`, and `PackageSyncStatus` in `packages/shared/src/api/types.ts`.
- Change `ARTIFACT_FORMAT_VERSION` to `'v2'`.
- Ensure `pruneArtifacts()` scans only the current `runtime/v2` directory; old `runtime/v1` trees are left orphaned.
- Add `slug: string` to `RuntimeArtifact`.
- In `buildArtifact()`, read `resolved.slugByPackage.get(resolved.packageId)`; throw `Error('package_slug_missing:<id>')` if absent; pass `slugByPackage` to `rewritePackageReferences`; build a `PackageSlugIndex` from `resolved.slugByPackage` and pass it to `buildSceneDependencies`; write the slug into the manifest body.
- In `toManifest()`, accept `packageSlug` and write `slug`; pass `pkg.slug` in `getManifest()` and `getManifestForRevision()`.
- In `StatusReporter.toStatus`, add `slug: pkg.slug` to `base`.
- Do not change `PackageRuntimeDependency`; dependency folders come from each dependency's own runtime manifest.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter server exec jest package-delivery.service package-revisions.service package-sync.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/types.ts packages/server/src/scripting-packages/package-delivery.service.ts packages/server/src/scripting-packages/package-delivery.service.spec.ts packages/server/src/scripting-packages/package-revisions.service.ts packages/server/src/scripting-packages/package-revisions.service.spec.ts packages/server/src/scripting-packages/package-runtime-references.ts packages/server/src/scripting-packages/package-runtime-references.spec.ts packages/server/src/godot-game/status-reporter.ts packages/server/src/godot-game/package-sync.service.spec.ts
git commit -m "feat(server): carry package slug in manifests and artifacts"
```

---

### Task 6: Frontend API, package filesystem, sync and package data use slug

**Files:**
- Modify: `frontend/src/api/services/scripting-packages.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.test.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/package-sync.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/package-sync.test.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx` (temporary inline slug field only)

**Interfaces:**
- Consumes: Task 1 shared slug fields.
- Produces:
  - `checkSlugAvailability(slug: string): Promise<{ slug: string; available: boolean; reason?: 'taken' | 'retired' }>` (controller method; it wraps the API service's `checkPackageSlugAvailability`)
  - `PackageFileSystem` path methods take `slug: string`
  - `publishPackageFiles(packageId: number, slug: string, files: PackageFileSystem, onProgress?)`
  - `reconcilePackageRevision(packageId: number, slug: string, files: PackageFileSystem, baseline, options?)`
  - `syncPackageRevision(packageId: number, slug: string, files: PackageFileSystem, onProgress?)`
  - `RoomPackageEntry.slug: string`
  - `createPackage(name, authorId, version, slug)`
  - `checkSlugAvailability(slug: string): Promise<{ slug: string; available: boolean; reason?: 'taken' | 'retired' }>`
  - `slugOf(packageId: number): string`

- [ ] **Step 1: Write failing filesystem/sync tests**

In `godot-packages-fs.test.ts`:

```ts
it('creates and addresses a package directory by slug', async () => {
  const fs = createPackageFileSystem({ bridge, getEngine, projectRoot });
  await fs.createPackageDir('hero');
  expect(fs.packageDir('hero')).toBe(`${projectRoot}/packages/hero`);
  expect(bridge.request).toHaveBeenCalledWith(
    expect.any(String),
    'createDir',
    expect.objectContaining({ packageSlug: 'hero' }),
  );
});

it('rejects an invalid slug before calling the bridge', async () => {
  const fs = createPackageFileSystem({ bridge, getEngine, projectRoot });
  await expect(fs.createPackageDir('../escape')).rejects.toThrow();
  expect(bridge.request).not.toHaveBeenCalled();
});
```

In `package-sync.test.ts` assert `publishPackageFiles(7, 'hero', files)` calls `files.collectFiles('hero')` and uploads with packageId 7, and `reconcilePackageRevision(7, 'hero', files, baseline)` applies `manifest.slug`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs package-sync`
Expected: FAIL because methods still take numeric ids.

- [ ] **Step 3: Implement slug-aware FS, sync and state**

- Add `checkPackageSlugAvailability` to the API service using `GET /scripting-packages/slug-availability`.
- In `godot-packages-fs.ts`, add `assertPackageSlug` (`^[a-z0-9_]{1,64}$`), change path methods to `slug: string`, send `{ packageSlug: slug }`, and expect `.<slug>.staging`/`.<slug>.previous`. `applyPackageRevision` uses `manifest.slug` for `replaceContents`.
- In `package-sync.ts`, add the `slug` parameter to publish/reconcile/sync and pass it to FS calls.
- In `use-room-packages.ts`, add `slug` to `RoomPackageEntry`, `packageFromStatus`, and `buildEntries`; change `createPackage` to accept and send slug, then `files.createPackageDir(created.slug)`; add `checkSlugAvailability(slug)` delegating to the API service; add `slugOf(packageId)` that reads from the current package list and throws `Error('package_slug_missing:<id>')`; pass `slugOf(id)` into all FS/sync calls.
- In `PackagesTab.tsx`, add a temporary `slug` input to the existing inline form and call `packages.createPackage(name, authorId, version, slug)`. Task 8 replaces this form with a modal.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs package-sync use-room-packages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/services/scripting-packages.ts "frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.ts" "frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.test.ts" "frontend/src/app/room/[room_code]/(godot)/package-sync.ts" "frontend/src/app/room/[room_code]/(godot)/package-sync.test.ts" "frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts" "frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx" "frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx"
git commit -m "feat(frontend): use package slug for editor files"
```

---

### Task 7: Frontend metadata update action

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx`

**Interfaces:**
- Consumes: Task 6's `RoomPackageEntry`, reducer and `updateScriptingPackage`.
- Produces:
  - reducer action `{ type: 'updated'; package: ScriptingPackage }`
  - `updatePackageMetadata(packageId: number, patch: { name?: string; version?: string }): Promise<ScriptingPackage>`
  - updating only `name`/`version`/`slug` in entries without touching status, progress or local changes

- [ ] **Step 1: Write failing hook/reducer tests**

Add to `use-room-packages.test.tsx`:

```ts
it('updates only metadata in the entry', async () => {
  updateScriptingPackage.mockResolvedValue({
    id: 7,
    slug: 'hero',
    name: 'Renamed',
    version: '1.2.3',
  });
  const { result } = renderHook(...);
  await act(() => result.current.updatePackageMetadata(7, { name: 'Renamed' }));
  expect(result.current.entries[0]).toMatchObject({
    packageId: 7,
    slug: 'hero',
    name: 'Renamed',
    version: '1.2.3',
    status: 'ready',
    localChanges: [],
  });
});

it('keeps local changes and status when metadata changes', async () => {
  // seed entry with localChanges: ['scene.tscn'] and status: 'warning'
  // call updatePackageMetadata and assert those fields are unchanged
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: FAIL because `updatePackageMetadata` and the reducer action do not exist.

- [ ] **Step 3: Implement the update path**

- Add `updateScriptingPackage` import and `updatePackageMetadata` to the controller; trim name/version and reject empty values locally with `Error('package_metadata_empty')`.
- Dispatch `{ type: 'updated', package }` after the API resolves.
- In the reducer, replace the package in `state.packages` by id; rebuild only the matching entry with `name`, `version`, `slug`, preserving every other field.
- Put API errors into `state.actions[packageId].error`, creating the action record if it does not exist yet, and rethrow.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts" "frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx"
git commit -m "feat(frontend): edit package metadata"
```

---

### Task 8: Packages tab modal creation and inline name/version pencils

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`

**Interfaces:**
- Consumes: Task 6's `createPackage(name, authorId, version, slug)`, controller `checkSlugAvailability(slug)`; Task 7's `updatePackageMetadata`; Task 6's `RoomPackageEntry.slug`.
- Produces: modal creation and inline metadata editing UI.

- [ ] **Step 1: Write failing UI tests**

Add to `PackagesTab.test.tsx`:

```ts
it('opens the creation modal from the header button', async () => {
  render(<PackagesTab packages={packages} authorId={42} />);
  await user.click(screen.getByRole('button', { name: 'Создать пакет' }));
  expect(screen.getByLabelText('Slug')).toBeInTheDocument();
});

it('shows a taken slug and disables submit', async () => {
  packages.checkSlugAvailability.mockResolvedValue({
    slug: 'hero',
    available: false,
    reason: 'taken',
  });
  render(<PackagesTab packages={packages} authorId={42} />);
  await user.click(screen.getByRole('button', { name: 'Создать пакет' }));
  await user.type(screen.getByLabelText('Slug'), 'hero');
  await waitFor(() => expect(screen.getByText('Slug уже занят')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Создать' })).toBeDisabled();
});

it('saves an edited package name', async () => {
  render(<PackagesTab packages={packages} authorId={42} />);
  await user.click(screen.getByRole('button', { name: 'Редактировать имя пакета' }));
  await user.clear(screen.getByLabelText('Имя пакета'));
  await user.type(screen.getByLabelText('Имя пакета'), 'Renamed');
  await user.keyboard('{Enter}');
  expect(updatePackageMetadata).toHaveBeenCalledWith(7, { name: 'Renamed' });
});

it('renders the slug instead of the numeric id', () => {
  render(<PackagesTab packages={packages} authorId={42} />);
  expect(screen.getByText('#hero')).toBeInTheDocument();
  expect(screen.queryByText('#7')).not.toBeInTheDocument();
});
```

Add a test that Esc cancels editing and that an empty name/version is not submitted.

- [ ] **Step 2: Run the UI tests and verify they fail**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: FAIL because the inline form and `#id` are still rendered.

- [ ] **Step 3: Replace the inline form with the modal**

- Remove the inline create card and its state.
- Header button «Создать пакет» opens an animate-ui `Dialog`.
- Modal fields: `Имя пакета`, `Версия` (default `0.1.0`), `Slug`.
- Slug input lowercases typed text; local regex validation; debounce 300 ms to `packages.checkSlugAvailability`.
- States: `checking`, `available`, `taken`, `retired`, `invalid`, `error`; Russian copy for `taken` («Slug уже занят») and `retired` («Этот slug был удалён и не может быть использован снова»).
- Ignore an availability response if the slug field changed while the request was in flight.
- Submit disabled while name empty, slug invalid/checking/taken/retired, creating, `!authorId`, or `!fsReady`.
- On success close/reset; on error show `createError` inside the modal.
- Update the header copy to `packages/<slug>` and the empty state to open the modal.

- [ ] **Step 4: Add inline name/version editing**

- Add `Pencil` buttons with `aria-label="Редактировать имя пакета"` and `aria-label="Редактировать версию"`.
- Each opens an inline input with save/cancel; Enter saves, Esc cancels; empty values are rejected.
- During request show a spinner and disable save/cancel; render errors in the card.
- Keep the pencils visible to every viewer; the server enforces edit rights, and a 403 is rendered in the card like the existing action errors.
- Display `#{entry.slug}` in monospace with `title="Slug пакета"`.
- Change the delete confirmation text to `#{entry.slug}`.

- [ ] **Step 5: Run the focused tests**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx" "frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx"
git commit -m "feat(frontend): add package creation modal and metadata editing"
```

---

### Task 9: Godot editor bridge uses slug folders

**Files:**
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd`
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd`
- Modify: `packages/server/godot_project/_wired/tests/package_fs_smoke.gd`

**Interfaces:**
- Consumes: Task 6's bridge payload `{ packageSlug: string }`.
- Produces:
  - `WiredPackageFs.package_dir(package_slug: String)`
  - `WiredPackageFs.is_valid_slug(slug: String) -> bool`
  - all `op_*` methods take `package_slug: String`
  - `plugin.gd` reads `packageSlug` and parses `res://packages/<slug>/...`

- [ ] **Step 1: Update the smoke test to the slug API**

In `package_fs_smoke.gd`, change every `WiredPackageFs.op_*(1)` / `package_dir(1)` to `"hero"` (and use `"7"` where a numeric legacy case is useful). Keep a positive assertion that `"7"` is a valid slug. Add:

```gdscript
func _test_invalid_slug() -> void:
    var problems: Array = []
    for slug in ["", "../escape", "Hero", "hero-one", "hero one"]:
        _expect(
            problems,
            not WiredPackageFs.is_valid_slug(slug),
            "%s must be an invalid slug" % [slug],
        )
    _report("invalid slugs are rejected", problems)
```

Call `_test_invalid_slug()` from `_initialize()`.

- [ ] **Step 2: Run the smoke test and verify it fails**

Run (pinned Godot 4.8-beta2 binary):

```bash
godot --headless --path packages/server/godot_project/_wired --script res://tests/package_fs_smoke.gd --quit-after 600
```

Expected: FAIL because `WiredPackageFs` still expects integers.

- [ ] **Step 3: Convert `package_fs.gd` to slug paths**

- Replace `is_valid_id` with `is_valid_slug` using `^[a-z0-9_]{1,64}$`.
- Change `package_dir`, `staging_dir`, `previous_dir`, `package_relative_path`, and every `op_*` signature to `package_slug: String`.
- Invalid slug returns `{"error": "invalid_slug"}` (or the existing error shape) without touching the filesystem.
- Keep `root_override` behavior and editor metadata handling unchanged.

- [ ] **Step 4: Convert `plugin.gd`**

- Read `params.get("packageSlug", "")` instead of `packageId`.
- Replace `_package_id_of_path` with `_package_slug_of_path`:
  - require prefix `res://packages/`;
  - take the first segment;
  - validate with `WiredPackageFs.is_valid_slug`;
  - ignore `.staging`/`.previous`.
- Group selected delete paths by slug and call `op_delete` with the slug.
- Toast text becomes `res://packages/<slug>/`.

- [ ] **Step 5: Run the smoke test**

Run the same Godot command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd packages/server/godot_project/_wired/tests/package_fs_smoke.gd
git commit -m "feat(godot): address editor package folders by slug"
```

---

### Task 10: Godot runtime artifact store and package manager use slug folders

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/artifact_store.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/package_manifest.gd`
- Create: `packages/server/godot_project/_wired/tests/artifact_store_smoke.gd`
- Modify: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd`
- Modify: `packages/server/godot_project/_wired/tests/state_persistence_smoke.gd`

**Interfaces:**
- Consumes: Task 5's manifests with `slug`.
- Produces:
  - `ArtifactStore` methods take explicit `slug: String`: `package_dir`, `staging_dir`, `revision_dir`, `stage`, `swap`, `prune`, `highest_revision`, `remove_files`, `remove_tree`
  - `PackagesManager._slugs: Dictionary`
  - `PackagesManager` loads/saves `user://wired/rooms/<room>/package_slugs.json`
  - `PackagesManager._sync_package_chain` fetches the runtime manifest, validates slug, remembers it, then calls `highest_revision(slug)`
  - `PackageManifest.validate_runtime(manifest, package_id)` requires a valid `slug`

- [ ] **Step 1: Write the failing artifact-store smoke test**

Create `artifact_store_smoke.gd` with a temporary root and these assertions:

```gdscript
func _test_paths_are_slug_based() -> void:
    var store := ArtifactStore.new(func(): return ROOT)
    _expect(store.package_dir("hero") == ROOT + "/hero", "package dir uses slug")
    _expect(store.revision_dir("hero", 2, "abc") == ROOT + "/hero/2-abc", "revision dir uses slug")

func _test_invalid_slug_is_rejected() -> void:
    var store := ArtifactStore.new(func(): return ROOT)
    for slug in ["", "../escape", "Hero", "hero-one"]:
        _expect(store.package_dir(slug) == "", "%s must not resolve to a directory" % slug)
        _expect(store.highest_revision(slug) == 0, "%s must not enumerate the root" % slug)
```

- [ ] **Step 2: Run it and verify it fails**

Run:

```bash
godot --headless --path packages/server/godot_project/_wired --script res://tests/artifact_store_smoke.gd --quit-after 600
```

Expected: FAIL because `ArtifactStore` methods take numeric ids.

- [ ] **Step 3: Convert `ArtifactStore`**

- Change all public methods to take `slug: String`.
- Add `is_valid_slug` same regex; invalid/empty returns `""`, `0`, or a no-op depending on return type, and never touches `<root>` itself.
- `package_dir(slug) = packages_root().path_join(slug)`; everything else derives from it.
- `remove_tree`/`remove_files` return without action for empty slug.

- [ ] **Step 4: Update `PackagesManager`**

- Add `_slugs: Dictionary` (numeric id keys) and `_slug_index_path()`.
- Clear `_slugs` when the room changes, then load `package_slugs.json` in `set_room()`/`configure()`, converting JSON string keys to ints; save atomically (write `.tmp`, then rename) after each successful apply.
- `packages_dir(id)`, `revision_dir(id, ...)`, `runtime_path(id, ...)` look up `_slugs.get(id, "")` and pass it to `ArtifactStore`. An empty slug returns `""` for paths.
- `_sync_package_chain`: call `fetch_runtime_manifest` first, validate it, call `_remember_slug(package_id, manifest.slug)`, then call `highest_revision(slug)` and the rest of the apply path. Remove any pre-manifest `highest_revision(package_id)` call.
- `forget_package(id, purge)`: if `_slugs` has no entry, return without touching any path; otherwise remove that slug directory.
- State dictionaries and `applied_packages()` keys stay numeric.

- [ ] **Step 5: Require slug in `PackageManifest.validate_runtime`**

Add a check that `manifest.slug` is a non-empty string matching `^[a-z0-9_]{1,64}$`; return a validation error if absent.

- [ ] **Step 6: Update `packages_manager_smoke.gd` and `state_persistence_smoke.gd`**

- Mock runtime manifests include `"slug": "hero"` (or another valid slug).
- Expected folders become `user://.../packages/<slug>/<revision>-<key>`.
- Add a test that an empty/unknown slug does not enumerate or delete the packages root.
- Add a test that `package_slugs.json` survives a simulated restart and lets `forget_package` purge the right directory.
- Add a test that two packages with different slugs keep independent highest revisions, even when a stale directory for another slug exists.
- Keep assertions that `applied_packages()` keys are `"7"`, not `"hero"`.

- [ ] **Step 7: Run Godot smoke tests**

```bash
godot --headless --path packages/server/godot_project/_wired --script res://tests/artifact_store_smoke.gd --quit-after 600
godot --headless --path packages/server/godot_project/_wired --script res://tests/packages_manager_smoke.gd --quit-after 600
godot --headless --path packages/server/godot_project/_wired --script res://tests/state_persistence_smoke.gd --quit-after 2
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/artifact_store.gd packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd packages/server/godot_project/_wired/_wired/scripts/global/package_manifest.gd packages/server/godot_project/_wired/tests/artifact_store_smoke.gd packages/server/godot_project/_wired/tests/packages_manager_smoke.gd packages/server/godot_project/_wired/tests/state_persistence_smoke.gd
git commit -m "feat(godot): run packages from slug folders"
```

---

### Task 11: Full verification and end-to-end check

**Files:**
- No production files expected. Fix only test fixtures or type errors uncovered here.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified build and test state.

- [ ] **Step 1: Run server tests and typecheck**

```bash
pnpm --filter server test
pnpm --filter server build
```

Expected: all Jest suites pass; `room-runtime.integration` remains skipped unless opted in; build succeeds.

- [ ] **Step 2: Run frontend tests, typecheck and lint**

```bash
pnpm --filter frontend test
pnpm check-types:frontend
pnpm --filter frontend lint
```

Expected: all Vitest files pass, types pass, lint passes without auto-fix changes.

- [ ] **Step 3: Run all relevant Godot smoke tests**

```bash
godot --headless --path packages/server/godot_project/_wired --script res://tests/package_fs_smoke.gd --quit-after 600
godot --headless --path packages/server/godot_project/_wired --script res://tests/artifact_store_smoke.gd --quit-after 600
godot --headless --path packages/server/godot_project/_wired --script res://tests/packages_manager_smoke.gd --quit-after 600
godot --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/package_entry_smoke.gd --quit-after 2
```

Expected: all PASS.

- [ ] **Step 4: Manual end-to-end check**

Start backend and frontend as documented (`pnpm dev:server`, `pnpm --filter frontend dev -- -p 3001`), then:

1. Open a room → Packages tab.
2. Create a package with slug `hero_controller`; verify the modal validates, checks availability, and closes on success.
3. Verify `res://packages/hero_controller/` appears in the Godot editor and `packages/<slug>` is shown in the tab.
4. Rename the package and version via pencils; verify the card updates and the slug/folder do not change.
5. Create a second package with slug `hero_weapon`; add a file in `hero_controller` referencing `res://packages/hero_weapon/...`; publish and emit.
6. Open the Game tab; verify the runtime folder is `user://wired/rooms/<room>/packages/hero_controller/...` and the dependency applies.
7. Try creating a package with an existing slug and with a deleted package's slug; both are blocked with the correct message.
8. Verify an existing package (slug `str(id)`) still opens with its numeric folder and numeric references.

- [ ] **Step 5: Commit any verification fixes**

```bash
git add <only the test fixture files changed in this task>
git commit -m "test: verify package slug flow"
```

Only commit if this task changed files; otherwise skip the commit. Never use `git add -A` here: `RoomPageClient.tsx` contains uncommitted user work and must not be staged or overwritten.
