# Room Access and Privacy Settings Design

Date: 2026-11-06

## Intent

The room Packages tab is renamed to **Room**. Its current package list and
package actions stay unchanged. The tab gains a **Room settings** button with a
modal dialog where the room author can configure who may:

- change package settings and emit packages in the room;
- add new packages to the room.

Separately, each package in the room can define who may edit that package.

The goal is to make room/package privacy explicit and configurable without
changing room visibility (`isPublic`) or the existing package workflow.

## Goals

- Rename the user-facing tab label from "Packages" to "Room"; keep the internal
  tab id `packages` to avoid unnecessary routing/test churn.
- Add room-level access policies for:
  - `packageManagement` (package settings + emit);
  - `packageCreation` (creating/adding packages).
- Add package-level access policy for `packageEditing`.
- Support three modes for every policy:
  - `all` — all authenticated (registered) users;
  - `author` — the room author for room policies, the package author for package
    policy (with the room author retaining baseline access to packages in their
    room);
  - `users` — an explicit list of user IDs.
- Enforce all policies on the backend, with frontend gating that matches.
- Preserve current effective behavior for existing rooms/packages through a
  startup backfill.
- Add an authenticated user search endpoint so "specific users" can be selected
  without exposing private user data.

## Non-goals

- No change to room visibility or membership (`isPublic`, author, contributors).
- No change to game runtime, tickets, WebSocket proxy, or package delivery.
- No new role/permission framework beyond the three policies above.
- No migration of legacy `runtime/v1` artifacts.
- No removal of existing `author`/`contributors` relations; they remain for
  ownership display and compatibility.

## Current behavior

- `Room` has `author` and `contributors`; `canEditRoom` allows only the author.
- `isRoomMember` allows author + contributors.
- Frontend `canManagePackages` is author + contributors.
- `ScriptingPackagesService.create` requires `isRoomMember`.
- `assertPackageEditing` allows package owner (author/contributors) or room
  author.
- `assertPackagePublishing` allows package owner or any room member.
- `PackageEditDialog` edits package metadata and slug.

The new policies replace the implicit "author + contributors" rule for the
specific actions above. Room author keeps baseline ownership rights.

## Data model

### Room

Add nullable columns:

```text
packageManagementAccess   varchar | null   // 'all' | 'author' | 'users'
packageManagementUserIds  jsonb | null     // number[]
packageCreationAccess     varchar | null
packageCreationUserIds    jsonb | null
```

No default at the DB column level. New rooms set the values in `RoomsService`.
Existing rows are backfilled on startup.

### ScriptingPackage

Add nullable columns:

```text
editingAccess    varchar | null   // 'all' | 'author' | 'users'
editingUserIds   jsonb | null     // number[]
```

No DB default. New packages set the value in `ScriptingPackagesService`.
Existing rows are backfilled on startup.

### Shared type

Add to `packages/shared/src/api/types.ts`:

```ts
export type RoomAccessMode = "all" | "author" | "users";

export type UpdateRoomAccessPayload = {
  packageManagementAccess?: RoomAccessMode;
  packageManagementUserIds?: number[];
  packageCreationAccess?: RoomAccessMode;
  packageCreationUserIds?: number[];
};

export type UpdatePackageAccessPayload = {
  editingAccess?: RoomAccessMode;
  editingUserIds?: number[];
};
```

Room and ScriptingPackage shared types gain the new fields as optional for
backward compatibility with older payloads.

## Permission rules

Define helpers in `packages/server/src/rooms/room-access.ts` and use them from
both server and (mirrored) frontend logic where needed.

### Room policies

```ts
canManageRoomPackages(room, userId): boolean
canCreateRoomPackages(room, userId): boolean
```

Evaluation:

- `all`: `userId != null` (authenticated user).
- `author`: `room.author?.id === userId`.
- `users`: `userId` is in the corresponding user ID list.
- Room author is always allowed, even if omitted from a list.

### Package editing

```ts
canEditPackage(pkg, userId): boolean
```

Evaluation:

- Room author of `pkg.room` is always allowed.
- Package author is always allowed.
- Package contributors are allowed only if present in `editingUserIds` after
  migration; the relation itself is not consulted for new decisions.
- `all`: any authenticated user.
- `author`: package author (already covered by baseline).
- `users`: `userId` is in `editingUserIds`.

This means a package policy can only expand access beyond the baseline owners;
it cannot remove the package author or room author.

### Existing actions

- `create` package: use `canCreateRoomPackages`.
- package metadata/edit, slug rename, delete: use `canEditPackage`.
- emit/download/enable/disable and revision publishing: use `canManageRoomPackages`
  for room-wide actions, plus `canEditPackage` where the action targets one
  package? For simplicity, emit uses `canManageRoomPackages` (room-level) because
  emit is a room runtime action. Package metadata uses `canEditPackage`.
- Workshop publish from a room package: use `canManageRoomPackages` (unchanged
  effective behavior: room member).

## Backfill for existing data

On application bootstrap:

- Rooms with null access fields:
  - `packageManagementAccess = 'users'`
  - `packageManagementUserIds = [author.id, ...contributor ids]`
  - same for package creation.
- Packages with null access fields:
  - `editingAccess = 'users'`
  - `editingUserIds = [package author id, ...package contributor ids, room author id]`
  (deduplicated).

This preserves the current "author + contributors" behavior for old rooms.

New rooms/packages are created with `author` mode and empty user lists.

## API changes

### Rooms

Add:

```http
PATCH /rooms/:roomId/access
```

