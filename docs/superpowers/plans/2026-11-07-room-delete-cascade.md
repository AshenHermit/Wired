# Room Delete Cascade + Warning Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make room deletion succeed by removing that room’s scripting packages through the existing package cleanup path, and require a warning confirm dialog before the UI fires delete.

**Architecture:** `RoomsService.remove` calls a new `ScriptingPackagesService.removeAllInRoom(roomId)` that deletes every package in the room via `remove` (with same-room dependent checks skipped so cascade cannot deadlock on in-room refs), then deletes the room row. Nest cycle `RoomsModule` ↔ `GodotGameModule` ↔ `ScriptingPackagesModule` is bridged with `forwardRef`. Frontend `RoomEditingPanel` adds a confirm dialog (PackagesTab `useConfirmDialog` shape) before calling `deleteRoom`.

**Tech Stack:** NestJS 11 + TypeORM, Jest; Next.js 16 + React 19 + next-intl + animate-ui Dialog; Vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-room-delete-cascade-design.md`

## Global Constraints

- Cascade must go through `ScriptingPackagesService.remove` (disk + revisions + runtime notify), not bare FK `onDelete: 'CASCADE'` alone.
- UI strings only via `frontend/messages/{en,ru}.json` + `useTranslations`; no hardcoded user-facing copy.
- Do not use `window.confirm`.
- Conventional Commits (`feat:`, `fix:`, `test:`).
- Server tests: `pnpm --filter server exec jest <spec-name>`; frontend: `pnpm --filter frontend exec vitest run <file>`.

## Review Focus

- Mid-cascade failure leaves some packages deleted and room still present — expect partial delete; no multi-package transaction required by spec; document in test that room delete only runs after all package removes resolve.
- Empty room (zero packages) still deletes.
- Confirm cancel must not call `deleteRoom`.
- Constructor arity change in `RoomsService` — every existing `new RoomsService(...)` in `rooms.service.spec.ts` must get the new dependency.
- Russian + English `Rooms.deleteDialog.*` keys both present.

## File map

| File | Role |
|------|------|
| `packages/server/src/scripting-packages/scripting-packages.service.ts` | Add `removeAllInRoom`; optional internal skip for same-room dependents |
| `packages/server/src/scripting-packages/scripting-packages.service.spec.ts` | Tests for `removeAllInRoom` |
| `packages/server/src/rooms/rooms.service.ts` | Call `removeAllInRoom` before room delete |
| `packages/server/src/rooms/rooms.module.ts` | Import `ScriptingPackagesModule` via `forwardRef` |
| `packages/server/src/rooms/rooms.service.spec.ts` | `remove` cascade tests + fix constructors |
| `frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.tsx` | Confirm dialog before delete |
| `frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.test.tsx` | Create: confirm/cancel coverage |
| `frontend/messages/en.json`, `ru.json` | `Rooms.deleteDialog` strings |

---

### Task 1: `removeAllInRoom` on ScriptingPackagesService

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.service.spec.ts`

**Interfaces:**
- Consumes: existing `remove(id: number): Promise<void>`, `packagesRepository`, `assertNoEnabledDependents`
- Produces: `removeAllInRoom(roomId: number): Promise<void>` — loads packages with `where: { room: { id: roomId } }`, deletes each through the same cleanup as `remove`, without failing on enabled dependents that themselves belong to `roomId` (out-of-scope dependents still use existing conflict behavior if the resolver ever returns them)

- [ ] **Step 1: Write failing tests** in `scripting-packages.service.spec.ts`

  - `removeAllInRoom deletes every package in the room via remove cleanup` — assert each in-room package id is deleted / storage cleanup path invoked in the same way as `remove`
  - `removeAllInRoom succeeds when an in-room package has an enabled in-room dependent` — setup where B depends on A in same room; expect both removed (no `package_has_dependents`)
  - `removeAllInRoom is a no-op when the room has no packages`

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec jest scripting-packages.service.spec --testNamePattern=removeAllInRoom`
Expected: FAIL (method missing)

- [ ] **Step 3: Implement `removeAllInRoom(roomId: number): Promise<void>`**

  Approach: find package ids for the room; for each id call an internal path equivalent to `remove` that skips `assertNoEnabledDependents` when every returned dependent’s package is also in that room’s id set (if any dependent is outside the set, keep throwing `ConflictException` as today). Prefer extending `remove` with an optional second argument only if it stays private/internal to the cascade — public HTTP delete behavior must remain unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server exec jest scripting-packages.service.spec --testNamePattern=removeAllInRoom`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/scripting-packages.service.ts packages/server/src/scripting-packages/scripting-packages.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(server): cascade-delete scripting packages for a room

