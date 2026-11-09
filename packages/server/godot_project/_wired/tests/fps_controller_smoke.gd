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
var _instances: Array[Node] = []
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
	if instance == null:
		_check(false, "the player scene must instantiate")
		return null
	if not instance.has_method("wish_direction"):
		_check(false, "the player scene must use the FPS controller script")
		instance.free()
		return null
	_instances.append(instance)
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
	for instance: Node in _instances:
		instance.free()
	_instances.clear()
	if _failures.is_empty():
		print("FPS_CONTROLLER_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("FPS_CONTROLLER_SMOKE_FAILED %s" % message)
	quit(1)
