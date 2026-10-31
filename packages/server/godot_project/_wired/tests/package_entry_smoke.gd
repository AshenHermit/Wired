extends SceneTree

## Headless smoke test for PackageEntryLoader and the reloader ownership rule.
##
## A package entry is the root `wired_package.gd` of an applied revision. The
## loader turns its registration into registry descriptors; a package without an
## entry is valid and must simply return false.
##
## The same suite proves that `PackageReloader` never collects roots owned by
## `StaticWorldContainer` (`_wired_registered = true`), including nested package
## roots inside them.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/package_entry_smoke.gd --quit-after 2

const FIXTURE_ROOT := "res://tests/fixtures/package_root"
const EMPTY_ROOT := "user://wired/package_entry_empty"
const PACKAGE_ID := "pkg.test"

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	# Deferred so tree traversal in the reloader check sees the live tree.
	_run.call_deferred()


func _run() -> void:
	_test_entry_registers_static_scene()
	_test_missing_entry_returns_false()
	_test_reloader_skips_registered_roots()
	_finish()


func _test_entry_registers_static_scene() -> void:
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ROOT
	context.revision = 1

	var ok := PackageEntryLoader.load_entry(PACKAGE_ID, 1, context, registry)
	_check(ok, "a package entry must load and register")

	var scenes := registry.get_static_scenes()
	_check(
		scenes.size() == 1,
		"the entry must register exactly one static scene, got %d" % scenes.size(),
	)
	if scenes.size() == 1:
		_check(
			scenes[0]["path"] == "static.tscn",
			"the static scene path must stay package-relative, got %s" % scenes[0]["path"],
		)
		_check(
			int(scenes[0]["order"]) == 10,
			"the static scene order must come from the registration, got %s"
			% scenes[0]["order"],
		)
		_check(
			str(scenes[0]["package_id"]) == PACKAGE_ID,
			"the registry must stamp the package id, got %s"
			% scenes[0]["package_id"],
		)
	_check(
		registry.get_context(PACKAGE_ID) == context,
		"the loader must store the applied revision context",
	)
	registry.free()


func _test_missing_entry_returns_false() -> void:
	DirAccess.make_dir_recursive_absolute(EMPTY_ROOT)
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = EMPTY_ROOT
	context.revision = 1

	var ok := PackageEntryLoader.load_entry(PACKAGE_ID, 1, context, registry)
	_check(not ok, "a package without an entry script must return false")
	_check(
		registry.get_static_scenes().is_empty(),
		"a package without an entry script must not register content",
	)
	_check(
		registry.get_context(PACKAGE_ID) == null,
		"a package without an entry script must not store a context",
	)
	registry.free()


func _test_reloader_skips_registered_roots() -> void:
	var scene_root := Node.new()
	scene_root.name = "ReloadCoordTestRoot"
	root.add_child(scene_root)
	var reloader := PackageReloader.new()
	scene_root.add_child(reloader)

	var plain := Node.new()
	plain.name = "PlainPackageRoot"
	plain.set_meta("_wired_package_id", 5)
	scene_root.add_child(plain)

	var registered := Node.new()
	registered.name = "RegisteredStaticRoot"
	registered.set_meta("_wired_package_id", 5)
	registered.set_meta("_wired_registered", true)
	scene_root.add_child(registered)

	var nested := Node.new()
	nested.name = "NestedPackageRoot"
	nested.set_meta("_wired_package_id", 6)
	registered.add_child(nested)

	var roots: Array[Node] = reloader._collect_roots()
	_check(
		roots.has(plain),
		"a package root not owned by the registry must stay reloadable",
	)
	_check(
		not roots.has(registered),
		"the reloader must skip roots tagged _wired_registered",
	)
	_check(
		not roots.has(nested),
		"the reloader must not descend into registry-owned static content",
	)
	scene_root.free()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if DirAccess.dir_exists_absolute(EMPTY_ROOT):
		DirAccess.remove_absolute(EMPTY_ROOT)
	if _failures.is_empty():
		print("PACKAGE_ENTRY_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("PACKAGE_ENTRY_SMOKE_FAILED %s" % message)
	quit(1)
