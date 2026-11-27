extends SceneTree

## Headless smoke-тест публичного API библиотеки `cura_registry`.
##
## Реальный пакет лежит в `godot_project/examples/cura_registry` вне базового
## проекта `res://`, поэтому тест загружает копию из
## `res://tests/fixtures/cura_registry/api.gd` и отдельно проверяет, что копия
## точно совпадает с оригиналом.
##
## Запуск из корня репозитория:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/cura_registry_api_smoke.gd --quit-after 2

const EXAMPLE_DIR := "../examples/cura_registry"
const FIXTURE_PATH := "res://tests/fixtures/cura_registry/api.gd"
const FIXTURE_ENTRY_PATH := "res://tests/fixtures/cura_registry/library_entry.gd"
const FIXTURE_ENTRY_ROOT := "res://tests/fixtures/cura_registry/library"
const PACKAGE_ID := "pkg.crate"
const REAL_API_PATH := "res://packages/cura_registry/api.gd"

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_fixture_matches_example()
	test_fixture_entry_matches_example()
	test_library_entry_registers_ui_and_server_components()
	test_library_entry_registers_categories_and_tool()
	test_register_prop_writes_both_descriptors()
	test_category_and_tool_entries()
	test_custom_entries_are_qualified_by_registry()
	test_resolve_path_uses_package_context()
	_finish()


## Копия обязана быть байт-в-байт той же, что и API реального пакета: иначе
## тест проверяет не тот код, который получают пользователи библиотеки.
func test_fixture_matches_example() -> void:
	var example_text := FileAccess.get_file_as_string(_example_path("api.gd"))
	var fixture_text := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(FIXTURE_PATH)
	)
	_check(not example_text.is_empty(), "the real example api.gd must exist")
	_check(not fixture_text.is_empty(), "the fixture api.gd must exist")
	_check(
		example_text.replace("\r\n", "\n") == fixture_text.replace("\r\n", "\n"),
		"the fixture must be an exact copy of the example api.gd",
	)


## Entry-фикстура обязана повторять реальный entry, кроме пути к API: иначе
## тест проверяет не тот код, который получают комнаты с библиотекой.
func test_fixture_entry_matches_example() -> void:
	var example_text := FileAccess.get_file_as_string(_example_path("wired_package.gd"))
	var fixture_text := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(FIXTURE_ENTRY_PATH)
	)
	_check(not example_text.is_empty(), "the real example entry must exist")
	_check(not fixture_text.is_empty(), "the fixture library entry must exist")
	if example_text.is_empty() or fixture_text.is_empty():
		return
	var normalized_fixture := fixture_text.replace("\r\n", "\n").replace(
		FIXTURE_PATH, REAL_API_PATH
	)
	_check(
		example_text.replace("\r\n", "\n") == normalized_fixture,
		"the fixture entry must match the example apart from the API path",
	)
	for source: String in [example_text, fixture_text]:
		for line: String in source.split("\n"):
			var stripped := line.strip_edges()
			_check(
				not stripped.begins_with("class_name "),
				"package scripts must not declare class_name",
			)
			_check(
				not stripped.begins_with("@rpc")
					and not stripped.begins_with("rpc(")
					and not stripped.begins_with("rpc_id("),
				"package scripts must not use direct RPC",
			)


## `PackageEntryLoader` грузит entry из фикстурного контекста; проверяем, что
## библиотека регистрирует ровно три компонента игрока в нужном порядке.
func test_library_entry_registers_ui_and_server_components() -> void:
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ENTRY_ROOT
	_check(
		PackageEntryLoader.load_entry(PACKAGE_ID, 1, context, registry),
		"the fixture library entry must load",
	)
	var components := registry.get_player_components()
	_check(components.size() == 3, "panel, manager and spawner must be registered")
	if components.size() != 3:
		registry.free()
		return
	_check(
		components[0]["path"] == "ui/registry_panel.tscn"
			and bool(components[0]["local_only"])
			and str(components[0]["authority"]) == "local",
		"panel must be local-only",
	)
	_check(
		components[1]["path"] == "tools/tool_manager.tscn"
			and str(components[1]["authority"]) == "server",
		"manager must be server-authority",
	)
	_check(str(components[2]["path"]) == "tools/spawner.tscn", "spawner weapon must be registered")
	registry.free()


func test_library_entry_registers_categories_and_tool() -> void:
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ENTRY_ROOT
	if not PackageEntryLoader.load_entry(PACKAGE_ID, 1, context, registry):
		_check(false, "the fixture library entry must load")
		registry.free()
		return
	var categories := registry.get_entries("cura.category")
	var tools := registry.get_entries("cura.tool")
	_check(categories.size() == 2, "props and tools categories must be registered")
	if categories.size() == 2:
		_check(
			str(categories[0]["qualified_id"]) == "pkg.crate/props"
				and str(categories[1]["qualified_id"]) == "pkg.crate/tools",
			"categories must be qualified by the package id",
		)
	_check(
		tools.size() == 1
			and str(tools[0]["qualified_id"]) == "pkg.crate/spawner"
			and str(tools[0]["options"].get("category", "")) == "tools",
		"the built-in spawner tool must be registered in tools",
	)
	registry.free()


