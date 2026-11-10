extends WiredPlayerComponent

## Example first-person controller (package `cura_player`).
##
## Server authority: the server reads the core 30 Hz input snapshot, derives
## the wish direction from the look yaw, simulates `Body` with `move_and_slide`
## and replicates `Body:position`/`Body:velocity` plus the look angles.
##
## Mouse look is client-authoritative and immediate: the owning client rotates
## `Body` from mouse deltas and sends absolute yaw/pitch snapshots to the
## server at 15 Hz. The camera is anchored to the `m_head` bone every visual
## frame and the shared look pitch is applied through
## `character_model.set_spine_rotation`. Yaw and pitch are replicated via
## `replicated_yaw`/`replicated_pitch`, so the head tilt and the camera stay in
## sync across peers without extra network messages.
##
## The root and the actual `CharacterBody3D` both carry `_wired_player_body`:
## `move_and_slide` reports the collider child, while package lookups usually
## start from the component root.

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

@export var character_model: Node

## Horizontal speed above this counts as moving. Below it the replicated
## velocity is treated as standing still, so friction leftovers do not keep
## the run animation playing.
const MOVEMENT_IDLE_SPEED := 0.15

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

func _wired_ready() -> void:
	if body == null:
		push_warning(
			"WIRED_EXAMPLE_BODY_MISSING_NODE package=%s node=Body" % package_id
		)
		return
	var dash_ev := InputEventKey.new()
	dash_ev.physical_keycode = KEY_SHIFT
	register_input_action(DASH_ACTION, [dash_ev])
	if is_server():
		register_action(LOOK, _on_look)
		register_action(DASH_ACTION, _on_dash)
	# The scene carries both markers; set them again so a programmatically built
	# body follows the same contract as the shipped scene.
	set_meta(PLAYER_BODY_META, true)
	body.set_meta(PLAYER_BODY_META, true)
	if player != null:
		# The authoritative spawn marker lives on the player, not in the package
		# scene. Apply it on every peer so the server simulates from the marker
		# and clients start there before the first synchronization. A restored
		# player anchor (preloaded by `PlayersManager` before `_ready`) wins over
		# the marker, so an old save without body component state still starts at
		# the persisted position.
		body.position = player.get_anchor_position_3d()
		player.set_anchor_position_3d(body.position)
	if is_local_player() and camera != null:
		camera.make_current()
	if is_local_player():
		character_model.make_first_person_vision()


## Client only: capture the pointer on click, release it on Escape and turn
## mouse motion into an immediate local look update.
func _wired_unhandled_input(event: InputEvent) -> void:
	if not is_local_player():
		return
	if event.is_action_pressed(action_name(DASH_ACTION)):
		# Prevent repeat while Shift is held (ignore echo events)
		if event is InputEventKey and (event as InputEventKey).echo:
			return
		request_action(DASH_ACTION)
		return
	if event is InputEventMouseButton:
		var button := event as InputEventMouseButton
		# A browser can drop pointer lock without delivering the Escape key, so
		# also recover when the pointer mode says the capture is gone.
		if (
			button.button_index == MOUSE_BUTTON_LEFT
			and button.pressed
			and (
				not _look_captured
				or Input.mouse_mode != Input.MOUSE_MODE_CAPTURED
			)
		):
			_capture_mouse()
		return
	if event is InputEventKey:
		var key := event as InputEventKey
		if key.pressed and not key.echo and key.keycode == KEY_ESCAPE:
			_release_mouse()
		return
	if event is InputEventMouseMotion:
		apply_mouse_look((event as InputEventMouseMotion).relative)


func _capture_mouse() -> void:
	_look_captured = true
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _release_mouse() -> void:
	_look_captured = false
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


## Whether a captured pointer may turn the view. Browsers can silently drop
## pointer lock without delivering Escape, so on web the real pointer mode is
## authoritative; headless tests have no real mode and rely on the flag.
func look_is_active(captured: bool, mouse_mode: int, is_web: bool) -> bool:
	return captured and (not is_web or mouse_mode == Input.MOUSE_MODE_CAPTURED)


func _look_input_allowed() -> bool:
	if look_is_active(_look_captured, Input.mouse_mode, OS.has_feature("web")):
		return true
	_look_captured = false
	return false


## Applies a mouse delta locally. The first delta seeds the local angles from
## the current body/camera transform, so there is no jump when look starts.
func apply_mouse_look(relative: Vector2) -> void:
	if not _look_input_allowed() or body == null:
		return
	if not _local_look_started:
		_local_yaw = body.rotation.y
		_local_pitch = camera.rotation.x if camera != null else 0.0
		_local_look_started = true
	_local_yaw = wrapf(_local_yaw - relative.x * mouse_sensitivity, -PI, PI)
	_local_pitch = clamp_look_pitch(_local_pitch - relative.y * mouse_sensitivity)
	body.rotation.y = _local_yaw
	if camera != null:
		camera.rotation.x = _local_pitch
	_look_dirty = true