EOF
)"
```

---

### Task 2: Wire room `remove` to package cascade

**Files:**
- Modify: `packages/server/src/rooms/rooms.service.ts`
- Modify: `packages/server/src/rooms/rooms.module.ts`
- Modify: `packages/server/src/rooms/rooms.service.spec.ts`
- Possibly: `packages/server/src/scripting-packages/scripting-packages.module.ts` if `forwardRef` needed on the export side

**Interfaces:**
- Consumes: `ScriptingPackagesService.removeAllInRoom(roomId: number): Promise<void>`
- Produces: `RoomsService.remove(id: number): Promise<void>` — `findOne` → `removeAllInRoom(id)` → `roomsRepository.delete(id)`

- [ ] **Step 1: Write failing tests** in `rooms.service.spec.ts`

  - `remove deletes packages in the room before deleting the room` — mock `removeAllInRoom` + `roomsRepository.delete`; assert `removeAllInRoom` called with room id before `delete`
  - `remove still deletes a room with no packages` — `removeAllInRoom` resolves; `delete` called
  - Update every `new RoomsService(...)` in this file to pass a packages-service mock (`{ removeAllInRoom: jest.fn(async () => undefined) }`)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec jest rooms.service.spec --testNamePattern=remove`
Expected: FAIL on missing cascade behavior / constructor arity

- [ ] **Step 3: Implement wiring**

  - Inject `@Inject(forwardRef(() => ScriptingPackagesService)) private readonly packagesService: ScriptingPackagesService` into `RoomsService`
  - `RoomsModule` imports `forwardRef(() => ScriptingPackagesModule)`
  - `remove`: after `findOne`, `await this.packagesService.removeAllInRoom(id)`, then existing `delete`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server exec jest rooms.service.spec`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/rooms/rooms.service.ts packages/server/src/rooms/rooms.module.ts packages/server/src/rooms/rooms.service.spec.ts packages/server/src/scripting-packages/scripting-packages.module.ts
git commit -m "$(cat <<'EOF'
fix(server): delete room packages before removing the room row

EOF
)"
```

---

### Task 3: Warning modal + i18n in RoomEditingPanel

**Files:**
- Modify: `frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.tsx`
- Create: `frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.test.tsx`
- Modify: `frontend/messages/en.json`
- Modify: `frontend/messages/ru.json`

**Interfaces:**
- Consumes: existing `deleteRoom(id)`, animate-ui `Dialog`, `Common.cancel`
- Produces: confirm gate before delete; keys `Rooms.deleteDialog.title`, `.description`, `.confirm`

- [ ] **Step 1: Add i18n keys**

  en:
  - `title`: `Delete room?`
  - `description`: `Room {name} and all of its packages, revisions, and artifacts will be permanently deleted. This cannot be undone.`
  - `confirm`: `Delete room`

  ru (match Packages.deleteDialog tone):
  - `title`: `Удалить комнату?`
  - `description`: `Комната {name} и все её пакеты, ревизии и артефакты будут удалены безвозвратно. Это действие нельзя отменить.`
  - `confirm`: `Удалить комнату`

- [ ] **Step 2: Write failing Vitest** `RoomEditingPanel.test.tsx`

  - Open edit for a room; click Delete → confirm dialog visible; `deleteRoom` not called yet
  - Cancel → dialog closes; `deleteRoom` never called
  - Confirm → `deleteRoom` called with room id

  Mock `@/api/services/rooms` (`deleteRoom`, `updateRoom`, `createRoom`). Follow patterns from nearby frontend component tests (next-intl / Testing Library).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run RoomEditingPanel`
Expected: FAIL (no confirm gate)

- [ ] **Step 4: Implement confirm dialog in `RoomEditingPanel`**

  Copy the small `useConfirmDialog` pattern from `PackagesTab.tsx` locally into this file (do not extract a shared module unless duplication hurts). On Delete click: `await confirm({ title, description with room name, confirmLabel, destructive: true })`; only then run existing `deleteRoomCb` body.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run RoomEditingPanel`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.tsx frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.test.tsx frontend/messages/en.json frontend/messages/ru.json
git commit -m "$(cat <<'EOF'
feat(frontend): warn before deleting a room and its packages

EOF
)"
```

---

### Task 4: Verification

**Files:** none new

- [ ] **Step 1: Run server specs touched**

Run: `pnpm --filter server exec jest rooms.service.spec scripting-packages.service.spec`
Expected: PASS

- [ ] **Step 2: Run frontend RoomEditingPanel test**

Run: `pnpm --filter frontend exec vitest run RoomEditingPanel`
Expected: PASS

- [ ] **Step 3: Mark design status approved/implemented** in the spec header if desired (optional)

- [ ] **Step 4: No extra commit unless status/doc-only change**
