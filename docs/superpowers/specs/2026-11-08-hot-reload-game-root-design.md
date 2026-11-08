# Hot-Reload Game Root Normalization

## Intent
Keep Godot multiplayer node paths stable when a package main scene is a wrapper such as `CustomMain -> Game -> SubViewport`. After hot reload, the live root must remain `Main/Game`, so `MultiplayerSpawner` and `MultiplayerSynchronizer` can resolve existing paths.

## Goals
- Install the package's inner `Game` node as the runtime `_game_root`.
- Preserve `Main/Game/SubViewport/...` paths.
- Preserve package-authored sibling UI/content by moving it under the extracted Game node.
- Keep the existing default-scene fallback and service binding behavior.
- Add a regression test for the nested-wrapper shape.

## Non-goals
- Change player synchronization or spawn protocol.
- Change package scene authoring requirements beyond supporting the existing wrapper shape.
- Change unrelated hot-reload lifecycle warnings.

## Chosen approach
Before swapping, normalize a `WiredGameScene` package instance. If it has a direct child named `Game` containing the configured `world_viewport`, detach that child, move the wrapper's other children under it, attach the `WiredGameScene` script and set its `world_viewport` to the existing viewport. The normalized node is then swapped into the stable `Main/Game` slot. Existing non-wrapper scenes remain unchanged.

## Constraints
The normalized root must retain the stable name and parent slot. Services are still detached before the swap and rebound into the normalized world viewport afterward. Invalid scenes must continue to be rejected without replacing the current root.

## Verification
Run the new nested-root regression through `main_scene_swap_smoke.gd`, then run the related Godot smoke tests and reproduce an Emit in a two-client room, checking that no `Main/Game/Game/...` paths are produced.