func visual_yaw() -> float:
	return _local_yaw if _local_look_started else replicated_yaw


func visual_pitch() -> float:
	return _local_pitch if _local_look_started else replicated_pitch


func clamp_look_pitch(pitch: float) -> float:
	return clampf(pitch, -MAX_PITCH, MAX_PITCH)


## Converts the core movement snapshot into a world-space horizontal direction.
## `move.y` is down-positive in the core snapshot, so W (`y = -1`) maps to the
## forward axis.
func wish_direction(yaw: float, move: Vector2) -> Vector3:
	var input := move.limit_length(1.0)
	if input.length_squared() < 0.0001:
		return Vector3.ZERO
	var right := Vector3(cos(yaw), 0.0, -sin(yaw))
	var forward := Vector3(-sin(yaw), 0.0, -cos(yaw))
	return (right * input.x + forward * -input.y).normalized()


func dash_direction(yaw: float, move: Vector2) -> Vector3:
	var wish := wish_direction(yaw, move)
	if wish.length_squared() > 0.0:
		return wish
	return Vector3(-sin(yaw), 0.0, -cos(yaw))


func jump_edge(on_floor: bool, jump_down: bool, was_down: bool) -> bool:
	return on_floor and jump_down and not was_down


## Server side: store the latest validated look snapshot from the owning client.
func _on_look(sender_peer: int, payload: Dictionary) -> void:
	if not is_server() or player == null or sender_peer != player.peer_id:
		return
	var yaw_value: Variant = payload.get("yaw", _yaw)
	var pitch_value: Variant = payload.get("pitch", _pitch)
	if not (yaw_value is float or yaw_value is int):
		return
	if not (pitch_value is float or pitch_value is int):
		return
	var yaw := float(yaw_value)
	var pitch := float(pitch_value)
	if not is_finite(yaw) or not is_finite(pitch):
		return
	_yaw = wrapf(yaw, -PI, PI)
	_pitch = clamp_look_pitch(pitch)
	replicated_yaw = _yaw
	replicated_pitch = _pitch
	if body != null:
		body.rotation.y = _yaw

## Server side: start a dash in the current wish direction.
func _on_dash(sender_peer: int, _payload: Dictionary) -> void:
	if not is_server() or player == null or sender_peer != player.peer_id:
		return
	if _dash_cooldown_left > 0.0:
		return
	_dash_dir = dash_direction(_yaw, _current_move())
	_dash_time_left = dash_duration
	_dash_cooldown_left = dash_cooldown


## Server only (the component base gates this hook). Simulates the body from
## the core input snapshot and publishes the anchor.
func _wired_physics_process(delta: float) -> void:
	if body == null or player == null:
		return
	_dash_time_left = maxf(_dash_time_left - delta, 0.0)
	_dash_cooldown_left = maxf(_dash_cooldown_left - delta, 0.0)
	var wish := wish_direction(_yaw, _current_move())
	var horizontal := Vector2(body.velocity.x, body.velocity.z)
	if _dash_time_left > 0.0:
		horizontal = Vector2(_dash_dir.x, _dash_dir.z) * dash_speed
	elif wish.length_squared() > 0.0:
		horizontal += Vector2(wish.x, wish.z) * speed
	
	horizontal /= 2.0
	
	body.velocity.x = horizontal.x
	body.velocity.z = horizontal.y
	
	var jump_down := bool(player.input.get("jump", false))
	if jump_edge(body.is_on_floor(), jump_down, _jump_was_down):
		body.velocity.y = jump_velocity
	elif not body.is_on_floor():
		body.velocity.y -= gravity * delta
	_jump_was_down = jump_down
	body.rotation.y = _yaw
	replicated_yaw = _yaw
	replicated_pitch = _pitch
	body.move_and_slide()
	player.set_anchor_position_3d(body.position)


## Every peer: apply the best available look angles and follow the body with the
## camera anchor. The owner keeps local look; remote peers use replicated look.
func _wired_visual_process(_delta: float) -> void:
	if body == null:
		return
	body.rotation.y = visual_yaw()
	# Rotate the spine/head by the shared look pitch. `visual_pitch()` is local
	# for the owner and replicated for remote peers, so every peer draws the
	# same head tilt without extra network messages.
	if character_model != null:
		character_model.set_spine_rotation(Vector3(-visual_pitch(), 0, 0))
	var avatar := body.get_node_or_null("Mesh") as MeshInstance3D
	if avatar != null:
		avatar.visible = not is_local_player()
	if player != null:
		player.set_anchor_position_3d(body.position)
	_update_movement_animation()
	if is_local_player() and camera != null and character_model != null:
		# Anchor the camera to the m_head bone every frame and layer the shared
		# pitch on top of the head's base orientation.
		var head_pose = character_model.get_head_global_pose()
		var pitch_basis := Basis.from_euler(Vector3(visual_pitch(), 0, 0))
		camera.global_position = head_pose.origin
		camera.transform.basis = pitch_basis
		if not look_is_active(_look_captured, Input.mouse_mode, OS.has_feature("web")):
			_look_captured = false
			# When the pointer is no longer captured we also discard any pending look delta
			_look_dirty = false
		_send_look_if_due()


