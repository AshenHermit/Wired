extends SceneTree

const MAIN_SCENE := "res://_wired/scenes/main.tscn"
const WiredGameSceneScript := preload("res://_wired/scripts/world/wired_game_scene.gd")

var _failures: PackedStringArray = []
var _checks := 0
var _stubs: Array = []


class StubPackages extends PackagesManager:
	var scenes: Dictionary = {}

	func instantiate_scene(
		_package_id: int, scene_path: String, _revision: int = 0
	) -> Node:
		var scene: PackedScene = scenes.get(scene_path, null)
		return scene.instantiate() if scene != null else null

	func runtime_path(
		_package_id: int, _revision: int, filepath: String, _artifact_key: String = ""
	) -> String:
		return "res://tests/packages/%s" % filepath


func _initialize() -> void:
	_test_swap_and_restore()
	_test_invalid_root_keeps_current()
	_test_missing_file_keeps_current()
	_test_missing_viewport_keeps_current()
	_test_multiple_subviewports()
	_test_multiple_registrations()
	_test_custom_ui_keeps_mouse_filter()
	_test_revision_rebuild()
	_test_retry_after_invalid()
	_finish()


func _make_main():
	var main = (load(MAIN_SCENE) as PackedScene).instantiate()
	main.call("_setup_services")
	return main


func _make_package_scene(root_name: String, viewport_index: int = 0) -> PackedScene:
	var root := SubViewportContainer.new()
	root.name = root_name
	root.set_script(WiredGameSceneScript)
	var preview := SubViewport.new()
	preview.name = "Preview"
	root.add_child(preview)
	preview.owner = root
	var world := SubViewport.new()
	world.name = "World"
	root.add_child(world)
	world.owner = root
	root.set("world_viewport", preview if viewport_index == 0 else world)
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	return packed


func _register_main(
	main, package_id: String, path: String, scene: PackedScene = null, order: int = 0
) -> void:
	var stub := StubPackages.new()
	if scene != null:
		stub.scenes[path] = scene
	_stubs.append(stub)
	var context := WiredPackageContext.new()
	context.package_id = package_id
	context.revision = 1
	context.artifact_key = "artifact"
	context.packages = stub
	var registry := main._registry as WiredPackageRegistry
	registry.register_context(package_id, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = package_id
	registration.add_main_scene(path, {"order": order})
	registry.add_registration(registration)


func _test_swap_and_restore() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	var default_viewport: SubViewport = default_root.get_node("SubViewport")
	var sw: Node = main.static_world
	var dw: Node = main.dynamic_world
	var pm: Node = main.players_manager
	_register_main(main, "1", "game/custom.tscn", _make_package_scene("CustomGame"))

	main.call("_rebuild_game_scene_if_needed")
	var custom: Node = main._game_root
	_check(custom != default_root, "the package scene must replace the default Game root")
	_check(custom.get_parent() == main, "the package scene must be installed under Main")
	_check(default_root.get_parent() == null, "the default Game root must be detached, not freed")
	_check(main._game_root == custom, "Main must track the installed root")

	var custom_viewport: SubViewport = custom.get("world_viewport")
	_check(sw.get_parent() == custom_viewport, "StaticWorld must move into world_viewport")
	_check(dw.get_parent() == custom_viewport, "DynamicWorld must move into world_viewport")
	_check(pm.get_parent() == custom_viewport, "Players must move into world_viewport")
	_check(main.static_world == sw, "StaticWorld must keep its instance across a swap")
	_check(main.dynamic_world == dw, "DynamicWorld must keep its instance across a swap")
	_check(main.players_manager == pm, "PlayersManager must keep its instance across a swap")

	var installed: Node = main._game_root
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == installed, "an unchanged main-scene key must not rebuild the scene")

	main._registry.clear_package("1")
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "removing the package must restore the default Game")
	_check(default_root.get_parent() == main, "the default Game must return under Main")
	_check(custom.get_parent() == null, "the replaced custom root must leave Main")
	_check(main._game_scene_key == "", "restoring the default Game must clear the scene key")
	_check(sw.get_parent() == default_viewport, "StaticWorld must return to the default viewport")
	_check(dw.get_parent() == default_viewport, "DynamicWorld must return to the default viewport")
	_check(pm.get_parent() == default_viewport, "Players must return to the default viewport")

	main.free()


func _make_scene_without_script() -> PackedScene:
	var root := Node.new()
	var child := SubViewport.new()
	root.add_child(child)
	child.owner = root
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	return packed


