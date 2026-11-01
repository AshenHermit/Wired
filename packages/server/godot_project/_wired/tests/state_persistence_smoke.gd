extends SceneTree

## Headless smoke test for the main-scene save/load integration.
##
## `main_scene._save_state` writes `players` and `dynamic_world` into
## `state.json`; `_load_state` seeds the dynamic records into the world's parked
## list (they are spawned later, after their package is applied) and hands player
## records to `PlayersManager`. The suite also proves that `main.tscn` reuses its
## authored dynamic spawner instead of adding a second one, that
## `Global.dynamic_world` is typed and registered, and that a parked record
## survives a save/load cycle.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/state_persistence_smoke.gd --quit-after 2

const MAIN_SCENE := "res://_wired/scenes/main.tscn"
const CRATE_TYPE := "pkg.state/crate"
const STATE_DIR := "user://wired_state_persistence_smoke"
## Save/load of a parked record needs a real dynamic type: the numeric package id
## and the fixture are the same ones `dynamic_world_smoke` uses.
const DYNAMIC_FIXTURE_ROOT := "res://tests/fixtures/dynamic_root"
const CRATE_SCENE := "crate.tscn"
const STAMP_PACKAGE_ID := "42"
const STAMP_PACKAGE_NUMBER := 42
const STAMP_CRATE_TYPE := "42/box"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _registries: Array[Node] = []


## Minimal dynamic record source: persistence plumbing does not need a physics
## body or a synchronizer (the dynamic world suite owns that path).
class FakeDynamicEntity extends Node:

	var entity_id := 0
	var type_id := ""
	var owner_player_id := 0

	func _wired_save_state() -> Dictionary:
		return {
			"position": [16.0, 32.0],
			"rotation": 0.0,
			"linear_velocity": [0.0, 0.0],
		}


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_main_scene_uses_the_authored_dynamic_spawner()
	_test_save_and_load_round_trip()
	_test_parked_dynamic_records_are_saved_and_reseeded()
	_free_owned()
	_finish()


func _test_main_scene_uses_the_authored_dynamic_spawner() -> void:
	var main: Variant = _instantiate_main()
	if main == null:
		return
	var dynamic_world: Variant = main.get_node_or_null(
		"Game/SubViewport/DynamicWorld"
	)
	_check(
		dynamic_world is DynamicWorldContainer,
		"main.tscn must attach DynamicWorldContainer to DynamicWorld",
	)
	if not (dynamic_world is DynamicWorldContainer):
		return
	_check(
		dynamic_world.get_node_or_null("Spawner") is MultiplayerSpawner,
		"main.tscn must keep its authored Spawner",
	)
	_check(
		_count_spawners(dynamic_world) == 1,
		"setup must never add a second dynamic spawner, got %d"
		% _count_spawners(dynamic_world),
	)
	var global := root.get_node_or_null("Global")
	_check(global != null, "the Global autoload must exist")
	if global != null:
		_check(
			global.get("dynamic_world") == dynamic_world,
			"Global.dynamic_world must reference the scene container",
		)


func _test_save_and_load_round_trip() -> void:
	var main: Variant = _instantiate_main()
	if main == null:
		return
	var dynamic_world := main._dynamic_world as DynamicWorldContainer
	var entity := FakeDynamicEntity.new()
	entity.entity_id = 77
	entity.type_id = CRATE_TYPE
	entity.owner_player_id = 5
	dynamic_world.add_child(entity)
	dynamic_world._entities[entity.entity_id] = entity

	main._state_dir = STATE_DIR
	_clean_state_dir()
	main._save_state("smoke")
	var saved := _read_state()
	_check(not saved.is_empty(), "save_state must write readable JSON")
	_check(
		saved.get("players", null) is Array,
		"state.json must contain a `players` array",
	)
	var dynamic_records: Variant = saved.get("dynamic_world", null)
	_check(
		dynamic_records is Array and dynamic_records.size() == 1,
		"state.json must contain the live dynamic record, got %s"
		% [dynamic_records],
	)
	if dynamic_records is Array and dynamic_records.size() == 1:
		var record: Dictionary = dynamic_records[0]
		_check(
			record.get("entity_id") == entity.entity_id,
			"the saved dynamic record must keep the entity id",
		)
		_check(
			record.get("type_id") == CRATE_TYPE,
			"the saved dynamic record must keep the qualified type",
		)
		_check(
			not record.has("spawn_data"),
			"the saved dynamic record must not contain transient spawn data",
		)

	# A fresh load only seeds the parked records; the entity itself is
	# restored after `package_applied`, not by `_load_state`.
	var reloaded: Variant = _instantiate_main()
	if reloaded == null:
		return
	reloaded._state_dir = STATE_DIR
	reloaded._load_state()
	_check(
		reloaded._dynamic_world.pending_records().size() == 1,
		"_load_state must seed the dynamic records, got %d"
		% reloaded._dynamic_world.pending_records().size(),
	)
	_check(
		reloaded._dynamic_world._entities.is_empty(),
		"_load_state must not spawn before the package is applied",
	)
	# Drop the record before teardown; nothing is replication-tracked here.
	dynamic_world._entities.erase(entity.entity_id)
	entity.free()


