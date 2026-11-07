# Room Read Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a room-level `readAccess` policy (default `all`) so package runtime delivery is no longer hard-gated on membership alone.

**Architecture:** Mirror the existing `packageManagement` / `packageCreation` room-access pattern: nullable columns, `canReadRoom` helper, create/backfill/`updateAccess` wiring, and a third section in `RoomAccessSettingsDialog`. Only `RoomMembershipGuard` switches from `isRoomMember` to `canReadRoom`; opening the room and Game stay on `canViewRoom`.

**Tech Stack:** NestJS 11 + TypeORM, shared TypeScript contracts, Next.js 16 / React 19, Jest (server) + Vitest (frontend), next-intl.

**Spec:** `docs/superpowers/specs/2026-11-07-room-read-access-design.md`

## Global Constraints

- Modes are exactly `all` | `author` | `users`; room author always allowed.
- New rooms and null backfill: `readAccess = 'all'`, `readUserIds = []`.
- Scope is package runtime delivery only — do not touch `canViewRoom`, Game tickets, or WS.
- No DB migrations (`DB_SYNC`); nullable columns with no column-level default.
- Stage only named files in each commit — never `git add -A` / `.` / `-a` (unrelated docs-refactor may be dirty).
- Match surrounding style: server Prettier single quotes; UI copy in both `en.json` and `ru.json`.

## Review Focus

- Contributor under `author` mode is denied delivery (membership no longer grants read) — covered in Task 2 + Task 4.
- Null `readAccess` before backfill: author allowed, stranger denied — covered in Task 2.
- Runtime service user still bypasses the user check but fails when package is not bound to the room — covered in Task 4 (existing cases must keep passing).
- `updateAccess` rejects unknown ids in `readUserIds` the same way as other lists — covered in Task 3.
- Dialog save payload always includes `readAccess` / `readUserIds` so a partial omit cannot leave stale server fields — covered in Task 5.

---

### Task 1: Shared types, entity, DTO

**Files:**
- Modify: `packages/shared/src/api/types.ts` (`Room`, `UpdateRoomAccessPayload`)
- Modify: `packages/server/src/database/entities/room.entity.ts`
- Modify: `packages/server/src/rooms/dto/update-room-access.dto.ts`

**Interfaces:**
- Consumes: existing `RoomAccessMode`
- Produces: `Room.readAccess?: RoomAccessMode`, `Room.readUserIds?: number[]`; same optional fields on `UpdateRoomAccessPayload` and `UpdateRoomAccessDto`; entity columns `readAccess: RoomAccessMode | null`, `readUserIds: number[] | null` (jsonb, default `[]` expression like sibling columns)

- [ ] **Step 1: Add the two fields to shared `Room` and `UpdateRoomAccessPayload`**

- [ ] **Step 2: Add matching nullable columns on `Room` entity (copy sibling column shape)**

- [ ] **Step 3: Add optional validated fields on `UpdateRoomAccessDto`**

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/api/types.ts packages/server/src/database/entities/room.entity.ts packages/server/src/rooms/dto/update-room-access.dto.ts
git commit -m "$(cat <<'EOF'
feat(rooms): add readAccess fields to room contract

