extends WiredPlayerComponent

## Test fixture: records which contract hooks ran and exposes one action and one
## replicated property. Package scripts never declare `class_name`.

var ready_count := 0
var process_count := 0
var physics_count := 0
var visual_count := 0
var last_input_event: InputEvent = null
var last_ping: Dictionary = {}

@onready var body: Node2D = $Body


func _wired_ready() -> void:
	ready_count += 1
	if is_server():
		register_action("ping", _on_ping)


func _wired_process(_delta: float) -> void:
	process_count += 1


func _wired_physics_process(_delta: float) -> void:
	physics_count += 1


func _wired_visual_process(_delta: float) -> void:
	visual_count += 1


func _wired_unhandled_input(event: InputEvent) -> void:
	last_input_event = event


func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray(["Body:position"])


func _wired_save_state() -> Dictionary:
	if body == null:
		return {"body_position": [0.0, 0.0]}
	return {"body_position": [body.position.x, body.position.y]}


func _wired_load_state(state: Dictionary) -> void:
	if body == null:
		return
	var value: Variant = state.get("body_position", [])
	if value is Array and value.size() >= 2:
		body.position = Vector2(float(value[0]), float(value[1]))


func _on_ping(sender_peer: int, payload: Dictionary) -> void:
	last_ping = {"sender": sender_peer, "payload": payload}