## A parked record is not lost by a save/load cycle: `save_state` persists it
## although it is not in the tree, and `seed_pending` brings it back to the
## parked list of a fresh world, where `restore_pending` spawns it again.
func _test_parked_dynamic_records_are_saved_and_reseeded() -> void:
	var world := _new_world()
	var entity := world.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [16.0, 32.0]}}
	)
	_check(entity != null, "the parked-record test needs a spawned entity")
	if entity == null:
		return
	var entity_id: int = entity.entity_id
	_check(
		world.park_package(STAMP_PACKAGE_NUMBER) == 1,
		"park must take the entity out of the tree",
	)

	var saved := world.save_state()
	_check(
		saved.size() == 1,
		"a parked entity must still be saved, got %d records" % saved.size(),
	)
	if saved.size() != 1:
		return
	_check(
		saved[0].get("entity_id") == entity_id,
		"the saved parked record must keep the entity id, got %s"
		% [saved[0].get("entity_id")],
	)
	_check(
		not saved[0].has("persistent"),
		"the save format must not leak the parked bookkeeping flag, got %s"
		% [saved[0]],
	)

	var reloaded := _new_world()
	reloaded.seed_pending(saved)
	_check(
		reloaded.pending_records().size() == 1,
		"seed_pending must park the saved record, got %d"
		% reloaded.pending_records().size(),
	)
	_check(
		reloaded.restore_pending() == 1,
		"parked entity returns after a save/load cycle",
	)
	_check(
		reloaded._entities.has(entity_id),
		"the restored entity must keep its saved id, got %s"
		% [reloaded._entities.keys()],
	)


# --- helpers --------------------------------------------------------------


func _instantiate_main() -> Node:
	var packed := load(MAIN_SCENE) as PackedScene
	_check(packed != null, "main.tscn must load")
	if packed == null:
		return null
	var main := packed.instantiate()
	if main == null:
		_check(false, "main.tscn must instantiate")
		return null
	_owned.append(main)
	root.add_child(main)
	return main


## A headless world with one registered numeric package. The runtime package id
## must be numeric because component and entity keys are addressed by it.
func _new_world() -> DynamicWorldContainer:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var context := WiredPackageContext.new()
	context.package_id = STAMP_PACKAGE_ID
	context.root_path = DYNAMIC_FIXTURE_ROOT
	context.revision = 1
	context.artifact_key = "k1"
	registry.register_context(STAMP_PACKAGE_ID, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = STAMP_PACKAGE_ID
	registration.add_dynamic_entity("box", CRATE_SCENE)
	registry.add_registration(registration)
	var world := DynamicWorldContainer.new()
	root.add_child(world)
	_owned.append(world)
	world.setup(registry, null)
	return world


func _count_spawners(node: Node) -> int:
	var count := 0
	for child: Node in node.get_children():
		if child is MultiplayerSpawner:
			count += 1
	return count


func _clean_state_dir() -> void:
	var path := STATE_DIR.path_join("state.json")
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
	var dir := ProjectSettings.globalize_path(STATE_DIR)
	if DirAccess.dir_exists_absolute(dir):
		DirAccess.remove_absolute(dir)


func _read_state() -> Dictionary:
	var file := FileAccess.open(STATE_DIR.path_join("state.json"), FileAccess.READ)
	if file == null:
		return {}
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		return {}
	return parsed


func _free_owned() -> void:
	_clean_state_dir()
	for node: Node in _owned:
		if is_instance_valid(node):
			node.free()
	_owned.clear()
	for registry: Node in _registries:
		if is_instance_valid(registry):
			registry.free()
	_registries.clear()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("STATE_PERSISTENCE_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("STATE_PERSISTENCE_SMOKE_FAILED %s" % message)
	quit(1)
