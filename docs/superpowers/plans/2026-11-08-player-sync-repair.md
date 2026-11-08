# Plan: Repair player synchronizer after package apply

## Problem
After Emit/package apply, client logs:
`Node not found: "Main/.../Players/PlayerN/PlayerBody/Sync"` and player position stops replicating (crates still sync via DynamicWorld).

## Root cause
`PlayersManager.apply_snapshot` on client repairs a missing player via `_adopt_repaired_player` + `build_player`, which recreates components and their `MultiplayerSynchronizer` (Sync). The server's replication cache still references the old node path, so updates are dropped. `_rebuild_components` path has the same issue.

## Root-cause finding
`PlayersManager._rebuild_components()` detached old components with `queue_free()` and immediately published replacement components in `player.components`. `queue_free()` is deferred until the end of the frame, so the old `MultiplayerSynchronizer` remained alive while the replacement used the same `.../Sync` path. A replication packet during that window could resolve the stale path to a missing node on the client, producing `Node not found: .../Sync`.

The attempted `_reregister_synchronizers()` workaround was removed: recreating a child does not repair the engine's path/net-id state and was not sufficient.

## Implemented fix
- Detach old components and call `free()` synchronously before `_add_registered_components()` creates replacements.
- Keep the player root and its spawner identity unchanged.
- Add regression assertions that the old component is invalid before the replacement is exposed and every replacement has a `Sync` node.

## Verification
- `players_manager_smoke.gd`: 122 checks passed.
- `late_join_smoke.gd`: 35 checks passed.
- `git diff --check`: passed.

## Remaining validation
A real two-process server/client run should still be performed with the pinned Godot runtime, because the smoke tests validate lifecycle and path invariants but do not exercise a live WebSocket replication packet during Emit.
