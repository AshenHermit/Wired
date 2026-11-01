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


## Source of the package-op probe. It must be compiled at runtime: this suite is
## the `--script` entry point, so a parse-time `extends` of `main_scene.gd` is
## resolved before the `Global` autoload exists and fails with
## "Identifier not found: Global". The probe never enters the tree and never
## calls `_ready`; it only overrides the two operations and the reconcile.
const PACKAGE_OP_PROBE_SOURCE := """
extends "res://_wired/scripts/main_scene.gd"

var order: Array[String] = []
## Emitted by the test to let the suspended operation finish.
signal gate

func _apply_package_revision(package_id: int, revision: int) -> void:
	order.append("apply:start:%d:%d" % [package_id, revision])
	await gate
	order.append("apply:end:%d:%d" % [package_id, revision])

func _apply_client_package(package_id: int, revision: int) -> void:
	order.append("client_apply:start:%d:%d" % [package_id, revision])
	await gate
	order.append("client_apply:end:%d:%d" % [package_id, revision])

func _apply_package_removal(
	package_id: int, purge: bool, _request_snapshot := true
) -> void:
	order.append("unload:%d:%s" % [package_id, purge])

func _reconcile_client_packages(_remote: Dictionary) -> bool:
	return true
"""


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_main_scene_uses_the_authored_dynamic_spawner()
	_test_save_and_load_round_trip()
	_test_parked_dynamic_records_are_saved_and_reseeded()
	await _test_package_ops_are_serialized()
	await _test_world_snapshot_waits_for_a_running_package_op()
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


## The queue is the only entry point that mutates packages, so a suspended apply
## must block a client apply and an unload behind it.
func _test_package_ops_are_serialized() -> void:
	var probe: Variant = _make_package_op_probe()
	if probe == null:
		return
	probe._enqueue_package_op({"kind": "apply", "id": 42, "revision": 1})
	probe._enqueue_package_op({"kind": "client_apply", "id": 42, "revision": 2})
	probe._enqueue_package_op({"kind": "unload", "id": 43, "purge": false})
	_check(
		probe.order == ["apply:start:42:1"],
		"only the first package op may start while it is suspended, got %s"
		% [probe.order],
	)
	_check(
		probe._package_ops_busy,
		"the queue must report itself busy while an op is suspended",
	)
	_check(
		probe._package_ops_queue.size() == 2,
		"the queued ops must wait behind the suspended one, got %d"
		% probe._package_ops_queue.size(),
	)

	probe.gate.emit()
	await process_frame
	await process_frame
	_check(
		probe.order
		== ["apply:start:42:1", "apply:end:42:1", "client_apply:start:42:2"],
		"a client apply must start only after the apply finished, got %s"
		% [probe.order],
	)

	probe.gate.emit()
	await process_frame
	await process_frame
	_check(
		probe.order
		== [
			"apply:start:42:1",
			"apply:end:42:1",
			"client_apply:start:42:2",
			"client_apply:end:42:2",
			"unload:43:false",
		],
		"the queue must run apply, client_apply and unload in order, got %s"
		% [probe.order],
	)
	_check(not probe._package_ops_busy, "the queue must clear its busy flag")
	probe.free()


## A snapshot arriving during a suspended op must be stored, not applied: its
## reconcile could otherwise unload a package the running op is still applying.
func _test_world_snapshot_waits_for_a_running_package_op() -> void:
	var probe: Variant = _make_package_op_probe()
	if probe == null:
		return
	# The replay reaches `applied_packages()`; an empty manager matches the empty
	# remote map without any network access.
	probe._packages = PackagesManager.new()
	probe._enqueue_package_op({"kind": "apply", "id": 42, "revision": 1})
	var snapshot := {WiredProtocol.KEY_PACKAGES: {}}
	probe._apply_world_snapshot(snapshot)
	_check(
		probe._pending_world_snapshot == snapshot,
		"a snapshot must be deferred while a package op is suspended, got %s"
		% [probe._pending_world_snapshot],
	)
	_check(
		probe._package_ops_busy,
		"a deferred snapshot must not clear the busy flag",
	)

	probe.gate.emit()
	await process_frame
	await process_frame
	await process_frame
	_check(
		probe._pending_world_snapshot.is_empty(),
		"the deferred snapshot must be replayed after the op finishes, got %s"
		% [probe._pending_world_snapshot],
	)
	_check(not probe._package_ops_busy, "the replay must release the mutex")
	probe._packages.free()
	probe.free()


# --- helpers --------------------------------------------------------------


## Compiles the package-op probe at runtime. See `PACKAGE_OP_PROBE_SOURCE` for
## why a parse-time inner class cannot be used in this `--script` suite.
func _make_package_op_probe() -> Node:
	var script := GDScript.new()
	script.source_code = PACKAGE_OP_PROBE_SOURCE
	var err := script.reload()
	_check(err == OK, "the package-op probe must compile, err=%d" % err)
	if err != OK:
		return null
	var probe := script.new() as Node
	_check(probe != null, "the package-op probe must instantiate")
	return probe


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
