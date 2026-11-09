# Cura Player FPS Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `examples/cura_player` into a working first-person controller with instant local mouse look and server-authoritative 3D movement, jump and dash.

**Architecture:** The owning client applies mouse deltas to `Body.rotation.y` / `Camera.rotation.x` immediately and sends absolute yaw/pitch at 15 Hz. The server reads the core 30 Hz input snapshot for WASD/jump, derives the wish direction from yaw, simulates the body, and replicates position, velocity and look angles. Replicated body/camera rotation is deliberately absent so the owner's camera is never overwritten.

**Tech Stack:** Godot 4.8-beta2, GDScript, headless `SceneTree` smoke tests (`_wired/tests/*_smoke.gd`).

**Spec:** `docs/superpowers/specs/2026-11-09-cura-player-fps-controller-design.md`

## Global Constraints

- Godot **4.8-beta2** only; the base project declares `config/features` `"4.8"`.
- Do not modify `_wired` core scripts, the core input map or `wired-platformer`.
- Server-authority components simulate on the server; clients send intents only through `WiredPlayerComponent.request_action`.
- `request_action` is limited to **20 actions/second** per player. Look snapshots are sent at most every **66 ms**; movement and jump use `WiredPlayer.input`, not package actions.
- The owner's local camera must never be overwritten by replicated values.
- GDScript uses tabs; keep UTF-8.

## Review Focus

- **WASD relative to view:** pushing W must move where the camera looks after any yaw; A/D must strafe, not turn. Pinned by `test_wish_direction_follows_yaw`.
- **Camera snap-back:** the owner must keep its local yaw/pitch after the first mouse movement even while the server keeps replicating look angles. Pinned by `test_visual_look_prefers_local_after_first_mouse_move`.
- **Replication conflict:** `Body:rotation` and `Body/Camera:rotation` must not be replicated. Pinned by `test_replication_uses_look_angles`.
- **Save compatibility:** old 2-element `[x, y]` position/velocity arrays must load without losing the body. Pinned by `test_old_two_axis_state_loads`.
- **Jump spam:** holding jump must not auto-bunny-hop; only a rising edge on the floor jumps. Pinned by `test_jump_requires_rising_edge`.
- **Pointer lock:** mouse motion must not rotate anything while the pointer is not captured. Pinned by `test_mouse_look_requires_capture`.
- **Pitch limits:** pitch must stay inside ±89°, never flip the camera. Pinned by `test_pitch_is_clamped`.
- **Dash:** Shift sends a package-qualified `dash` action via `request_action`. Pinned by `test_local_shift_requests_dash`.
- **Pointer lock guard:** `apply_mouse_look` uses `_look_input_allowed()`, which reads real `Input.mouse_mode` on web and clears stale capture flags. Pinned by `test_pointer_lock_guard_uses_real_mode`.
- **Remote avatar visibility:** non-local players show a `Mesh` avatar; the owner hides its own. Pinned by `test_remote_avatar_visibility`.
- **Component contract:** `_wired_ready` registers `dash` and replicates `replicated_yaw`/`replicated_pitch`. Pinned by `test_ready_registers_component_contract`.

---

### Task 1: FPS Controller, Scene and Headless Smoke Test

**Files:**
- Create: `packages/server/godot_project/_wired/tests/fps_controller_smoke.gd`
- Modify: `packages/server/godot_project/examples/cura_player/player/character.gd`
- Modify: `packages/server/godot_project/examples/cura_player/player/player_character.tscn`

**Interfaces:**
- Consumes: `WiredPlayerComponent` hooks (`_wired_ready`, `_wired_unhandled_input`, `_wired_physics_process`, `_wired_visual_process`, `_wired_replicated_properties`, `_wired_save_state`, `_wired_load_state`), `WiredPlayer.input` (`{move: Vector2, jump: bool, seq: int}`), `register_action`, `request_action`, `player.set_anchor_position_3d`.
- Produces: `func wish_direction(yaw: float, move: Vector2) -> Vector3`, `func dash_direction(yaw: float, move: Vector2) -> Vector3`, `func clamp_look_pitch(pitch: float) -> float`, `func jump_edge(on_floor: bool, jump_down: bool, was_down: bool) -> bool`, `func visual_yaw() -> float`, `func visual_pitch() -> float`, `func apply_mouse_look(relative: Vector2) -> void`, `func look_is_active(captured: bool, mouse_mode: int, is_web: bool) -> bool`, `func _look_input_allowed() -> bool`, replicated properties `replicated_yaw`, `replicated_pitch`, and the `look` / `dash` actions.

