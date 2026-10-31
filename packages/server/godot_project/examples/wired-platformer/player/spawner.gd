extends WiredPlayerComponent

## Example crate spawner (package `wired-platformer`).
##
## The local player aims with the mouse; the component converts the cursor to
## world space through the game viewport's canvas transform and sends only a
## unit direction. The server validates that direction, enforces a per-player
## cooldown and a live-crate limit, and computes the spawn point from its own
## authoritative anchor. A client can never choose the spawn position.
##
## No `class_name`: package scripts must not pollute the global class list.

@export var spawn_offset := 48.0
@export var impulse_force := 320.0
@export var cooldown_ms := 250
@export var max_per_player := 8

## Per-owner timestamp of the last accepted request.
var _last_spawn_msec: Dictionary = {}
## Entities this component spawned, used for the live per-player limit.
var _spawned: Array[Node] = []


func _wired_ready() -> void:
	if is_server():
		register_action("spawn_crate", _on_spawn_crate)


## Only the local player sends intents. The base component already gates this
## hook by `player.is_local_player()`; the check stays explicit because the
## example doubles as the contract for package authors.
func _wired_unhandled_input(event: InputEvent) -> void:
	if player == null or not player.is_local_player():
		return
	var button := event as InputEventMouseButton
	if button == null:
		return
	if button.button_index != MOUSE_BUTTON_LEFT or not button.pressed:
		return
	var viewport := get_viewport()
	if viewport == null:
		return
	# The game lives in a stretched SubViewport under the dark UI overlay, so
	# screen coordinates must go through the canvas transform to reach the world.
	var mouse_world: Vector2 = (
		viewport.get_canvas_transform().affine_inverse()
		* viewport.get_mouse_position()
	)
	var direction := WiredAim.direction(
		player.get_anchor_position_2d(), mouse_world
	)
	request_action("spawn_crate", {"direction": direction})


## Server side. `sender_peer` is the authenticated peer the transport routed the
## action from; it must own this player.
func _on_spawn_crate(sender_peer: int, payload: Dictionary) -> void:
	if player == null or not is_server():
		return
	if sender_peer != player.peer_id:
		_reject("sender")
		return
	if not _consume_cooldown(player.player_id):
		_reject("cooldown")
		return
	if _live_spawn_count() >= max_per_player:
		_reject("limit")
		return
	var direction := _validated_direction(payload.get("direction", Vector2.ZERO))
	if direction == Vector2.ZERO:
		_reject("direction")
		return
	var anchor := player.get_anchor_position_2d()
	var entity := spawn_dynamic(
		"crate",
		{
			"position": anchor + direction * spawn_offset,
			"direction": direction,
			"impulse_force": impulse_force,
			"owner_player_id": player.player_id,
		}
	)
	if entity == null:
		_reject("dynamic_world")
		return
	_spawned.append(entity)


## Server-side validation: finite and close to unit length. The result is
## normalized so a slightly short vector cannot weaken the impulse.
func _validated_direction(value: Variant) -> Vector2:
	var direction := Vector2.ZERO
	if value is Vector2:
		direction = value
	elif value is Array and value.size() >= 2:
		direction = Vector2(float(value[0]), float(value[1]))
	if not direction.is_finite():
		return Vector2.ZERO
	var length := direction.length()
	if length < 0.1 or length > 1.0:
		return Vector2.ZERO
	return direction.normalized()


func _consume_cooldown(owner_player_id: int) -> bool:
	var now := Time.get_ticks_msec()
	var last := int(_last_spawn_msec.get(owner_player_id, -1))
	if last >= 0 and now - last < cooldown_ms:
		return false
	_last_spawn_msec[owner_player_id] = now
	return true


## Crates despawned by the server are freed, so invalid nodes stop counting.
func _live_spawn_count() -> int:
	var live: Array[Node] = []
	for entity: Node in _spawned:
		if is_instance_valid(entity) and not entity.is_queued_for_deletion():
			live.append(entity)
	_spawned = live
	return _spawned.size()


func _reject(reason: String) -> void:
	push_warning(
		"WIRED_EXAMPLE_SPAWN_REJECTED player=%d reason=%s"
		% [player.player_id if player != null else 0, reason]
	)
