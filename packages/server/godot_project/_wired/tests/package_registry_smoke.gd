extends SceneTree

## Headless smoke test for the package registry primitives.
##
## `WiredPackageRegistry` is pure data: it collects package registrations and
## contexts and exposes deterministic, qualified descriptors for the static
## world, player components and dynamic entities. No network or scene tree is
## involved, so the whole suite runs synchronously.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/package_registry_smoke.gd --quit-after 2

var _failures: PackedStringArray = []
var _checks := 0


## Stands in for PackagesManager so the context can be tested without network
## or files on disk. The numeric parameter types are part of the contract: the
## registry works with string ids, the manager with the backend's integer ids.
class StubPackages extends PackagesManager:
	var runtime_calls: Array = []
	var instantiate_calls: Array = []

	func runtime_path(
		package_id: int, revision: int, filepath: String, artifact_key: String = ""
	) -> String:
		runtime_calls.append(
			{
				"package_id": package_id,
				"revision": revision,
				"path": filepath,
				"artifact_key": artifact_key,
			}
		)
		return "stub://%d/%d/%s" % [package_id, revision, filepath]

	func instantiate_scene(package_id: int, scene_path: String, revision: int = 0) -> Node:
		instantiate_calls.append(
			{"package_id": package_id, "path": scene_path, "revision": revision}
		)
		var node := Node.new()
		node.name = "StubScene"
		return node


func _initialize() -> void:
	_test_registry_orders_and_qualifies()
	_test_registration_index_breaks_ties()
	_test_clear_package()
	_test_dynamic_entities()
	_test_static_scenes()
	_test_main_scenes()
	_test_context_paths()
	_test_context_with_packages()
	_finish()


func _test_registry_orders_and_qualifies() -> void:
	var registry := WiredPackageRegistry.new()
	var ctx_b := WiredPackageContext.new()
	ctx_b.package_id = "pkg.b"
	registry.register_context("pkg.b", ctx_b)
	var b := WiredPackageRegistration.new()
	b.package_id = "pkg.b"
	b.add_player_component("player/body.tscn", {"order": 20, "authority": "server"})
	registry.add_registration(b)
	var a := WiredPackageRegistration.new()
	a.package_id = "pkg.a"
	a.add_player_component(
		"player/camera.tscn", {"order": 10, "authority": "local", "local_only": true}
	)
	a.add_player_component("player/body.tscn", {"order": 5, "authority": "server"})
	registry.add_registration(a)

	var components := registry.get_player_components()
	_check(
		components.size() == 3,
		"three player components must be registered, got %d" % components.size(),
	)
	if components.size() == 3:
		_check(
			components[0]["package_id"] == "pkg.a",
			"the first component must come from pkg.a, got %s" % components[0]["package_id"],
		)
		_check(
			components[0]["path"] == "player/body.tscn",
			"order must sort inside a package, got %s" % components[0]["path"],
		)
		_check(
			components[1]["path"] == "player/camera.tscn",
			"the second pkg.a component must be the camera, got %s" % components[1]["path"],
		)
		_check(
			components[1]["authority"] == "local" and components[1]["local_only"],
			"authority and local_only must be exposed on the descriptor",
		)
		_check(
			components[2]["package_id"] == "pkg.b",
			"the last component must come from pkg.b, got %s" % components[2]["package_id"],
		)
		_check(
			components[0].get("options", {}).get("order", -1) == 5,
			"the options dictionary must be preserved on the descriptor",
		)
	_check(
		registry.get_context("pkg.b") == ctx_b,
		"the registered context must be returned by package id",
	)
	_check(
		registry.get_context("pkg.missing") == null,
		"an unknown package must not have a context",
	)
	_check(
		registry.resolve_action("pkg.a", "fire") == "pkg.a/fire",
		"action names must be qualified with the package id",
	)
	_check(
		registry.resolve_action("pkg.b", "jump") == "pkg.b/jump",
		"every package must qualify its own actions",
	)
	registry.free()


func _test_registration_index_breaks_ties() -> void:
	var registry := WiredPackageRegistry.new()
	var registration := WiredPackageRegistration.new()
	registration.package_id = "pkg.a"
	registration.add_player_component("player/first.tscn", {"order": 7})
	registration.add_player_component("player/second.tscn", {"order": 7})
	registry.add_registration(registration)

	var components := registry.get_player_components()
	_check(
		components.size() == 2,
		"two tied components must be registered, got %d" % components.size(),
	)
	if components.size() == 2:
		_check(
			components[0]["path"] == "player/first.tscn",
			"equal order must keep the registration index order, got %s" % components[0]["path"],
		)
		_check(
			int(components[0]["registration_index"]) == 0
			and int(components[1]["registration_index"]) == 1,
			"registration_index must count entries inside the registration",
		)
	registry.free()