- [ ] **Step 1: Write the failing headless smoke test**

Create `packages/server/godot_project/_wired/tests/fps_controller_smoke.gd`:

```gdscript
extends SceneTree

## Headless smoke test for the cura_player FPS controller.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/fps_controller_smoke.gd --quit-after 2

const EXAMPLE_DIR := "../examples/cura_player"
const CHARACTER_PATH := "player/player_character.tscn"
const EPSILON := 0.001

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_wish_direction_follows_yaw()
	test_pitch_is_clamped()
	test_jump_requires_rising_edge()
	test_visual_look_prefers_local_after_first_mouse_move()
	test_replication_uses_look_angles()
	test_old_two_axis_state_loads()
	test_mouse_look_requires_capture()
	test_scene_is_fps_ready()
	test_local_shift_requests_dash()
	test_pointer_lock_guard_uses_real_mode()
	test_remote_avatar_visibility()
	test_ready_registers_component_contract()
	_finish()


func test_wish_direction_follows_yaw() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	_check_vector(
		character.wish_direction(0.0, Vector2(0.0, -1.0)),
		Vector3(0.0, 0.0, -1.0),
		"W at yaw 0 must point forward",
	)
	_check_vector(
		character.wish_direction(0.0, Vector2(0.0, 1.0)),
		Vector3(0.0, 0.0, 1.0),
		"S at yaw 0 must point backward",
	)
	_check_vector(
		character.wish_direction(0.0, Vector2(1.0, 0.0)),
		Vector3(1.0, 0.0, 0.0),
		"D at yaw 0 must point right",
	)
	_check_vector(
		character.wish_direction(0.0, Vector2(-1.0, 0.0)),
		Vector3(-1.0, 0.0, 0.0),
		"A at yaw 0 must point left",
	)
	_check_vector(
		character.wish_direction(PI / 2.0, Vector2(1.0, 0.0)),
		Vector3(0.0, 0.0, -1.0),
		"D at yaw 90 degrees must use the rotated right axis",
	)
	_check_vector(
		character.wish_direction(0.0, Vector2.ZERO),
		Vector3.ZERO,
		"no input must produce no wish direction",
	)


func test_pitch_is_clamped() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	_check(character.clamp_look_pitch(10.0) < PI / 2.0, "pitch must stay below +90 degrees")
	_check(character.clamp_look_pitch(-10.0) > -PI / 2.0, "pitch must stay above -90 degrees")


func test_jump_requires_rising_edge() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	_check(character.jump_edge(true, true, false), "a fresh press on the floor must jump")
	_check(not character.jump_edge(true, true, true), "holding jump must not re-jump")
	_check(not character.jump_edge(false, true, false), "airborne jump must be ignored")


func test_visual_look_prefers_local_after_first_mouse_move() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	character.replicated_yaw = 0.25
	character.replicated_pitch = 0.1
	character._local_look_started = false
	_check(
		is_equal_approx(character.visual_yaw(), 0.25),
		"before local look the replicated yaw must drive the view",
	)
	character._local_yaw = 1.0
	character._local_pitch = 0.5
	character._local_look_started = true
	_check(is_equal_approx(character.visual_yaw(), 1.0), "local yaw must win after look starts")
	_check(is_equal_approx(character.visual_pitch(), 0.5), "local pitch must win after look starts")


func test_replication_uses_look_angles() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	var properties: PackedStringArray = character._wired_replicated_properties()
	_check(properties.has("Body:position"), "position must replicate")
	_check(properties.has("Body:velocity"), "velocity must replicate")
	_check(properties.has("replicated_yaw"), "yaw must replicate")
	_check(properties.has("replicated_pitch"), "pitch must replicate")
	_check(
		not properties.has("Body:rotation") and not properties.has("Body/Camera:rotation"),
		"body/camera rotation must not replicate over the owner's local look",
	)


func test_old_two_axis_state_loads() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	character._wired_load_state({
		"position": [1.5, 2.5],
		"linear_velocity": [3.0, 4.0],
	})
	var body: CharacterBody3D = character.get("body")
	_check(is_equal_approx(body.position.x, 1.5), "old state must restore X")
	_check(is_equal_approx(body.position.y, 2.5), "old state must restore Y")
	_check(is_zero_approx(body.position.z), "old state must default Z to zero")
	var state: Dictionary = character._wired_save_state()
	_check(state["position"] is Array and state["position"].size() == 3, "position must save 3 axes")
	_check(
		state["linear_velocity"] is Array and state["linear_velocity"].size() == 3,
		"velocity must save 3 axes",
	)


func test_mouse_look_requires_capture() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	var motion := InputEventMouseMotion.new()
	motion.relative = Vector2(40.0, 0.0)
	character._look_captured = false
	var before: float = character._local_yaw
	character.apply_mouse_look(motion.relative)
	_check(
		is_equal_approx(character._local_yaw, before),
		"mouse motion must do nothing while the pointer is not captured",
	)
	character._look_captured = true
	character.apply_mouse_look(motion.relative)
	_check(
		not is_equal_approx(character._local_yaw, before),
		"mouse motion must rotate the view while the pointer is captured",
	)


func test_scene_is_fps_ready() -> void:
	var character: Variant = _load_character()
	if character == null:
		return
	_check(is_equal_approx(character.speed, 6.0), "speed must be 6 m/s")
	var body: CharacterBody3D = character.get("body")
	var camera: Camera3D = character.get("camera")
	_check(body != null, "the scene must expose the CharacterBody3D body")
	_check(camera != null, "the scene must expose the Camera3D camera")
	if body != null:
		var collider := body.get_node_or_null("CollisionShape3D") as CollisionShape3D
		_check(collider != null, "the body must have a CollisionShape3D")
		if collider != null:
			var capsule := collider.shape as CapsuleShape3D
			_check(capsule != null, "the collider must be a CapsuleShape3D")
			if capsule != null:
				_check(is_equal_approx(capsule.radius, 0.4), "capsule radius must be 0.4 m")
				_check(is_equal_approx(capsule.height, 1.8), "capsule height must be 1.8 m")
	if camera != null:
		_check(is_equal_approx(camera.position.y, 1.6), "the camera must sit at eye height 1.6 m")


func _load_character() -> Node:
	var path := _example_path(CHARACTER_PATH)
	var packed := load(path) as PackedScene
	if packed == null:
		_check(false, "the player scene must load from %s" % path)
		return null
	var instance := packed.instantiate()
	_check(instance != null, "the player scene must instantiate")
	return instance


func _example_path(relative_path: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return (
		project_dir
		.path_join(EXAMPLE_DIR)
		.path_join(relative_path)
		.simplify_path()
	)


func _check_vector(actual: Vector3, expected: Vector3, message: String) -> void:
	_check(actual.distance_to(expected) <= EPSILON, "%s: got %s" % [message, actual])


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("FPS_CONTROLLER_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("FPS_CONTROLLER_SMOKE_FAILED %s" % message)
	quit(1)
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
packages/server/godot_runtime/4.8-beta2-win32-x64/Godot_v4.8-beta2_win64_console.exe \
  --headless --path packages/server/godot_project/_wired \
  --script res://tests/fps_controller_smoke.gd --quit-after 2
```

