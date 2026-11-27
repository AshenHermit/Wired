extends SceneTree

## Headless smoke-тест демо-пакета `crate_prop_example`.
##
## Проверяет, что сторонний пакет может вызвать публичный API `cura_registry`
## из своего `wired_package.gd` и зарегистрировать спавнимый проп. Реальный пакет
## лежит вне базового проекта `res://`, поэтому entry грузится из фикстуры,
## отличающейся от оригинала только путём загрузки `api.gd`: smoke-тест не может
## разрешить `res://packages/cura_registry/api.gd`.
##
## Запуск из корня репозитория:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/cura_prop_example_smoke.gd --quit-after 2

const EXAMPLE_DIR := "../examples/crate_prop_example"
const FIXTURE_ROOT := "res://tests/fixtures/cura_registry"
const PACKAGE_ID := "pkg.crate"
const REVISION := 1
const CRATE_PATH := "dynamic/crate.tscn"
const CRATE_ID := "crate"
const CATEGORY_ID := "props"
const REAL_API_PATH := "res://packages/cura_registry/api.gd"
const FIXTURE_API_PATH := "res://tests/fixtures/cura_registry/api.gd"

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_fixture_matches_example()
	test_example_registers_cross_package_prop()
	test_example_crate_scene_contract()
	_finish()


## Фикстура обязана повторять реальный entry дословно, кроме пути к API:
## иначе тест проверяет не тот код, который получают пользователи пакета.
func test_fixture_matches_example() -> void:
	var example_text := FileAccess.get_file_as_string(
		_example_path("wired_package.gd")
	)
	var fixture_text := FileAccess.get_file_as_string(
		ProjectSettings.globalize_path(_fixture_entry_path())
	)
	_check(not example_text.is_empty(), "the real example entry must exist")
	_check(not fixture_text.is_empty(), "the fixture crate entry must exist")
	var normalized_fixture := fixture_text.replace("\r\n", "\n").replace(
		FIXTURE_API_PATH, REAL_API_PATH
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
	_check(
		example_text.contains('preload("%s")' % REAL_API_PATH),
		"the real entry must preload the published cura_registry api",
	)


func test_example_registers_cross_package_prop() -> void:
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = "pkg.crate"
	context.root_path = _fixture_root()
	_check(PackageEntryLoader.load_entry("pkg.crate", 1, context, registry), "entry must load")
	var entities := registry.get_dynamic_entities()
	var props := registry.get_entries("cura.prop")
	_check(entities.size() == 1 and props.size() == 1, "crate must be registered twice")
	if entities.size() != 1 or props.size() != 1:
		registry.free()
		return
	_check(
		entities[0]["qualified_type"] == "pkg.crate/crate"
			and props[0]["qualified_id"] == "pkg.crate/crate",
		"both descriptors must share the qualified id",
	)
	_check(
		str(entities[0]["path"]) == CRATE_PATH
			and str(entities[0]["authority"]) == "server",
		"the dynamic descriptor must point at the crate scene on the server",
	)
	_check(
		str(props[0]["options"].get("dynamic_type", "")) == CRATE_ID
			and str(props[0]["options"].get("category", "")) == CATEGORY_ID,
		"the prop metadata must reference its category and dynamic type",
	)
	var categories := registry.get_entries("cura.category")
	_check(
		categories.size() == 1
			and str(categories[0]["qualified_id"]) == "pkg.crate/%s" % CATEGORY_ID,
		"the entry must register the prop category under the package namespace",
	)
	_check(
		registry.get_context("pkg.crate") == context,
		"the loader must store the applied package context",
	)
	registry.free()


## Проп спавнится сервером через `WiredDynamicEntity`, поэтому корень сцены
## должен быть RigidBody3D с массой 1, box-коллайдером и кубом.
func test_example_crate_scene_contract() -> void:
	var path := _example_path(CRATE_PATH)
	var packed := load(path) as PackedScene
	_check(packed != null, "the example crate scene must load from %s" % path)
	if packed == null:
		return
	var instance := packed.instantiate()
	if instance == null:
		_check(false, "the example crate scene must instantiate")
		return
	_check(instance is WiredDynamicEntity, "the crate root must extend WiredDynamicEntity")
	_check(instance is RigidBody3D, "the crate root must be a RigidBody3D")
	var body := instance as RigidBody3D
	if body != null:
		_check(
			is_equal_approx(body.mass, 1.0),
			"the crate mass must be 1, got %s" % body.mass,
		)
	var collision := instance.get_node_or_null("Collision") as CollisionShape3D
	_check(collision != null, "the crate must have a CollisionShape3D named Collision")
	if collision != null:
		_check(collision.shape is BoxShape3D, "the crate collision must be a BoxShape3D")
	var mesh := instance.get_node_or_null("Mesh") as MeshInstance3D
	_check(mesh != null, "the crate must have a MeshInstance3D named Mesh")
	if mesh != null:
		_check(mesh.mesh is BoxMesh, "the crate mesh must be a BoxMesh")
	instance.free()


func _fixture_root() -> String:
	return FIXTURE_ROOT


func _fixture_entry_path() -> String:
	return _fixture_root().path_join("crate_entry.gd")


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
		print("CURA_PROP_EXAMPLE_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("CURA_PROP_EXAMPLE_SMOKE_FAILED %s" % message)
	quit(1)
