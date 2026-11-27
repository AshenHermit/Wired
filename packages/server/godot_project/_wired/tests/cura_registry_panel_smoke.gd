extends SceneTree

## Headless smoke-тест панели реестра `cura_registry`.
##
## Реальный пакет лежит в `godot_project/examples/cura_registry` вне базового
## проекта `res://`, поэтому тест инстанцирует фикстурный скрипт
## `res://tests/fixtures/cura_registry/registry_panel.gd`. Сцена проверяется по
## тексту (её `ext_resource` указывает на путь пакета, недоступный внутри
## `res://`), обе копии сверяются байт-в-байт с оригиналами. Захват указателя в
## headless нельзя проверить через `Input.mouse_mode`: движок игнорирует его
## смену без окна, поэтому тест использует локальный флаг панели — так же, как
## `cura_player` использует флаг на web.
##
## Запуск из корня репозитория:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/cura_registry_panel_smoke.gd --quit-after 2

const EXAMPLE_DIR := "../examples/cura_registry"
const FIXTURE_SCENE_PATH := "res://tests/fixtures/cura_registry/registry_panel.tscn"
const FIXTURE_SCRIPT_PATH := "res://tests/fixtures/cura_registry/registry_panel.gd"
const PACKAGE_ID := "pkg.crate"
const PROP_ID := "pkg.crate/crate"
const TOOL_ID := "pkg.crate/spawner"
const ACTION := "pkg.crate/cura_panel"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _previous_packages: Variant = null
var _q_panel: Variant = null
var _rebuild_panel: Variant = null
var _rebuild_registry: StubRegistry = null
var _rebuild_before := 0


## Минимальный игрок: базовый компонент спрашивает только local-флаг и
## авторитетность. `WiredPlayer` нужен для статической типизации поля `player`.
class StubPlayer extends WiredPlayer:
	func _ready() -> void:
		pass

	func is_local_player() -> bool:
		return true

	func is_server_authority() -> bool:
		return true


## Замена реестра ядра: панель должна работать с инжектированным экземпляром и
## дёргать ровно три `get_entries`, по одному на каждый из kinds.
class StubRegistry extends WiredPackageRegistry:
	var calls: Array[String] = []
	var categories: Array[Dictionary] = []
	var props: Array[Dictionary] = []
	var tools: Array[Dictionary] = []

	func configure(
		cats: Array[Dictionary], entries_props: Array[Dictionary], entries_tools: Array[Dictionary]
	) -> void:
		categories = _copy(cats)
		props = _copy(entries_props)
		tools = _copy(entries_tools)

	func get_entries(kind: String) -> Array[Dictionary]:
		calls.append(kind)
		if kind == "cura.category":
			return _copy(categories)
		if kind == "cura.prop":
			return _copy(props)
		if kind == "cura.tool":
			return _copy(tools)
		return []

	func _copy(source: Array[Dictionary]) -> Array[Dictionary]:
		var result: Array[Dictionary] = []
		for entry: Dictionary in source:
			result.append(entry.duplicate(true))
		return result


## Замена `Global.packages`: сигнал `package_applied` наследуется от ядра,
## проверяем, что панель подключается именно к нему.
class StubPackages extends PackagesManager:
	pass


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_fixture_matches_example()
	test_panel_builds_categories_and_emits_selection()
	toggle_and_pointer_tests()
	test_sorting_and_unknown_category()
	# Оба отложенных эффекта готовятся в одном кадре: `--quit-after 2` оставляет
	# только один переход через `await process_frame`.
	_prepare_deferred_checks()
	await process_frame
	_finish_deferred_checks()
	_restore_services()
	_free_owned()
	_finish()


## Копии обязаны быть байт-в-байт теми же, что и файлы реального пакета: иначе
## тест проверяет не тот код, который получают пользователи библиотеки.
func test_fixture_matches_example() -> void:
	for relative_path: String in ["registry_panel.gd", "registry_panel.tscn"]:
		var example_text := FileAccess.get_file_as_string(_example_path(relative_path))
		var fixture_text := FileAccess.get_file_as_string(
			ProjectSettings.globalize_path(
				FIXTURE_SCRIPT_PATH if relative_path.ends_with(".gd") else FIXTURE_SCENE_PATH
			)
		)
		_check(not example_text.is_empty(), "the real example %s must exist" % relative_path)
		_check(not fixture_text.is_empty(), "the fixture %s must exist" % relative_path)
		_check(
			example_text.replace("\r\n", "\n") == fixture_text.replace("\r\n", "\n"),
			"the fixture must be an exact copy of the example %s" % relative_path,
		)
	var source := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(FIXTURE_SCRIPT_PATH)
	)
	for line: String in source.split("\n"):
		_check(
			not line.strip_edges().begins_with("class_name "),
			"package script must not declare class_name",
		)
	var scene_text := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(FIXTURE_SCENE_PATH)
	)
	_check(
		scene_text.contains('[node name="RegistryPanel" type="CanvasLayer"]')
			and scene_text.contains('type="Script"'),
		"the panel scene root must be a CanvasLayer with the panel script",
	)