EOF
)"
```

---

### Task 2: `canReadRoom` helper

**Files:**
- Modify: `packages/server/src/rooms/room-access.ts`
- Modify: `packages/server/src/rooms/room-access.spec.ts`
- Modify: `frontend/src/utils/room-access.ts` (add fields + `canReadRoom` mirror)
- Modify: `frontend/src/utils/room-access.test.ts`

**Interfaces:**
- Consumes: `RoomAccessSubject` extended with `readAccess?: RoomAccessMode | null`, `readUserIds?: number[] | null`
- Produces: `canReadRoom(room: RoomAccessSubject, userId?: number | null): boolean` — author always true; `all` ⇒ authenticated; `users` ⇒ id in `readUserIds`; `author`/null/other ⇒ author only

- [ ] **Step 1: Write failing server tests in `room-access.spec.ts`**

```ts
describe('canReadRoom', () => {
  const room = {
    isPublic: false,
    author: { id: 1 },
    contributors: [{ id: 2 }],
    readAccess: 'users' as const,
    readUserIds: [2],
  };

  it('allows selected users and the author', () => {
    expect(canReadRoom(room, 2)).toBe(true);
    expect(canReadRoom(room, 1)).toBe(true);
    expect(canReadRoom(room, 3)).toBe(false);
    expect(canReadRoom(room, undefined)).toBe(false);
  });

  it('treats all as any authenticated user', () => {
    const allRoom = { ...room, readAccess: 'all' as const };
    expect(canReadRoom(allRoom, 999)).toBe(true);
    expect(canReadRoom(allRoom, undefined)).toBe(false);
  });

  it('denies contributors under author mode', () => {
    const authorRoom = { ...room, readAccess: 'author' as const, readUserIds: [] };
    expect(canReadRoom(authorRoom, 1)).toBe(true);
    expect(canReadRoom(authorRoom, 2)).toBe(false);
  });

  it('denies strangers when readAccess is null', () => {
    const nullRoom = { ...room, readAccess: null, readUserIds: null };
    expect(canReadRoom(nullRoom, 1)).toBe(true);
    expect(canReadRoom(nullRoom, 3)).toBe(false);
  });
});
```

- [ ] **Step 2: Run server test to verify it fails**

Run: `pnpm --filter server exec jest room-access.spec --runInBand`  
Expected: FAIL — `canReadRoom` not exported / undefined

- [ ] **Step 3: Implement `canReadRoom` in `room-access.ts` (same structure as `canManageRoomPackages`) and extend `RoomAccessSubject`**

- [ ] **Step 4: Run server test to verify it passes**

Run: `pnpm --filter server exec jest room-access.spec --runInBand`  
Expected: PASS

- [ ] **Step 5: Mirror helper + tests on the frontend**

Run: `pnpm --filter frontend exec vitest run src/utils/room-access.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/rooms/room-access.ts packages/server/src/rooms/room-access.spec.ts frontend/src/utils/room-access.ts frontend/src/utils/room-access.test.ts
git commit -m "$(cat <<'EOF'
feat(rooms): add canReadRoom access helper

EOF
)"
```

---

### Task 3: Create defaults, backfill, and `updateAccess`

**Files:**
- Modify: `packages/server/src/rooms/rooms.service.ts` (`create`, `onApplicationBootstrap`, `updateAccess`)
- Modify: `packages/server/src/rooms/rooms.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 fields; `UpdateRoomAccessDto.readUserIds`
- Produces: create sets `readAccess: 'all'`, `readUserIds: []`; bootstrap backfills null `readAccess` → `'all'` and null `readUserIds` → `[]` (also add `{ readAccess: IsNull() }` to the find `where`); `updateAccess` validates/persists the new fields like the existing four

- [ ] **Step 1: Extend failing/updated expectations in `rooms.service.spec.ts`**
  - `create` expects `readAccess: 'all'`, `readUserIds: []`
  - new bootstrap case: null `readAccess` → `'all'` / `[]`
  - bootstrap must not overwrite an explicit `readAccess`
  - `updateAccess` validates unknown ids inside `readUserIds` and persists when valid

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter server exec jest rooms.service.spec --runInBand`  
Expected: FAIL on missing `readAccess` defaults / backfill / update paths

- [ ] **Step 3: Implement create, backfill, and `updateAccess` wiring in `rooms.service.ts`**

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter server exec jest rooms.service.spec --runInBand`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/rooms/rooms.service.ts packages/server/src/rooms/rooms.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(rooms): default and backfill readAccess to all

