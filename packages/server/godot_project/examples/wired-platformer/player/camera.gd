extends WiredPlayerComponent

## Example 2D platformer camera (package `wired-platformer`).
##
## The component never owns the transform: `Camera2D` follows the player anchor,
## which the body component derives from the replicated `Body:position`. Only
## the local player enables the camera; remote copies run the same visual hook
## with the camera disabled so late enable/disable never jumps the view.
##
## v1 does not smooth the camera: the anchor already follows the replicated
## server position, and smoothing would add a second lag on top.

var camera: Camera2D = null


## v1 follow rule. Kept static so the example contract is testable without a
## scene tree; future versions can add look-ahead here.
static func target_position(anchor: Vector2) -> Vector2:
	return anchor


func _wired_ready() -> void:
	camera = get_node_or_null("Camera2D") as Camera2D
	if camera == null:
		push_warning(
			"WIRED_EXAMPLE_CAMERA_MISSING_NODE package=%s node=Camera2D" % package_id
		)
		return
	camera.enabled = is_local_player()
	camera.position_smoothing_enabled = false
	_follow_anchor()


func _wired_process(_delta: float) -> void:
	_follow_anchor()


func _wired_visual_process(_delta: float) -> void:
	_follow_anchor()


func _follow_anchor() -> void:
	if camera == null or player == null:
		return
	camera.global_position = target_position(player.get_anchor_position_2d())
