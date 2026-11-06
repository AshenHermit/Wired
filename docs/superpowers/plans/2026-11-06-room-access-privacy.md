# Room Access and Privacy Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable room/package privacy policies, rename the Packages tab to Room, and enforce the new rules on backend and frontend.

**Architecture:** Store three access policies as nullable JSON-backed columns on `Room` and `ScriptingPackage`, backfill existing rows to preserve current behavior, enforce them through `room-access.ts` and `ScriptingPackagesService`, and expose them through focused REST endpoints and modals.

**Tech Stack:** NestJS 11, TypeORM, PostgreSQL, Next.js 16, React 19, next-intl, Vitest, Jest.

**Spec:** `docs/superpowers/specs/2026-11-06-room-access-privacy-design.md`

## Global Constraints

- `DB_SYNC`-driven schema: add columns as nullable; no migration files.
- New rooms/packages default to `author` mode with empty user lists.
- Existing rows backfill only when the new fields are null.
- `all` means all authenticated users, never anonymous visitors.
- Room author and package author are never locked out by a policy.
- UI copy must live in `frontend/messages/{en,ru}.json`.
- Conventional Commits.

## Review Focus

1. Anonymous caller tries to mutate room/package access — must receive 401, not a partial update.
2. Room or package author is omitted from a `users` list — must still retain access.
3. Existing rooms with contributors must keep those contributors' rights after backfill.
4. Package editing rights must not accidentally grant room-wide package creation rights.
5. Stale user IDs in access lists must not grant access to a different, newly created user with the same numeric id (IDs are immutable, but the list must be treated as exact-match only).

---

### Task 1: Shared access types

**Files:**
- Modify: `packages/shared/src/api/types.ts`

**Interfaces:**
- Produces: `RoomAccessMode`, `UpdateRoomAccessPayload`, `UpdatePackageAccessPayload`; optional access fields on `Room` and `ScriptingPackage`.

- [ ] **Step 1: Add the shared types**

Add `RoomAccessMode`, `UpdateRoomAccessPayload`, and `UpdatePackageAccessPayload`. Add optional `packageManagementAccess`, `packageManagementUserIds`, `packageCreationAccess`, `packageCreationUserIds` to `Room`; add optional `editingAccess`, `editingUserIds` to `ScriptingPackage`.

- [ ] **Step 2: Typecheck shared**

Run: `pnpm --filter server check-types` (server imports shared through tsconfig paths)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api/types.ts
git commit -m "feat(shared): add room and package access policy types"
```

---

### Task 2: Room entity columns

**Files:**
- Modify: `packages/server/src/database/entities/room.entity.ts`

**Interfaces:**
- Consumes: `RoomAccessMode` is string at DB level.
- Produces: nullable columns on `Room`.

- [ ] **Step 1: Add columns**

Add four nullable columns: `packageManagementAccess`, `packageManagementUserIds`, `packageCreationAccess`, `packageCreationUserIds`. Use `varchar` for mode and `jsonb` with default `[]` for IDs. Do not set a non-null default.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/database/entities/room.entity.ts
git commit -m "feat(server): add room access policy columns"
```

---

### Task 3: Package entity columns

**Files:**
- Modify: `packages/server/src/database/entities/scripting-package.entity.ts`

**Interfaces:**
- Produces: nullable `editingAccess`, `editingUserIds` on `ScriptingPackage`.

- [ ] **Step 1: Add columns**

Add nullable `editingAccess` (varchar) and `editingUserIds` (jsonb, default `[]`).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/database/entities/scripting-package.entity.ts
git commit -m "feat(server): add package editing access columns"
```

---

### Task 4: Room access helpers

**Files:**
- Modify: `packages/server/src/rooms/room-access.ts`
- Modify: `packages/server/src/rooms/room-access.spec.ts`

**Interfaces:**
- Produces: `canManageRoomPackages(room, userId)`, `canCreateRoomPackages(room, userId)`.
- Consumes: extended `RoomAccessSubject` with access fields.

- [ ] **Step 1: Write failing tests**

Extend the subject type in tests and add:

```ts
const room = {
  isPublic: false,
  author: { id: 1 },
  contributors: [{ id: 2 }],
  packageManagementAccess: 'users',
  packageManagementUserIds: [2],
  packageCreationAccess: 'author',
  packageCreationUserIds: [],
};

