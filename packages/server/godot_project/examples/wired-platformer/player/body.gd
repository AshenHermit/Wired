extends WiredPlayerComponent

## Example 2D platformer body (package `wired-platformer`).
##
## Server authority: the server reads the replicated input snapshot, simulates
## `Body` with `move_and_slide` and publishes `Body:position`/`Body:velocity`.
## Every peer keeps the component for visuals and writes the replicated body
## position into the player anchor, which the camera follows.
##
## The root and the actual `CharacterBody2D` both carry `_wired_player_body`:
## `move_and_slide` reports the collider child, while package lookups usually
## start from the component root.

const PLAYER_BODY_META := "_wired_player_body"

@export var speed := 240.0
@export var jump_velocity := -420.0
@export var gravity := 980.0
@export var push_strength := 1.0
## Horizontal decay applied when the player gives no meaningful input, so a
## push from another player survives the next frame and then settles.
@export var friction := 1200.0

var body: CharacterBody2D = null
## Package-defined input actions (registered via `register_input_action`),
## independent of the core `wired_move_*` map.
const MOVE_LEFT := "move_left"
const MOVE_RIGHT := "move_right"
const MOVE_UP := "move_up"
const MOVE_DOWN := "move_down"
const JUMP := "jump"
const DASH_ACTION := "dash"
var _dash_impulse := 600.0
## Last move vector received from the owning client (server authority).
var _move_input := Vector2.ZERO
var _jump_input := false


func _wired_ready() -> void:
	body = get_node_or_null("Body") as CharacterBody2D
	if body == null:
		push_warning(
			"WIRED_EXAMPLE_BODY_MISSING_NODE package=%s node=Body" % package_id
		)
		return
	# Register package-local movement + jump + dash actions. `register_input_action`
	# qualifies every name with the package id, so they never collide with other
	# packages or the core `wired_*` actions.
	var left_ev := InputEventKey.new()
	left_ev.physical_keycode = KEY_A
	var right_ev := InputEventKey.new()
	right_ev.physical_keycode = KEY_D
	var up_ev := InputEventKey.new()
	up_ev.physical_keycode = KEY_W
	var down_ev := InputEventKey.new()
	down_ev.physical_keycode = KEY_S
	var jump_ev := InputEventKey.new()
	jump_ev.physical_keycode = KEY_SPACE
	var dash_ev := InputEventKey.new()
	dash_ev.physical_keycode = KEY_SHIFT
	register_input_action(MOVE_LEFT, [left_ev])
	register_input_action(MOVE_RIGHT, [right_ev])
	register_input_action(MOVE_UP, [up_ev])
	register_input_action(MOVE_DOWN, [down_ev])
	register_input_action(JUMP, [jump_ev])
	register_input_action(DASH_ACTION, [dash_ev])
	if is_server():
		register_action("move", _on_move)
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
		body.position = player.get_anchor_position_2d()
		player.set_anchor_position_2d(body.position)


## Client only: sample the package-defined movement keys and forward them to the
## server. The base component already gates this hook by `player.is_local_player()`.
func _wired_unhandled_input(event: InputEvent) -> void:
	if not is_local_player():
		return
	# Only keyboard events change movement/dash state; reacting to every input
	# event (mouse motion) would flood the action rate limit and drop updates.
	if not (event is InputEventKey):
		return
	if event.echo:
		return
	var move := Vector2(
		(float(is_action_pressed(MOVE_RIGHT)) - float(is_action_pressed(MOVE_LEFT))),
		(float(is_action_pressed(MOVE_DOWN)) - float(is_action_pressed(MOVE_UP)))
	).limit_length(1.0)
	var jump := is_action_pressed(JUMP)
	request_action("move", {"move": [move.x, move.y], "jump": jump})
	if is_action_just_pressed(DASH_ACTION):
		request_action(DASH_ACTION, {})


## Server side: store the latest movement snapshot from the owning client.
func _on_move(sender_peer: int, payload: Dictionary) -> void:
	if not is_server() or player == null:
		return
	if sender_peer != player.peer_id:
		return
	var m = payload.get("move", [0.0, 0.0])
	if m is Array and m.size() >= 2:
		_move_input = Vector2(float(m[0]), float(m[1]))
	_jump_input = bool(payload.get("jump", false))


## Server side: apply a horizontal dash impulse to the authoritative body.
func _on_dash(sender_peer: int, _payload: Dictionary) -> void:
	if not is_server() or body == null or player == null:
		return
	if sender_peer != player.peer_id:
		return
	var dir := 1.0
	if body.velocity.x < 0:
		dir = -1.0
	elif body.velocity.x == 0:
		dir = 1.0
	body.velocity.x = dir * _dash_impulse


## Server only (the component base gates this hook). Moves the body, publishes
## the anchor and pushes other player bodies it ran into.
func _wired_physics_process(delta: float) -> void:
	if body == null or player == null:
		return
	var input_x := _move_x(_move_input)
	if absf(input_x) > 0.01:
		# Meaningful input owns the horizontal axis.
		body.velocity.x = input_x * speed
	else:
		# Idle: never erase an external push in the same frame. Decay it with
		# friction instead, so another player's push survives long enough to
		# move this body.
		body.velocity.x = move_toward(body.velocity.x, 0.0, friction * delta)
	if body.is_on_floor():
		if _jump_input:
			body.velocity.y = jump_velocity
	else:
		body.velocity.y += gravity * delta
	# `move_and_slide` removes the velocity component that hit the other body,
	# so keep the intended velocity for the push loop.
	var motion_velocity := body.velocity
	body.move_and_slide()
	player.set_anchor_position_2d(body.position)
	PlayerPush.push_collisions(body, motion_velocity, push_strength)


## Every peer: derive the local anchor from the replicated body position. The
## camera component reads the same anchor, so clients follow the server.
func _wired_visual_process(_delta: float) -> void:
	if body == null or player == null:
		return
	player.set_anchor_position_2d(body.position)


func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray(["Body:position", "Body:velocity"])


## Persists both the body transform and its velocity: a restart must resume the
## body in the same place and with the same motion, not at the spawn marker.
func _wired_save_state() -> Dictionary:
	if body == null:
		return {}
	return {
		"position": [body.position.x, body.position.y],
		"linear_velocity": [body.velocity.x, body.velocity.y],
	}


func _wired_load_state(state: Dictionary) -> void:
	if body == null:
		return
	if state.has("position"):
		body.position = _as_vector2(state["position"], body.position)
	if state.has("linear_velocity"):
		body.velocity = _as_vector2(state["linear_velocity"], body.velocity)
	if player != null:
		player.set_anchor_position_2d(body.position)


func _as_vector2(value: Variant, fallback: Vector2) -> Vector2:
	if value is Vector2:
		var vector: Vector2 = value
		return vector
	if value is Array and value.size() >= 2:
		return Vector2(float(value[0]), float(value[1]))
	return fallback


func _move_x(move: Variant) -> float:
	var value := 0.0
	if move is Vector2:
		value = (move as Vector2).x
	elif move is Vector3:
		value = (move as Vector3).x
	return clampf(value, -1.0, 1.0)
