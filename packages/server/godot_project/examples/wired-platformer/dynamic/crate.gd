extends WiredDynamicEntity

## Example 2D crate (package `wired-platformer`).
##
## The entity root replicates the `RigidBody2D` transform and velocity. The
## server applies the cursor impulse once on a fresh spawn; clients freeze the
## body and only render the replicated values. Restoring a saved crate goes
## through `_wired_load_state`, so the one-shot impulse is never replayed.
##
## `spawn_data` comes from the player spawner: `{direction, impulse_force}`.
## The server already normalized the direction and computed the spawn point from
## its authoritative anchor.

@export var impulse_force := 320.0

@onready var body: RigidBody2D = $RigidBody2D


func _wired_apply_spawn(data: Dictionary) -> void:
	if body == null:
		push_warning(
			"WIRED_EXAMPLE_CRATE_MISSING_NODE type=%s node=RigidBody2D" % type_id
		)
		return
	# Both paths start from the persisted state; restore never applies impulse.
	_wired_load_state(data.get("state", {}))
	if bool(data.get("restore", false)):
		return
	if not _is_server():
		return
	var spawn_data: Dictionary = data.get("spawn_data", {})
	var direction := _as_vector2(spawn_data.get("direction", Vector2.ZERO))
	if direction == Vector2.ZERO:
		return
	var force := float(spawn_data.get("impulse_force", impulse_force))
	body.apply_central_impulse(direction * force)


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
