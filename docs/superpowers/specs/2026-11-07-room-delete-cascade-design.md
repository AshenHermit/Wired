# Room delete cascade + warning modal

**Date:** 2026-11-07  
**Status:** approved  
**Size:** small change

## Intent

Room delete currently dies with Postgres `FK_3722eb880ebdd10139aa6290e48` because `scripting_package.roomId` still points at the room. Fix deletion by removing that room’s packages first (full package cleanup), and require an explicit warning confirmation in the UI before the destructive click runs.

## Goals

- `DELETE /rooms/:id` succeeds when the room has scripting packages.
- Those packages are removed through `ScriptingPackagesService.remove` (revisions, disk files, runtime artifacts, room notification) — not a bare FK cascade.
- Edit-room UI shows a warning modal before delete; cancel leaves the room and packages untouched.
- Same-room package dependency order does not trip `package_has_dependents`.

## Non-goals

- Detaching packages (`roomId = NULL`) or keeping orphan package rows.
- Soft-delete / trash / undo for rooms or packages.
- Changing who may delete a room (auth stays as today).
- Extracting a shared confirm-dialog package beyond what’s needed in `RoomEditingPanel` (reuse the PackagesTab pattern in place or a tiny local helper).
- Migrating `onDelete: 'CASCADE'` on the entity as the primary fix.

## Anti-goals

- Deleting the room while leaving package rows or `runtime/v2` / `revisions/` trees behind.
- Firing delete on the first click of the destructive button with no confirm.
- Silently skipping `assertNoEnabledDependents` for packages still referenced from *other* rooms.

## Constraints

- Root cause: `RoomsService.remove` does `roomsRepository.delete(id)` with no package cleanup; `ScriptingPackage.room` has no `onDelete`.
- `RoomsModule` → `ScriptingPackagesModule` → `GodotGameModule` → `RoomsModule` is a Nest cycle; inject with `forwardRef` (or equivalent ModuleRef) rather than inventing a parallel delete path.
- UI strings live in `frontend/messages/{en,ru}.json` under `Rooms` (next-intl); match Russian copy style of existing `Packages.deleteDialog`.
- Existing package delete confirm lives inline in `PackagesTab` (`useConfirmDialog`); mirror that shape for rooms.

## Approaches considered

1. **Cascade via `packagesService.remove`, then delete room + confirm modal (chosen).** Correct cleanup; reuses dependent-guard and disk cleanup; modal matches existing package UX.
2. **Entity `onDelete: 'CASCADE'` only.** Fixes the FK, orphans files on disk / runtime artifacts.
3. **Raw SQL transaction deleting package/revision rows + room.** Duplicates `remove` and skips storage/runtime notify.

**Picked:** (1).

## Behavior

### Backend (`RoomsService.remove`)

1. `findOne(id)` as today.
2. Load all `scripting_package` rows for that room.
3. Delete them via `ScriptingPackagesService.remove` in an order that clears same-room dependents first (dependents before dependencies). Builder picks topo-sort vs repeated “no remaining in-room enabled dependents” passes; either is fine if tested.
4. If an **enabled** dependent outside this room still references a package being deleted, keep today’s `409 package_has_dependents` — room delete fails; user must resolve the other room first. Modal copy should not promise success in that edge case.
5. Then `roomsRepository.delete(id)`; unchanged NotFound if race.

Wire `ScriptingPackagesModule` into `RoomsModule` with `forwardRef` as needed.

### Frontend (`RoomEditingPanel`)

- Destructive **Delete** opens a second confirm dialog (not `window.confirm`).
- Copy (en/ru): title + description that the room **and all its packages/revisions/artifacts** will be permanently deleted; confirm + cancel.
- Only on confirm call existing `deleteRoom` API; success toast / close / `onChange` unchanged.
- Edit dialog stays open if the user cancels the confirm.

### Tests

- Server: room with packages deletes successfully; packages `remove` invoked; room with out-of-room enabled dependent still conflicts; empty room still deletes.
- Frontend: delete requires confirm; cancel does not call API (extend or add a focused test near room panel if one exists; otherwise light coverage is enough).

## Builder calls

- Exact topo algorithm and whether to stop the room runtime before package deletes: builder decides; prefer notifying package removal the same way single-package delete already does.
- Whether to lift `useConfirmDialog` into a shared hook: only if duplication is awkward; otherwise copy the small pattern into `RoomEditingPanel`.
