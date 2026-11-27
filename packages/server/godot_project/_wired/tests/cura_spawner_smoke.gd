extends SceneTree

## Headless smoke-тест встроенного инструмента `spawner` библиотеки `cura_registry`.
##
## Настоящий пакет лежит вне `res://`, поэтому сцена и скрипт загружаются из
## fixture-копий. Копии совпадают с оригиналами до одного пути: в скрипте —
## путь базового `hand_weapon.gd`, в сцене — путь самого скрипта. Тест проверяет
## это равенство с подстановкой, а не байт-в-байт: `extends` обязан отличаться.
## Основная проверка — спавн по доверенному hit менеджера, без клиентских данных.
##
## Запуск из корня репозитория:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/cura_spawner_smoke.gd --quit-after 2

const EXAMPLE_DIR := "../examples/cura_registry/tools"
const FIXTURE_SCENE_PATH := "res://tests/fixtures/cura_registry/spawner.tscn"
const FIXTURE_SCRIPT_PATH := "res://tests/fixtures/cura_registry/spawner.gd"
const REAL_SCENE_SCRIPT_PATH := "res://packages/cura_registry/tools/spawner.gd"
const REAL_BASE_PATH := "res://packages/cura_registry/hand_weapon.gd"
const FIXTURE_BASE_PATH := "res://tests/fixtures/cura_registry/hand_weapon.gd"
const PACKAGE_ID := "pkg.crate"
const TOOL_ID := "spawner"
const PROP_ID := "pkg.crate/crate"
const WEAPON_GROUP := "cura_hand_weapon"
const CHARACTER_GROUP := "cura_player_character"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []


## Минимальный игрок: базовый компонент спрашивает только локальность и
## авторитетность; `components` нужен для поиска персонажа вьюмодели.
class StubPlayer extends WiredPlayer:
	func _ready() -> void:
		pass

	func is_local_player() -> bool:
		return true

	func is_server_authority() -> bool:
		return true


## Замена менеджера из Task 4: записывает спавны, не трогает ядро.
class StubManager extends Node:
	var active_tool_id: String = ""
	var spawn_calls: Array[Dictionary] = []

	func spawn_prop(qualified_type: String, position: Vector3) -> Node:
		spawn_calls.append({"type": qualified_type, "position": position})
		return null


## Персонаж из `cura_player` с контрактом монтировки вьюмодели.
class StubCharacter extends WiredPlayerComponent:
	var tool_mount: Node3D = null
	var equip_calls := 0
	var clear_calls := 0

	func _ready() -> void:
		pass

	func equip_viewmodel(scene: PackedScene) -> Node:
		equip_calls += 1
		if scene == null or tool_mount == null:
			return null
		var viewmodel := scene.instantiate()
		if viewmodel != null:
			tool_mount.add_child(viewmodel)
		return viewmodel

	func clear_viewmodel() -> void:
		clear_calls += 1
		if tool_mount == null:
			return
		for child: Node in tool_mount.get_children():
			child.free()


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_fixture_matches_example()
	test_spawner_scene_contract()
	test_spawner_uses_trusted_hit()
	test_context_manager_is_authoritative()
	test_viewmodel_mounts_through_character()
	_free_owned()
	_finish()


## Копии обязаны отличаться от оригиналов только одним путём: иначе тест
## проверяет не тот код, который получают пользователи библиотеки.
func test_fixture_matches_example() -> void:
	for relative_path: String in ["spawner.gd", "spawner.tscn"]:
		var example_text := FileAccess.get_file_as_string(_example_path(relative_path))
		var fixture_text := FileAccess.get_file_as_string(
			ProjectSettings.globalize_path(
				FIXTURE_SCRIPT_PATH if relative_path.ends_with(".gd") else FIXTURE_SCENE_PATH
			)
		)
		_check(
			not example_text.is_empty(),
			"the real example %s must exist" % relative_path,
		)
		_check(not fixture_text.is_empty(), "the fixture %s must exist" % relative_path)
		var normalized_fixture := fixture_text.replace("\r\n", "\n")
		if relative_path.ends_with(".gd"):
			normalized_fixture = normalized_fixture.replace(
				FIXTURE_BASE_PATH, REAL_BASE_PATH
			)
		else:
			normalized_fixture = normalized_fixture.replace(
				FIXTURE_SCRIPT_PATH, REAL_SCENE_SCRIPT_PATH
			)
		_check(
			example_text.replace("\r\n", "\n") == normalized_fixture,
			"the fixture %s must match the example apart from the path" % relative_path,
		)
	var source := FileAccess.get_file_as_string(_example_path("spawner.gd"))
	_check(
		source.contains('extends "%s"' % REAL_BASE_PATH),
		"spawner.gd must extend the library hand_weapon.gd",
	)
	for line: String in source.split("\n"):
		_check(
			not line.strip_edges().begins_with("class_name "),
			"package script must not declare class_name",
		)
	_check(
		not source.contains("/root/Global") and not source.contains(".rpc("),
		"spawner must not reach Global or declare RPCs itself",
	)