func _test_clear_package() -> void:
	var registry := WiredPackageRegistry.new()
	var ctx_a := WiredPackageContext.new()
	ctx_a.package_id = "pkg.a"
	var ctx_b := WiredPackageContext.new()
	ctx_b.package_id = "pkg.b"
	registry.register_context("pkg.a", ctx_a)
	registry.register_context("pkg.b", ctx_b)
	for package_id: String in ["pkg.a", "pkg.b"]:
		var registration := WiredPackageRegistration.new()
		registration.package_id = package_id
		registration.add_player_component("%s/body.tscn" % package_id, {"order": 1})
		registry.add_registration(registration)

	registry.clear_package("pkg.a")
	var components := registry.get_player_components()
	_check(
		components.size() == 1,
		"clearing one package must keep the other, got %d entries" % components.size(),
	)
	if components.size() == 1:
		_check(
			components[0]["package_id"] == "pkg.b",
			"only pkg.b must survive clear_package, got %s" % components[0]["package_id"],
		)
	_check(registry.get_context("pkg.a") == null, "clear_package must drop the package context")
	_check(registry.get_context("pkg.b") == ctx_b, "clear_package must keep other contexts")
	registry.free()


func _test_dynamic_entities() -> void:
	var registry := WiredPackageRegistry.new()
	var registration := WiredPackageRegistration.new()
	registration.package_id = "pkg.a"
	registration.add_dynamic_entity(
		"crate", "dynamic/crate.tscn", {"authority": "server", "persist": true}
	)
	registry.add_registration(registration)

	var entities := registry.get_dynamic_entities()
	_check(
		entities.size() == 1,
		"one dynamic entity must be registered, got %d" % entities.size(),
	)
	if entities.size() == 1:
		var entity := entities[0]
		_check(entity["package_id"] == "pkg.a", "a dynamic entity must keep its package id")
		_check(entity["local_type"] == "crate", "a dynamic entity must keep its local type")
		_check(
			entity["qualified_type"] == "pkg.a/crate",
			"a dynamic type must be qualified with the package id",
		)
		_check(
			entity["path"] == "dynamic/crate.tscn",
			"a dynamic entity must keep its relative path",
		)
		_check(int(entity["order"]) == 0, "an omitted order must default to 0")
		_check(entity["authority"] == "server", "authority must default to server")
		_check(entity["local_only"] == false, "local_only must default to false")
		_check(
			entity.get("options", {}).get("persist", false) == true,
			"dynamic options must be preserved",
		)
	_check(
		registry.find_dynamic_entity("pkg.a/crate")["qualified_type"] == "pkg.a/crate",
		"find_dynamic_entity must resolve a qualified type",
	)
	_check(
		registry.find_dynamic_entity("pkg.a/missing").is_empty(),
		"an unknown qualified type must resolve to an empty descriptor",
	)
	_check(
		registry.get_player_components().is_empty()
		and registry.get_static_scenes().is_empty(),
		"a dynamic entity must not leak into other descriptor lists",
	)
	registry.free()


func _test_static_scenes() -> void:
	var registry := WiredPackageRegistry.new()
	var registration := WiredPackageRegistration.new()
	registration.package_id = "pkg.a"
	registration.add_static_scene("static/b.tscn", {"order": 2})
	registration.add_static_scene("static/a.tscn", {"order": 1})
	registration.add_static_scene("static/default.tscn")
	registry.add_registration(registration)

	var scenes := registry.get_static_scenes()
	_check(scenes.size() == 3, "three static scenes must be registered, got %d" % scenes.size())
	if scenes.size() == 3:
		_check(scenes[0]["path"] == "static/default.tscn", "order must sort static scenes")
		_check(scenes[1]["path"] == "static/a.tscn", "order must sort static scenes")
		_check(scenes[2]["path"] == "static/b.tscn", "order must sort static scenes")
		_check(int(scenes[0]["order"]) == 0, "an omitted static order must default to 0")
		_check(
			scenes[0].get("options", {}).is_empty(),
			"an omitted static options dictionary must stay empty",
		)
	_check(
		registry.get_player_components().is_empty()
		and registry.get_dynamic_entities().is_empty(),
		"a static scene must not leak into other descriptor lists",
	)
	registry.free()