Body: `UpdateRoomAccessPayload`.

Guard: authenticated user. Service calls `canEditRoom(room, userId)` (room author
only). Updates the four access fields. Validates user IDs exist.

Could also include these fields in `UpdateRoomDto`, but a separate endpoint keeps
room metadata updates and permission policy updates distinct and makes
authorization clearer.

### Scripting packages

Add:

```http
PATCH /scripting-packages/:id/access
```

Body: `UpdatePackageAccessPayload`.

Guard: authenticated user. Service allows the call if `canEditRoom(pkg.room, userId)`
or `pkg.author?.id === userId`. Updates `editingAccess` and `editingUserIds`.

### Users

Add an authenticated search endpoint:

```http
GET /users/search?q=<string>&limit=<number>
```

Returns `PublicUser[]` (id, name, picture) for users whose name or email
matches the query. Used by the user picker. Requires authentication. Results are
limited (default 10, max 25). This avoids exposing the full user table while
still allowing selection of specific users.

## Frontend changes

### Tab label

- `frontend/messages/en.json`: `Room.tabs.packages` -> `"Room"`.
- `frontend/messages/ru.json`: `Room.tabs.packages` -> `"Комната"` (or chosen
  Russian label; final wording can be adjusted).
- Internal tab id remains `packages`.

### Room settings modal

Add a `RoomAccessSettingsDialog` component, opened from `PackagesTab` header by a
settings button. Only show the button when `canEditRoom(room, viewerId)` is true
(room author). The dialog contains:

- mode select for package management & emit;
- mode select for package creation;
- user picker for `users` mode;
- save/cancel.

The dialog loads/saves through `updateRoomAccess`.

### User picker

A reusable component that searches users via `searchUsers` and displays selected
users as removable chips. Used in both room and package access dialogs.

### Package access

Extend `PackageEditDialog` (or add a dedicated dialog) with an "Access" section:
mode select + user picker. Save through `updatePackageAccess`. Show this section
only when `canEditRoom(room, viewerId) || pkg.author?.id === viewerId`.

### Permission gating

Replace frontend `canManagePackages` with:

```ts
canManagePackages = canManageRoomPackages(room, viewerId);
canCreatePackages = canCreateRoomPackages(room, viewerId);
```

Add `canEditPackage(entry, viewerId, room)` for edit/delete buttons.

Keep existing UI behavior for users who already had rights via backfill.

## Backend enforcement changes

- `RoomsService.create`: initialize access fields to `author` mode with empty
  user arrays.
- `RoomsService.update`: unchanged for metadata; new access endpoint handles
  policies.
- `ScriptingPackagesService.create`: initialize `editingAccess = 'author'`,
  `editingUserIds = []`.
- `create`: permission check uses `canCreateRoomPackages`.
- `assertPackageEditing`: use `canEditPackage`.
- `assertPackagePublishing`: keep package owner or room member; additionally
  require `canManageRoomPackages` for emit? The current behavior allows any room
  member to publish revisions. To avoid changing behavior unexpectedly, keep
  `assertPackagePublishing` as owner or room member. The room-level
  `packageManagement` policy is enforced in frontend and can also be enforced
  here by requiring `canManageRoomPackages` for publishing revisions. Decision:
  enforce `canManageRoomPackages` in `assertPackagePublishing` for room packages,
  because emit is explicitly part of that policy. This is a behavior change but
  matches the requested feature.

- `canEditPackage` added to `room-access.ts` (package-specific helper can live in
  `scripting-packages` service or `room-access.ts`; keep package helper in
  `scripting-packages.service.ts` because it needs package data).

## Migration/backfill

No SQL migration files (schema is `DB_SYNC`-driven). Backfill runs on
application bootstrap:

- `RoomsService` implements `OnApplicationBootstrap` (or a dedicated
  initializer) and updates null access fields.
- `ScriptingPackagesService` already implements `OnApplicationBootstrap`; extend
  it to backfill package access fields.

Backfill is idempotent and only touches rows where the new fields are null.

## Tests

Server:

- `room-access.spec.ts`: add tests for `canManageRoomPackages`,
  `canCreateRoomPackages`.
- `rooms.service.spec.ts`: backfill and access endpoint authorization.
- `scripting-packages.service.spec.ts`: backfill, `canEditPackage`, create
  permissions, access endpoint.
- `users.controller.spec.ts` or service spec: search endpoint behavior and
  privacy.

Frontend:

- Update `PackagesTab.test.tsx` expectations for new button/dialog and gating.
- Add tests for access mode evaluation helpers.
- Add `RoomAccessSettingsDialog` tests.
- Update `use-room-packages` tests if permission inputs change.

## Risks and open decisions

- `all` mode means any authenticated user, not anonymous visitors. Anonymous
  users still cannot mutate.
- User IDs stored as JSON arrays are not foreign keys; invalid IDs are possible
  if users are deleted. Validation on save prevents new invalid IDs. For v1,
  deletion of a user does not cascade into access lists; stale IDs are a known
  limitation and can be cleaned up in a later iteration.
- Backfill runs once per process startup and is safe for multiple instances
  because it only updates null fields.
- If `DB_SYNC` adds columns with null values, bootstrap must run before the app
  serves requests. Nest bootstrap already awaits `OnApplicationBootstrap`.
- The tab is renamed in UI only; internal id remains `packages`, so deep links
  and tests that use the tab value are unaffected.

## Approval

This document is the design. Implementation should not start until it is
approved. After approval, use `superpowers:writing-plans` to create the
implementation plan.