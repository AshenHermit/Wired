# Package Hot Reload and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make package revisions hot-reload static scenes, dynamic entities and player components; add room-level disable/enable and permanent delete with a confirmed animate-ui modal.

**Architecture:** The backend owns an authoritative active package set (`ScriptingPackage.enabled`). Publish/disable/enable/delete each become one runtime control command (`package`, `unload`) plus one client event (`package_revision`, `package_removed`). The Godot server parks dynamic entities (id + state) before reloading a package and restores them with the new context; clients converge on the server's package map through the world snapshot, pruning only entities whose package stamp is stale.

**Tech Stack:** NestJS 11 + TypeORM, Godot 4.8 GDScript, Next.js 16 + React 19, Jest, Vitest, GDScript headless smoke tests.

**Spec:** `docs/superpowers/specs/2026-11-01-package-hot-reload-and-lifecycle-design.md`

## Global Constraints

- Russian UI copy, UTF-8, existing tone (`Пакеты`, `Убрать из редактора`).
- Hashids: frontend package ids are plain numbers in these APIs; do not touch `hash-utils.ts`.
- Server Prettier: single quotes, trailing commas; server lint auto-fixes, frontend lint does not.
- No migrations: `DB_SYNC=1` adds `enabled` with a default; the column must be `@Column({ default: true })`.
- Only `PackageSyncService` may write runtime stdin; all new commands go through `RoomRuntimeSession.sendCommand`.
- Never delete package files on disable; delete them only on permanent delete.
- Default branch is `master`; user's WIP changes must stay intact (uncommitted `GameTab.tsx`, `players_manager.gd`, `main_scene.gd`, `game-room.service.ts`, tests).
- Run server commands from `packages/server` via pnpm; the Godot binary must be 4.8-beta2.

## Review Focus

1. **Disable/delete while the room runtime is stopped** — the next start must purge save-file records of deleted packages, and no command may throw when there is no process.
2. **Lost `package_removed` event** — a reconnecting client must converge through the snapshot without deleting entities created after the snapshot was built.
3. **Same revision, new artifact key** (dependency republish) — live entities must be replaced by artifact stamp, not by revision number.
4. **Enabled package depending on a disabled one** — disable keeps files on disk; publish and delete must answer `409` with `{ packageId/dependencyId, name }`.
5. **Client cannot download a package from the server map** — no infinite loop, no applying players/dynamic state while `packages_match` is false, and recovery once the package is deleted.
6. **Local-only and snapshot-repaired players** during component rebuild — parked component state must not leak between packages or peers.

---

### Task 1: `enabled` in shared contract, entity and DTO

**Files:**
- Modify: `packages/server/src/database/entities/scripting-package.entity.ts`
- Modify: `packages/shared/src/api/types.ts`
- Modify: `packages/server/src/scripting-packages/dto/update-scripting-package.dto.ts`
- Test: `packages/server/src/scripting-packages/update-scripting-package.dto.spec.ts` (create)

**Interfaces:**
- Produces: `ScriptingPackage.enabled: boolean`; `UpdateScriptingPackagePayload` gains `enabled?: boolean`; `ScriptingPackage.enabled` default true in DB.
- Produces: `UpdateScriptingPackageDto` with fields `name?`, `version?`, `description?`, `dependencies?`, `scripts?`, `physicalFiles?`, `parentPackageId?`, `enabled?`.

- [ ] **Step 1: Write the failing DTO test**

Create `update-scripting-package.dto.spec.ts` following the style of `create-room.dto.spec.ts` (`plainToInstance` + `validate`):

```ts
it('accepts a boolean enabled flag', async () => {
  const dto = plainToInstance(UpdateScriptingPackageDto, { enabled: false });
  expect(await validate(dto)).toHaveLength(0);
});

it('rejects a non-boolean enabled flag', async () => {
  const dto = plainToInstance(UpdateScriptingPackageDto, { enabled: 'false' });
  expect((await validate(dto)).map((e) => e.property)).toContain('enabled');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter server exec jest update-scripting-package.dto`
Expected: FAIL — `enabled` is not validated / `UpdateScriptingPackageDto` has no `enabled`.

- [ ] **Step 3: Add the field in three places**

In `scripting-package.entity.ts` after `physicalFiles`:

```ts
@ApiProperty({ description: 'package is active in its room' })
@Column({ default: true })
enabled: boolean;
```

In `packages/shared/src/api/types.ts`, add `enabled: boolean;` to `ScriptingPackage`, and change the update payload to:

```ts
export type UpdateScriptingPackagePayload = Partial<CreateScriptingPackagePayload> & {
  enabled?: boolean;
};
```

Replace `UpdateScriptingPackageDto` with an explicit class (do not use `PartialType`) listing the existing optional fields plus:

```ts
@ApiPropertyOptional({ description: 'package is active in its room' })
@IsOptional()
@IsBoolean()
enabled?: boolean;
```

Keep the same decorators/imports as `create-scripting-package.dto.ts`.

- [ ] **Step 4: Run the test, server typecheck and frontend types**

Run: `pnpm --filter server exec jest update-scripting-package.dto`
Expected: PASS.

Run: `pnpm --filter server build`
Expected: exit 0.

Run: `pnpm check-types:frontend`
Expected: exit 0 (fix any object literal that now misses `enabled` by adding it where a full `ScriptingPackage` is built — only test fixtures usually need it).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/database/entities/scripting-package.entity.ts packages/shared/src/api/types.ts packages/server/src/scripting-packages/dto/update-scripting-package.dto.ts packages/server/src/scripting-packages/update-scripting-package.dto.spec.ts
git commit -m "feat(packages): add enabled flag to the package contract"
```

---

### Task 2: Runtime control commands for unload and the room package list

**Files:**
- Modify: `packages/server/src/godot-game/room-runtime.session.ts`
- Modify: `packages/server/src/godot-game/room-runtime.service.ts`
- Test: `packages/server/src/godot-game/room-runtime.service.spec.ts`

**Interfaces:**
- Produces: `RoomRuntimeSession.sendPackageUnload(packageId: number, purge: boolean): boolean` → `unload <id>` / `unload <id> purge`.
- Produces: `RoomRuntimeSession.sendRoomPackages(packageIds: number[]): boolean` → `room-packages 3,7`; empty array → `room-packages`.
- Produces: `RoomRuntimeService.sendPackageUnload(roomId: string, packageId: number, purge: boolean): boolean` and `RoomRuntimeService.sendRoomPackages(roomId: string, packageIds: number[]): boolean`, both `false` for unknown room.

- [ ] **Step 1: Write the failing service tests**

Next to the existing `sendPackage` tests (`room-runtime.service.spec.ts:673-700`), add:

```ts
it('sends unload with and without purge', () => {
  expect(service.sendPackageUnload('room-1', 42, false)).toBe(true);
  expect(session.sendCommand).toHaveBeenCalledWith('unload 42');
  expect(service.sendPackageUnload('room-1', 42, true)).toBe(true);
  expect(session.sendCommand).toHaveBeenCalledWith('unload 42 purge');
});

it('sends the full room package list and rejects invalid ids', () => {
  expect(service.sendRoomPackages('room-1', [3, 7, 3])).toBe(true);
  expect(session.sendCommand).toHaveBeenCalledWith('room-packages 3,7');
  expect(service.sendRoomPackages('room-1', [3, 0])).toBe(false);
  expect(service.sendRoomPackages('room-missing', [3])).toBe(false);
});
```

Use the spec's existing session double; if it exposes `sendPackage` rather than `sendCommand`, assert through the double's recorded calls after wiring `sendCommand`.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter server exec jest room-runtime.service`
Expected: FAIL — `sendPackageUnload is not a function`.

- [ ] **Step 3: Implement the commands**

In `room-runtime.session.ts`, next to `sendPackage` (line 468):

```ts
sendPackageUnload(packageId: number, purge: boolean): boolean {
  if (!Number.isInteger(packageId) || packageId <= 0) return false;
  return this.sendCommand(
    purge ? `unload ${packageId} purge` : `unload ${packageId}`,
  );
}

sendRoomPackages(packageIds: number[]): boolean {
  const ids = [...new Set(packageIds)];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return false;
  return this.sendCommand(
    ids.length > 0 ? `room-packages ${ids.join(',')}` : 'room-packages',
  );
}
```