func test_register_prop_writes_both_descriptors() -> void:
	var reg := WiredPackageRegistration.new()
	reg.package_id = PACKAGE_ID
	var api := load(FIXTURE_PATH)
	if api == null:
		_check(false, "api.gd must load")
		return
	api.register_prop(reg, "crate", "dynamic/crate.tscn", {
		"category": "props", "label": "Wooden crate", "authority": "server", "persist": true,
	})
	var dynamics: Array[Dictionary] = []
	var props: Array[Dictionary] = []
	for entry: Dictionary in reg._entries:
		if str(entry.get("kind", "")) == "dynamic":
			dynamics.append(entry)
		elif str(entry.get("kind", "")) == "cura.prop":
			props.append(entry)
	_check(dynamics.size() == 1 and props.size() == 1, "prop must register two descriptors")
	if dynamics.size() != 1 or props.size() != 1:
		return
	_check(
		props[0]["id"] == "crate"
			and props[0]["options"]["dynamic_type"] == "crate"
			and props[0]["options"]["category"] == "props"
			and bool(props[0]["options"]["persist"]),
		"prop metadata must flow into the custom entry",
	)
	_check(str(dynamics[0]["path"]) == "dynamic/crate.tscn", "dynamic scene path preserved")
	_check(str(dynamics[0]["authority"]) == "server", "dynamic authority preserved")
	_check(
		bool(dynamics[0]["options"].get("persist", false)),
		"dynamic persist flag preserved",
	)


func test_category_and_tool_entries() -> void:
	var reg := WiredPackageRegistration.new()
	reg.package_id = PACKAGE_ID
	var api := load(FIXTURE_PATH)
	if api == null:
		_check(false, "api.gd must load")
		return
	api.register_category(reg, "props", {"label": "Props", "order": 10})
	api.register_tool(reg, "spawner", {"label": "Toolgun", "category": "tools"})
	var categories: Array[Dictionary] = []
	var tools: Array[Dictionary] = []
	for entry: Dictionary in reg._entries:
		if str(entry.get("kind", "")) == "cura.category":
			categories.append(entry)
		elif str(entry.get("kind", "")) == "cura.tool":
			tools.append(entry)
	_check(
		categories.size() == 1 and tools.size() == 1,
		"category and tool must register one custom entry each",
	)
	if categories.size() != 1 or tools.size() != 1:
		return
	_check(
		str(categories[0]["id"]) == "props"
			and str(categories[0]["options"]["label"]) == "Props"
			and int(categories[0]["order"]) == 10,
		"category id and options must be preserved",
	)
	_check(
		str(tools[0]["id"]) == "spawner"
			and str(tools[0]["options"]["label"]) == "Toolgun"
			and str(tools[0]["options"]["category"]) == "tools",
		"tool id and options must be preserved",
	)


## Публичные дескрипторы проходят через реестр ядра: локальный id должен
## получить префикс `<package_id>/`, а `kind` — исчезнуть из дескриптора.
func test_custom_entries_are_qualified_by_registry() -> void:
	var registry := WiredPackageRegistry.new()
	var reg := WiredPackageRegistration.new()
	reg.package_id = PACKAGE_ID
	var api := load(FIXTURE_PATH)
	if api == null:
		_check(false, "api.gd must load")
		registry.free()
		return
	api.register_prop(reg, "crate", "dynamic/crate.tscn", {"category": "props"})
	api.register_tool(reg, "spawner", {"label": "Toolgun"})
	registry.add_registration(reg)
	var props := registry.get_entries("cura.prop")
	_check(props.size() == 1, "registry must expose the prop custom entry")
	if props.size() == 1:
		_check(
			str(props[0].get("qualified_id", "")) == "pkg.crate/crate"
				and not props[0].has("kind"),
			"registry must qualify the prop id and strip its kind",
		)
	var tool := registry.find_entry("cura.tool", "pkg.crate/spawner")
	_check(not tool.is_empty(), "find_entry must resolve the qualified tool id")
	registry.free()


func test_resolve_path_uses_package_context() -> void:
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = "res://tests/fixtures/cura_registry"
	registry.register_context(PACKAGE_ID, context)
	var global_node := root.get_node_or_null("Global")
	_check(global_node != null, "the Global autoload must exist")
	if global_node == null:
		registry.free()
		return
	var previous: Variant = global_node.get("package_registry")
	global_node.set("package_registry", registry)
	var api := load(FIXTURE_PATH)
	var resolved := ""
	if api != null:
		resolved = str(api.resolve_path(PACKAGE_ID, "dynamic/crate.tscn"))
		_check(
			str(api.resolve_path("pkg.unknown", "dynamic/crate.tscn")) == "",
			"unknown package must resolve to an empty path",
		)
	global_node.set("package_registry", previous)
	_check(
		resolved == context.scene_path("dynamic/crate.tscn"),
		"resolve_path must use the applied package context",
	)
	registry.free()


func _example_path(relative_path: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return (
		project_dir
		.path_join(EXAMPLE_DIR)
		.path_join(relative_path)
		.simplify_path()
	)


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("CURA_REGISTRY_API_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("CURA_REGISTRY_API_SMOKE_FAILED %s" % message)
	quit(1)