func _test_main_scenes() -> void:
	var registry := WiredPackageRegistry.new()
	_check(
		registry.get_main_scene().is_empty(),
		"a registry without main scenes must return an empty descriptor",
	)
	_check(
		registry.get_main_scenes().is_empty(),
		"a registry without main scenes must return an empty list",
	)

	var b := WiredPackageRegistration.new()
	b.package_id = "pkg.b"
	b.add_main_scene("game/b.tscn", {"order": 20})
	registry.add_registration(b)

	var a := WiredPackageRegistration.new()
	a.package_id = "pkg.a"
	a.add_main_scene("game/first.tscn", {"order": 10})
	a.add_main_scene("game/second.tscn", {"order": 10})
	registry.add_registration(a)

	var scenes := registry.get_main_scenes()
	_check(scenes.size() == 3, "three main scenes must be registered, got %d" % scenes.size())
	if scenes.size() == 3:
		_check(
			scenes[0]["package_id"] == "pkg.a"
			and scenes[0]["path"] == "game/first.tscn",
			"the first main scene must be pkg.a/first.tscn, got %s/%s"
			% [scenes[0]["package_id"], scenes[0]["path"]],
		)
		_check(
			scenes[1]["path"] == "game/second.tscn",
			"equal order must keep the registration index order, got %s" % scenes[1]["path"],
		)
		_check(
			scenes[2]["package_id"] == "pkg.b",
			"the last main scene must be pkg.b, got %s" % scenes[2]["package_id"],
		)
		_check(
			not scenes[0].has("kind"),
			"main descriptors must not expose the internal kind discriminator",
		)
	_check(
		registry.get_main_scene()["path"] == "game/first.tscn",
		"get_main_scene must return the first ordered descriptor",
	)
	_check(
		registry.get_player_components().is_empty()
		and registry.get_static_scenes().is_empty()
		and registry.get_dynamic_entities().is_empty(),
		"a main scene must not leak into other descriptor lists",
	)
	registry.clear_package("pkg.a")
	var remaining := registry.get_main_scenes()
	_check(
		remaining.size() == 1 and remaining[0]["package_id"] == "pkg.b",
		"clear_package must drop only that package's main scenes",
	)
	registry.free()


func _test_context_paths() -> void:
	var context := WiredPackageContext.new()
	context.package_id = "pkg.a"
	context.root_path = "res://tests/fixtures"
	_check(
		context.scene_path("static/scene.tscn")
		== "res://tests/fixtures/static/scene.tscn",
		"without a manager the context must join root_path, got %s"
		% context.scene_path("static/scene.tscn"),
	)
	# The error is expected: this path is the documented failure contract.
	_check(
		context.instantiate("missing.tscn") == null,
		"a missing scene must instantiate to null",
	)


func _test_context_with_packages() -> void:
	var packages := StubPackages.new()
	var context := WiredPackageContext.new()
	context.package_id = "42"
	context.revision = 3
	context.artifact_key = "abcdef"
	context.packages = packages

	var managed_path := context.scene_path("player/body.tscn")
	_check(
		managed_path == "stub://42/3/player/body.tscn",
		"with a manager the context must defer to its runtime path, got %s" % managed_path,
	)
	_check(
		packages.runtime_calls.size() == 1
		and int(packages.runtime_calls[0]["package_id"]) == 42
		and int(packages.runtime_calls[0]["revision"]) == 3
		and str(packages.runtime_calls[0]["artifact_key"]) == "abcdef",
		"the context must pass numeric ids and the pinned revision to the manager",
	)
	var node := context.instantiate("player/body.tscn")
	_check(
		node != null and node.name == "StubScene",
		"with a manager the context must instantiate through it",
	)
	_check(
		packages.instantiate_calls.size() == 1
		and int(packages.instantiate_calls[0]["package_id"]) == 42
		and str(packages.instantiate_calls[0]["path"]) == "player/body.tscn"
		and int(packages.instantiate_calls[0]["revision"]) == 3,
		"the context must ask the manager for the pinned revision",
	)
	if node != null:
		node.free()
	packages.free()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("PACKAGE_REGISTRY_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("PACKAGE_REGISTRY_SMOKE_FAILED %s" % message)
	quit(1)