func test_panel_builds_categories_and_emits_selection() -> void:
	var panel: Variant = _new_panel()
	if panel == null:
		return
	panel.player = _stub_player()
	var registry := _default_registry()
	panel.set_registry(registry)
	panel.rebuild()
	_check(panel.item_count() == 2, "panel must list one prop and one tool")
	_check(
		registry.calls == ["cura.category", "cura.prop", "cura.tool"],
		"rebuild must read all three registry kinds",
	)
	_check(panel.is_in_group("cura_registry_panel"), "panel must join the panel group")
	var seen: Array = []
	panel.prop_selected.connect(func(value): seen.append(value))
	panel.select_item(0)
	_check(seen == [PROP_ID], "selection must emit a qualified prop id")
	_check(not panel.is_open(), "selection must close the panel")
	var tools: Array = []
	panel.tool_selected.connect(func(value): tools.append(value))
	panel.select_item(1)
	_check(tools == [TOOL_ID], "tool selection must emit a qualified tool id")
	panel.select_item(99)
	_check(tools == [TOOL_ID], "an out-of-range index must emit nothing")


## Открытие панели освобождает указатель, закрытие возвращает захват только
## если он был до открытия. На web флаг — единственный надёжный источник, в
## headless тоже приходится проверять его вместо `Input.mouse_mode`.
func toggle_and_pointer_tests() -> void:
	var panel: Variant = _new_panel()
	if panel == null:
		return
	panel.pointer_captured = true
	panel.toggle()
	_check(panel.is_open(), "first toggle must open")
	_check(not panel.pointer_captured, "opening must release the captured pointer")
	panel.toggle()
	_check(not panel.is_open(), "second toggle must close")
	_check(panel.pointer_captured, "closing must restore the captured pointer")
	_check(panel.capture_restored, "closing must report the restored capture")
	var uncaptured: Variant = _new_panel()
	if uncaptured == null:
		return
	uncaptured.toggle()
	uncaptured.toggle()
	_check(not uncaptured.pointer_captured, "an uncaptured pointer must stay released")
	_check(not uncaptured.capture_restored, "closing without capture must not restore it")


func test_sorting_and_unknown_category() -> void:
	var panel: Variant = _new_panel()
	if panel == null:
		return
	var registry := StubRegistry.new()
	_owned.append(registry)
	registry.configure(
		[
			{
				"id": "props", "qualified_id": "pkg.crate/props", "package_id": PACKAGE_ID,
				"options": {"label": "Props", "order": 5},
			}
		],
		[
			{
				"id": "zebra", "qualified_id": "pkg.crate/zebra", "package_id": PACKAGE_ID,
				"options": {"order": 20, "category": "props", "label": "Zebra"},
			},
			{
				"id": "apple", "qualified_id": "pkg.crate/apple", "package_id": PACKAGE_ID,
				"options": {"order": 10, "category": "props", "label": "Apple"},
			},
		],
		[
			{
				"id": "mystery", "qualified_id": "pkg.crate/mystery", "package_id": PACKAGE_ID,
				"options": {"order": 1, "category": "", "label": "Mystery"},
			}
		]
	)
	panel.set_registry(registry)
	panel.rebuild()
	_check(panel.item_count() == 3, "all entries must be listed once")
	panel.rebuild()
	_check(panel.item_count() == 3, "rebuilding must not duplicate items")
	var seen: Array = []
	panel.prop_selected.connect(func(value): seen.append(value))
	var tools: Array = []
	panel.tool_selected.connect(func(value): tools.append(value))
	panel.select_item(0)
	panel.select_item(2)
	_check(seen == ["pkg.crate/apple"], "entries must sort by order inside a category")
	_check(tools == ["pkg.crate/mystery"], "unknown categories must go to the fallback group")


