extends SceneTree

## Headless smoke-тест менеджера инструментов `cura_registry`.
##
## Реальный пакет лежит в `godot_project/examples/cura_registry` вне базового
## проекта `res://`, поэтому тест загружает копию из
## `res://tests/fixtures/cura_registry/tool_manager.gd` и отдельно проверяет,
## что копия байт-в-байт совпадает с оригиналом. Часы менеджера подменяются
## наследником `StubManager`, поэтому проверка темпа стрельбы детерминирована.
##
## Запуск из корня репозитория:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/cura_tool_manager_smoke.gd --quit-after 2

const EXAMPLE_DIR := "../examples/cura_registry"
const FIXTURE_PATH := "res://tests/fixtures/cura_registry/tool_manager.gd"
const FIXTURE_SCENE_PATH := "res://tests/fixtures/cura_registry/tool_manager.tscn"
const PACKAGE_ID := "pkg.crate"
const TOOL_ID := "pkg.crate/spawner"
const PROP_ID := "pkg.crate/crate"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _character: Node = null
var _previous_registry: Variant = null
var _previous_world: Variant = null


## Минимальный игрок: менеджер использует только эти методы и список компонентов.
class StubPlayer extends WiredPlayer:
	var server_authority := true
	var local_player := true
	var anchor := Vector3.ZERO
	var registered_actions: Dictionary = {}
	var sent_actions: Array[Dictionary] = []

	func _ready() -> void:
		pass

	func is_server_authority() -> bool:
		return server_authority

	func is_local_player() -> bool:
		return local_player

	func register_action(action: String, handler: Callable) -> void:
		registered_actions[action] = handler

	func request_action(action: String, payload: Dictionary = {}) -> void:
		sent_actions.append({"action": action, "payload": payload})

	func get_anchor_position_3d() -> Vector3:
		return anchor


## Инструмент из Task 3 с перехватом серверных хуков.
class StubWeapon extends "res://tests/fixtures/cura_registry/hand_weapon.gd":
	var primary_calls := 0
	var equip_calls := 0
	var unequip_calls := 0
	var last_ctx: Dictionary = {}

	func wired_primary(ctx: Dictionary) -> void:
		primary_calls += 1
		last_ctx = ctx

	func wired_equip(_ctx: Dictionary) -> void:
		equip_calls += 1

	func wired_unequip() -> void:
		unequip_calls += 1


## Персонаж из `cura_player`: захват взгляда и реплицированные углы.
class StubCharacter extends Node:
	var captured: bool = false
	var replicated_yaw: float = 0.0
	var replicated_pitch: float = 0.0

	func is_look_captured() -> bool:
		return captured


## Панель из Task 5: сигналы выбора и состояние открытости.
class StubPanel extends WiredPlayerComponent:
	signal prop_selected(qualified_type: String)
	signal tool_selected(qualified_tool: String)

	var open := false

	func is_open() -> bool:
		return open


class StubManager extends "res://tests/fixtures/cura_registry/tool_manager.gd":
	var clock_msec: int = 0
	var raycast_hit: Dictionary = {}

	func now_msec() -> int:
		return clock_msec

	func server_raycast() -> Dictionary:
		return raycast_hit


class StubDynamicWorld extends DynamicWorldContainer:
	var calls: Array[Dictionary] = []

	func spawn_entity(qualified_type: String, data: Dictionary = {}) -> Node:
		calls.append({"type": qualified_type, "data": data})
		return Node.new()


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_fixture_matches_example()
	test_base_script_contract()
	test_action_registration_and_panel_selection()
	test_click_requires_capture_and_closed_panel()
	test_fire_rate_is_limited()
	test_missing_weapon_disables_fire()
	test_valid_action_dispatches_trusted_context()
	test_action_dispatches_without_local_selection()
	test_client_authoritative_prop_is_rejected()
	test_spawn_prop_uses_dynamic_world()
	_restore_services()
	_free_owned()
	_finish()