Expected: a parse error for missing `wish_direction` / script fields, or `FPS_CONTROLLER_SMOKE_FAILED` lines. It must not print `ALL TESTS PASSED`.

- [ ] **Step 3: Replace `character.gd` with the FPS controller**

Keep the `WiredPlayerComponent` extension and the `PLAYER_BODY_META` contract. Update the top doc comment to FPS (not 2D platformer). Exact members:

```gdscript
const PLAYER_BODY_META := "_wired_player_body"
const MAX_PITCH := PI / 2.0 - 0.001
const LOOK_SEND_INTERVAL_MSEC := 66

@export var speed := 6.0
@export var jump_velocity := 6.5
@export var gravity := 20.0
@export var friction := 60.0
@export var mouse_sensitivity := 0.0022
@export var dash_speed := 12.0
@export var dash_duration := 0.15
@export var dash_cooldown := 0.6

@export var body: CharacterBody3D = null
@export var camera: Camera3D = null

const LOOK := "look"
const DASH_ACTION := "dash"

## Server-authored look, replicated to every peer.
var replicated_yaw := 0.0
var replicated_pitch := 0.0

var _yaw := 0.0
var _pitch := 0.0
var _local_yaw := 0.0
var _local_pitch := 0.0
var _local_look_started := false
var _look_captured := false
var _look_dirty := false
var _last_look_sent_msec := -1
var _dash_time_left := 0.0
var _dash_cooldown_left := 0.0
var _dash_dir := Vector3.FORWARD
var _jump_was_down := false
```

Behavior:

