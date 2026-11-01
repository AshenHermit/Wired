extends SceneTree

## Headless smoke test for the example player camera.
##
## `camera.gd` lives in the example package outside `res://`, so the suite
## loads it by absolute path derived from the project directory (the example
## package is copied into the project root at publish time). The static
## `target_position` helper is the v1 follow rule: the anchor is used as-is.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/camera_follow_smoke.gd --quit-after 2

const EXAMPLE_RELATIVE_DIR := "../examples/wired-platformer/player"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_target_position_returns_the_anchor()
	_test_local_camera_enabled_and_follows_the_anchor()
	_test_remote_camera_disabled_but_follows_the_replicated_anchor()
	_free_owned()
	_finish()


func _test_target_position_returns_the_anchor() -> void:
	var script := _load_example_script("camera.gd")
	_check(script != null, "the example camera.gd must load")
	if script == null:
		return
	var camera: Node = script.new()
	if camera == null:
		_check(false, "the example camera.gd must instantiate")
		return
	_owned.append(camera)
	var anchor := Vector2(32, 48)
	var target: Variant = camera.call("target_position", anchor)
	_check(
		target == anchor,
		"`target_position` must return the anchor unchanged in v1, got %s"
		% [target],
	)


func _test_local_camera_enabled_and_follows_the_anchor() -> void:
	var component := _instantiate_camera()
	if component == null:
		return
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(1, 1, "local", null)
	player.set_anchor_position_2d(Vector2(32, 48))
	player.add_component(component, "local", false)
	root.add_child(player)
	var camera := component.get_node_or_null("Camera2D") as Camera2D
	_check(camera != null, "the example camera scene must contain a Camera2D")
	if camera == null:
		return
	_check(
		camera.enabled,
		"the local player's camera must be enabled after `_wired_ready`",
	)
	_check(
		not camera.position_smoothing_enabled,
		"the v1 camera must not smooth its position",
	)
	_check(
		camera.global_position == Vector2(32, 48),
		"the camera must start on the anchor, got %s" % camera.global_position,
	)
	player.set_anchor_position_2d(Vector2(64, -16))
	component._process(0.016)
	_check(
		camera.global_position == Vector2(64, -16),
		"the camera must follow the anchor on process, got %s"
		% camera.global_position,
	)
	player.set_anchor_position_2d(Vector2(96, 128))
	component._wired_visual_process(0.016)
	_check(
		camera.global_position == Vector2(96, 128),
		"the camera must follow the anchor on visual process, got %s"
		% camera.global_position,
	)


## A remote player's copy still runs the visual hook on every peer; only the
## enabled flag is owner-only.
func _test_remote_camera_disabled_but_follows_the_replicated_anchor() -> void:
	var component := _instantiate_camera()
	if component == null:
		return
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(2, 5, "remote", null)
	player.set_anchor_position_2d(Vector2(16, 24))
	player.add_component(component, "local", false)
	root.add_child(player)
	var camera := component.get_node_or_null("Camera2D") as Camera2D
	_check(camera != null, "the remote camera scene must contain a Camera2D")
	if camera == null:
		return
	_check(
		not camera.enabled,
		"a remote player's camera must stay disabled",
	)
	player.set_anchor_position_2d(Vector2(-32, -48))
	component._process(0.016)
	_check(
		camera.global_position == Vector2(-32, -48),
		"a remote camera must still follow the replicated anchor, got %s"
		% camera.global_position,
	)


# --- helpers --------------------------------------------------------------


func _instantiate_camera() -> Node:
	var packed := _load_example_scene("camera.tscn")
	if packed == null:
		return null
	var camera: Node = packed.instantiate()
	_check(camera != null, "the example camera.tscn must instantiate")
	return camera


func _load_example_scene(file_name: String) -> PackedScene:
	var path := _example_path(file_name)
	if not FileAccess.file_exists(path):
		printerr("CAMERA_FOLLOW_SMOKE_MISSING_EXAMPLE %s" % path)
		return null
	return load(path) as PackedScene


func _load_example_script(file_name: String) -> Script:
	var path := _example_path(file_name)
	if not FileAccess.file_exists(path):
		printerr("CAMERA_FOLLOW_SMOKE_MISSING_EXAMPLE %s" % path)
		return null
	return load(path) as Script


## Examples are not part of `res://`; resolve them next to the base project.
func _example_path(file_name: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return project_dir.path_join(EXAMPLE_RELATIVE_DIR).path_join(file_name).simplify_path()


func _free_owned() -> void:
	for node: Node in _owned:
		if is_instance_valid(node) and not node.is_queued_for_deletion():
			node.free()
	_owned.clear()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("CAMERA_FOLLOW_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("CAMERA_FOLLOW_SMOKE_FAILED %s" % message)
	quit(1)