## Owning client only. The server simulates the body and replicates its
## velocity, so the local player can derive walk/idle from that velocity
## without reading its own input. Only the horizontal part counts: a jump
## in place must stay idle.
func _update_movement_animation() -> void:
	if character_model == null or body == null:
		return
	var horizontal := Vector2(body.velocity.x, body.velocity.z)
	if horizontal.length_squared() > MOVEMENT_IDLE_SPEED * MOVEMENT_IDLE_SPEED:
		character_model.set_movement_running()
		var dir = body.to_local(body.global_position + body.velocity)
		character_model.set_movement_direction(Vector2(dir.x, -dir.z).normalized())
	else:
		character_model.set_movement_idle()


func _send_look_if_due() -> void:
	if not _look_dirty or not _local_look_started:
		return
	var now := Time.get_ticks_msec()
	if now - _last_look_sent_msec < LOOK_SEND_INTERVAL_MSEC:
		return
	_look_dirty = false
	_last_look_sent_msec = now
	request_action(LOOK, {"yaw": _local_yaw, "pitch": _local_pitch})


func _current_move() -> Vector2:
	if player == null:
		return Vector2.ZERO
	var raw: Variant = player.input.get("move", Vector2.ZERO)
	var move := Vector2.ZERO
	
	if raw is Vector2:
		var vector: Vector2 = raw
		move = vector
	elif raw is Array:
		var values: Array = raw
		if values.size() >= 2:
			move = Vector2(float(values[0]), float(values[1]))
	return move.limit_length(1.0)


func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray([
		"Body:position",
		"Body:velocity",
		":replicated_yaw",
		":replicated_pitch",
	])


## Properties smoothed on remote peers so movement and look don't snap between
## network ticks. `Body:velocity` is intentionally excluded: it drives the
## run/idle animation, not the visual transform.
func _wired_interpolated_properties() -> PackedStringArray:
	return PackedStringArray([
		"Body:position",
		":replicated_yaw",
		":replicated_pitch",
	])


## Look angles are interpolated along the shortest arc (`-PI`..`PI`) so the
## camera/head doesn't spin the long way when yaw wraps from `PI` to `-PI`.
## `Body:position` is a plain Vector3 and interpolates component-wise.
func _wired_angle_properties() -> PackedStringArray:
	return PackedStringArray([
		":replicated_yaw",
		":replicated_pitch",
	])


## Persists the full 3D body transform, velocity and look direction: a restart
## must resume in the same place and looking the same way.
func _wired_save_state() -> Dictionary:
	if body == null:
		return {}
	return {
		"position": [body.position.x, body.position.y, body.position.z],
		"linear_velocity": [body.velocity.x, body.velocity.y, body.velocity.z],
		"yaw": _yaw,
		"pitch": _pitch,
	}


func _wired_load_state(state: Dictionary) -> void:
	if body == null:
		return
	if state.has("position"):
		body.position = _as_vector3(state["position"], body.position)
	if state.has("linear_velocity"):
		body.velocity = _as_vector3(state["linear_velocity"], body.velocity)
	if state.has("yaw"):
		var yaw_value: Variant = state["yaw"]
		if yaw_value is float or yaw_value is int:
			_yaw = wrapf(float(yaw_value), -PI, PI)
	if state.has("pitch"):
		var pitch_value: Variant = state["pitch"]
		if pitch_value is float or pitch_value is int:
			_pitch = clamp_look_pitch(float(pitch_value))
	replicated_yaw = _yaw
	replicated_pitch = _pitch
	body.rotation.y = _yaw
	if camera != null:
		camera.rotation.x = _pitch
	if player != null:
		player.set_anchor_position_3d(body.position)


func _as_vector3(value: Variant, fallback: Vector3) -> Vector3:
	if value is Vector3:
		var vector: Vector3 = value
		return vector
	if value is Array:
		var values: Array = value
		if values.size() >= 3:
			return Vector3(float(values[0]), float(values[1]), float(values[2]))
		if values.size() == 2:
			return Vector3(float(values[0]), float(values[1]), 0.0)
	return fallback