- `_wired_ready`: guard `body == null` with the existing warning; set both `PLAYER_BODY_META` markers; register `dash` InputMap action on `KEY_SHIFT` and, when `is_server()`, `register_action(LOOK, _on_look)` and `register_action(DASH_ACTION, _on_dash)`. Apply `player.get_anchor_position_3d()` to `body.position` and back. When `is_local_player()` and `camera != null`, call `camera.make_current()`.
- `_wired_unhandled_input`: return unless `is_local_player()`. Left mouse press calls `_capture_mouse()` (also recaptures when `Input.mouse_mode != MOUSE_MODE_CAPTURED` to recover from a browser-dropped lock); `Escape` (key press) calls `_release_mouse()`. `InputEventMouseMotion` calls `apply_mouse_look(event.relative)` only when `_look_input_allowed()` returns true; Shift key press sends the package `dash` action via `request_action()`.
- `_capture_mouse` sets `_look_captured = true` and `Input.mouse_mode = Input.MOUSE_MODE_CAPTURED`; `_release_mouse` sets it false and `MOUSE_MODE_VISIBLE`.
- `look_is_active(captured, mouse_mode, is_web)` returns `captured and (not is_web or mouse_mode == MOUSE_MODE_CAPTURED)`; `_look_input_allowed()` calls it with `_look_captured`, `Input.mouse_mode`, `OS.has_feature("web")` and clears `_look_captured` when it returns false.
- `apply_mouse_look(relative)`: return unless `_look_input_allowed() and body != null`. On the first call set `_local_yaw = body.rotation.y`, `_local_pitch = camera.rotation.x` (or `0.0`), and `_local_look_started = true`. Then `_local_yaw = wrapf(_local_yaw - relative.x * mouse_sensitivity, -PI, PI)`, `_local_pitch = clamp_look_pitch(_local_pitch - relative.y * mouse_sensitivity)`, write both to the body/camera, and set `_look_dirty = true`.
- `visual_yaw()` / `visual_pitch()` return the local values when `_local_look_started`, otherwise the replicated values.
- `clamp_look_pitch(pitch)` returns `clampf(pitch, -MAX_PITCH, MAX_PITCH)`.
- `wish_direction(yaw, move)` clamps `move` with `limit_length(1.0)`, returns `Vector3.ZERO` below `0.0001` squared length, otherwise `(right * move.x + forward * -move.y).normalized()` with `right = Vector3(cos(yaw), 0, -sin(yaw))` and `forward = Vector3(-sin(yaw), 0, -cos(yaw))`.
- `dash_direction(yaw, move)` returns `wish_direction(yaw, move)` when non-zero, otherwise the forward vector `Vector3(-sin(yaw), 0, -cos(yaw))`.
- `jump_edge(on_floor, jump_down, was_down)` returns `on_floor and jump_down and not was_down`.
- `_on_look(sender_peer, payload)`: accept only server + owning peer; read `yaw`/`pitch` with the current values as defaults; reject non-finite; `_yaw = wrapf(yaw, -PI, PI)`, `_pitch = clamp_look_pitch(pitch)`, then assign `replicated_yaw` / `replicated_pitch`.
- `_on_dash(sender_peer, payload)`: accept only server + owning peer; ignore while `_dash_cooldown_left > 0`; `_dash_dir = dash_direction(_yaw, _current_move())`, `_dash_time_left = dash_duration`, `_dash_cooldown_left = dash_cooldown`.
- `_wired_physics_process(delta)`: return when `body == null or player == null`. Read `_current_move()` from `player.input.get("move", Vector2.ZERO)`. Tick `_dash_time_left` / `_dash_cooldown_left` down with `maxf(..., 0.0)`. While dashing set horizontal velocity to `_dash_dir * dash_speed`; with a wish direction set it to `wish * speed`; otherwise `move_toward` X/Z toward zero with `friction * delta`. Read `jump_down = bool(player.input.get("jump", false))`; if `jump_edge(body.is_on_floor(), jump_down, _jump_was_down)` set `velocity.y = jump_velocity`, else if `not body.is_on_floor()` subtract `gravity * delta`. Store `_jump_was_down`. Set `body.rotation.y = _yaw`, `replicated_yaw = _yaw`, `replicated_pitch = _pitch`, `body.move_and_slide()`, then `player.set_anchor_position_3d(body.position)`.
- `_wired_visual_process`: return when `body == null`; write `body.rotation.y = visual_yaw()` and `camera.rotation.x = visual_pitch()` (guard camera); set the avatar mesh `visible = not is_local_player()`; publish the anchor; when `is_local_player()` clear a stale capture flag via `_look_input_allowed()` and call `_send_look_if_due()`.
- `_send_look_if_due`: return unless `_look_dirty and _local_look_started`; use `Time.get_ticks_msec()` and skip while `now - _last_look_sent_msec < LOOK_SEND_INTERVAL_MSEC`; then clear `_look_dirty`, store the time, and `request_action(LOOK, {"yaw": _local_yaw, "pitch": _local_pitch})`.
- `_current_move()` converts `player.input`'s `move` (`Vector2` or 2-element Array) to `Vector2`, `limit_length(1.0)`, or `Vector2.ZERO`.
- `_wired_replicated_properties()` returns exactly `PackedStringArray(["Body:position", "Body:velocity", "replicated_yaw", "replicated_pitch"])`.
- `_wired_save_state()` returns `{"position": [x, y, z], "linear_velocity": [vx, vy, vz], "yaw": _yaw, "pitch": _pitch}`.
- `_wired_load_state(state)` restores position/velocity through `_as_vector3`, restores `_yaw`/`_pitch` (assign both replicated fields and body/camera), and updates the anchor.
- `_as_vector3(value, fallback)` accepts `Vector3`, 3-element arrays, and 2-element arrays (Z defaults to `0.0`).
- Remove the old 2D leftovers: `push_strength`, `camera_movement_speed`, `_dash_impulse`, `_move_input`, `_jump_input`, `_on_move`, `_move_x`, and the package `move_*`/`jump` actions.