EOF
)"
```

---

### Task 4: Wire `RoomMembershipGuard`

**Files:**
- Modify: `packages/server/src/scripting-packages/guards/room-membership.guard.ts`
- Modify: `packages/server/src/scripting-packages/guards/room-membership.guard.spec.ts`

**Interfaces:**
- Consumes: `canReadRoom(room, user.id)`
- Produces: human callers pass when `canReadRoom` is true; runtime service user still bypasses membership/`canReadRoom` but keeps package↔room binding; error codes/messages unchanged

- [ ] **Step 1: Update guard fixture room and tests**
  - Base fixture: `readAccess: 'all'`, `readUserIds: []` so existing “allows author/contributor” cases stay green
  - Change `rejects an authenticated non-member` into an allow when `readAccess === 'all'`
  - Add: stranger rejected when `readAccess: 'author'`
  - Add: listed user allowed when `readAccess: 'users'`
  - Add: contributor rejected when `readAccess: 'author'`
  - Keep runtime bypass + wrong-package rejection

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter server exec jest room-membership.guard.spec --runInBand`  
Expected: FAIL — still membership-gated / missing new cases

- [ ] **Step 3: Replace `isRoomMember` with `canReadRoom` for non-runtime users in the guard**

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter server exec jest room-membership.guard.spec --runInBand`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/guards/room-membership.guard.ts packages/server/src/scripting-packages/guards/room-membership.guard.spec.ts
git commit -m "$(cat <<'EOF'
feat(packages): gate runtime delivery on canReadRoom

EOF
)"
```

---

### Task 5: Room access dialog + i18n

**Files:**
- Modify: `frontend/src/app/room/[room_code]/_godot/dialogs/RoomAccessSettingsDialog.tsx`
- Modify: `frontend/src/app/room/[room_code]/_godot/dialogs/RoomAccessSettingsDialog.test.tsx`
- Modify: `frontend/messages/en.json` (`RoomAccess`)
- Modify: `frontend/messages/ru.json` (`RoomAccess`)

**Interfaces:**
- Consumes: `Room.readAccess` / `readUserIds`, `UpdateRoomAccessPayload`
- Produces: third `AccessSection`; save payload includes `readAccess` + `readUserIds`; re-seed on open defaults missing values to `"all"` / `[]`

- [ ] **Step 1: Update i18n**
  - en: `roomRead`: `"Room read"`; widen `description` to mention reading package data for the runtime
  - ru: `roomRead`: `"Чтение комнаты"`; matching description update

- [ ] **Step 2: Extend dialog test expectations** so the save call includes `readAccess: "all"`, `readUserIds: []` (and management change still works with three sections — use section title / index carefully)

- [ ] **Step 3: Run dialog test to verify fail**

Run: `pnpm --filter frontend exec vitest run RoomAccessSettingsDialog`  
Expected: FAIL — payload missing read fields / third section absent

- [ ] **Step 4: Add the third section + state/payload/re-seed in the dialog**

- [ ] **Step 5: Run dialog test to verify pass**

Run: `pnpm --filter frontend exec vitest run RoomAccessSettingsDialog`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/room/[room_code]/_godot/dialogs/RoomAccessSettingsDialog.tsx frontend/src/app/room/[room_code]/_godot/dialogs/RoomAccessSettingsDialog.test.tsx frontend/messages/en.json frontend/messages/ru.json
git commit -m "$(cat <<'EOF'
feat(frontend): expose room read access in settings dialog

EOF
)"
```

---

### Task 6: Verification

**Files:** none new

- [ ] **Step 1: Run targeted server suites**

Run: `pnpm --filter server exec jest room-access.spec rooms.service.spec room-membership.guard.spec --runInBand`  
Expected: PASS

- [ ] **Step 2: Run targeted frontend suites**

Run: `pnpm --filter frontend exec vitest run src/utils/room-access.test.ts RoomAccessSettingsDialog`  
Expected: PASS

- [ ] **Step 3: Typecheck touched packages**

Run: `pnpm --filter server check-types` and `pnpm check-types:frontend`  
Expected: PASS

No commit unless verification forced extra fixes; if fixes land, commit only those named files.
