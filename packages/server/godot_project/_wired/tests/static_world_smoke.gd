extends SceneTree

## Headless smoke test for the static world container.
##
## `StaticWorldContainer` is the local-only owner of package static scenes: it
## instantiates them from the registry, tags every root so the package reloader
## leaves them alone, and exposes the player spawn markers of those scenes.
##
## The fixture scene intentionally nests its markers under a plain child to
## prove that markers are collected recursively.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/static_world_smoke.gd --quit-after 2

const FIXTURE_ROOT := "res://tests/fixtures/static_root"
const PACKAGE_ID := "pkg.test"
const STATIC_SCENE := "static.tscn"
## Runtime package ids are numeric on the wire; a package removal is addressed by
## that id, so the rebuild-after-forget check uses one too.
const FORGOTTEN_PACKAGE_ID := "42"

var _failures: PackedStringArray = []
var _checks := 0
var _worlds: Array[Node] = []
var _registries: Array[Node] = []


func _initialize() -> void:
	# Deferred so the tree is running before markers resolve global transforms.
	_run.call_deferred()


func _run() -> void:
	_test_rebuild_instantiates_registered_static_scenes()
	_test_staged_rebuild_keeps_old_world_until_commit()
	_test_rebuild_does_not_duplicate_scenes()
	_test_clear_removes_only_registered_children()
	_test_rebuild_removes_scenes_of_a_forgotten_package()
	_test_spawn_markers_are_collected_recursively()
	_test_missing_context_is_skipped()
	_free_worlds()
	_finish()


func _test_rebuild_instantiates_registered_static_scenes() -> void:
	var world := _make_world(_make_registry())
	world.rebuild()

	_check(
		world.get_child_count() == 1,
		"rebuild must add one scene per static registration, got %d children"
		% world.get_child_count(),
	)
	if world.get_child_count() != 1:
		return
	var instance := world.get_child(0)
	_check(
		str(instance.get_meta("_wired_package_id", "")) == PACKAGE_ID,
		"a static root must be tagged with its package id",
	)
	_check(
		instance.get_meta("_wired_registered", false) == true,
		"a static root must be tagged as registry-owned",
	)
	_check(
		world.get_spawn_position_2d(0) == Vector2(48, 96),
		"the first spawn marker must be at (48, 96), got %s"
		% world.get_spawn_position_2d(0),
	)


func _test_staged_rebuild_keeps_old_world_until_commit() -> void:
	var world := _make_world(_make_registry())
	world.rebuild()
	var old_instance := world.get_child(0)
	var prepared: Dictionary = world.prepare_rebuild()
	_check(
		prepared.get("ok", false),
		"staged rebuild must prepare a replacement set",
	)
	_check(
		world.get_child(0) == old_instance,
		"staged rebuild must keep the old world active before commit",
	)
	_check(
		world.commit_prepared(prepared),
		"staged rebuild must commit a prepared replacement",
	)
	_check(
		world.get_child_count() == 1 and world.get_child(0) != old_instance,
		"commit must replace the old world without duplication",
	)
	world.free()


func _test_rebuild_does_not_duplicate_scenes() -> void:
	var world := _make_world(_make_registry())
	world.rebuild()
	world.rebuild()

	_check(
		world.get_child_count() == 1,
		"a second rebuild must replace, not duplicate, registered scenes; got %d children"
		% world.get_child_count(),
	)


func _test_clear_removes_only_registered_children() -> void:
	var world := _make_world(_make_registry())
	world.rebuild()
	var manual := Node.new()
	manual.name = "Manual"
	world.add_child(manual)

	world.clear()

	_check(
		world.get_child_count() == 1,
		"clear must remove only registered children, got %d children"
		% world.get_child_count(),
	)
	_check(
		world.get_child_count() == 1 and world.get_child(0) == manual,
		"clear must keep unregistered children",
	)
	_check(
		world.get_spawn_position_2d(0) == Vector2.ZERO,
		"cleared static scenes must not expose spawn markers",
	)


func _test_rebuild_removes_scenes_of_a_forgotten_package() -> void:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var context := WiredPackageContext.new()
	context.package_id = FORGOTTEN_PACKAGE_ID
	context.root_path = FIXTURE_ROOT
	registry.register_context(FORGOTTEN_PACKAGE_ID, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = FORGOTTEN_PACKAGE_ID
	registration.add_static_scene(STATIC_SCENE)
	registry.add_registration(registration)

	var world := _make_world(registry)
	world.rebuild()
	_check(
		world.get_child_count() == 1,
		"the forget check needs one static scene, got %d"
		% world.get_child_count(),
	)
	if world.get_child_count() != 1:
		return

	# A removed package is forgotten in the registry, then the world is rebuilt:
	# its scenes must not survive the reload that no longer registers them.
	registry.clear_package(FORGOTTEN_PACKAGE_ID)
	world.rebuild()
	_check(
		world.get_child_count() == 0,
		"forgotten package scenes disappear, got %d children"
		% world.get_child_count(),
	)


func _test_spawn_markers_are_collected_recursively() -> void:
	var world := _make_world(_make_registry())
	world.rebuild()

	_check(
		world.get_spawn_position_3d(1) == Vector3(1, 2, 3),
		"a nested Marker3D with wired_player_spawn meta must be found, got %s"
		% world.get_spawn_position_3d(1),
	)
	_check(
		world.get_spawn_position_2d(1) == Vector2(1, 2),
		"a Marker3D must project to (x, y) in 2D, got %s"
		% world.get_spawn_position_2d(1),
	)
	_check(
		world.get_spawn_position_3d(0) == Vector3(48, 96, 0),
		"a Marker2D must lift to (x, y, 0) in 3D, got %s"
		% world.get_spawn_position_3d(0),
	)
	_check(
		world.get_spawn_position_2d(2) == Vector2.ZERO,
		"markers without the group or meta must be ignored",
	)
	_check(
		world.get_spawn_position_2d(99) == Vector2.ZERO,
		"an out-of-range 2D spawn index must return Vector2.ZERO",
	)
	_check(
		world.get_spawn_position_3d(99) == Vector3.ZERO,
		"an out-of-range 3D spawn index must return Vector3.ZERO",
	)


func _test_missing_context_is_skipped() -> void:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var registration := WiredPackageRegistration.new()
	registration.package_id = PACKAGE_ID
	registration.add_static_scene(STATIC_SCENE)
	registry.add_registration(registration)

	var world := _make_world(registry)
	world.rebuild()

	_check(
		world.get_child_count() == 0,
		"a registration without a context must be skipped, got %d children"
		% world.get_child_count(),
	)


# --- helpers --------------------------------------------------------------


## Builds a registry with one context and one static registration, matching the
## package lifecycle that Task 4 will drive in the real runtime.
func _make_registry() -> WiredPackageRegistry:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ROOT
	registry.register_context(PACKAGE_ID, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = PACKAGE_ID
	registration.add_static_scene(STATIC_SCENE)
	registry.add_registration(registration)
	return registry


## The container needs a tree so marker transforms and groups resolve.
func _make_world(registry: WiredPackageRegistry) -> StaticWorldContainer:
	var world := StaticWorldContainer.new()
	world.setup(registry)
	root.add_child(world)
	_worlds.append(world)
	return world


func _free_worlds() -> void:
	for world: Node in _worlds:
		world.free()
	_worlds.clear()
	for registry: Node in _registries:
		registry.free()
	_registries.clear()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("STATIC_WORLD_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("STATIC_WORLD_SMOKE_FAILED %s" % message)
	quit(1)