it('allows selected users and the author to manage packages', () => {
  expect(canManageRoomPackages(room, 2)).toBe(true);
  expect(canManageRoomPackages(room, 1)).toBe(true);
  expect(canManageRoomPackages(room, 3)).toBe(false);
  expect(canManageRoomPackages(room, undefined)).toBe(false);
});

it('treats all as any authenticated user', () => {
  const allRoom = { ...room, packageManagementAccess: 'all' };
  expect(canManageRoomPackages(allRoom, 999)).toBe(true);
  expect(canManageRoomPackages(allRoom, undefined)).toBe(false);
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter server exec jest room-access`
Expected: FAIL.

- [ ] **Step 3: Implement helpers**

Import `RoomAccessMode` from `@wired-io/shared`. Implement `canManageRoomPackages` and `canCreateRoomPackages`. Room author is always allowed. `all` requires `userId != null`. Exact-match only for `users`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server exec jest room-access`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/rooms/room-access.ts packages/server/src/rooms/room-access.spec.ts
git commit -m "feat(server): add room package access helpers"
```

---

### Task 5: Room backfill and create defaults

**Files:**
- Modify: `packages/server/src/rooms/rooms.service.ts`
- Modify: `packages/server/src/rooms/rooms.service.spec.ts` (if present)

**Interfaces:**
- Produces: `RoomsService.onApplicationBootstrap`, `create` initializes access fields, `assertRoomAccessEditing`.
- Consumes: `Room` entity columns.

- [ ] **Step 1: Write failing tests**

Add tests for bootstrap backfill of null access fields and author-only default on create.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter server exec jest rooms.service`
Expected: FAIL.

- [ ] **Step 3: Implement backfill and defaults**

Implement `OnApplicationBootstrap` in `RoomsService`. Backfill null fields to `users` mode with author + contributors. Set new rooms to `author` mode with empty arrays. Add `assertRoomAccessEditing(user, roomId)` using `canEditRoom`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server exec jest rooms.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/rooms/rooms.service.ts
git commit -m "feat(server): backfill and default room access policies"
```

---

### Task 6: Room access endpoint

**Files:**
- Create: `packages/server/src/rooms/dto/update-room-access.dto.ts`
- Modify: `packages/server/src/rooms/rooms.controller.ts`
- Modify: `packages/server/src/rooms/rooms.service.ts`

**Interfaces:**
- Produces: `PATCH /rooms/:roomId/access`, `RoomsService.updateAccess(roomId, dto, user)`.
- Consumes: `UpdateRoomAccessPayload`.

- [ ] **Step 1: Add DTO**

Create DTO with optional mode and user ID array fields. Add validation decorators consistent with existing DTOs.

- [ ] **Step 2: Add controller route**

Add authenticated `PATCH :roomId/access` calling `assertRoomAccessEditing` then `updateAccess`. Add a controller test asserting an anonymous request returns 401.

- [ ] **Step 3: Implement service method**

Validate user IDs exist, update the four fields, return room.

- [ ] **Step 4: Typecheck/tests**

Run: `pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/rooms/dto/update-room-access.dto.ts packages/server/src/rooms/rooms.controller.ts packages/server/src/rooms/rooms.service.ts
git commit -m "feat(server): add room access update endpoint"
```

---

### Task 7: Package backfill and create defaults

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`

**Interfaces:**
- Produces: package access fields initialized on create; backfill in existing `onApplicationBootstrap`.
- Consumes: `ScriptingPackage` columns.

- [ ] **Step 1: Write failing tests**

Add tests for bootstrap backfill and create defaults.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend `onApplicationBootstrap` to backfill null `editingAccess` to `users` with author + contributors + room author. Set new packages to `author` mode with empty list.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/scripting-packages.service.ts
git commit -m "feat(server): backfill and default package editing access"
```

---

### Task 8: Package editing access helper and enforcement

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`

**Interfaces:**
- Produces: `canEditPackage(pkg, userId)`, `assertPackageAccessEditing(user, packageId)`.
- Consumes: `Room` access baseline.

- [ ] **Step 1: Write failing tests**

Add tests for all modes, author baseline, room author baseline, and selected users.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: FAIL.

- [ ] **Step 3: Implement**

Implement `canEditPackage` and use it in `assertPackageEditing`. Keep `assertPackagePublishing` logic but add `canManageRoomPackages` for room packages.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/scripting-packages.service.ts
git commit -m "feat(server): enforce package editing access policies"
```

---

### Task 9: Package access endpoint

**Files:**
- Create: `packages/server/src/scripting-packages/dto/update-package-access.dto.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`

**Interfaces:**
- Produces: `PATCH /scripting-packages/:id/access`, `ScriptingPackagesService.updateAccess(id, dto, user)`.

- [ ] **Step 1: Add DTO and route**

Create DTO with optional `editingAccess` and `editingUserIds`. Add authenticated route. Add a controller test asserting an anonymous request returns 401.

- [ ] **Step 2: Implement service method**

Authorize via room author or package author. Validate user IDs. Update fields. Return package.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/scripting-packages/dto/update-package-access.dto.ts packages/server/src/scripting-packages/scripting-packages.controller.ts packages/server/src/scripting-packages/scripting-packages.service.ts
git commit -m "feat(server): add package access update endpoint"
```

---

### Task 10: Create permissions use new policies

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`

**Interfaces:**
- Consumes: `canCreateRoomPackages`.

- [ ] **Step 1: Update `create`**

Replace `isRoomMember(foundRoom, user.id)` with `canCreateRoomPackages(foundRoom, user.id)`.

- [ ] **Step 2: Update tests**

Adjust service tests to reflect new gating.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter server exec jest scripting-packages.service`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/scripting-packages/scripting-packages.service.ts
git commit -m "feat(server): gate package creation on room policy"
```

---

### Task 11: User search endpoint

**Files:**
- Modify: `packages/server/src/users/users.controller.ts`
- Modify: `packages/server/src/users/users.service.ts`

**Interfaces:**
- Produces: `GET /users/search?q=&limit=`, returns `PublicUser[]`.

- [ ] **Step 1: Write failing tests**

Add service/controller tests for authenticated search and result projection.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter server exec jest users`
Expected: FAIL.

- [ ] **Step 3: Implement search**

Add `search(query, limit)` to `UsersService` using ILIKE on name/email, limited. Add controller route with auth guard. Return public fields only.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server exec jest users`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/users/users.controller.ts packages/server/src/users/users.service.ts
git commit -m "feat(server): add authenticated user search endpoint"
```

---

### Task 12: Frontend API services

**Files:**
- Modify: `frontend/src/api/services/rooms.ts`
- Modify: `frontend/src/api/services/scripting-packages.ts`
- Create: `frontend/src/api/services/users.ts` additions or modify existing

**Interfaces:**
- Produces: `updateRoomAccess`, `updatePackageAccess`, `searchUsers`.

- [ ] **Step 1: Add API functions**

Add typed calls for new endpoints.

- [ ] **Step 2: Typecheck frontend**

Run: `pnpm check-types:frontend`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/services/rooms.ts frontend/src/api/services/scripting-packages.ts frontend/src/api/services/users.ts
git commit -m "feat(frontend): add access policy API calls"
```

---

### Task 13: Frontend permission helpers

**Files:**
- Create: `frontend/src/utils/room-access.ts`
- Create: `frontend/src/utils/room-access.test.ts`

**Interfaces:**
- Produces: `canManageRoomPackages`, `canCreateRoomPackages`, `canEditPackage`.

- [ ] **Step 1: Write failing tests**

```ts
const room = {
  author: { id: 1 },
  packageManagementAccess: "users",
  packageManagementUserIds: [2],
  packageCreationAccess: "author",
  packageCreationUserIds: [],
};

it("mirrors server room package rights", () => {
  expect(canManageRoomPackages(room, 1)).toBe(true);
  expect(canManageRoomPackages(room, 2)).toBe(true);
  expect(canManageRoomPackages(room, 3)).toBe(false);
});

it("lets package policy expand beyond room owners", () => {
  const pkg = {
    author: { id: 5 },
    room: { author: { id: 1 } },
    editingAccess: "users",
    editingUserIds: [9],
  };
  expect(canEditPackage(pkg, 9, room)).toBe(true);
  expect(canEditPackage(pkg, 7, room)).toBe(false);
  expect(canEditPackage(pkg, 1, room)).toBe(true);
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter frontend exec vitest run room-access`
Expected: FAIL.

- [ ] **Step 3: Implement helpers**

Mirror server rules.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter frontend exec vitest run room-access`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/room-access.ts frontend/src/utils/room-access.test.ts
git commit -m "feat(frontend): add room and package access helpers"
```

---

### Task 14: Rename tab label

**Files:**
- Modify: `frontend/messages/en.json`
- Modify: `frontend/messages/ru.json`

**Interfaces:**
- Produces: tab label "Room"/"Комната".

- [ ] **Step 1: Update labels**

Change `Room.tabs.packages` to `"Room"` and `"Комната"`.

- [ ] **Step 2: Commit**

```bash
git add frontend/messages/en.json frontend/messages/ru.json
git commit -m "feat(frontend): rename room packages tab to Room"
```

---

### Task 15: User picker component

**Files:**
- Create: `frontend/src/components/access/UserPicker.tsx`

**Interfaces:**
- Consumes: `searchUsers`.
- Produces: reusable picker with selected chips.

- [ ] **Step 1: Implement component**

Search input, results list, selected chips, remove action.

- [ ] **Step 2: Typecheck**

Run: `pnpm check-types:frontend`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/access/UserPicker.tsx
git commit -m "feat(frontend): add reusable user picker"
```

---

### Task 16: Room access settings dialog

**Files:**
- Create: `frontend/src/app/room/[room_code]/_godot/dialogs/RoomAccessSettingsDialog.tsx`
- Modify: `frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx`

**Interfaces:**
- Consumes: `updateRoomAccess`, `UserPicker`, `RoomAccessMode`.
- Produces: modal with two policy selectors.

- [ ] **Step 1: Implement dialog**

Mode selects and user pickers for both policies. Save/cancel. Show validation errors.

- [ ] **Step 2: Add settings button**

In `PackagesTab` header, show button only when `canEditRoom(room, viewerId)` (pass room or author id). Open dialog.

- [ ] **Step 3: Typecheck**

Run: `pnpm check-types:frontend`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/room/[room_code]/_godot/dialogs/RoomAccessSettingsDialog.tsx frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx
git commit -m "feat(frontend): add room access settings dialog"
```

---

### Task 17: Package access UI

**Files:**
- Modify: `frontend/src/app/room/[room_code]/_godot/dialogs/PackageEditDialog.tsx`

**Interfaces:**
- Consumes: `updatePackageAccess`, `UserPicker`.

- [ ] **Step 1: Add access section**

Add mode select + user picker. Save access through `updatePackageAccess`. Show only when author/room author.

- [ ] **Step 2: Typecheck**

Run: `pnpm check-types:frontend`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/room/[room_code]/_godot/dialogs/PackageEditDialog.tsx
git commit -m "feat(frontend): add per-package editing access controls"
```

---

### Task 18: Wire frontend gating

**Files:**
- Modify: `frontend/src/app/room/[room_code]/_godot/RoomWorkspace.tsx`
- Modify: `frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx`

**Interfaces:**
- Consumes: `canManageRoomPackages`, `canCreateRoomPackages`, `canEditPackage`.

- [ ] **Step 1: Replace `canManagePackages`**

Use `canManageRoomPackages(room, viewerId)`. Add `canCreatePackages` and `canEditPackage`.

- [ ] **Step 2: Gate buttons**

Create button uses `canCreatePackages`; edit/delete use `canEditPackage`.

- [ ] **Step 3: Run frontend tests**

Run: `pnpm --filter frontend test`
Expected: PASS (update tests as needed).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/room/[room_code]/_godot/RoomWorkspace.tsx frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx
git commit -m "feat(frontend): gate room package actions on access policies"
```

---

### Task 19: Final verification

**Files:**
- None

- [ ] **Step 1: Run server tests**

Run: `pnpm --filter server test`
Expected: all passing.

- [ ] **Step 2: Run frontend tests**

Run: `pnpm --filter frontend test`
Expected: all passing.

- [ ] **Step 3: Typecheck both**

Run: `pnpm check-types:frontend && pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 4: Commit any final test updates**

```bash
git add -A
git commit -m "test: cover room and package access policies"
```