## Копия обязана быть байт-в-байт той же, что и оригинал пакета: иначе тест
## проверяет не тот код, который получают пользователи библиотеки.
func test_fixture_matches_example() -> void:
	for relative_path: String in ["tool_manager.gd", "tool_manager.tscn"]:
		var example_text := FileAccess.get_file_as_string(
			_example_path(relative_path)
		)
		var fixture_text := FileAccess.get_file_as_string(
			ProjectSettings.globalize_path(
				FIXTURE_SCENE_PATH if relative_path.ends_with(".tscn") else FIXTURE_PATH
			)
		)
		_check(not example_text.is_empty(), "the real example %s must exist" % relative_path)
		_check(not fixture_text.is_empty(), "the fixture %s must exist" % relative_path)
		_check(
			example_text.replace("\r\n", "\n") == fixture_text.replace("\r\n", "\n"),
			"the fixture must be an exact copy of the example %s" % relative_path,
		)
	var scene_text := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(FIXTURE_SCENE_PATH)
	)
	_check(
		scene_text.contains('[node name="ToolManager" type="Node3D"]')
			and scene_text.contains('type="Script"'),
		"the manager scene root must be a Node3D with the manager script",
	)


func test_base_script_contract() -> void:
	var manager := _new_manager(true)
	_check(manager is WiredPlayerComponent, "manager must extend WiredPlayerComponent")
	var source := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(FIXTURE_PATH)
	)
	for line: String in source.split("\n"):
		_check(
			not line.strip_edges().begins_with("class_name "),
			"package script must not declare class_name",
		)
	_check(source.contains('const ACTION_USE := "use_tool"'), "missing ACTION_USE constant")
	for field: String in ["selected_tool", "selected_prop", "active_tool_id", "panel_open"]:
		_check(manager.get(field) != null, "manager must expose %s" % field)
	_check(str(manager.selected_tool) == "", "selected_tool must default to empty")
	_check(str(manager.selected_prop) == "", "selected_prop must default to empty")
	_check(str(manager.active_tool_id) == "", "active_tool_id must default to empty")
	_check(not manager.panel_open, "panel_open must default to false")
	for method: String in [
		"set_active", "spawn_prop", "server_raycast", "now_msec", "_on_use_tool",
	]:
		_check(manager.has_method(method), "manager must implement %s" % method)
	var expected := PackedStringArray(["selected_tool", "selected_prop", "active_tool_id"])
	_check(
		manager._wired_replicated_properties() == expected,
		"manager must replicate selection and active tool",
	)
	manager.selected_tool = TOOL_ID
	manager.selected_prop = PROP_ID
	manager.active_tool_id = TOOL_ID
	var state := manager._wired_save_state()
	_check(
		str(state.get("selected_tool", "")) == TOOL_ID
			and str(state.get("selected_prop", "")) == PROP_ID
			and str(state.get("active_tool_id", "")) == TOOL_ID,
		"manager must persist the same strings it replicates",
	)
	manager.selected_tool = ""
	manager.selected_prop = ""
	manager.active_tool_id = ""
	manager._wired_load_state(state)
	_check(
		manager.selected_tool == TOOL_ID
			and manager.selected_prop == PROP_ID
			and manager.active_tool_id == TOOL_ID,
		"manager must restore selection and active tool",
	)
	_check(
		manager.server_raycast().is_empty(),
		"a raycast without a 3D world must return an empty dictionary",
	)


func test_action_registration_and_panel_selection() -> void:
	var player := _stub_player()
	var panel := StubPanel.new()
	panel.package_id = PACKAGE_ID
	panel.add_to_group("cura_registry_panel")
	player.components.append(panel)
	_owned.append(panel)
	var manager := StubManager.new()
	manager.package_id = PACKAGE_ID
	manager.player = player
	root.add_child(manager)
	_owned.append(manager)
	_check(
		player.registered_actions.has("pkg.crate/use_tool"),
		"the server manager must register the qualified use_tool action",
	)
	panel.prop_selected.emit(PROP_ID)
	panel.tool_selected.emit(TOOL_ID)
	_check(manager.selected_prop == PROP_ID, "prop_selected must update selected_prop")
	_check(manager.selected_tool == TOOL_ID, "tool_selected must update selected_tool")
	panel.open = true
	var event := _lmb_press()
	manager._wired_unhandled_input(event)
	_check(player.sent_actions.is_empty(), "an open panel must block clicks")