## Готовим Q и `package_applied` в одном кадре: после `action_press` движок
## выставит `just_pressed` на следующем кадре, а `call_deferred` из сигнала
## выполнится там же. Так укладываемся в `--quit-after 2`.
func _prepare_deferred_checks() -> void:
	_q_panel = _new_detached_panel()
	if _q_panel != null:
		_q_panel.player = _stub_player()
		_check(InputMap.has_action(ACTION), "the panel must register its Q action")
		var has_q := false
		for event: InputEvent in InputMap.action_get_events(ACTION):
			if (
				event is InputEventKey
				and (event as InputEventKey).physical_keycode == KEY_Q
			):
				has_q = true
		_check(has_q, "the panel action must contain an InputEventKey with KEY_Q")
		Input.action_press(ACTION)
	var global_node := root.get_node("Global")
	_previous_packages = global_node.get("packages")
	var packages := StubPackages.new()
	global_node.set("packages", packages)
	_owned.append(packages)
	_rebuild_panel = _new_panel()
	if _rebuild_panel == null:
		return
	_rebuild_registry = _default_registry()
	_rebuild_panel.player = _stub_player()
	_rebuild_panel.set_registry(_rebuild_registry)
	_rebuild_panel.rebuild()
	_check(
		packages.is_connected(
			"package_applied", Callable(_rebuild_panel, "_on_package_applied")
		),
		"the panel must listen for package_applied",
	)
	_rebuild_before = _rebuild_registry.calls.size()
	packages.package_applied.emit(1, 1, PackedStringArray())
	_check(
		_rebuild_registry.calls.size() == _rebuild_before,
		"rebuild must be deferred",
	)


func _finish_deferred_checks() -> void:
	if InputMap.has_action(ACTION):
		Input.action_release(ACTION)
	if _q_panel != null:
		_q_panel._wired_process(0.016)
		_check(_q_panel.is_open(), "Q must open the panel")
		_q_panel.close_panel()
		_check(not _q_panel.is_open(), "close_panel must close the panel")
	if _rebuild_panel != null and _rebuild_registry != null:
		_check(
			_rebuild_registry.calls.size() == _rebuild_before + 3,
			"package_applied must rebuild the panel",
		)


func _default_registry() -> StubRegistry:
	var registry := StubRegistry.new()
	_owned.append(registry)
	registry.configure(
		[
			{
				"id": "props", "qualified_id": "pkg.crate/props", "package_id": PACKAGE_ID,
				"options": {"label": "Props", "order": 5},
			}
		],
		[
			{
				"id": "crate", "qualified_id": PROP_ID, "package_id": PACKAGE_ID,
				"options": {"order": 10, "category": "props", "label": "Crate"},
			}
		],
		[
			{
				"id": "spawner", "qualified_id": TOOL_ID, "package_id": PACKAGE_ID,
				"options": {"order": 20, "category": "tools", "label": "Toolgun"},
			}
		]
	)
	return registry


func _stub_player() -> StubPlayer:
	var player := StubPlayer.new()
	player.peer_id = 2
	_owned.append(player)
	return player


func _new_panel() -> Variant:
	var script: GDScript = load(FIXTURE_SCRIPT_PATH)
	if script == null:
		_check(false, "the fixture panel script must load")
		return null
	var panel: Variant = script.new()
	if not (panel is WiredPlayerComponent):
		_check(false, "the fixture panel must be a WiredPlayerComponent")
		return null
	panel.package_id = PACKAGE_ID
	root.add_child(panel)
	_owned.append(panel)
	return panel


## Отсоединённая копия нужна для проверки Q: базовый `_process` не должен
## переключать панель в момент, когда тест ждёт кадр после action_press.
func _new_detached_panel() -> Variant:
	var script: GDScript = load(FIXTURE_SCRIPT_PATH)
	if script == null:
		_check(false, "the fixture panel script must load")
		return null
	var panel: Variant = script.new()
	if not (panel is WiredPlayerComponent):
		_check(false, "the fixture panel must be a WiredPlayerComponent")
		return null
	panel.package_id = PACKAGE_ID
	panel._wired_ready()
	_owned.append(panel)
	return panel


func _example_path(relative_path: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return (
		project_dir
		.path_join(EXAMPLE_DIR)
		.path_join("ui")
		.path_join(relative_path)
		.simplify_path()
	)


func _restore_services() -> void:
	var global_node := root.get_node("Global")
	if global_node != null:
		global_node.set("packages", _previous_packages)


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
		print("CURA_REGISTRY_PANEL_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("CURA_REGISTRY_PANEL_SMOKE_FAILED %s" % message)
	quit(1)
