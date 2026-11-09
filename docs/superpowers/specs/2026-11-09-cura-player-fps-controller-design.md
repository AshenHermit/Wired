# Cura Player FPS Controller Design

Date: 2026-11-09

## Intent

`packages/server/godot_project/examples/cura_player` is a first-person example
copied from `wired-platformer`. Its `character.gd` still contains 2D
platformer logic wrapped in 3D nodes, so the player cannot move or look
properly: rotation is applied twice (locally and on the server), horizontal
velocity accumulates without a cap, `speed` is unused, the dash uses world X,
and saves drop the Z axis. The example must become a working FPS controller:
WASD movement with gravity/jump, mouse look with an instantly responsive local
camera, and server-authoritative body movement.

## Goals

- Instant local mouse look (camera follows the mouse with no network latency).
- Server-authoritative movement, jump, dash and body position, matching the
  existing Wired player-component contract.
- Correct 3D replication: remote peers see the server body position and look
  orientation without fighting the owner's local camera.
- Save/load the full 3D position, velocity and look angles.
- Keep the package self-contained and conventional for Wired examples.

## Non-goals

- Client-side movement prediction or rollback.
- Shooting, weapon models, animations, crouch/sprint/stamina.
- Network interpolation/extrapolation for remote players.
- Changing Wired core scripts, the core input map or the platformer example.

## Constraints

- The server simulates server-authority components; clients only render
  replicated values and send intents through `request_action`.
- `WiredPlayer.request_action` is a reliable RPC limited to 20 actions/second
  per player. Mouse motion must never be sent per event.
- The core already samples `wired_move_*`/`wired_jump` at 30 Hz on the
  unreliable channel and stores the validated snapshot in `WiredPlayer.input`.
- `MultiplayerSynchronizer` replicates server values to every peer, including
  the owner; a replicated body rotation would overwrite the owner's local look.

## Approaches

1. **Client-side look + local camera, server-authoritative body (chosen).**
   The owner applies mouse deltas to `Body.rotation.y` and `Camera.rotation.x`
   immediately and sends absolute yaw/pitch to the server at 15 Hz. The server
   uses yaw for movement/dash direction and replicates yaw/pitch to other
   peers. The owner never lets replicated rotation drive its own camera.
2. **Server-side look.** The client sends deltas, the server rotates and
   replicates; consistent, but the view lags by a full round trip and mouse
   motion would have to be throttled hard. Rejected for an FPS.
3. **Client-authoritative body movement.** The owner simulates and reports its
   position. Rejected: contradicts the existing server-authority model and
   needs reconciliation.

Input channel:

- Use the existing core 30 Hz unreliable snapshot (`WiredPlayer.input`) for
  movement and jump. It is already validated, rate-free, and does not consume
  the package action budget.
- Use one package action `look` at 15 Hz for absolute yaw/pitch and one
  `dash` action. Together they stay below 20 actions/second.

## Design

### Input and look

- Register the `look` and `dash` gameplay actions and a `cura_player/dash`
  InputMap action on Shift. Movement and jump use the core snapshot; a Shift
  press sends the package `dash` action via `request_action`.
- `_wired_ready`: the local player makes the camera current. A left click
  captures the pointer (browser pointer lock requires a user gesture);
  Escape releases it.
- `_wired_unhandled_input` (local player only): a Shift press sends `dash`;
  on captured `InputEventMouseMotion`, apply `relative` with
  `mouse_sensitivity`, clamp pitch to ±89°, update
  `Body.rotation.y`/`Camera.rotation.x` immediately, and mark look dirty.
  On web, a delta whose real `Input.mouse_mode` is not captured clears the
  capture flag and is ignored, because the browser can drop pointer lock
  without delivering Escape.
- `_wired_visual_process` (every peer, every idle frame):
  - owner before the first mouse movement: use the replicated yaw/pitch;
  - owner after the first mouse movement: apply `_local_yaw`/`_local_pitch`
    every frame so replication can never snap the camera back;
  - clear a stale capture flag when web pointer lock is gone;
  - non-owner: apply replicated yaw/pitch;
  - show the remote avatar only to non-owners;
  - publish `Body.position` into the player anchor in all cases.
- Look snapshot is sent from `_wired_visual_process` at most every 66 ms while
  dirty; payload is absolute `{yaw, pitch}` in radians.

### Movement (server)

- Movement comes from `player.input.move` (`x` right/left, `y` down/up).
- Wish direction is derived from server yaw:
  `right = (cos yaw, 0, -sin yaw)`, `forward = (-sin yaw, 0, -cos yaw)`,
  `wish = right * move.x + forward * (-move.y)`.
- With input: horizontal velocity is set to `wish.normalized() * speed`
  (no accumulation). Without input: decay with `friction`.
- Jump: rising edge only (`player.input.jump`), applied when
  `is_on_floor()`; otherwise `velocity.y -= gravity * delta`.
- Dash: on the `dash` action, direction is the current wish direction,
  falling back to body forward; horizontal velocity is locked to
  `dash_speed` for `dash_duration`, with a cooldown. Ignored while on
  cooldown.
- `move_and_slide()`, then publish the anchor.

### Replication

- Replicated properties: `Body:position`, `Body:velocity`,
  `replicated_yaw`, `replicated_pitch`.
- Do **not** replicate `Body:rotation` / `Body/Camera:rotation`: the owner
  drives them locally, and remote peers derive them from the replicated
  angles in `_wired_visual_process`.
- Server physics keeps `body.rotation.y = _yaw` so the body's forward axis
  matches movement; the camera is not used for movement.
- `_on_look` validates the sender, finiteness, wraps yaw and clamps pitch.

### Persistence

- Save `{position: [x, y, z], linear_velocity: [x, y, z], yaw, pitch}`.
- Load accepts old 2-element arrays (missing `z` defaults to `0`), restores
  the body transform and velocity, applies yaw/pitch, and updates the anchor.

### Scene

- Remove the `speed = 1.0` override (default becomes `6.0` m/s).
- Give the capsule explicit proportions (`radius 0.4`, `height 1.8`) and
  offset it to `y = 0.9`, so the body origin is at the feet.
- Put the camera at eye height: `y = 1.6` above the feet (1.6 m above the
  floor at rest), not 1.6 m above the capsule centre.
- Add a capsule `MeshInstance3D` avatar aligned with the collider so remote
  peers can see the player; hide it for the owning player.
- Put the spawn marker on the floor (`y = 0.5`) so the body does not drop on
  spawn.

## Files

- `packages/server/godot_project/examples/cura_player/player/character.gd`
- `packages/server/godot_project/examples/cura_player/player/player_character.tscn`
- `docs/superpowers/specs/2026-11-09-cura-player-fps-controller-design.md`

## Calls made by the planner

- Core input instead of package-local WASD: less code, 30 Hz, no action
  budget, and the core already validates the snapshot.
- 15 Hz absolute look snapshots instead of deltas: reliable channel, no drift,
  and well below the action limit. Remote rotation steps at 15 Hz are
  acceptable for an example; the owner is unaffected.
- Keep server-authoritative position (no prediction) to match Wired's player
  contract.

## Open items for the builder

- Verify the example still parses and imports in the pinned 4.8-beta2 project.
- Manual check in the Game tab: local look is instant, WASD moves relative to
  view, jump/dash replicate to a second client, and the camera does not snap.