func test_click_requires_capture_and_closed_panel() -> void:
	var manager := _new_manager(true)  # is_server_authority() == true
	manager.player = _stub_player()
	_add_weapon(manager.player)
	_add_character(true)
	manager._wired_unhandled_input(_lmb_press())  # без экипированного инструмента
	_check(
		manager.player.sent_actions.is_empty(),
		"click without an equipped tool must not fire",
	)
	manager.set_active(TOOL_ID, PROP_ID)
	manager.panel_open = true
	manager._wired_unhandled_input(_lmb_press())
	_check(manager.player.sent_actions.is_empty(), "open panel must swallow clicks")
	manager.panel_open = false
	var character := _add_character(false)
	manager._wired_unhandled_input(_lmb_press())  # без захвата
	_check(manager.player.sent_actions.is_empty(), "uncaptured click must not fire")
	character.captured = true
	manager._wired_unhandled_input(_lmb_press())
	_check(manager.player.sent_actions.size() == 1, "captured click must fire")
	if manager.player.sent_actions.size() == 1:
		_check(
			str(manager.player.sent_actions[0]["action"]) == "pkg.crate/use_tool",
			"click must send the qualified use_tool action",
		)


func test_fire_rate_is_limited() -> void:
	var manager := StubManager.new()
	manager.player = _stub_player()
	manager.package_id = PACKAGE_ID
	manager.panel_open = false
	root.add_child(manager)
	_owned.append(manager)
	# Темп измеряется для экипированного инструмента: без active_tool_id
	# клик не становится action по требованиям spec.
	_add_weapon(manager.player)
	manager.set_active(TOOL_ID, PROP_ID)
	_add_character(true)
	for i in 20:
		manager.clock_msec = i * 50
		manager._wired_unhandled_input(_lmb_press())
	_check(manager.player.sent_actions.size() == 4, "fire rate must stay at 4/s")


func test_missing_weapon_disables_fire() -> void:
	var manager := _new_manager(true)
	manager.player = _stub_player()
	var weapon := _add_weapon(manager.player)
	_install_services()
	manager.set_active(TOOL_ID, PROP_ID)
	manager.player.components.clear()
	manager._on_use_tool(2, {"tool": TOOL_ID, "prop": PROP_ID})
	_check(weapon.primary_calls == 0, "unknown weapon must not be invoked")


func test_valid_action_dispatches_trusted_context() -> void:
	var manager := _new_manager(true)
	manager.player = _stub_player()
	var weapon := _add_weapon(manager.player)
	_install_services()
	manager.set_active(TOOL_ID, PROP_ID)
	_check(manager.active_tool_id == TOOL_ID, "a registered weapon must become active")
	_check(weapon.equip_calls == 1, "set_active must equip the weapon on the server")
	var hit := {"position": Vector3(1, 1, 1), "normal": Vector3(0, 1, 0)}
	manager.raycast_hit = hit
	manager._on_use_tool(
		2, {"tool": TOOL_ID, "prop": PROP_ID, "hit": Vector3(99, 99, 99)}
	)
	_check(weapon.primary_calls == 1, "valid action must call wired_primary")
	_check(
		weapon.last_ctx["hit"] == hit,
		"client hit must never be used as the authoritative hit",
	)
	manager.raycast_hit = {}
	manager._on_use_tool(2, {"tool": TOOL_ID, "prop": PROP_ID})
	_check(weapon.primary_calls == 1, "no server hit means no use")
	manager.raycast_hit = hit
	_check(
		str(weapon.last_ctx.get("selected_prop", "")) == PROP_ID,
		"the trusted context must carry the selected prop",
	)
	_check(
		str(weapon.last_ctx.get("payload", {}).get("tool", "")) == TOOL_ID,
		"the trusted context must carry the original payload",
	)
	manager._on_use_tool(3, {"tool": TOOL_ID, "prop": PROP_ID})
	manager._on_use_tool(2, {"tool": "pkg.crate/unknown", "prop": PROP_ID})
	manager._on_use_tool(2, {"tool": TOOL_ID, "prop": "pkg.crate/unknown"})
	_check(weapon.primary_calls == 1, "untrusted actions must be rejected")


## Серверная копия менеджера удалённого игрока не получает `set_active`:
## выбор приходит только локальному компоненту, поэтому action обязан
## найти инструмент по `payload.tool` и экипировать его на сервере сам.
func test_action_dispatches_without_local_selection() -> void:
	var manager := _new_manager(true)
	manager.player = _stub_player()
	var weapon := _add_weapon(manager.player)
	_install_services()
	manager.raycast_hit = {"position": Vector3(1, 1, 1), "normal": Vector3(0, 1, 0)}
	_check(
		manager.active_tool_id.is_empty(),
		"the server manager must start without a locally selected tool",
	)
	manager._on_use_tool(2, {"tool": TOOL_ID, "prop": PROP_ID})
	_check(
		weapon.primary_calls == 1,
		"a valid action must dispatch without a local set_active",
	)
	_check(weapon.equip_calls == 1, "the server must equip the weapon before use")


