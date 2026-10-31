extends SceneTree

## Headless smoke test for the main scene layout.
##
## The game runs inside a `SubViewportContainer`/`SubViewport` pair so package
## static scenes, dynamic entities and players live in their own 2D/3D world.
## The UI stays a `CanvasLayer` above it and must never swallow input: the aim
## cursor is the only thing that sees the mouse.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/scene_layout_smoke.gd --quit-after 2

const MAIN_SCENE := "res://_wired/scenes/main.tscn"
const STATIC_WORLD_SCRIPT := "static_world_container.gd"

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	_test_main_scene_has_game_viewport()
	_finish()


func _test_main_scene_has_game_viewport() -> void:
	var scene := load(MAIN_SCENE) as PackedScene
	_check(scene != null, "the main scene must load as a PackedScene")
	if scene == null:
		return
	var main := scene.instantiate()
	_check(main != null, "the main scene must instantiate")
	if main == null:
		return

	var game := main.get_node_or_null("Game")
	_check(game is SubViewportContainer, "Main/Game must be a SubViewportContainer")
	if game is SubViewportContainer:
		_check(game.stretch, "Main/Game must stretch its SubViewport to the container")
		_check(
			game.anchor_left == 0.0
			and game.anchor_top == 0.0
			and game.anchor_right == 1.0
			and game.anchor_bottom == 1.0,
			"Main/Game must anchor to the full rect",
		)

	var viewport := main.get_node_or_null("Game/SubViewport")
	_check(viewport is SubViewport, "Main/Game/SubViewport must be a SubViewport")
	if viewport is SubViewport:
		_check(
			viewport.size == Vector2i(960, 540),
			"the SubViewport must be authored as 960x540, got %s" % viewport.size,
		)
		_check(
			viewport.render_target_update_mode == SubViewport.UPDATE_ALWAYS,
			"the SubViewport must render every frame",
		)
		_check(
			viewport.handle_input_locally,
			"the SubViewport must handle input locally for the aim cursor",
		)
		_check(
			viewport.own_world_3d,
			"the SubViewport must own its 3D world so package scenes stay isolated",
		)

	var static_world := main.get_node_or_null("Game/SubViewport/StaticWorld")
	_check(static_world != null, "Main/Game/SubViewport/StaticWorld must exist")
	if static_world != null:
		var script := static_world.get_script() as Script
		_check(script != null, "StaticWorld must have a script attached")
		if script != null:
			_check(
				script.resource_path.ends_with(STATIC_WORLD_SCRIPT),
				"StaticWorld must use %s, got %s" % [STATIC_WORLD_SCRIPT, script.resource_path],
			)

	var dynamic_world := main.get_node_or_null("Game/SubViewport/DynamicWorld")
	_check(dynamic_world != null, "Main/Game/SubViewport/DynamicWorld must exist")
	if dynamic_world != null:
		_check(
			dynamic_world.get_node_or_null("Spawner") is MultiplayerSpawner,
			"DynamicWorld/Spawner must be a MultiplayerSpawner",
		)

	var players := main.get_node_or_null("Game/SubViewport/Players")
	_check(players != null, "Main/Game/SubViewport/Players must exist")
	if players != null:
		_check(
			players.get_node_or_null("Spawner") is MultiplayerSpawner,
			"Players/Spawner must be a MultiplayerSpawner",
		)

	var ui := main.get_node_or_null("UI")
	_check(ui is CanvasLayer, "Main/UI must stay a CanvasLayer")
	if ui is CanvasLayer:
		var controls := ui.find_children("*", "Control", true, false)
		var authored := 0
		for child: Node in controls:
			var control := child as Control
			# Internal children (RichTextLabel's scrollbar) are created at
			# runtime, so they cannot carry the authored flag; main_scene.gd
			# enforces the rule for them and the second pass below checks it.
			if control.owner == null:
				continue
			authored += 1
			_check(
				control.mouse_filter == Control.MOUSE_FILTER_IGNORE,
				"UI control %s must ignore the mouse so clicks reach the game viewport"
				% ui.get_path_to(control),
			)
		_check(
			authored > 0,
			"Main/UI must contain at least one authored Control to verify input pass-through",
		)
		_check(
			main.has_method("_setup_ui_input_passthrough"),
			"Main must enforce mouse pass-through on runtime-generated UI controls",
		)
		if main.has_method("_setup_ui_input_passthrough"):
			main.call("_setup_ui_input_passthrough")
			for child: Node in controls:
				var control := child as Control
				_check(
					control.mouse_filter == Control.MOUSE_FILTER_IGNORE,
					"UI control %s must still ignore the mouse after the runtime pass"
					% ui.get_path_to(control),
				)
		_check(
			game != null and ui.get_index() > game.get_index(),
			"Main/UI must be drawn above Main/Game",
		)

	main.free()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("SCENE_LAYOUT_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("SCENE_LAYOUT_SMOKE_FAILED %s" % message)
	quit(1)
