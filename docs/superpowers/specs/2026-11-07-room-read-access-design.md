# Room Read Access Design

Date: 2026-11-07

## Intent

Non-members hitting package runtime delivery get `You cannot read this room`
because `RoomMembershipGuard` hard-requires `isRoomMember`. Authors need a
room setting that controls who may **read** room package artifacts for the
runtime, defaulting to everyone authenticated (`all` / «все»).

## Goals

- Add room policy `readAccess` / `readUserIds` with the existing
  `all` | `author` | `users` modes.
- Enforce it on package runtime delivery (`RoomMembershipGuard`).
- Expose it as a third section in `RoomAccessSettingsDialog`.
- Default new rooms to `all`; backfill null rows to `all` (opens delivery for
  existing rooms to any signed-in user — intentional).
- Keep room author always allowed; runtime service user stays exempt from the
  user check but still package-bound.

## Non-goals

- No change to `isPublic` / `canViewRoom` (opening the room).
- No change to Game tickets, WebSocket proxy, or play gating.
- No change to `packageManagement` / `packageCreation` / package editing.
- No broader “every read endpoint” sweep.

## Anti-goals

- Conflating read with manage/create policies.
- Leaving delivery gated only on membership while the UI claims «все».

## Constraints

- Mirror the existing room-access pattern (nullable columns, startup backfill,
  `UpdateRoomAccessPayload`, shared + frontend helpers).
- `DB_SYNC`-driven schema; no migrations.
- Stage only named feature files; dirty tree may hold unrelated docs-refactor.

## Approaches

1. **Dedicated `readAccess` policy, backfill `all` (chosen)** — same shape as
   management/creation; guard uses `canReadRoom`; dialog gains a section;
   existing rooms become readable by all authenticated users after backfill.
2. **Same policy, status-quo backfill** — old rooms get `users` =
   author+contributors; rejected because the product default is «все» and the
   current membership lock is the bug being fixed.
3. **Reuse `canViewRoom`** — no dialog setting; strangers only if public;
   rejected because it cannot express `author`/`users`.

## Design

### Data

Room columns (nullable, no DB default):

- `readAccess: RoomAccessMode | null`
- `readUserIds: number[] | null` (jsonb)

Shared: extend `Room`, `UpdateRoomAccessPayload`.

### Rules

`canReadRoom(room, userId)` in `room-access.ts` (and frontend mirror if needed):

- author always true;
- `all`: any authenticated user;
- `author`: author only;
- `users`: id in `readUserIds`;
- unauthenticated → false.

`RoomMembershipGuard`: replace `isRoomMember` with `canReadRoom` for human
users; keep `isRuntimeServiceUser` bypass; keep package↔room binding.

### Defaults / backfill

- Create: `readAccess = 'all'`, `readUserIds = []`.
- Bootstrap null → same (`all`, `[]`).

### API / UI

- `PATCH /rooms/:id/access` accepts the two new fields (author-only via
  `canEditRoom`).
- Dialog: third `AccessSection` («Чтение комнаты» / «Room read»); save payload
  includes the new fields; `onSaved` still replaces room state.

### Tests

- `canReadRoom` unit cases.
- Guard: member, stranger with `all`, stranger with `author`, listed `users`,
  runtime service user, wrong package/room.
- Service create/backfill defaults; access PATCH round-trip.
- Dialog/i18n smoke as needed.

## Builder notes

Rename of the guard class is optional; behavior change matters more than the
name. Frontend `canReadRoom` only if some UI gates on it; delivery errors
surface from the API either way.
