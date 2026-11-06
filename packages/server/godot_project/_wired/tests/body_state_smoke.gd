extends SceneTree

## Restart-style test for the example player body persistence.
##
## `body.gd` must save and load both the body position and velocity, and the
## player anchor must act as a fallback when an old save has no body component
## state. The example lives outside `res://`, so its scene is loaded by absolute
## path like `spawner_smoke.gd` does.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/body_state_smoke.gd --quit-after 2

const EXAMPLE_ROOT := "../examples/wired-platformer"
const PACKAGE_ID := "pkg.example"
const COMPONENT_PATH := "player/body.tscn"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_body_saves_and_restores_position_and_velocity()
	_test_saved_anchor_is_the_fallback()
	_free_owned()
	_finish()


func _test_body_saves_and_restores_position_and_velocity() -> void:
	var player := _make_player_with_body(Vector2(10, 20))
	root.add_child(player)
	var component: Variant = _body_component(player)
	if component == null:
		return
	component.body.position = Vector2(30, 40)
	component.body.velocity = Vector2(5, -6)
	var saved := player.save_state()
	_check(
		saved.get("components", {}).has("%s:%s" % [PACKAGE_ID, COMPONENT_PATH]),
		"the body state must use the stable component key",
	)
	var state: Dictionary = saved["components"]["%s:%s" % [PACKAGE_ID, COMPONENT_PATH]]
	_check(
		state.get("position") == [30.0, 40.0],
		"the body must save its position, got %s" % [state.get("position")],
	)
	_check(
		state.get("linear_velocity") == [5.0, -6.0],
		"the body must save its velocity, got %s" % [state.get("linear_velocity")],
	)

	var restored := _make_player_with_body(Vector2(10, 20))
	restored.apply_saved_anchor(saved)
	var restored_component: Variant = _body_component(restored)
	root.add_child(restored)
	restored.load_state(saved)
	if restored_component == null:
		return
	_check(
		restored_component.body.position == Vector2(30, 40),
		"the restarted body must restore its position, got %s"
		% restored_component.body.position,
	)
	_check(
		restored_component.body.velocity == Vector2(5, -6),
		"the restarted body must restore its velocity, got %s"
		% restored_component.body.velocity,
	)


## A save file from before `body.gd` implemented `_wired_save_state` has only
## the player anchor. The body must start there instead of at the spawn marker.
func _test_saved_anchor_is_the_fallback() -> void:
	var saved := {
		"player_id": 7,
		"anchor_position_2d": [77.0, 88.0],
		"anchor_position_3d": [0.0, 0.0, 0.0],
		"components": {},
	}
	var player := _make_player_with_body(Vector2(1, 2))
	player.apply_saved_anchor(saved)
	root.add_child(player)
	player.load_state(saved)
	var component: Variant = _body_component(player)
	if component == null:
		return
	_check(
		component.body.position == Vector2(77, 88),
		"without component state the saved anchor must place the body, got %s"
		% component.body.position,
	)


# --- helpers --------------------------------------------------------------


func _make_player(anchor: Vector2) -> WiredPlayer:
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(7, 1, "bob", null)
	player.set_anchor_position_2d(anchor)
	return player


func _body_component(player: WiredPlayer) -> WiredPlayerComponent:
	if player.components.is_empty():
		return null
	var component := player.components[0]
	component.package_id = PACKAGE_ID
	component.relative_path = COMPONENT_PATH
	return component


## Adds the example body as the player's only component. Called after the player
## anchor is set, matching `PlayersManager.build_player`.
func _make_player_with_body(anchor: Vector2) -> WiredPlayer:
	var player := _make_player(anchor)
	var packed := load(_example_path(COMPONENT_PATH)) as PackedScene
	if packed == null:
		_check(false, "the example body scene must load")
		return player
	var component := packed.instantiate() as WiredPlayerComponent
	if component == null:
		_check(false, "the example body must extend WiredPlayerComponent")
		return player
	player.add_component(component, "server", false)
	return player


func _example_path(relative_path: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return (
		project_dir
		.path_join(EXAMPLE_ROOT)
		.path_join(relative_path)
		.simplify_path()
	)


func _free_owned() -> void:
	for node: Node in _owned:
		if is_instance_valid(node):
			node.free()
	_owned.clear()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("BODY_STATE_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("BODY_STATE_SMOKE_FAILED %s" % message)
	quit(1)