In `room-runtime.service.ts`, mirror `sendPackage` (line 87):

```ts
sendPackageUnload(roomId: string, packageId: number, purge: boolean): boolean {
  return this.registry.get(roomId)?.sendPackageUnload(packageId, purge) ?? false;
}

sendRoomPackages(roomId: string, packageIds: number[]): boolean {
  return this.registry.get(roomId)?.sendRoomPackages(packageIds) ?? false;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter server exec jest room-runtime.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/godot-game/room-runtime.session.ts packages/server/src/godot-game/room-runtime.service.ts packages/server/src/godot-game/room-runtime.service.spec.ts
git commit -m "feat(game): add unload and room-packages runtime commands"
```

---

### Task 3: Sync service lifecycle — statuses, disable, enable, delete

**Files:**
- Modify: `packages/server/src/godot-game/package-sync.types.ts`
- Modify: `packages/server/src/godot-game/sync-record-store.ts`
- Modify: `packages/server/src/godot-game/status-reporter.ts`
- Modify: `packages/server/src/godot-game/package-sync.service.ts`
- Modify: `packages/shared/src/api/types.ts` (`PackageSyncStatus`)
- Test: `packages/server/src/godot-game/package-sync.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 runtime methods; Task 1 `enabled`.
- Produces: `PackageRevisionDispatcher` also declares `packageEnabledChanged(packageId: number): Promise<void>` and `packageRemoved(packageId: number, roomId: number): void`.
- Produces: `SyncRecordStore.remove(roomId: string, packageId: number): boolean`.
- Produces: `StatusReporter.toStatus(pkg, roomId, revision: number | null, publishedAt: Date | null)`.
- Produces: `PackageSyncStatus { enabled: boolean; revision: number; publishedAt: string | null; ... }` — unpublished/disabled room packages appear with `revision: 0`, `state: 'published'`, `runtime.state: 'pending'`.
- Produces: `PackageSyncService.packageEnabledChanged(packageId)`, `packageRemoved(packageId, roomId)`; `roomPackages(roomId, enabledOnly = true)`.

- [ ] **Step 1: Write failing tests for the four transitions**

In `package-sync.service.spec.ts` (reuse `roomPackage`, `publishRevision`, `runtime` mock; extend the mock with `sendPackageUnload`, `sendRoomPackages`):

```ts
it('deactivates a disabled package and drops its record', async () => {
  packages.findOne.mockResolvedValue({ ...roomPackage, enabled: false });
  await service.packageEnabledChanged(42);
  expect(runtime.sendPackageUnload).toHaveBeenCalledWith('7', 42, false);
  expect(service['store'].get('7', 42)).toBeUndefined();
});

it('reconciles an enabled package from its latest published revision', async () => {
  packages.findOne.mockResolvedValue({ ...roomPackage, enabled: true });
  publishRevision(42, 3);
  await service.packageEnabledChanged(42);
  expect(runtime.sendPackage).toHaveBeenCalledWith('7', 42, 3);
});

it('purges a removed package', () => {
  service.packageRemoved(42, 7);
  expect(runtime.sendPackageUnload).toHaveBeenCalledWith('7', 42, true);
});

it('reports disabled and unpublished packages with enabled flag', async () => {
  packages.find.mockResolvedValue([
    { ...roomPackage, enabled: false },
    { id: 43, name: 'Draft', room: { id: 7 }, enabled: true },
  ]);
  const statuses = await service.getStatuses('7');
  expect(statuses).toEqual([
    expect.objectContaining({ packageId: 42, enabled: false, revision: 0, publishedAt: null }),
    expect.objectContaining({ packageId: 43, enabled: true, revision: 0 }),
  ]);
});

it('does not dispatch a published revision of a disabled package', async () => {
  packages.findOne.mockResolvedValue({ ...roomPackage, enabled: false });
  await service.revisionPublished(42, 3);
  expect(runtime.sendPackage).not.toHaveBeenCalled();
});

