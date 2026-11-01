extends WiredDynamicEntity

## Test fixture: a crate that records spawn applications and impulses.
##
## `apply_count` must stay at 1 for every entity (spawn is applied exactly
## once), while `impulse_count` must stay at 0 on the restore path: replaying a
## transient cursor impulse from `state.json` would change the body velocity.
## Package scripts never declare `class_name`.

var apply_count := 0
var impulse_count := 0
var last_impulse := Vector2.ZERO

@onready var body: RigidBody2D = $RigidBody2D


func _wired_apply_spawn(data: Dictionary) -> void:
	apply_count += 1
	if body == null:
		return
	# Restore and fresh spawn both start from the saved state. Only a fresh
	# server spawn applies the one-shot impulse.
	_wired_load_state(data.get("state", {}))
	if bool(data.get("restore", false)):
		return
	if not _is_server():
		return
	var spawn_data: Dictionary = data.get("spawn_data", {})
	var impulse := float(
		spawn_data.get("impulse", spawn_data.get("impulse_force", 0.0))
	)
	if impulse == 0.0:
		return
	var direction := _as_vector2(spawn_data.get("direction", Vector2.RIGHT))
	impulse_count += 1
	last_impulse = direction * impulse
	body.apply_central_impulse(last_impulse)


func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray(
		["RigidBody2D:position", "RigidBody2D:rotation", "RigidBody2D:linear_velocity"]
	)


func _wired_save_state() -> Dictionary:
	if body == null:
		return {}
	return {
		"position": [body.position.x, body.position.y],
		"rotation": body.rotation,
		"linear_velocity": [body.linear_velocity.x, body.linear_velocity.y],
	}


func _wired_load_state(state: Dictionary) -> void:
	if body == null:
		return
	if state.has("position"):
		body.position = _as_vector2(state["position"], body.position)
	if state.has("rotation"):
		body.rotation = float(state["rotation"])
	if state.has("linear_velocity"):
		body.linear_velocity = _as_vector2(
			state["linear_velocity"], body.linear_velocity
		)