func _make_scripted_scene_without_viewport() -> PackedScene:
	var root := Node.new()
	root.set_script(WiredGameSceneScript)
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	return packed


func _test_invalid_root_keeps_current() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(main, "1", "game/plain.tscn", _make_scene_without_script())
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "a root without WiredGameScene must not replace Game")
	main.free()


func _test_missing_file_keeps_current() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(main, "1", "game/missing.tscn")
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "a missing main scene file must not replace Game")
	main.free()


func _test_missing_viewport_keeps_current() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(
		main, "1", "game/no_viewport.tscn", _make_scripted_scene_without_viewport()
	)
	main.call("_rebuild_game_scene_if_needed")
	_check(
		main._game_root == default_root,
		"a WiredGameScene without world_viewport must not replace Game",
	)
	main.free()


func _test_multiple_subviewports() -> void:
	var main = _make_main()
	var sw: Node = main.static_world
	_register_main(
		main, "1", "game/two_views.tscn", _make_package_scene("TwoViews", 1)
	)
	main.call("_rebuild_game_scene_if_needed")
	var custom: Node = main._game_root
	var preview: SubViewport = custom.get_node("Preview")
	var world: SubViewport = custom.get_node("World")
	_check(sw.get_parent() == world, "services must go to the designated world_viewport")
	_check(not preview.is_ancestor_of(sw), "the first SubViewport must stay free for the package")
	main.free()


func _test_multiple_registrations() -> void:
	var main = _make_main()
	_register_main(main, "2", "game/late.tscn", _make_package_scene("Late"), 20)
	_register_main(main, "1", "game/early.tscn", _make_package_scene("Early"), 10)
	main.call("_rebuild_game_scene_if_needed")
	_check(
		main._game_root.name == "Early",
		"the deterministic first main scene must win, got %s" % main._game_root.name,
	)
	_check(
		main._registry.get_main_scenes().size() == 2,
		"both main scenes must stay registered for the warning path",
	)
	main.free()


func _test_custom_ui_keeps_mouse_filter() -> void:
	var main = _make_main()
	var scene := _make_package_scene("WithUi")
	var root := scene.instantiate()
	var button := Button.new()
	button.name = "HudButton"
	root.add_child(button)
	button.owner = root
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	_register_main(main, "1", "game/with_ui.tscn", packed)
	main.call("_rebuild_game_scene_if_needed")
	main.call("_setup_ui_input_passthrough")
	var custom: Node = main._game_root
	var hud := custom.get_node("HudButton") as Button
	_check(
		hud.mouse_filter == Control.MOUSE_FILTER_STOP,
		"custom scene UI must keep its own mouse_filter",
	)
	var log_control := main.ui.get_node("Margin/VBox/Log") as Control
	_check(
		log_control.mouse_filter == Control.MOUSE_FILTER_IGNORE,
		"Main/UI must still ignore the mouse after the swap",
	)
	main.free()


func _test_revision_rebuild() -> void:
	var main = _make_main()
	_register_main(main, "1", "game/rev.tscn", _make_package_scene("Rev1"))
	main.call("_rebuild_game_scene_if_needed")
	var first: Node = main._game_root
	var stub := StubPackages.new()
	stub.scenes["game/rev.tscn"] = _make_package_scene("Rev2")
	_stubs.append(stub)
	var context := WiredPackageContext.new()
	context.package_id = "1"
	context.revision = 2
	context.artifact_key = "artifact"
	context.packages = stub
	main._registry.register_context("1", context)
	main.call("_rebuild_game_scene_if_needed")
	var second: Node = main._game_root
	_check(
		second != first and second.name == "Rev2",
		"a new revision must rebuild the main scene",
	)
	_check(first.get_parent() == null, "the previous revision root must leave Main")
	main.free()


func _test_retry_after_invalid() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(main, "1", "game/retry.tscn", _make_scene_without_script())
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "the invalid scene must be rejected")
	main._registry.clear_package("1")
	_register_main(main, "1", "game/retry.tscn", _make_package_scene("Retried"))
	main.call("_rebuild_game_scene_if_needed")
	_check(
		main._game_root.name == "Retried",
		"a fixed scene must replace the default Game after a failed attempt",
	)
	main.free()


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	for stub: Node in _stubs:
		if is_instance_valid(stub):
			stub.free()
	_stubs.clear()
	if _failures.is_empty():
		print("MAIN_SCENE_SWAP_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("MAIN_SCENE_SWAP_SMOKE_FAILED %s" % message)
	quit(1)