func test_client_authoritative_prop_is_rejected() -> void:
	var manager := _new_manager(true)
	manager.player = _stub_player()
	var weapon := _add_weapon(manager.player)
	_install_services()
	manager.set_active(TOOL_ID, PROP_ID)
	manager.raycast_hit = {"position": Vector3(1, 1, 1), "normal": Vector3(0, 1, 0)}
	manager._on_use_tool(2, {"tool": TOOL_ID, "prop": "pkg.crate/local_crate"})
	_check(
		weapon.primary_calls == 0,
		"a prop without server authority must not be used",
	)


func test_spawn_prop_uses_dynamic_world() -> void:
	var manager := _new_manager(true)
	manager.player = _stub_player()
	var world := _install_services()
	var spawned := manager.spawn_prop(PROP_ID, Vector3(1, 2, 3))
	_check(spawned != null, "spawn_prop must return the spawned node")
	if spawned != null:
		spawned.free()
	_check(world.calls.size() == 1, "spawn_prop must call spawn_entity exactly once")
	if world.calls.size() == 1:
		_check(
			str(world.calls[0]["type"]) == PROP_ID
				and str(world.calls[0]["data"].get("position", "")) == str(Vector3(1, 2, 3))
				and int(world.calls[0]["data"].get("owner_player_id", 0)) == 2,
			"spawn_prop must pass the qualified type, position and owner peer",
		)


func _new_manager(server_authority: bool) -> StubManager:
	var manager := StubManager.new()
	manager.package_id = PACKAGE_ID
	manager.authority_mode = "server" if server_authority else "local"
	root.add_child(manager)
	_owned.append(manager)
	return manager


func _stub_player() -> StubPlayer:
	var player := StubPlayer.new()
	player.peer_id = 2
	_owned.append(player)
	return player


func _add_weapon(player: WiredPlayer) -> StubWeapon:
	var weapon := StubWeapon.new()
	weapon.package_id = PACKAGE_ID
	weapon.tool_id = "spawner"
	weapon.requires_prop = true
	weapon.add_to_group("cura_hand_weapon")
	player.components.append(weapon)
	root.add_child(weapon)
	_owned.append(weapon)
	return weapon


func _add_character(captured: bool) -> StubCharacter:
	if _character != null and is_instance_valid(_character):
		_character.free()
	var character := StubCharacter.new()
	character.captured = captured
	character.add_to_group("cura_player_character")
	root.add_child(character)
	_character = character
	_owned.append(character)
	return character


func _install_services() -> StubDynamicWorld:
	var global_node := root.get_node("Global")
	if _previous_registry == null:
		_previous_registry = global_node.get("package_registry")
		var registration := WiredPackageRegistration.new()
		registration.package_id = PACKAGE_ID
		registration.add_custom("cura.tool", "spawner", {"label": "Toolgun"})
		registration.add_custom("cura.prop", "crate", {"label": "Crate"})
		registration.add_dynamic_entity(
			"crate", "dynamic/crate.tscn", {"authority": "server"}
		)
		registration.add_custom("cura.prop", "local_crate", {"label": "Local crate"})
		registration.add_dynamic_entity(
			"local_crate", "dynamic/local_crate.tscn", {"authority": "local"}
		)
		var registry := WiredPackageRegistry.new()
		registry.add_registration(registration)
		global_node.set("package_registry", registry)
		_owned.append(registry)
	var world := StubDynamicWorld.new()
	_previous_world = global_node.get("dynamic_world")
	global_node.set("dynamic_world", world)
	root.add_child(world)
	_owned.append(world)
	return world


func _restore_services() -> void:
	var global_node := root.get_node("Global")
	if _previous_registry != null:
		global_node.set("package_registry", _previous_registry)
	if _previous_world != null:
		global_node.set("dynamic_world", _previous_world)


func _lmb_press() -> InputEventMouseButton:
	var event := InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = true
	return event


func _example_path(relative_path: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return (
		project_dir
		.path_join(EXAMPLE_DIR)
		.path_join("tools")
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
		print("CURA_TOOL_MANAGER_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("CURA_TOOL_MANAGER_SMOKE_FAILED %s" % message)
	quit(1)
