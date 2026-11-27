extends SceneTree

## Headless smoke-тест базового инструмента `hand_weapon`.
##
## Реальный скрипт лежит в `godot_project/examples/cura_registry` вне базового
## проекта `res://`, поэтому тест загружает копию из
## `res://tests/fixtures/cura_registry/hand_weapon.gd` и отдельно проверяет,
## что копия байт-в-байт совпадает с оригиналом. Наследник фикстуры компилируется
## во время выполнения: он перехватывает `wired_primary` и визуальные хуки.
##
## Запуск из корня репозитория:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/cura_hand_weapon_smoke.gd --quit-after 2

const EXAMPLE_DIR := "../examples/cura_registry"
const FIXTURE_PATH := "res://tests/fixtures/cura_registry/hand_weapon.gd"
const PACKAGE_ID := "pkg.crate"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []


## Минимальный игрок: базовый компонент спрашивает только local-флаг и
## авторитетность. `WiredPlayer` нужен для статической типизации поля `player`.
class StubPlayer extends WiredPlayer:
	func _ready() -> void:
		pass

	func is_local_player() -> bool:
		return true

	func is_server_authority() -> bool:
		return true


## Замена менеджера из Task 4: базовый инструмент читает только активный id.
class StubManager extends Node:
	var active_tool_id: String = ""


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_fixture_matches_example()
	test_base_script_contract()
	test_primary_receives_context()
	test_visual_hooks_follow_active_id()
	test_visual_stays_inactive_without_manager()
	test_state_hooks_delegate()
	_free_owned()
	_finish()


## Копия обязана быть байт-в-байт той же, что и оригинал пакета: иначе тест
## проверяет не тот код, который получают пользователи библиотеки.
func test_fixture_matches_example() -> void:
	var example_text := FileAccess.get_file_as_string(_example_path("hand_weapon.gd"))
	var fixture_text := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(FIXTURE_PATH)
	)
	_check(not example_text.is_empty(), "the real example hand_weapon.gd must exist")
	_check(not fixture_text.is_empty(), "the fixture hand_weapon.gd must exist")
	_check(
		example_text.replace("\r\n", "\n") == fixture_text.replace("\r\n", "\n"),
		"the fixture must be an exact copy of the example hand_weapon.gd",
	)


func test_base_script_contract() -> void:
	var weapon: Variant = _new_base_weapon()
	if weapon == null:
		return
	_check(weapon is WiredPlayerComponent, "hand_weapon must extend WiredPlayerComponent")
	var source := str(weapon.get_script().get_source_code())
	var declares_class_name := false
	for line: String in source.split("\n"):
		if line.strip_edges().begins_with("class_name "):
			declares_class_name = true
	_check(not declares_class_name, "package script must not declare class_name")
	for field: String in ["tool_id", "viewmodel_path", "requires_prop"]:
		_check(weapon.get(field) != null, "hand_weapon must expose %s" % field)
	_check(weapon.get("manager") == null, "manager must be a Node field defaulting to null")
	_check(str(weapon.tool_id) == "", "tool_id must default to an empty string")
	_check(str(weapon.viewmodel_path) == "", "viewmodel_path must default to an empty string")
	_check(not bool(weapon.requires_prop), "requires_prop must default to false")
	for export_line: String in [
		"@export var tool_id: String",
		"@export var viewmodel_path: String",
		"@export var requires_prop: bool = false",
	]:
		_check(source.contains(export_line), "missing export: %s" % export_line)
	for method: String in [
		"wired_equip",
		"wired_unequip",
		"wired_primary",
		"wired_secondary",
		"wired_update",
		"wired_visual_equip",
		"wired_visual_update",
		"wired_save_state",
		"wired_load_state",
	]:
		_check(weapon.has_method(method), "hand_weapon must implement %s" % method)
	_check(weapon._wired_save_state().is_empty(), "default state must be empty")
	# Хуки по умолчанию не должны падать без менеджера и без пропсов.
	weapon.wired_equip({})
	weapon.wired_unequip()
	weapon.wired_primary({})
	weapon.wired_secondary({})
	weapon.wired_update(0.016)
	weapon.wired_visual_equip(true)
	weapon.wired_visual_update(0.016, true)
	weapon._wired_load_state({"unused": true})


func test_primary_receives_context() -> void:
	var weapon: Variant = _new_weapon()
	if weapon == null:
		return
	weapon.player = _stub_player()
	weapon.tool_id = "spawner"
	var ctx := {"hit": {"position": Vector3(1, 2, 3)}, "selected_prop": "pkg.crate/crate"}
	weapon.wired_primary(ctx)
	_check(weapon.last_ctx == ctx, "wired_primary must receive the server context")