- [ ] **Step 4: Fix the player scene**

In `player_character.tscn`:

- Change the script `ext_resource` to the relocatable relative path:

```ini
[ext_resource type="Script" path="character.gd" id="1_58pw5"]
```

- Remove `speed = 1.0` so the script default `6.0` applies.
- Give the capsule explicit values:

```ini
[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_nsyls"]
radius = 0.4
height = 1.8
```
and offset the `CollisionShape3D` transform to `y = 0.9` so the body origin sits at the feet.

- Add a capsule `MeshInstance3D` avatar named `Mesh` aligned with the collider so remote peers can see the player; it is hidden for the owning player in `_wired_visual_process`.

- Move the camera to eye height (`y = 1.6` above the feet):

```ini
[node name="Camera" type="Camera3D" parent="Body" unique_id=2021528673]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.6, 0)
```

- Put the spawn marker on the floor (`y = 0.5`) so the body does not drop on spawn.

- [ ] **Step 5: Run the smoke test and confirm it passes**

Run the same command as Step 2.

Expected: `FPS_CONTROLLER_SMOKE_OK checks=...` followed by `ALL TESTS PASSED`, exit code `0`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/godot_project/_wired/tests/fps_controller_smoke.gd \
  packages/server/godot_project/examples/cura_player/player/character.gd \
  packages/server/godot_project/examples/cura_player/player/player_character.tscn
git commit -m "fix(examples): make cura_player a working FPS controller"
```

---

### Task 2: Regression and In-Game Verification

**Files:**
- Verify only; no code changes expected.

**Interfaces:**
- Consumes: the new smoke test, `_wired/tests/example_package_contract_smoke.gd`, the Game tab.

- [ ] **Step 1: Re-run the FPS smoke test**

Run the Task 1 Step 2 command.

Expected: `ALL TESTS PASSED`.

- [ ] **Step 2: Run the existing example contract test**

Run:

```bash
packages/server/godot_runtime/4.8-beta2-win32-x64/Godot_v4.8-beta2_win64_console.exe \
  --headless --path packages/server/godot_project/_wired \
  --script res://tests/example_package_contract_smoke.gd --quit-after 2
```

Expected: `EXAMPLE_PACKAGE_CONTRACT_SMOKE_OK ...` and `ALL TESTS PASSED`. It must still reference `wired-platformer`; the new example does not change that contract.

- [ ] **Step 3: Confirm no core files changed**

Run:

```bash
git status --short
git diff --stat HEAD~1
```

Expected: only `examples/cura_player/player/character.gd`, `examples/cura_player/player/player_character.tscn` and the new test appear from Task 1 (plus the spec/plan docs if they were not committed earlier). No `_wired/scripts`, `_wired/project.godot` or `wired-platformer` changes.

- [ ] **Step 4: Manual Game-tab check (hand to the user)**

This cannot be automated headlessly. The user must publish the `cura_player` package to a room, open the **Game** tab, click the viewport to lock the pointer, and confirm:

- mouse look is immediate and the view does not snap back while moving;
- W/A/S/D move relative to the view, Space jumps once per press, Shift dashes;
- a second client sees the first player's position and facing direction update;
- after a room restart the player returns to the saved 3D position and look direction.

Expected: all four hold. If look snaps, the owner's `visual_yaw()`/replication properties are wrong; if movement is wrong, `wish_direction()` or server yaw is wrong.