func test_spawner_scene_contract() -> void:
	var weapon: Variant = _load_spawner()
	if weapon == null:
		return
	_check(weapon is Node3D, "spawner scene root must be a Node3D")
	_check(weapon is WiredPlayerComponent, "spawner must extend hand_weapon")
	_check(str(weapon.tool_id) == TOOL_ID, "spawner must expose the local tool id")
	_check(weapon.requires_prop, "spawner requires a selected prop")
	_check(
		weapon.is_in_group(WEAPON_GROUP),
		"spawner must join the tool manager's weapon group",
	)
	weapon.package_id = PACKAGE_ID
	_check(
		str(weapon._qualified_tool_id()) == "%s/%s" % [PACKAGE_ID, TOOL_ID],
		"spawner's tool id must qualify with its package id",
	)
	var viewmodel: Variant = weapon.get_node_or_null(str(weapon.viewmodel_path))
	_check(viewmodel is Node3D, "viewmodel_path must point to a viewmodel node")
	if viewmodel != null:
		_check(_has_mesh(viewmodel), "the viewmodel must contain a pistol mesh")


func test_spawner_uses_trusted_hit() -> void:
	var weapon: Variant = _load_spawner()
	if weapon == null:
		return
	weapon.player = _stub_player()
	var manager := _stub_manager()  # записывает spawn_calls
	var ctx := {
		"manager": manager,
		"selected_prop": PROP_ID,
		"hit": {"position": Vector3(1, 2, 3), "normal": Vector3(0, 1, 0)},
	}
	weapon.wired_primary(ctx)
	_check(manager.spawn_calls.size() == 1, "spawner must spawn once")
	_check(
		manager.spawn_calls[0]["type"] == PROP_ID
			and manager.spawn_calls[0]["position"].is_equal_approx(Vector3(1, 2.05, 3)),
		"spawn must use the trusted hit plus surface offset",
	)
	_check(weapon.requires_prop, "spawner requires a selected prop")


## Серверный вызов берёт менеджер только из контекста: застарелое поле
## `weapon.manager` не должно подменять доверенный менеджер из `ctx`.
func test_context_manager_is_authoritative() -> void:
	var weapon: Variant = _load_spawner()
	if weapon == null:
		return
	weapon.player = _stub_player()
	weapon.manager = _stub_manager()
	var manager := _stub_manager()
	weapon.wired_primary({
		"manager": manager,
		"selected_prop": PROP_ID,
		"hit": {"position": Vector3(4, 5, 6), "normal": Vector3(0, 0, 1)},
	})
	_check(
		(weapon.manager as StubManager).spawn_calls.is_empty(),
		"the stale manager field must not spawn",
	)
	_check(manager.spawn_calls.size() == 1, "the context manager must spawn")
	if manager.spawn_calls.size() == 1:
		_check(
			manager.spawn_calls[0]["position"].is_equal_approx(Vector3(4, 5, 6.05)),
			"the context hit normal must offset the spawn point",
		)


func test_viewmodel_mounts_through_character() -> void:
	var weapon: Variant = _load_spawner()
	if weapon == null:
		return
	var player := _stub_player()
	weapon.player = player
	weapon.package_id = PACKAGE_ID
	var manager := _stub_manager()
	manager.active_tool_id = "%s/%s" % [PACKAGE_ID, TOOL_ID]
	weapon.manager = manager
	var character := StubCharacter.new()
	character.tool_mount = Node3D.new()
	character.add_to_group(CHARACTER_GROUP)
	root.add_child(character.tool_mount)
	player.components.append(character)
	_owned.append(character)
	_owned.append(character.tool_mount)
	weapon._wired_visual_process(0.016)
	_check(character.equip_calls == 1, "an active spawner must equip its viewmodel")
	_check(
		character.tool_mount.get_child_count() == 1,
		"the viewmodel must be instanced into the character's tool mount",
	)
	if character.tool_mount.get_child_count() == 1:
		_check(
			_has_mesh(character.tool_mount.get_child(0)),
			"the mounted viewmodel must carry the pistol mesh",
		)
	manager.active_tool_id = ""
	weapon._wired_visual_process(0.016)
	_check(character.clear_calls == 1, "an inactive spawner must clear its viewmodel")
	_check(
		character.tool_mount.get_child_count() == 0,
		"unequip must leave the tool mount empty",
	)


func _load_spawner() -> Variant:
	var packed := load(FIXTURE_SCENE_PATH) as PackedScene
	if packed == null:
		_check(false, "the spawner scene must load from %s" % FIXTURE_SCENE_PATH)
		return null
	var weapon := packed.instantiate()
	if weapon == null:
		_check(false, "the spawner scene must instantiate")
		return null
	root.add_child(weapon)
	_owned.append(weapon)
	return weapon


func _stub_player() -> WiredPlayer:
	var player := StubPlayer.new()
	_owned.append(player)
	return player


func _stub_manager() -> StubManager:
	var manager := StubManager.new()
	root.add_child(manager)
	_owned.append(manager)
	return manager


func _has_mesh(node: Node) -> bool:
	if node is MeshInstance3D:
		return true
	for child: Node in node.get_children():
		if _has_mesh(child):
			return true
	return false


func _example_path(relative_path: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return (
		project_dir
		.path_join(EXAMPLE_DIR)
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
		print("CURA_SPAWNER_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("CURA_SPAWNER_SMOKE_FAILED %s" % message)
	quit(1)