it('announces all room package ids including disabled ones on runtime ready', async () => {
  runtime.getRuntime.mockReturnValue({ state: 'running' });
  packages.find.mockResolvedValue([
    { ...roomPackage, enabled: true },
    { id: 43, name: 'Off', room: { id: 7 }, enabled: false },
  ]);
  await service.onRuntimeReady('7');
  expect(runtime.sendRoomPackages).toHaveBeenCalledWith('7', [42, 43]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter server exec jest package-sync.service`
Expected: FAIL — missing methods / missing `enabled` in statuses.

- [ ] **Step 3: Implement store, reporter and service**

`sync-record-store.ts`:

```ts
remove(roomId: string, packageId: number): boolean {
  return this.recordsByKey.delete(SyncRecordStore.key(roomId, packageId));
}
```

`status-reporter.ts` — `toStatus` gains nullable inputs and `enabled`:

```ts
toStatus(
  pkg: ScriptingPackage,
  roomId: string,
  revision: number | null,
  publishedAt: Date | null,
): PackageSyncStatus {
  const enabled = pkg.enabled !== false;
  const base = {
    packageId: pkg.id,
    name: pkg.name,
    enabled,
    revision: 0,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
  };
  if (revision === null) {
    return {
      ...base,
      state: 'published',
      runtime: { state: 'pending', revision: 0, error: null, updatedAt: null },
      clients: [],
    };
  }
  const record = this.store.get(roomId, pkg.id);
  // rest unchanged, but spread `base` and set `revision`
}
```

`packages/shared/src/api/types.ts` — `PackageSyncStatus` becomes:

```ts
export interface PackageSyncStatus {
  packageId: number;
  name: string;
  enabled: boolean;
  revision: number;
  publishedAt: string | null;
  state: PackageRevisionSyncState;
  runtime: PackageRuntimeSyncStatus;
  clients: PackageClientSyncStatus[];
}
```

`package-sync.service.ts`:

```ts
async packageEnabledChanged(packageId: number): Promise<void> {
  const pkg = await this.packages.findOne({
    where: { id: packageId },
    relations: { room: true },
  });
  if (!pkg?.room) return;
  const roomId = String(pkg.room.id);
  if (pkg.enabled === false) {
    this.store.remove(roomId, packageId);
    this.runtime.sendPackageUnload(roomId, packageId, false);
    this.logger.log(`package ${packageId} disabled in room ${roomId}`);
    return;
  }
  await this.reconcileRoom(roomId);
}

packageRemoved(packageId: number, roomId: number): void {
  const id = String(roomId);
  this.store.remove(id, packageId);
  this.runtime.sendPackageUnload(id, packageId, true);
  this.logger.log(`package ${packageId} removed from room ${id}`);
}
```

Also:
- `revisionPublished`: after the package lookup, `if (pkg.enabled === false) { this.logger.log(...); return; }`.
- `getStatuses`: use `roomPackages(roomId, false)` and `toStatus(pkg, roomId, revision?.revision ?? null, revision?.publishedAt ?? null)`.
- `roomPackages(roomId: string, enabledOnly = true)`: `where: { room: { id: Number(roomId) }, ...(enabledOnly ? { enabled: true } : {}) }`.
- `onRuntimeReady`: after `reconcileRoom(roomId, true)`, call `this.announceRoomPackages(roomId)`:

```ts
private async announceRoomPackages(roomId: string): Promise<void> {
  const roomPackages = await this.roomPackages(roomId, false);
  this.runtime.sendRoomPackages(roomId, roomPackages.map((pkg) => pkg.id));
}
```

Wire it without unhandled rejections, matching the existing observer style (`.catch` + log).

Keep `package-sync.types.ts` imports unchanged; add the two methods to `PackageRevisionDispatcher`.

- [ ] **Step 4: Run the suite and the typechecks**

Run: `pnpm --filter server exec jest package-sync.service`
Expected: PASS (existing tests may need `enabled: true` in `roomPackage`).

Run: `pnpm --filter server build` and `pnpm check-types:frontend`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/godot-game/package-sync.types.ts packages/server/src/godot-game/sync-record-store.ts packages/server/src/godot-game/status-reporter.ts packages/server/src/godot-game/package-sync.service.ts packages/server/src/godot-game/package-sync.service.spec.ts packages/shared/src/api/types.ts
git commit -m "feat(game): apply package disable and removal to the room runtime"
```

---

### Task 4: Readiness must ignore disabled and unpublished packages

**Files:**
- Modify: `packages/server/src/godot-game/game-room.service.ts:143-172`
- Test: `packages/server/src/godot-game/game-room.service.spec.ts`

**Interfaces:**
- Consumes: Task 3 `PackageSyncStatus.enabled` / `revision`.

- [ ] **Step 1: Write the failing test**

```ts
it('does not wait for disabled or unpublished room packages', async () => {
  packageSync.getStatuses.mockResolvedValue([
    { packageId: 1, enabled: false, revision: 0, runtime: { state: 'pending' } },
    { packageId: 2, enabled: true, revision: 0, runtime: { state: 'pending' } },
    { packageId: 3, enabled: true, revision: 4, runtime: { state: 'applied' } },
  ]);
  await expect(service.getConnection(user, 7)).resolves.toBeTruthy();
});
```

Assert against the real setter name used by the spec (`getConnection` / `connect`); the point is that the 10-second poll returns immediately.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter server exec jest game-room.service`
Expected: FAIL — the call hangs until the poll deadline and throws `409 packages_pending`.

- [ ] **Step 3: Filter the readiness set**

In `waitForInitialPackages`:

```ts
const statuses = (await this.packageSync.getStatuses(roomId)).filter(
  (status) => status.enabled && status.revision > 0,
);
```

Keep the empty-list meaning "nothing to wait for". `getPackages` stays unfiltered: the panel needs disabled and unpublished rows.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter server exec jest game-room.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/godot-game/game-room.service.ts packages/server/src/godot-game/game-room.service.spec.ts
git commit -m "fix(game): do not block connections on inactive packages"
```

---

### Task 5: Notify the sync service from PATCH and DELETE

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts:141-196`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.controller.spec.ts`

**Interfaces:**
- Consumes: Task 3 `PackageRevisionDispatcher.packageEnabledChanged/packageRemoved`.
- Produces: `ScriptingPackagesService` constructor gains `@Optional() @Inject(PACKAGE_REVISION_DISPATCHER) dispatcher?: PackageRevisionDispatcher`.
- Produces: `PATCH` with a changed `enabled` calls `dispatcher.packageEnabledChanged(id)`; `DELETE` calls `dispatcher.packageRemoved(id, roomId)` after a successful delete (room packages only).

- [ ] **Step 1: Write failing tests**

Service spec (construct with a `{ packageEnabledChanged: jest.fn(), packageRemoved: jest.fn() }` double):

```ts
it('notifies the dispatcher when enabled flips', async () => {
  packagesRepository.findOne.mockResolvedValue(pkg({ enabled: true }));
  await service.update(42, { enabled: false });
  expect(dispatcher.packageEnabledChanged).toHaveBeenCalledWith(42);
});

it('does not notify when enabled is unchanged', async () => {
  packagesRepository.findOne.mockResolvedValue(pkg({ enabled: true }));
  await service.update(42, { enabled: true });
  expect(dispatcher.packageEnabledChanged).not.toHaveBeenCalled();
});

it('notifies removal with the room id', async () => {
  packagesRepository.findOne.mockResolvedValue(pkg({ room: { id: 7 } }));
  packagesRepository.delete.mockResolvedValue({ affected: 1 });
  await service.remove(42);
  expect(dispatcher.packageRemoved).toHaveBeenCalledWith(42, 7);
});
```

Controller spec: assert `DELETE` still returns 200/204 and that a dispatcher rejection does not change the HTTP result (deletion is authoritative).

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: FAIL — `dispatcher.packageEnabledChanged` not called.

- [ ] **Step 3: Wire the notifications**

Add the optional injection to the constructor (same pattern as `storage`) and:

```ts
const previousEnabled = pkg.enabled !== false;
if (dto.enabled !== undefined) pkg.enabled = dto.enabled;
const saved = await this.packagesRepository.save(pkg);
if (dto.enabled !== undefined && dto.enabled !== previousEnabled) {
  await this.dispatcher?.packageEnabledChanged(id).catch((error: unknown) => {
    this.logger.warn(`Failed to notify package ${id} enabled change: ${String(error)}`);
  });
}
return this.findOne(saved.id);
```

`remove`:

```ts
const pkg = await this.findOne(id);
const roomId = pkg.room?.id ?? null;
const result = await this.packagesRepository.delete(id);
if (!result.affected) throw new NotFoundException(...);
try { await this.storage?.removePackage(id); } catch (error) { ... }
if (roomId !== null) {
  try {
    this.dispatcher?.packageRemoved(id, roomId);
  } catch (error) {
    this.logger.warn(`Failed to notify package ${id} removal: ${String(error)}`);
  }
}
```

`scripting-packages.module.ts` already imports `GodotGameModule`; if Nest reports a missing provider, add `PACKAGE_REVISION_DISPATCHER` to that module's imports/exports — do not create a new module.

- [ ] **Step 4: Run the specs**

Run: `pnpm --filter server exec jest scripting-packages.service scripting-packages.controller`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/scripting-packages.service.ts packages/server/src/scripting-packages/scripting-packages.service.spec.ts packages/server/src/scripting-packages/scripting-packages.controller.spec.ts
git commit -m "feat(packages): notify the room runtime on toggle and delete"
```

---

### Task 6: Dependency invariant — block unsafe delete and publish

**Files:**
- Modify: `packages/server/src/scripting-packages/package-storage.service.ts` (add `readDraftFile`)
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts` (delete guard)
- Modify: `packages/server/src/scripting-packages/package-revisions.service.ts:145-175` (publish guard)
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`
- Test: `packages/server/src/scripting-packages/package-revisions.service.spec.ts`
- Test: `packages/server/src/scripting-packages/package-storage.service.spec.ts`

**Interfaces:**
- Produces: `PackageStorageService.readDraftFile(packageId: number, revision: number, filepath: string): Promise<string>`.
- Produces: `DELETE /scripting-packages/:id` returns `409 { statusCode: 409, code: 'package_has_dependents', dependents: [{ packageId, name }] }` for enabled dependents.
- Produces: `POST .../publish` returns `409 { statusCode: 409, code: 'dependency_disabled', dependencyId, name }` when a same-room transitive dependency is disabled.
- Consumes: `PackageDeliveryService.findDependentRoomPackages(id)` (already returns transitive dependents across rooms).

- [ ] **Step 1: Write failing tests**

Service spec, delete guard:

```ts
it('refuses to delete a package with enabled room dependents', async () => {
  packagesRepository.findOne.mockResolvedValue(pkg({ id: 42, room: { id: 7 } }));
  delivery.findDependentRoomPackages.mockResolvedValue([{ packageId: 9, roomId: 7, revision: 2 }]);
  packagesRepository.find.mockResolvedValue([{ id: 9, name: 'Dep', enabled: true }]);
  await expect(service.remove(42)).rejects.toMatchObject({
    response: { code: 'package_has_dependents', dependents: [{ packageId: 9, name: 'Dep' }] },
  });
  expect(packagesRepository.delete).not.toHaveBeenCalled();
});

it('deletes when every dependent is disabled', async () => {
  delivery.findDependentRoomPackages.mockResolvedValue([{ packageId: 9, roomId: 7, revision: 2 }]);
  packagesRepository.find.mockResolvedValue([{ id: 9, name: 'Dep', enabled: false }]);
  await service.remove(42);
  expect(packagesRepository.delete).toHaveBeenCalledWith(42);
});
```

Revisions spec, publish guard:

```ts
it('rejects publishing when a same-room dependency is disabled', async () => {
  packagesService.findOne.mockResolvedValue({ id: 42, room: { id: 7 } });
  storage.listDraftFiles.mockResolvedValue([{ path: 'main.gd' }]);
  storage.readDraftFile.mockResolvedValue('load("res://packages/9/a.tscn")');
  packagesRepository.findOne.mockResolvedValue({ id: 9, enabled: false, room: { id: 7 }, name: 'Off' });
  await expect(service.publish(42, 1)).rejects.toMatchObject({
    response: { code: 'dependency_disabled', dependencyId: 9, name: 'Off' },
  });
  expect(storage.publishRevision).not.toHaveBeenCalled();
});
```

Storage spec: `readDraftFile` returns a draft file and rejects for a missing file.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter server exec jest scripting-packages.service package-revisions.service package-storage.service`
Expected: FAIL — deletion succeeds / publish proceeds.

- [ ] **Step 3: Implement the guards**

`package-storage.service.ts`:

```ts
async readDraftFile(packageId: number, revision: number, filepath: string): Promise<string> {
  return readFile(this.resolveInside(this.draftRevisionDir(packageId, revision), filepath), 'utf8');
}
```

Use the same path-safety helper as `readPublishedFile`.

`ScriptingPackagesService` — inject `@Optional() private readonly delivery?: PackageDeliveryService` (module already imports `PackageDeliveryModule`) and add:

```ts
private async assertNoEnabledDependents(packageId: number): Promise<void> {
  if (!this.delivery) return;
  const dependents = await this.delivery.findDependentRoomPackages(packageId);
  if (dependents.length === 0) return;
  const rows = await this.packagesRepository.find({
    where: { id: In(dependents.map((dependent) => dependent.packageId)) },
  });
  const blocking = rows
    .filter((row) => row.enabled !== false)
    .map((row) => ({ packageId: row.id, name: row.name }))
    .sort((a, b) => a.packageId - b.packageId);
  if (blocking.length === 0) return;
  throw new ConflictException({
    statusCode: 409,
    code: 'package_has_dependents',
    message: 'Enabled packages depend on this package',
    dependents: blocking,
  });
}
```

Call it at the very start of `remove`, before the DB delete.

`PackageRevisionsService.publish` — after `findRevision` and before the publish lock:

```ts
await this.assertNoDisabledRoomDependency(packageId, revision, row.files);
```

Implementation (private):

```ts
private async assertNoDisabledRoomDependency(
  packageId: number, revision: number, files: PackageFileEntry[],
): Promise<void> {
  const pkg = await this.packagesService.findOne(packageId);
  if (!pkg.room) return;
  const visited = new Set<number>();
  const queue: number[] = [];
  for (const file of files.filter(isTextPackageFile)) {
    const text = await this.storage.readDraftFile(packageId, revision, file.path);
    for (const ref of collectPackageReferences(text)) {
      if (ref !== packageId && !visited.has(ref)) { visited.add(ref); queue.push(ref); }
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const latest = await this.revisionsRepository.findOne({
      where: { package: { id }, status: 'published' },
      order: { revision: 'DESC' },
    });
    if (!latest) continue;
    const pins = await this.storage.readPinnedDependencies(id, latest.revision);
    for (const pinned of pins?.keys() ?? []) {
      if (pinned !== packageId && !visited.has(pinned)) { visited.add(pinned); queue.push(pinned); }
    }
  }
  if (visited.size === 0) return;
  const deps = await this.packagesRepository.find({ where: { id: In([...visited]) } });
  const blocked = deps.find((dep) => dep.enabled === false && dep.room?.id === pkg.room!.id);
  if (!blocked) return;
  throw new ConflictException({
    statusCode: 409,
    code: 'dependency_disabled',
    message: `Dependency ${blocked.id} is disabled in this room`,
    dependencyId: blocked.id,
    name: blocked.name,
  });
}
```

`revisionsRepository`/`packagesRepository` must be loaded with `relations: { room: true }` where the code checks `dep.room?.id`; adjust the `find` call accordingly (`relations: { room: true }`).

- [ ] **Step 4: Run the three specs**

Run: `pnpm --filter server exec jest scripting-packages.service package-revisions.service package-storage.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/package-storage.service.ts packages/server/src/scripting-packages/scripting-packages.service.ts packages/server/src/scripting-packages/package-revisions.service.ts packages/server/src/scripting-packages/*.spec.ts
git commit -m "feat(packages): guard delete and publish against inactive dependencies"
```

---

### Task 7: Protocol, network event and `PackagesManager.forget_package`

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/wired_protocol.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/network/network.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd`
- Test: `packages/server/godot_project/_wired/tests/network_readiness_smoke.gd`
- Test: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd`

**Interfaces:**
- Produces: `WiredProtocol.EVENT_PACKAGE_REMOVED = "package_removed"`, `WiredProtocol.META_PACKAGE_ARTIFACT_KEY = "_wired_package_artifact_key"`.
- Produces: `WiredNetwork.remove_package_revision(package_id: int) -> void` (server only; erases the revision map and broadcasts).
- Produces: `PackagesManager.forget_package(package_id: int, purge: bool = false) -> void`.
- Produces: `PackagesManager.packages_dir(package_id)` is the directory removed on purge (already exists).

- [ ] **Step 1: Write failing smoke checks**

`network_readiness_smoke.gd`:

```gdscript
func _test_remove_package_revision_forgets_the_entry() -> void:
	var net := WiredNetwork.new()
	net._package_revisions[42] = 3
	net.remove_package_revision(42)
	_check(not net.get_package_revisions().has(42), "removed package must leave the revision map")
	net.free()
```

`packages_manager_smoke.gd`:

```gdscript
func _test_forget_package_clears_applied_state() -> void:
	var manager := PackagesManager.new()
	manager.set_room("77")
	manager._current_revisions[42] = 3
	manager._current_artifact_keys[42] = "abc"
	manager.forget_package(42, false)
	_check(manager.current_revision(42) == 0, "forget clears the revision")
	_check(manager.current_artifact_key(42).is_empty(), "forget clears the artifact key")
	manager.free()
```

Add both calls to the existing `_run()`.

- [ ] **Step 2: Run them and watch them fail**

Run: `<godot> --headless --path packages/server/godot_project/_wired --script res://tests/network_readiness_smoke.gd --quit-after 2`
Expected: FAIL — `remove_package_revision` not found.

Run the same for `packages_manager_smoke.gd`.
Expected: FAIL — `forget_package` not found.

- [ ] **Step 3: Implement**

`wired_protocol.gd`:

```gdscript
const EVENT_PACKAGE_REMOVED := "package_removed"
const META_PACKAGE_ARTIFACT_KEY := "_wired_package_artifact_key"
```

`network.gd` — add near `set_package_revision` and export nothing else:

```gdscript
const EVENT_PACKAGE_REMOVED := WiredProtocol.EVENT_PACKAGE_REMOVED

func remove_package_revision(package_id: int) -> void:
	if not _is_server():
		return
	if not _package_revisions.has(package_id):
		return
	_package_revisions.erase(package_id)
	print("WIRED_PACKAGE_REVISION_REMOVED package=%d" % package_id)
	_broadcast_event({
		"type": EVENT_PACKAGE_REMOVED,
		WiredProtocol.KEY_PACKAGE_ID: package_id,
	})
```

If `_package_reports` is keyed by package id, erase it too.

`packages_manager.gd`:

```gdscript
func forget_package(package_id: int, purge: bool = false) -> void:
	_current_revisions.erase(package_id)
	_current_artifact_keys.erase(package_id)
	_scene_dependencies.erase(package_id)
	_file_hashes.erase(package_id)
	if purge:
		_remove_tree(packages_dir(package_id))
	print("WIRED_PACKAGES_FORGOTTEN package=%d purge=%s" % [package_id, purge])

func _remove_tree(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	for name in dir.get_files():
		DirAccess.remove_absolute(path.path_join(name))
	for name in dir.get_directories():
		_remove_tree(path.path_join(name))
	DirAccess.remove_absolute(path)
```

- [ ] **Step 4: Run both smokes**

Run both commands from Step 2.
Expected: PASS (`WIRED_...` lines, exit 0).

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/wired_protocol.gd packages/server/godot_project/_wired/_wired/scripts/network/network.gd packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd packages/server/godot_project/_wired/tests/network_readiness_smoke.gd packages/server/godot_project/_wired/tests/packages_manager_smoke.gd
git commit -m "feat(runtime): announce package removal and forget package state"
```

---

### Task 8: Dynamic world — park, restore, purge and stamped snapshots

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/world/dynamic_world_container.gd`
- Test: `packages/server/godot_project/_wired/tests/dynamic_world_smoke.gd`

**Interfaces:**
- Produces: `seed_pending(records: Array) -> void`, `pending_records() -> Array`.
- Produces: `park_package(package_id: int) -> int`, `drop_package(package_id: int) -> int`, `restore_pending() -> int`, `purge_package(package_id: int) -> int`, `purge_missing_packages(package_ids: PackedStringArray) -> int`.
- Produces: `apply_snapshot(records: Array, packages: Dictionary = {}) -> void` — replaces `apply_snapshot(records)`; stamps entities with package id/revision/artifact key.
- Produces: `save_state()` includes parked persistent records; `snapshot_state()` stays live-only.
- Removes: `restore_pending(records)` argument form (callers updated in Task 10).

- [ ] **Step 1: Write failing smoke checks**

In `dynamic_world_smoke.gd`, using the existing fixture package/registry helpers:

```gdscript
func _test_park_keeps_identity_and_state() -> void:
	var world := _make_world()               # existing helper in the file
	var entity := world.spawn_entity("42/box", {"state": {"hp": 5}})
	var id := entity.entity_id
	_check(world.park_package(42) == 1, "park must take the entity out of the tree")
	_check(world._entities.is_empty(), "parked entity leaves the index")
	_check(world.restore_pending() == 1, "restore must bring the entity back")
	var restored = world._entities[id]
	_check(restored != null, "restore keeps the entity id")
	_check(_state_of(restored).get("hp") == 5, "restore keeps the persisted state")

func _test_purge_drops_parked_records() -> void:
	... park, then world.purge_package(42), then world.pending_records().is_empty()

func _test_snapshot_removes_entities_of_an_unloaded_package() -> void:
	... spawn two entities, apply_snapshot([record_of_other], {"other": {...}})
	_check(not world._entities.has(first_id), "entity of a package missing from the map is pruned")

func _test_snapshot_keeps_entities_created_after_the_snapshot() -> void:
	... spawn entity, then apply_snapshot([], {"42": {"revision": 3, "artifact_key": "k"}})
	_check(world._entities.has(id), "entity with a current stamp survives an empty snapshot")

func _test_snapshot_replaces_a_stale_entity_by_id() -> void:
	... spawn with stamp rev 1, apply_snapshot([record], {"42": {"revision": 2, "artifact_key": "k2"}})
	_check(world._entities[id].get_meta(WiredProtocol.META_PACKAGE_REVISION) == 2, "entity is rebuilt on the new revision")
```

Add the five calls to `_run()`.

- [ ] **Step 2: Run and watch them fail**

Run: `<godot> --headless --path packages/server/godot_project/_wired --script res://tests/dynamic_world_smoke.gd --quit-after 2`
Expected: FAIL — `park_package` not found.

- [ ] **Step 3: Implement park/restore/purge**

Replace `_saved_dynamic_records` ownership with a `_parked: Array[Dictionary] = []` field.

```gdscript
func seed_pending(records: Array) -> void:
	_parked.clear()
	for record in records:
		_parked.append(_parked_record(record))
	_reserve_ids(_parked)

func pending_records() -> Array:
	return _parked.duplicate(true)

func park_package(package_id: int) -> int:
	var parked := 0
	for id: Variant in _entities.keys():
		var entity = _entities[id]
		if not is_instance_valid(entity):
			_entities.erase(id)
			continue
		if _package_of(entity.type_id) != package_id:
			continue
		_parked.append({
			"entity_id": int(id),
			"type_id": String(entity.type_id),
			"owner_player_id": int(entity.owner_player_id),
			"state": entity._wired_save_state(),
			"persistent": bool(entity.persistent),
		})
		_entities.erase(id)
		_restored_ids.erase(int(entity.get_meta(WiredProtocol.META_SOURCE_ENTITY_ID, 0)))
		_detach_and_free(entity)
		parked += 1
	print("WIRED_DYNAMIC_PARKED package=%d entities=%d" % [package_id, parked])
	return parked
```

`drop_package` is the same loop without appending a record (client path).
`restore_pending` iterates `_parked`, calls a count-returning `_restore_records([record])`, keeps failures, prints `WIRED_DYNAMIC_RESTORED restored=%d pending=%d`.
`purge_package` / `purge_missing_packages` filter `_parked`.

Helpers to add: `_package_of(type_id) -> int`, `_detach_and_free(entity)`, `_parked_record(record)` (normalizes and drops non-persistent-only keys when needed).

Change `_restore_records(records) -> int` and return the number restored (all existing callers ignore the value except `restore_pending`).

- [ ] **Step 4: Implement stamps, replacement and conditional prune**

`_instantiate_entity`:

```gdscript
var descriptor: Dictionary = _registry.find_dynamic_entity(type_id)
var package_id := str(descriptor.get(WiredProtocol.KEY_PACKAGE_ID, ""))
var context := _registry.get_context(package_id)
entity.set_meta(WiredProtocol.META_PACKAGE_ID, package_id)
entity.set_meta(WiredProtocol.META_PACKAGE_REVISION, context.revision if context != null else 0)
entity.set_meta(WiredProtocol.META_PACKAGE_ARTIFACT_KEY,
	context.artifact_key if context != null else "")
```

`apply_snapshot(records, packages = {})`:

```gdscript
var seen := {}
for raw in records:
	var payload := _spawn_record(raw)
	var id := int(payload.get("entity_id", 0))
	if id <= 0: continue
	seen[id] = true
	var type_id := str(payload.get("type_id", ""))
	if _entities.has(id) and is_instance_valid(_entities[id]):
		var current = _entities[id]
		if _stamp_stale(current, type_id, packages):
			_detach_and_free(current)
			_entities.erase(id)
		else:
			current._wired_load_state(payload.get("state", {}))
			continue
	var entity := _instantiate_entity({...payload, "restore": true}, type_id)
	if entity != null:
		_entities[id] = entity
		_adopt_repaired_entity(entity)
# prune
for id: Variant in _entities.keys():
	if seen.has(int(id)): continue
	var entity = _entities[id]
	if not is_instance_valid(entity): _entities.erase(id); continue
	if _prune_allowed(entity, packages):
		_detach_and_free(entity)
		_entities.erase(id)
```

```gdscript
func _stamp_stale(entity: Node, type_id: String, packages: Dictionary) -> bool:
	var package_id := str(_package_of(type_id))
	var stamp := packages.get(package_id)
	if stamp == null:
		return true
	return (
		int(entity.get_meta(WiredProtocol.META_PACKAGE_REVISION, -1)) != int(stamp.revision)
		or str(entity.get_meta(WiredProtocol.META_PACKAGE_ARTIFACT_KEY, ""))
			!= str(stamp.artifact_key)
	)

func _prune_allowed(entity: Node, packages: Dictionary) -> bool:
	var package_id := str(entity.get_meta(WiredProtocol.META_PACKAGE_ID, ""))
	var stamp = packages.get(package_id)
	if stamp == null:
		return true
	return (
		int(entity.get_meta(WiredProtocol.META_PACKAGE_REVISION, -1)) != int(stamp.revision)
		or str(entity.get_meta(WiredProtocol.META_PACKAGE_ARTIFACT_KEY, ""))
			!= str(stamp.artifact_key)
	)
```

`save_state()` merges live records with `_parked` (persistent only, dedupe by `entity_id`, live wins) and returns the sorted list. `snapshot_state()` stays `_state_records(false)`.

- [ ] **Step 5: Run the smoke and the neighboring suites**

Run: `<godot> --headless --path packages/server/godot_project/_wired --script res://tests/dynamic_world_smoke.gd --quit-after 2`
Expected: PASS.

Run: `state_persistence_smoke.gd`, `spawner_smoke.gd`, `late_join_smoke.gd` the same way.
Expected: PASS (update call sites in tests to `restore_pending()` / `apply_snapshot(records, packages)` if they used the old signatures).

- [ ] **Step 6: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/world/dynamic_world_container.gd packages/server/godot_project/_wired/tests/dynamic_world_smoke.gd
git commit -m "feat(runtime): park and stamp dynamic entities across package reloads"
```

---

### Task 9: Player component state parking and purge

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/players/wired_player.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/players_manager.gd`
- Test: `packages/server/godot_project/_wired/tests/players_manager_smoke.gd`

**Interfaces:**
- Produces: `WiredPlayer.park_component_states() -> void`, `purge_package(package_id: String) -> void`, `keep_only_packages(package_ids: PackedStringArray) -> void`; parked entries merge into `save_state()["components"]`.
- Produces: `PlayersManager.purge_package(package_id: int) -> void`, `PlayersManager.purge_missing_packages(package_ids: PackedStringArray) -> void`.

- [ ] **Step 1: Write a failing smoke test**

Next to `_test_hot_reload_rebuilds_live_components`:

```gdscript
func _test_removed_component_state_survives_until_the_package_returns() -> void:
	var player := _player_with_components([42])     # existing fixture helper
	player.components[0]._wired_load_state({"hp": 9})
	_remove_component_package(42)                  # registry now has no package 42
	players.rebuild_live_components()
	_check(player.components.is_empty(), "removed component leaves the player")
	var saved: Dictionary = player.save_state()
	_check(saved.components.has("42:player_component.tscn"), "state is parked, not lost")
	_restore_component_package(42)
	players.rebuild_live_components()
	_check(_state_of(player.components[0]).get("hp") == 9, "state returns with the package")

func _test_purge_package_drops_parked_component_state() -> void:
	... park, players.purge_package(42), player.save_state().components must not have the key
```

Reuse the file's existing fixtures; the helper names above describe intent, keep the file's actual shape.

- [ ] **Step 2: Run and watch it fail**

Run: `<godot> --headless --path packages/server/godot_project/_wired --script res://tests/players_manager_smoke.gd --quit-after 2`
Expected: FAIL — state lost after rebuild.

- [ ] **Step 3: Implement parking**

`wired_player.gd`:

```gdscript
var _parked_component_states: Dictionary = {}

func park_component_states() -> void:
	for component in components:
		if component == null: continue
		_parked_component_states[component.state_key()] = component._wired_save_state()

func purge_package(package_id: String) -> void:
	for key: String in _parked_component_states.keys():
		if key.begins_with(package_id + ":"):
			_parked_component_states.erase(key)

func keep_only_packages(package_ids: PackedStringArray) -> void:
	for key: String in _parked_component_states.keys():
		if not package_ids.has(key.get_slice(":", 0)):
			_parked_component_states.erase(key)
```

`save_state()` starts from `_parked_component_states.duplicate()` and overwrites with live component states; `load_state()` keeps only keyed entries with no live component in parked, then applies the keyed state to live components (legacy array branch unchanged).

`players_manager.gd`:

```gdscript
func purge_package(package_id: int) -> void:
	var key := str(package_id)
	for player in _spawned.values():
		player.purge_package(key)
	for state: Dictionary in _saved_states.values():
		var components: Dictionary = state.get("components", {})
		for component_key: String in components.keys():
			if component_key.begins_with(key + ":"):
				components.erase(component_key)

func purge_missing_packages(package_ids: PackedStringArray) -> void:
	for player in _spawned.values():
		player.keep_only_packages(package_ids)
	for state: Dictionary in _saved_states.values():
		var components: Dictionary = state.get("components", {})
		for component_key: String in components.keys():
			if not package_ids.has(component_key.get_slice(":", 0)):
				components.erase(component_key)
```

In `_rebuild_components`, call `player.park_component_states()` before detaching the old components.

- [ ] **Step 4: Run the smoke**

Run: `<godot> --headless --path packages/server/godot_project/_wired --script res://tests/players_manager_smoke.gd --quit-after 2`
Expected: PASS (all existing tests plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/players/wired_player.gd packages/server/godot_project/_wired/_wired/scripts/global/players_manager.gd packages/server/godot_project/_wired/tests/players_manager_smoke.gd
git commit -m "feat(runtime): park player component state across package reloads"
```

---

### Task 10: Main scene — package operation queue, removal and client reconcile

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Test: `packages/server/godot_project/_wired/tests/static_world_smoke.gd`
- Test: `packages/server/godot_project/_wired/tests/state_persistence_smoke.gd`

**Interfaces:**
- Consumes: Task 7 `remove_package_revision`, `forget_package`; Task 8 parked world; Task 9 player purge.
- Produces: `_enqueue_package_op(op: Dictionary) -> void`; `_apply_package_removal(package_id: int, purge: bool, request_snapshot := true) -> void`; `_apply_room_packages(csv: String) -> void`; `_reconcile_client_packages(remote: Dictionary) -> bool`; `_schedule_package_retry(package_id: int, error: String) -> void`.

- [ ] **Step 1: Write failing static/state checks**

`static_world_smoke.gd` — rebuild after `clear_package`:

```gdscript
func _test_rebuild_removes_scenes_of_a_forgotten_package() -> void:
	... register package 42 with one scene, rebuild, assert child count 1
	registry.clear_package("42")
	container.rebuild()
	_check(container.get_child_count() == 0, "forgotten package scenes disappear")
```

`state_persistence_smoke.gd` — parked records survive a save/load round trip:

```gdscript
func _test_parked_dynamic_records_are_saved_and_reseeded() -> void:
	... park one entity, saved = world.save_state()
	var reloaded := _new_world(); reloaded.seed_pending(saved)
	_check(reloaded.restore_pending() == 1, "parked entity returns after a save/load cycle")
```

- [ ] **Step 2: Run and watch the state test fail**

Run: `<godot> --headless --path packages/server/godot_project/_wired --script res://tests/state_persistence_smoke.gd --quit-after 2`
Expected: FAIL — `seed_pending` never receives the save records (main_scene still stores `_saved_dynamic_records`).

- [ ] **Step 3: Replace `_saved_dynamic_records` with the world-owned pending list**

- `_load_state`: call `_dynamic_world.seed_pending(dynamic_records)` instead of assigning `_saved_dynamic_records`.
- `_save_state`: `_dynamic_world.save_state()` now already includes parked records (no other change).
- `_apply_registered_package(package_id, revision)`:
  1. `_dynamic_world.park_package(package_id)` when `_server_mode`, else `_dynamic_world.drop_package(package_id)`.
  2. keep registry clear + entry load + static rebuild + players rebuild;
  3. server: `_dynamic_world.restore_pending()`; client: `_request_world_snapshot()`.

- [ ] **Step 4: Add the operation queue and control commands**

Fields:

```gdscript
var _package_ops_busy := false
var _package_ops_queue: Array[Dictionary] = []
```

`_control_loop` command parsing (split on whitespace, ignore empty parts):

```gdscript
match parts[0]:
	"shutdown": ...
	"package":
		if parts.size() == 3 and parts[1].is_valid_int() and parts[2].is_valid_int():
			_enqueue_package_op({"kind": "apply", "id": parts[1].to_int(), "revision": parts[2].to_int()})
	"unload":
		if parts.size() in [2, 3] and parts[1].is_valid_int():
			_enqueue_package_op({
				"kind": "unload",
				"id": parts[1].to_int(),
				"purge": parts.size() == 3 and parts[2] == "purge",
			})
	"room-packages":
		_apply_room_packages(parts[1] if parts.size() > 1 else "")
```

`_pump_package_ops` awaits the operation, clears `_package_ops_busy`, re-schedules itself with `call_deferred`.

`_apply_package_removal(package_id, purge, request_snapshot := true)`:

```gdscript
if _server_mode:
	_dynamic_world.park_package(package_id)
else:
	_dynamic_world.drop_package(package_id)
_registry.clear_package(package_id)
_packages.forget_package(package_id, purge)
_static_world.rebuild()
_players.rebuild_live_components()
if purge:
	_dynamic_world.purge_package(package_id)
	_players.purge_package(package_id)
if _server_mode:
	_net.remove_package_revision(package_id)
elif request_snapshot:
	_request_world_snapshot()
```

`_apply_room_packages(csv)` parses ids, then `_dynamic_world.purge_missing_packages(ids)` and `_players.purge_missing_packages(ids)`.

- [ ] **Step 5: Add client package reconcile and retry**

`_apply_world_snapshot` becomes async (`await` allowed) and:

```gdscript
var remote_packages: Dictionary = snapshot.get(WiredProtocol.KEY_PACKAGES, {})
if not await _reconcile_client_packages(remote_packages):
	_pending_world_snapshot = snapshot
	return
if not SnapshotRules.packages_match(remote_packages, _packages.applied_packages()):
	_pending_world_snapshot = snapshot
	print("WIRED_WORLD_SNAPSHOT_DEFERRED reason=package_mismatch ...")
	return
_pending_world_snapshot = {}
_players.apply_snapshot(players)
_dynamic_world.apply_snapshot(dynamic_records, remote_packages)
```

`_reconcile_client_packages`:

```gdscript
func _reconcile_client_packages(remote: Dictionary) -> bool:
	if _server_mode:
		return true
	for id: Variant in _packages.applied_packages():
		if not remote.has(str(id)):
			_apply_package_removal(int(id), false, false)
	for id: Variant in remote:
		var want: Dictionary = remote[id]
		var have: Dictionary = _packages.applied_packages().get(str(id), {})
		if (
			int(have.get("revision", 0)) == int(want.get("revision", 0))
			and str(have.get("artifact_key", "")) == str(want.get("artifact_key", ""))
		):
			continue
		var result: Dictionary = await _packages.sync_package(int(id), int(want.get("revision", 0)))
		if not result.get("ok", false):
			_schedule_package_retry(int(id), str(result.get("error", "")))
			return false
	return true
```

`_schedule_package_retry` uses `_package_retry_running` to avoid stacking attempts, delays `[2.0, 5.0, 10.0]`, then 10 s forever, prints `WIRED_PACKAGE_SYNC_FAILED package=%d error=%s retry=%.1f`, waits with `get_tree().create_timer(...).timeout`, then `_request_world_snapshot()`. Reset the attempt counter after a successful reconcile.

`_on_server_event`: add

```gdscript
WiredProtocol.EVENT_PACKAGE_REMOVED:
	_enqueue_package_op({"kind": "unload", "id": int(event.get(WiredProtocol.KEY_PACKAGE_ID, 0)), "purge": false})
```

Client `_apply_client_package` failure path: on `not ok`, call `_schedule_package_retry` instead of silently reporting failure.

- [ ] **Step 6: Run the Godot smokes**

Run `static_world_smoke.gd`, `state_persistence_smoke.gd`, `dynamic_world_smoke.gd`, `players_manager_smoke.gd`, `late_join_smoke.gd`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/main_scene.gd packages/server/godot_project/_wired/tests/static_world_smoke.gd packages/server/godot_project/_wired/tests/state_persistence_smoke.gd
git commit -m "feat(runtime): serialize package operations and reconcile clients with the server"
```

---

### Task 11: Frontend API and package hook — toggle, delete, removals

**Files:**
- Modify: `frontend/src/api/services/scripting-packages.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`
- Test: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx`

**Interfaces:**
- Produces: `updateScriptingPackage(id: number, data: UpdateScriptingPackagePayload): Promise<ScriptingPackage>` (`PATCH scripting-packages/:id`), `deleteScriptingPackage(id: number): Promise<void>` (`DELETE scripting-packages/:id`).
- Produces: `RoomPackagesController.setPackageEnabled(packageId: number, enabled: boolean): void`, `deletePackage(packageId: number): void`.
- Produces: `RoomPackageEntry.enabled: boolean`; `RoomPackageStatus` adds `'disabled'`.
- Produces: reducer action `{ type: 'removed'; ids: number[] }` and `removedIds: Set<number>` tombstones cleared on room reset.

- [ ] **Step 1: Write failing hook tests**

In `use-room-packages.test.tsx` (extend the existing mock module with `updateScriptingPackage`, `deleteScriptingPackage`):

```tsx
it('patches enabled and refreshes', async () => {
  const { result } = await renderLoaded();
  await act(() => result.current.setPackageEnabled(42, false));
  expect(updateScriptingPackage).toHaveBeenCalledWith(42, { enabled: false });
  expect(getRoomPackages).toHaveBeenCalledTimes(2);
});

it('deletes the package, its editor directory and the entry', async () => {
  const fs = createFakeFs();
  const { result } = await renderLoaded({ fs });
  await act(() => result.current.deletePackage(42));
  expect(deleteScriptingPackage).toHaveBeenCalledWith(42);
  expect(fs.deleted).toContain(42);
  expect(result.current.entries.find((e) => e.packageId === 42)).toBeUndefined();
});

it('does not resurrect a deleted package from the room prop', async () => {
  // delete 42, then rerender with the stale roomPackages prop containing 42
  expect(result.current.entries.find((e) => e.packageId === 42)).toBeUndefined();
});

it('drops entries missing from the polling response', async () => {
  getRoomPackages.mockResolvedValueOnce({ roomId: 7, packages: [] });
  await act(() => result.current.refresh());
  expect(result.current.entries).toHaveLength(0);
});

it('exposes disabled entries with a disabled status', async () => {
  getRoomPackages.mockResolvedValueOnce(statusWith({ packageId: 42, enabled: false, revision: 0 }));
  await act(() => result.current.refresh());
  expect(result.current.entries[0]).toMatchObject({ enabled: false, status: 'disabled' });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: FAIL — `setPackageEnabled` is not a function.

- [ ] **Step 3: Add API functions**

```ts
export async function updateScriptingPackage(
  id: number,
  data: UpdateScriptingPackagePayload
) {
  return apiClient.patch<ScriptingPackage, UpdateScriptingPackagePayload>(
    `scripting-packages/${id}`,
    data
  );
}

export async function deleteScriptingPackage(id: number) {
  await apiClient.delete<void>(`scripting-packages/${id}`);
}
```

Match `apiClient`'s generic/`delete` signature used elsewhere (see `packages/server` client wrappers or `rooms` service for the exact pattern).

- [ ] **Step 4: Extend types and reducer**

- `RoomPackageStatus` union gains `'disabled'`.
- `RoomPackageEntry` gains `enabled: boolean`.
- `State` gains `removedIds: Set<number>`.
- `mergePackages(packages, incoming, removedIds)` skips ids present in `removedIds`.
- New reducer branch:

```ts
case 'removed':
  return {
    ...state,
    packages: state.packages.filter((pkg) => !action.ids.includes(pkg.id)),
    entries: state.entries.filter((entry) => !action.ids.includes(entry.packageId)),
    removedIds: new Set([...state.removedIds, ...action.ids]),
  };
```

- `loaded`: compute `incomingIds`; `dropped` = current packages not in `incomingIds`; tombstones `new Set([...state.removedIds, ...dropped])`; merge filtered packages; `buildEntries`.
- `reset` clears `removedIds` (room change).
- `packageFromStatus`: carry `enabled: status.enabled`.
- `buildEntries`: `enabled = remote?.enabled ?? true`; status = `enabled ? existingChain : 'disabled'`; keep local-changes visible.

- [ ] **Step 5: Add controller methods**

```ts
const setPackageEnabled = (packageId: number, enabled: boolean) => {
  if (!beginAction(packageId)) return;
  void guarded(packageId, async () => {
    await updateScriptingPackage(packageId, { enabled });
    setNotice(packageId, enabled ? 'Пакет включён' : 'Пакет отключён');
    await refresh();
  }).finally(() => endAction(packageId));
};

const deletePackage = (packageId: number) => {
  if (!beginAction(packageId)) return;
  void guarded(packageId, async () => {
    await deleteScriptingPackage(packageId);
    try { await files.deletePackage(packageId); } catch { /* editor FS may be unavailable */ }
    snapshotsRef.current.delete(packageId);
    loadedRef.current.delete(packageId);
    dispatch({ type: 'removed', ids: [packageId] });
    setNotice(packageId, 'Пакет удалён из комнаты');
    await refresh();
  }).finally(() => endAction(packageId));
};
```

`guarded` must surface `409` dependents as a readable error: add

```ts
function deleteConflictMessage(error: unknown): string | null {
  const data = (error as { response?: { data?: { code?: string; dependents?: { name: string }[] } } })
    ?.response?.data;
  if (data?.code !== 'package_has_dependents' || !data.dependents?.length) return null;
  return `Сначала отключите или удалите зависимые пакеты: ${data.dependents
    .map((dependent) => dependent.name)
    .join(', ')}`;
}
```

and use it in the catch path before the generic error message.

Export both new methods in the returned controller object.

- [ ] **Step 6: Run the hook tests and typecheck**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: PASS.

Run: `pnpm check-types:frontend`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/services/scripting-packages.ts "frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts" "frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx"
git commit -m "feat(packages): toggle and delete room packages from the panel state"
```

---

### Task 12: Packages tab — animate-ui dialogs, disabled badge, delete action

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`
- Test: `frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx`

**Interfaces:**
- Consumes: Task 11 controller methods and `enabled`/`disabled` entry fields.
- Produces: no native `window.confirm/alert/prompt` left in `frontend/src`.
- Produces: delete confirmation dialog (animate-ui `Dialog`) with package name and id; conflict confirmation dialogs for download/emit.

- [ ] **Step 1: Rewrite the tests that assert `window.confirm`**

Replace the four `window.confirm` assertions (`PackagesTab.test.tsx` lines ~144, 169, 192, 297) with:

```tsx
fireEvent.click(screen.getByRole('button', { name: 'Скачать в редактор' }));
const dialog = await screen.findByRole('dialog');
fireEvent.click(within(dialog).getByRole('button', { name: 'Продолжить' }));
await waitFor(() => expect(onDownload).toHaveBeenCalledWith(42, { force: true }));
```

Add new tests:

```tsx
it('shows a disabled badge and hides Emit for a disabled package', () => {
  render(<PackagesTab authorId={42} packages={controller({ entries: [entry({ enabled: false, status: 'disabled' })] })} />);
  expect(screen.getByText('Отключён')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Emit' })).not.toBeInTheDocument();
});

it('confirms permanent deletion in a dialog', async () => {
  const onDelete = vi.fn();
  render(<PackagesTab authorId={42} packages={controller({ entries: [entry()], deletePackage: onDelete })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Удалить из комнаты' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/#42/)).toBeInTheDocument();
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить навсегда' }));
  expect(onDelete).toHaveBeenCalledWith(42);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: FAIL — no dialog role, `window.confirm` still used.

- [ ] **Step 3: Replace `window.confirm` with an animate-ui confirm hook**

Import the dialog from `@/components/animate-ui/components/radix/dialog` (same pattern as `frontend/src/app/(browser)/_components/rooms.tsx`).

```tsx
type ConfirmRequest = {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  resolve: (value: boolean) => void;
};

function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const confirm = useCallback((next: Omit<ConfirmRequest, 'resolve'>) =>
    new Promise<boolean>((resolve) => setRequest({ ...next, resolve })), []);
  const dialog = (
    <Dialog open={request !== null} onOpenChange={(open) => {
      if (!open && request) { request.resolve(false); setRequest(null); }
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex !justify-between">
          <Button variant="outline" onClick={() => { request?.resolve(false); setRequest(null); }}>Отмена</Button>
          <Button variant={request?.destructive ? 'destructive' : 'default'}
            onClick={() => { request?.resolve(true); setRequest(null); }}>
            {request?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { confirm, dialog };
}
```

`useConfirmedAction` takes `confirm` and replaces `window.confirm(question)` with `await confirm({ title: 'Продолжить?', description: question, confirmLabel: 'Продолжить' })`.

Render `{confirm.dialog}` (or pass it up) inside `PackagesTab`.

- [ ] **Step 4: Add toggle and delete controls**

In `PackageCard` header actions:

- `{entry.enabled ? 'Отключить' : 'Включить'}` → `onToggle(entry.packageId, !entry.enabled)`.
- Danger button `Удалить из комнаты` (only when `entry.enabled === false || entry.status !== 'not-loaded'`; keep it always visible but rely on the dialog) → `confirm({ title: 'Удалить пакет из комнаты?', description: <>Пакет <strong>{entry.name}</strong> (#{entry.packageId}) будет удалён вместе с ревизиями и артефактами. Отменить это нельзя.</>, confirmLabel: 'Удалить навсегда', destructive: true })` then `onDelete(entry.packageId)`.
- Hide Emit when `!entry.enabled`; show text `Пакет отключён в комнате` instead of the runtime block.
- Keep "Убрать из редактора" with a title clarifying it only deletes the local editor copy.

Add `onToggle`/`onDelete` props and wire them from `PackagesTab` to `packages.setPackageEnabled` / `packages.deletePackage`.

- [ ] **Step 5: Run the tab tests and lint**

Run: `pnpm --filter frontend exec vitest run PackagesTab`
Expected: PASS.

Run: `pnpm --filter frontend lint`
Expected: exit 0 (no `window.confirm` remains in `PackagesTab.tsx`).

- [ ] **Step 6: Commit**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx" "frontend/src/app/room/[room_code]/(godot)/PackagesTab.test.tsx"
git commit -m "feat(packages): add disable and delete controls with animate-ui dialogs"
```

---

### Task 13: Game tab filters and full verification

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/GameTab.tsx`
- Test: `frontend/src/app/room/[room_code]/(godot)/GameTab.test.tsx`

**Interfaces:**
- Consumes: Task 3 status shape (`enabled`, `revision`, nullable `publishedAt`).
- Produces: exported helpers `activePackages(packages)`, `packagesAreApplied(packages)`, `packagesFailed(packages)`; bridge config and readiness ignore disabled/unpublished entries.

- [ ] **Step 1: Write failing tests**

```tsx
it('ignores disabled and unpublished packages when judging readiness', () => {
  const status = statusWith([
    { packageId: 1, enabled: false, revision: 3, runtime: { state: 'pending' } },
    { packageId: 2, enabled: true, revision: 0, runtime: { state: 'pending' } },
  ]);
  expect(packagesAreApplied(status)).toBe(true);
  expect(packagesFailed(status)).toBe(false);
});

it('passes only enabled published packages to the bridge config', () => {
  expect(activePackages(statusWith([
    { packageId: 1, enabled: false, revision: 3 },
    { packageId: 2, enabled: true, revision: 0 },
    { packageId: 3, enabled: true, revision: 4 },
  ]))).toEqual([{ packageId: 3, revision: 4 }]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter frontend exec vitest run GameTab`
Expected: FAIL — helpers not exported / disabled entries counted.

- [ ] **Step 3: Implement the filter**

In `GameTab.tsx`:

```ts
export function activePackages(packages: RoomPackagesStatus) {
  return packages.packages
    .filter((entry) => entry.enabled && entry.revision > 0)
    .map(({ packageId, revision }) => ({ packageId, revision }));
}

export function packagesAreApplied(packages: RoomPackagesStatus) {
  return activePackages(packages).length === 0 ||
    activePackages(packages).every(({ packageId, revision }) => {
      const status = packages.packages.find((p) => p.packageId === packageId);
      return status?.runtime.state === 'applied' && status.runtime.revision >= revision;
    });
}

export function packagesFailed(packages: RoomPackagesStatus) {
  const active = new Set(activePackages(packages).map((p) => p.packageId));
  return packages.packages.some((p) => active.has(p.packageId) && p.runtime.state === 'failed');
}
```

Use `activePackages(packageStatus)` where the bridge config is built (line ~570) and update `describeRuntime` to count only active packages.

- [ ] **Step 4: Run the whole verification set**

Run: `pnpm --filter frontend exec vitest run GameTab`
Expected: PASS.

Run: `pnpm --filter server test`
Expected: PASS (all suites; `room-runtime.integration` stays skipped).

Run: `pnpm --filter frontend test`
Expected: PASS.

Run: `pnpm --filter server build`, `pnpm check-types:frontend`, `pnpm --filter frontend lint`, `pnpm --filter server lint`
Expected: exit 0.

Run the Godot smoke set: `network_readiness_smoke`, `packages_manager_smoke`, `dynamic_world_smoke`, `static_world_smoke`, `players_manager_smoke`, `state_persistence_smoke`, `late_join_smoke`, `spawner_smoke`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/GameTab.tsx" "frontend/src/app/room/[room_code]/(godot)/GameTab.test.tsx"
git commit -m "feat(game): exclude inactive packages from the game readiness gate"
```

---

## Manual acceptance (after all tasks)

1. Start Postgres and server, open a room, package with a static scene, a player component and a dynamic entity; start the Game tab.
2. Emit a new revision that changes the scene, the component script and the dynamic entity script → all three visibly reload, entity keeps position/state, players keep component state.
3. Remove the dynamic entity type from registration and Emit → entity disappears; re-add and Emit → it returns with its state.
4. Disable the package → its scenes/entities/components disappear on the server and on a second client; `state.json` still contains its entity records; enable → they return.
5. Delete the package (confirm modal) → content disappears everywhere, disk directory is gone, restarting the room does not resurrect parked entities, and the panel no longer lists it.
6. Publish from another tab while the game runs → server and clients apply within one poll/event cycle.
7. Delete a package that an enabled package depends on → `409` message lists the dependent; disable the dependent and retry → delete succeeds.