func test_visual_hooks_follow_active_id() -> void:
	var weapon: Variant = _new_weapon()
	if weapon == null:
		return
	weapon.player = _stub_player()
	weapon.package_id = PACKAGE_ID
	weapon.manager = _stub_manager_with_active("pkg.crate/spawner")
	weapon.tool_id = "spawner"
	weapon._wired_visual_process(0.016)
	_check(weapon.equip_calls == 1, "active weapon must be visually equipped once")
	_check(weapon.visual_update_calls == 1, "active weapon must be visually updated")
	_check(weapon.last_visual_is_local, "visual update must receive the local-player flag")
	weapon._wired_visual_process(0.016)
	_check(weapon.equip_calls == 1, "equip must not repeat while the id is unchanged")
	_check(weapon.visual_update_calls == 2, "visual update must run on every active frame")
	weapon.manager.active_tool_id = ""
	weapon._wired_visual_process(0.016)
	_check(weapon.unequip_calls == 1, "inactive weapon must be visually unequipped")
	_check(weapon.visual_update_calls == 2, "inactive weapon must not be visually updated")


func test_visual_stays_inactive_without_manager() -> void:
	var weapon: Variant = _new_weapon()
	if weapon == null:
		return
	weapon.player = _stub_player()
	weapon.package_id = PACKAGE_ID
	weapon.tool_id = "spawner"
	weapon._wired_visual_process(0.016)
	weapon._wired_visual_process(0.016)
	_check(
		weapon.equip_calls == 0 and weapon.unequip_calls == 0,
		"a weapon without a manager must never fire visual equip/unequip",
	)


## Базовый компонент должен делегировать состояния наследнику, а не хранить
## собственный словарь: spawner будет сохранять свои данные через этот мост.
func test_state_hooks_delegate() -> void:
	var weapon: Variant = _new_weapon()
	if weapon == null:
		return
	var state: Dictionary = weapon.call("_wired_save_state") as Dictionary
	_check(bool(state.get("stored", false)), "_wired_save_state must delegate to wired_save_state")
	var payload := {"selected_prop": "pkg.crate/crate"}
	weapon._wired_load_state(payload)
	_check(weapon.loaded_state == payload, "_wired_load_state must delegate to wired_load_state")


func _new_base_weapon() -> Variant:
	var script: GDScript = load(FIXTURE_PATH)
	if script == null:
		_check(false, "fixture hand_weapon.gd must load")
		return null
	var weapon: Variant = script.new()
	if weapon == null:
		_check(false, "fixture hand_weapon.gd must be instantiable")
		return null
	root.add_child(weapon)
	_owned.append(weapon)
	return weapon


## Наследник компилируется из исходника, чтобы тест не добавлял ещё один
## зафиксированный файл и проверял именно публичный контракт суперкласса.
func _new_weapon() -> Variant:
	var script := GDScript.new()
	script.source_code = _weapon_subclass_source()
	var error := script.reload()
	if error != OK:
		_check(false, "hand_weapon subclass must compile, error=%d" % error)
		return null
	var weapon: Variant = script.new()
	if weapon == null:
		_check(false, "hand_weapon subclass must be instantiable")
		return null
	root.add_child(weapon)
	_owned.append(weapon)
	return weapon


func _weapon_subclass_source() -> String:
	return """
extends "%s"

var last_ctx: Dictionary = {}
var equip_calls := 0
var unequip_calls := 0
var visual_update_calls := 0
var last_visual_is_local := false
var loaded_state: Dictionary = {}


func wired_primary(ctx: Dictionary) -> void:
	last_ctx = ctx


func wired_visual_equip(active: bool) -> void:
	if active:
		equip_calls += 1
	else:
		unequip_calls += 1


func wired_visual_update(_delta: float, is_local: bool) -> void:
	visual_update_calls += 1
	last_visual_is_local = is_local


func wired_save_state() -> Dictionary:
	return {"stored": true}


func wired_load_state(state: Dictionary) -> void:
	loaded_state = state
""" % FIXTURE_PATH


func _stub_player() -> WiredPlayer:
	var player := StubPlayer.new()
	_owned.append(player)
	return player


func _stub_manager_with_active(active_id: String) -> Node:
	var manager := StubManager.new()
	manager.active_tool_id = active_id
	root.add_child(manager)
	_owned.append(manager)
	return manager


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
		print("CURA_HAND_WEAPON_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("CURA_HAND_WEAPON_SMOKE_FAILED %s" % message)
	quit(1)
