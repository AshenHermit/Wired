extends SceneTree

## Headless contract test for the example package entry.
##
## The example package lives in `godot_project/examples/wired-platformer`, which
## is intentionally outside the base `_wired` project (so it is not copied into
## every room's editor). This suite therefore loads a fixture entry with exactly
## the same five registrations and empty `Node` scenes, and asserts the
## declarative contract the example must follow: kinds, relative paths, order,
## authority, local-only flag and dynamic options.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/example_package_contract_smoke.gd --quit-after 2

const FIXTURE_ROOT := "res://tests/fixtures/example_contract"
const PACKAGE_ID := "pkg.example"
const REVISION := 1
const PLATFORM_PATH := "static/platform.tscn"
const BODY_PATH := "player/body.tscn"
const CAMERA_PATH := "player/camera.tscn"
const SPAWNER_PATH := "player/spawner.tscn"
const CRATE_PATH := "dynamic/crate.tscn"

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	test_example_contract_registers_all_kinds()
	_finish()


## The brief's contract shape. A failure before the fixture exists proves the
## suite cannot pass vacuously.
func test_example_contract_registers_all_kinds() -> void:
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ROOT

	var ok := PackageEntryLoader.load_entry(PACKAGE_ID, REVISION, context, registry)
	_check(ok, "the example contract entry must load and register")

	var scenes := registry.get_static_scenes()
	var components := registry.get_player_components()
	var entities := registry.get_dynamic_entities()

	_check(
		scenes.size() == 1,
		"the example must register exactly one static scene, got %d" % scenes.size(),
	)
	_check(
		components.size() == 3,
		"the example must register exactly three player components, got %d"
		% components.size(),
	)
	_check(
		entities.size() == 1,
		"the example must register exactly one dynamic entity, got %d"
		% entities.size(),
	)

	if scenes.size() == 1:
		_check(
			str(scenes[0]["path"]) == PLATFORM_PATH,
			"the static scene must be %s, got %s" % [PLATFORM_PATH, scenes[0]["path"]],
		)
		_check(
			int(scenes[0]["order"]) == 10,
			"the platform order must be 10, got %s" % scenes[0]["order"],
		)
		_check(
			str(scenes[0]["authority"]) == "server",
			"static scenes default to server authority, got %s"
			% scenes[0]["authority"],
		)

	# Registration order is deterministic: body 10, camera 20, spawner 30.
	var expected_paths := [BODY_PATH, CAMERA_PATH, SPAWNER_PATH]
	var expected_orders := [10, 20, 30]
	var expected_authority := ["server", "local", "server"]
	var expected_local_only := [false, true, false]
	for index in mini(components.size(), expected_paths.size()):
		var descriptor := components[index]
		_check(
			str(descriptor["path"]) == expected_paths[index],
			"player component %d must be %s, got %s"
			% [index, expected_paths[index], descriptor["path"]],
		)
		_check(
			int(descriptor["order"]) == expected_orders[index],
			"player component %s order must be %d, got %s"
			% [descriptor["path"], expected_orders[index], descriptor["order"]],
		)
		_check(
			str(descriptor["authority"]) == expected_authority[index],
			"player component %s authority must be %s, got %s"
			% [
				descriptor["path"],
				expected_authority[index],
				descriptor["authority"],
			],
		)
		_check(
			bool(descriptor["local_only"]) == expected_local_only[index],
			"player component %s local_only must be %s, got %s"
			% [
				descriptor["path"],
				expected_local_only[index],
				descriptor["local_only"],
			],
		)

	if entities.size() == 1:
		var crate := entities[0]
		_check(
			str(crate["local_type"]) == "crate",
			"the dynamic type must be the local name crate, got %s"
			% crate.get("local_type", ""),
		)
		_check(
			str(crate["qualified_type"]) == "%s/crate" % PACKAGE_ID,
			"the registry must qualify the crate type, got %s"
			% crate.get("qualified_type", ""),
		)
		_check(
			str(crate["path"]) == CRATE_PATH,
			"the crate scene must be %s, got %s" % [CRATE_PATH, crate["path"]],
		)
		_check(
			str(crate["authority"]) == "server",
			"the crate authority must be server, got %s" % crate["authority"],
		)
		_check(
			bool(crate["options"].get("persist", false)),
			"the crate must persist",
		)
		_check(
			int(crate["options"].get("limit_per_player", 0)) == 8,
			"the crate limit must be 8 per player, got %s"
			% crate["options"].get("limit_per_player", 0),
		)

	_check(
		registry.get_context(PACKAGE_ID) == context,
		"the loader must store the applied revision context",
	)
	registry.free()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("EXAMPLE_PACKAGE_CONTRACT_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("EXAMPLE_PACKAGE_CONTRACT_SMOKE_FAILED %s" % message)
	quit(1)
