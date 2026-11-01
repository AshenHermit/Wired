extends SceneTree

## Headless smoke test for the dynamic world container and its entities.
##
## `DynamicWorldContainer` spawns package-registered dynamic scenes through a
## `MultiplayerSpawner`, tracks them by `entity_id`, persists their state
## without the transient `spawn_data`, and restores saved records through
## `_wired_load_state` only. The fixture crate counts how many times it applied
## a spawn and how many impulses it received, so a restore that replays the
## cursor impulse is observable.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/dynamic_world_smoke.gd --quit-after 2

const FIXTURE_ROOT := "res://tests/fixtures/dynamic_root"
const PACKAGE_ID := "pkg.test"
const CRATE_SCENE := "crate.tscn"
const CRATE_TYPE := "pkg.test/crate"
const OTHER_PACKAGE_ID := "pkg.other"
## Runtime package ids are numeric on the wire. A stamp is derived from the
## `<package_id>/<local_type>` prefix, so the reload/prune tests need a numeric
## package instead of the fixture-only `pkg.test`.
const STAMP_PACKAGE_ID := "42"
const STAMP_PACKAGE_NUMBER := 42
const STAMP_CRATE_TYPE := "42/box"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _registries: Array[Node] = []


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_setup_creates_a_spawner_when_missing()
	_test_setup_uses_the_passed_spawner_without_duplicating_it()
	_test_spawn_entity_instantiates_and_tracks_the_entity()
	_test_spawn_entity_rejects_unknown_types()
	_test_client_freeze_disables_bodies()
	_test_save_state_omits_spawn_data()
	_test_despawn_and_restore_do_not_replay_the_impulse()
	_test_restore_pending_waits_for_the_registered_package()
	_test_saved_ids_are_reserved_before_the_package_arrives()
	_test_restore_reassigns_a_colliding_id()
	_test_persist_false_is_live_but_not_saved()
	_test_non_server_authority_is_rejected()
	_test_snapshot_apply_is_idempotent()
	_test_snapshot_updates_existing_entity_state()
	_test_registry_roots_are_tagged_as_registered()
	_test_park_keeps_identity_and_state()
	_test_purge_drops_parked_records()
	_test_snapshot_removes_entities_of_an_unloaded_package()
	_test_snapshot_keeps_entities_created_after_the_snapshot()
	_test_snapshot_replaces_a_stale_entity_by_id()
	_free_owned()
	_finish()


func _test_setup_creates_a_spawner_when_missing() -> void:
	var world := _make_world()
	world.setup(_make_registry(), null)

	var spawner := world.get_node_or_null("Spawner") as MultiplayerSpawner
	_check(spawner != null, "setup must create a MultiplayerSpawner child")
	_check(
		world.get_child_count() == 1,
		"setup must add exactly one spawner, got %d children"
		% world.get_child_count(),
	)
	if spawner == null:
		return
	_check(
		spawner.spawn_path == NodePath(".."),
		"the spawner must parent entities under the dynamic world, got %s"
		% spawner.spawn_path,
	)


func _test_setup_uses_the_passed_spawner_without_duplicating_it() -> void:
	var world := _make_world()
	var spawner := MultiplayerSpawner.new()
	spawner.name = "Spawner"
	world.add_child(spawner)

	world.setup(_make_registry(), spawner)
	world.setup(_make_registry(), spawner)

	_check(
		world.get_child_count() == 1,
		"setup must reuse the authored spawner and never duplicate it, got %d children"
		% world.get_child_count(),
	)
	_check(
		world.get_node_or_null("Spawner") == spawner,
		"setup must keep the passed spawner as the only one",
	)
	_check(
		spawner.spawn_path == NodePath(".."),
		"setup must configure the passed spawner, got %s" % spawner.spawn_path,
	)


func _test_spawn_entity_instantiates_and_tracks_the_entity() -> void:
	var world := _make_world()
	world.setup(_make_registry(), null)

	var entity := world.spawn_entity(
		CRATE_TYPE,
		{
			"owner_player_id": 7,
			"state": {"position": [64.0, 96.0]},
			"spawn_data": {"impulse": 480.0},
		}
	)

	_check(entity != null, "spawn_entity must return the spawned entity")
	var dynamic := entity as WiredDynamicEntity
	_check(dynamic != null, "the fixture crate must extend WiredDynamicEntity")
	if dynamic == null:
		return
	_check(
		dynamic.entity_id > 0,
		"every dynamic entity must get a positive entity id, got %d"
		% dynamic.entity_id,
	)
	_check(
		dynamic.type_id == CRATE_TYPE,
		"the entity must keep its qualified type, got %s" % dynamic.type_id,
	)
	_check(
		dynamic.owner_player_id == 7,
		"the entity must keep its owner player, got %d" % dynamic.owner_player_id,
	)
	_check(
		entity.get_meta("_wired_entity_id", 0) == dynamic.entity_id,
		"the entity must carry its id as metadata",
	)
	_check(
		_live_entities(world).size() == 1,
		"the spawner must parent one live entity, got %d"
		% _live_entities(world).size(),
	)
	var body := entity.get_node_or_null("RigidBody2D") as RigidBody2D
	_check(body != null, "the fixture crate must contain a RigidBody2D")
	if body == null:
		return
	_check(
		body.position == Vector2(64, 96),
		"the spawn state must set the body position, got %s" % body.position,
	)
	_check(
		entity.get("apply_count") == 1,
		"the entity must apply its spawn exactly once, got %s"
		% entity.get("apply_count"),
	)
	_check(
		entity.get("impulse_count") == 1,
		"a fresh server spawn must apply the cursor impulse once, got %s"
		% entity.get("impulse_count"),
	)


func _test_spawn_entity_rejects_unknown_types() -> void:
	var world := _make_world()
	world.setup(_make_registry(), null)

	var entity := world.spawn_entity("pkg.test/missing", {})

	_check(entity == null, "an unregistered dynamic type must not spawn")
	_check(
		_live_entities(world).is_empty(),
		"a rejected spawn must not add any entity, got %d"
		% _live_entities(world).size(),
	)


func _test_client_freeze_disables_bodies() -> void:
	var world := _make_world()
	world.setup(_make_registry(), null)
	var entity := world.spawn_entity(CRATE_TYPE, {})
	_check(entity != null, "the freeze test needs a spawned entity")
	if entity == null:
		return
	var body := entity.get_node_or_null("RigidBody2D") as RigidBody2D
	_check(body != null, "the fixture crate must contain a RigidBody2D")
	if body == null:
		return

	entity._wired_freeze_on_client()

	_check(body.freeze, "a client copy must freeze its RigidBody2D")
	_check(
		body.freeze_mode == RigidBody2D.FREEZE_MODE_STATIC,
		"a frozen client body must use static freeze mode, got %d"
		% body.freeze_mode,
	)
	_check(body.sleeping, "a frozen client body must sleep")


func _test_save_state_omits_spawn_data() -> void:
	var world := _make_world()
	world.setup(_make_registry(), null)
	var entity := world.spawn_entity(
		CRATE_TYPE,
		{
			"owner_player_id": 3,
			"state": {"position": [12.0, 34.0]},
			"spawn_data": {"impulse": 120.0},
		}
	)
	_check(entity != null, "the save test needs a spawned entity")
	if entity == null:
		return

	var saved := world.save_state()
	_check(saved.size() == 1, "save_state must return one record per entity")
	if saved.size() != 1:
		return
	var record: Dictionary = saved[0]
	_check(
		record.get("entity_id") == entity.entity_id,
		"the record must keep the entity id",
	)
	_check(
		record.get("type_id") == CRATE_TYPE,
		"the record must keep the qualified type",
	)
	_check(
		record.get("owner_player_id") == 3,
		"the record must keep the owner player",
	)
	_check(
		not record.has("spawn_data"),
		"transient spawn data must never be persisted, got %s" % [record],
	)
	_check(
		not record.has("restore"),
		"the restore flag must never be persisted, got %s" % [record],
	)
	var state: Dictionary = record.get("state", {})
	for key: String in ["position", "rotation", "linear_velocity"]:
		_check(
			state.has(key),
			"the saved state must contain `%s`, got %s" % [key, state],
		)


func _test_despawn_and_restore_do_not_replay_the_impulse() -> void:
	var world := _make_world()
	world.setup(_make_registry(), null)
	var entity := world.spawn_entity(
		CRATE_TYPE,
		{
			"state": {"position": [40.0, 60.0]},
			"spawn_data": {"impulse": 480.0},
		}
	)
	_check(entity != null, "the restore test needs a spawned entity")
	if entity == null:
		return
	var entity_id: int = entity.entity_id
	var saved := world.save_state()

	world.despawn_entity(entity_id)
	_check(
		not world._entities.has(entity_id),
		"despawn_entity must forget the entity by id",
	)
	_check(
		entity.is_queued_for_deletion(),
		"despawn_entity must queue the entity for removal",
	)
	_check(
		world.save_state().is_empty(),
		"a despawned entity must disappear from save_state",
	)

	world.load_state(saved)
	_check(
		world._entities.has(entity_id),
		"load_state must spawn a record that is not live anymore",
	)
	var restored: Node = world._entities.get(entity_id)
	_check(restored != null, "the restored entity must be tracked by id")
	if restored == null:
		return
	_check(
		restored.entity_id == entity_id,
		"the restored entity must keep its persisted id, got %d"
		% restored.entity_id,
	)
	_check(
		restored.type_id == CRATE_TYPE,
		"the restored entity must keep its type, got %s" % restored.type_id,
	)
	_check(
		restored.get("apply_count") == 1,
		"the restored entity must apply its spawn exactly once, got %s"
		% restored.get("apply_count"),
	)
	_check(
		restored.get("impulse_count") == 0,
		"restoring must never replay the transient impulse, got %s"
		% restored.get("impulse_count"),
	)
	var body := restored.get_node_or_null("RigidBody2D") as RigidBody2D
	_check(body != null, "the restored crate must contain a RigidBody2D")
	if body != null:
		_check(
			body.position == Vector2(40, 60),
			"the restored body must load the saved position, got %s"
			% body.position,
		)
		_check(
			body.rotation == float(saved[0].get("state", {}).get("rotation", 0.0)),
			"the restored body must load the saved rotation, got %s"
			% body.rotation,
		)

	world.load_state(saved)
	_check(
		_live_entities(world).size() == 1,
		"load_state must be idempotent, got %d live entities"
		% _live_entities(world).size(),
	)


func _test_restore_pending_waits_for_the_registered_package() -> void:
	var registry := _make_registry()
	var world := _make_world()
	world.setup(registry, null)
	var records: Array = [
		{
			"entity_id": 42,
			"type_id": "pkg.other/crate",
			"owner_player_id": 1,
			"state": {"position": [1.0, 2.0]},
		},
		{
			"entity_id": 43,
			"type_id": CRATE_TYPE,
			"owner_player_id": 2,
			"state": {"position": [10.0, 20.0]},
		},
	]

	world.seed_pending(records)
	world.restore_pending()
	_check(
		world._entities.has(43),
		"a registered record must restore immediately",
	)
	_check(
		not world._entities.has(42),
		"a record whose package is missing must stay pending",
	)
	world.restore_pending()
	_check(
		_live_entities(world).size() == 1,
		"restore_pending must not duplicate an already restored record, got %d"
		% _live_entities(world).size(),
	)

	_register_other_package(registry)
	world.restore_pending()
	_check(
		world._entities.has(42),
		"a pending record must restore once its package is registered",
	)
	_check(
		world._entities[42].get("impulse_count") == 0,
		"restore_pending must not replay the impulse either",
	)
	# A record that was already restored is never resurrected by later package
	# applications, even after an explicit despawn.
	world.despawn_entity(43)
	world.restore_pending()
	_check(
		not world._entities.has(43),
		"an already restored record must not respawn after a despawn",
	)
	# `load_state` is the explicit full reload: it may bring a despawned record
	# back, but never replays its transient impulse.
	world.load_state(records)
	_check(
		world._entities.has(43) and world._entities[43].get("impulse_count") == 0,
		"a full load_state must restore the record without the impulse",
	)


## Regression: a saved record for an unregistered package must reserve its id
## immediately. Otherwise a fresh spawn takes that id, and when the package
## arrives the saved record is skipped forever and lost on the next save.
func _test_saved_ids_are_reserved_before_the_package_arrives() -> void:
	var registry := _make_registry()
	var world := _make_world()
	world.setup(registry, null)
	var records: Array = [
		{
			"entity_id": 1,
			"type_id": "pkg.other/crate",
			"owner_player_id": 1,
			"state": {"position": [7.0, 8.0]},
		},
	]

	world.seed_pending(records)
	world.restore_pending()
	_check(
		world._entities.is_empty(),
		"the pending record must not spawn before its package is registered",
	)
	_check(
		world._next_entity_id > 1,
		"restore_pending must reserve the saved id, next=%d"
		% world._next_entity_id,
	)
	var fresh := world.spawn_entity(
		CRATE_TYPE, {"state": {"position": [16.0, 32.0]}}
	) as WiredDynamicEntity
	_check(fresh != null, "a fresh spawn must still work")
	if fresh == null:
		return
	_check(
		fresh.entity_id != 1,
		"a fresh entity must not take the reserved saved id, got %d"
		% fresh.entity_id,
	)

	_register_other_package(registry)
	world.restore_pending()
	_check(
		world._entities.has(1),
		"the saved entity must restore after its package is registered",
	)
	if world._entities.has(1):
		_check(
			world._entities[1].type_id == "pkg.other/crate",
			"the saved id must belong to the saved record, got %s"
			% world._entities[1].type_id,
		)
	_check(
		world._entities.has(fresh.entity_id),
		"the fresh entity must survive the later restore",
	)
	_check(
		_live_entities(world).size() == 2,
		"both the fresh and the saved entity must exist, got %d"
		% _live_entities(world).size(),
	)


## If a saved id is already occupied by a different entity, the restore must
## reassign a fresh id instead of dropping the record or overwriting the node.
func _test_restore_reassigns_a_colliding_id() -> void:
	var registry := _make_registry()
	var world := _make_world()
	world.setup(registry, null)
	var occupied := world.spawn_entity(
		CRATE_TYPE, {"entity_id": 9, "state": {"position": [1.0, 2.0]}}
	) as WiredDynamicEntity
	_check(
		occupied != null and occupied.entity_id == 9,
		"the collision test needs a live entity with id 9",
	)
	if occupied == null:
		return
	var duplicate := world.spawn_entity(CRATE_TYPE, {"entity_id": 9})
	_check(
		duplicate == null,
		"spawn_entity must reject an id that is already in use",
	)
	_check(
		world._entities.get(9) == occupied,
		"a rejected id must not overwrite the live entity",
	)

	_register_other_package(registry)
	world.seed_pending(
		[
			{
				"entity_id": 9,
				"type_id": "pkg.other/crate",
				"owner_player_id": 2,
				"state": {"position": [5.0, 6.0]},
			},
		]
	)
	world.restore_pending()
	_check(
		world._entities.get(9) == occupied,
		"the live entity must keep its id after the colliding restore",
	)
	var restored_id := 0
	for entity_id: Variant in world._entities:
		var node: Node = world._entities[entity_id]
		if str(node.get("type_id")) == "pkg.other/crate":
			restored_id = int(entity_id)
	_check(
		restored_id > 0,
		"the colliding saved record must still restore, not be skipped",
	)
	_check(
		restored_id != 9,
		"the saved record must get a fresh id, got %d" % restored_id,
	)
	_check(
		_live_entities(world).size() == 2,
		"the colliding restore must preserve both entities, got %d"
		% _live_entities(world).size(),
	)


## `persist: false` must be honest: the entity lives in the world and in the
## late-join snapshot, but never appears in `state.json`.
func _test_persist_false_is_live_but_not_saved() -> void:
	var world := _make_world()
	world.setup(_make_registry({"persist": false}), null)
	var entity := world.spawn_entity(
		CRATE_TYPE, {"state": {"position": [5.0, 6.0]}}
	)
	_check(entity != null, "a non-persistent type must still spawn")
	_check(
		world.save_state().is_empty(),
		"persist: false must keep the entity out of state.json",
	)
	_check(
		world.snapshot_state().size() == 1,
		"persist: false must still reach a late-join snapshot",
	)


## The core only supports server-authoritative dynamic entities. A registration
## asking for client authority is rejected instead of silently ignoring the
## option and simulating on the server anyway.
func _test_non_server_authority_is_rejected() -> void:
	var world := _make_world()
	world.setup(_make_registry({"authority": "local"}), null)
	_check(
		world.spawn_entity(CRATE_TYPE, {}) == null,
		"a non-server dynamic authority must not spawn",
	)
	_check(
		_live_entities(world).is_empty(),
		"a rejected authority must not leave an entity behind",
	)


## The server-authored late-join snapshot repairs entities the spawner dropped
## before the client applied its packages, and is idempotent on retry.
func _test_snapshot_apply_is_idempotent() -> void:
	var registry := _make_stamp_registry()
	var server := _make_world()
	server.setup(registry, null)
	var source := server.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [21.0, 22.0]}}
	)
	_check(source != null, "the snapshot test needs a server entity")
	if source == null:
		return
	var snapshot := server.snapshot_state()
	var client := _make_world()
	client.setup(registry, null)
	client.apply_snapshot(snapshot, _stamp_map())
	client.apply_snapshot(snapshot, _stamp_map())
	_check(
		_live_entities(client).size() == 1,
		"applying a snapshot twice must not duplicate entities, got %d"
		% _live_entities(client).size(),
	)
	var restored := client._entities.get(source.entity_id) as WiredDynamicEntity
	_check(restored != null, "the snapshot must recreate the entity by id")
	if restored != null:
		var body := restored.get_node_or_null("RigidBody2D") as RigidBody2D
		_check(
			body != null and body.position == Vector2(21, 22),
			"the snapshot entity must load its final state, got %s"
			% (body.position if body != null else Vector2.ZERO),
		)


## A repeated snapshot is not only idempotent: it is the client's repair path
## after dropped synchronizer packets, so an already-tracked entity must adopt
## the fresh authoritative state instead of being skipped.
func _test_snapshot_updates_existing_entity_state() -> void:
	var registry := _make_stamp_registry()
	var server := _make_world()
	server.setup(registry, null)
	var source := server.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [10.0, 20.0]}}
	)
	_check(source != null, "the snapshot refresh test needs a server entity")
	if source == null:
		return
	var snapshot := server.snapshot_state()
	var client := _make_world()
	client.setup(registry, null)
	client.apply_snapshot(snapshot, _stamp_map())
	var entity := client._entities.get(source.entity_id) as WiredDynamicEntity
	_check(entity != null, "the first snapshot must create the entity")
	if entity == null:
		return
	var instance_id := entity.get_instance_id()
	# The server moved the crate while the client was not processing packets.
	snapshot[0]["state"]["position"] = [30.0, 40.0]
	client.apply_snapshot(snapshot, _stamp_map())
	var refreshed := client._entities.get(source.entity_id) as WiredDynamicEntity
	_check(
		refreshed != null and refreshed.get_instance_id() == instance_id,
		"a repeated snapshot must refresh the existing entity, not replace it",
	)
	_check(
		_live_entities(client).size() == 1,
		"a repeated snapshot must not duplicate an existing entity, got %d"
		% _live_entities(client).size(),
	)
	if refreshed != null:
		var body := refreshed.get_node_or_null("RigidBody2D") as RigidBody2D
		_check(
			body != null and body.position == Vector2(30, 40),
			"the existing entity must adopt the fresh snapshot state, got %s"
			% (body.position if body != null else Vector2.ZERO),
		)


func _test_registry_roots_are_tagged_as_registered() -> void:
	var world := _make_world()
	world.setup(_make_registry(), null)
	var entity := world.spawn_entity(CRATE_TYPE, {})
	_check(entity != null, "the metadata test needs an entity")
	if entity != null:
		_check(
			bool(entity.get_meta("_wired_registered", false)),
			"a registry-created dynamic root must carry _wired_registered",
		)


# --- task 8: park, restore, purge and stamped snapshots -------------------


## A reload parks the previous revision's entities instead of losing them: the
## id and the persisted state survive, the node leaves the tree, and
## `restore_pending` brings it back on the new revision.
func _test_park_keeps_identity_and_state() -> void:
	var world := _make_world()
	world.setup(_make_stamp_registry(), null)
	var entity := world.spawn_entity(
		STAMP_CRATE_TYPE,
		{"state": {"position": [12.0, 34.0]}, "spawn_data": {"impulse": 480.0}}
	)
	_check(entity != null, "the park test needs a spawned entity")
	if entity == null:
		return
	var id: int = entity.entity_id
	var state_before := _state_of(entity)

	_check(
		world.park_package(STAMP_PACKAGE_NUMBER) == 1,
		"park must take the entity out of the tree",
	)
	_check(world._entities.is_empty(), "parked entity leaves the index")
	_check(
		_live_entities(world).is_empty(),
		"a parked entity must leave the tree, got %d"
		% _live_entities(world).size(),
	)
	_check(
		world.pending_records().size() == 1,
		"park must keep one pending record, got %d"
		% world.pending_records().size(),
	)
	_check(
		world.save_state().size() == 1,
		"a parked persistent entity must stay in state.json",
	)

	_check(world.restore_pending() == 1, "restore must bring the entity back")
	_check(
		world.pending_records().is_empty(),
		"a restored record must leave the pending list",
	)
	var restored: Variant = world._entities.get(id)
	_check(restored != null, "restore keeps the entity id")
	if restored == null:
		return
	_check(
		restored.get("impulse_count") == 0,
		"restoring a parked entity must not replay the impulse, got %s"
		% restored.get("impulse_count"),
	)
	_check(
		_state_of(restored).get("position") == state_before.get("position"),
		"restore keeps the persisted state, before=%s after=%s"
		% [state_before.get("position"), _state_of(restored).get("position")],
	)


func _test_purge_drops_parked_records() -> void:
	var world := _make_world()
	world.setup(_make_stamp_registry(), null)
	var entity := world.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [4.0, 5.0]}}
	)
	_check(entity != null, "the purge test needs a spawned entity")
	if entity == null:
		return
	world.park_package(STAMP_PACKAGE_NUMBER)
	_check(
		world.purge_package(STAMP_PACKAGE_NUMBER) == 1,
		"purge must drop the parked record of the package",
	)
	_check(
		world.pending_records().is_empty(),
		"a purged record must not be restored later, got %s"
		% [world.pending_records()],
	)
	_check(
		world.restore_pending() == 0,
		"restore_pending must not resurrect a purged record",
	)

	# `purge_missing_packages` keeps the records whose package id is listed.
	world.seed_pending(
		[
			{"entity_id": 11, "type_id": "42/box", "state": {}},
			{"entity_id": 12, "type_id": "43/box", "state": {}},
		]
	)
	_check(
		world.purge_missing_packages(PackedStringArray(["42"])) == 1,
		"purge_missing_packages must drop the record of an unloaded package",
	)
	_check(
		world.pending_records().size() == 1
		and world.pending_records()[0].get("entity_id") == 11,
		"purge_missing_packages must keep the record of a loaded package, got %s"
		% [world.pending_records()],
	)


## The server snapshot names the package map it was authored against. An entity
## of a package missing from that map is gone from the client world, so the
## snapshot prunes it.
func _test_snapshot_removes_entities_of_an_unloaded_package() -> void:
	var world := _make_world()
	world.setup(_make_stamp_registry(), null)
	var first := world.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [1.0, 2.0]}}
	)
	var second := world.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [3.0, 4.0]}}
	)
	_check(
		first != null and second != null,
		"the prune test needs two spawned entities",
	)
	if first == null or second == null:
		return
	var first_id: int = first.entity_id

	# The snapshot names no entity and its map does not contain package 42.
	world.apply_snapshot([], {"7": {"revision": 1, "artifact_key": "other"}})

	_check(
		not world._entities.has(first_id),
		"entity of a package missing from the map is pruned",
	)
	_check(
		world._entities.is_empty() and _live_entities(world).is_empty(),
		"every entity of an unloaded package must be pruned, got %d live"
		% _live_entities(world).size(),
	)


## A snapshot is a diff, not a reset: an entity created after the snapshot was
## taken still carries a current stamp and must survive.
func _test_snapshot_keeps_entities_created_after_the_snapshot() -> void:
	var world := _make_world()
	world.setup(_make_stamp_registry(), null)
	var entity := world.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [7.0, 8.0]}}
	)
	_check(entity != null, "the keep test needs a spawned entity")
	if entity == null:
		return
	var id: int = entity.entity_id

	world.apply_snapshot([], _stamp_map())

	_check(
		world._entities.has(id),
		"entity with a current stamp survives an empty snapshot",
	)


## A snapshot authored against another revision rebuilds the entity under the
## same id, so its state comes from the new revision instead of the old node.
func _test_snapshot_replaces_a_stale_entity_by_id() -> void:
	var registry := _make_stamp_registry(1, "k1")
	var world := _make_world()
	world.setup(registry, null)
	var entity := world.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [1.0, 2.0]}}
	)
	_check(entity != null, "the replace test needs a spawned entity")
	if entity == null:
		return
	var id: int = entity.entity_id
	var instance_id := entity.get_instance_id()
	var record := {
		"entity_id": id,
		"type_id": STAMP_CRATE_TYPE,
		"owner_player_id": 0,
		"state": {"position": [5.0, 6.0]},
	}

	# Adding the package revision to the registry is what a reload does before
	# the snapshot of the new revision is applied.
	registry.register_context(
		STAMP_PACKAGE_ID, _make_stamp_context(2, "k2")
	)
	world.apply_snapshot([record], _stamp_map(2, "k2"))

	var rebuilt: Variant = world._entities.get(id)
	_check(rebuilt != null, "a stale entity must be rebuilt under the same id")
	if rebuilt == null:
		return
	_check(
		rebuilt.get_instance_id() != instance_id,
		"the stale node itself must be replaced, not mutated",
	)
	_check(
		rebuilt.get_meta(WiredProtocol.META_PACKAGE_REVISION) == 2,
		"entity is rebuilt on the new revision, got %s"
		% rebuilt.get_meta(WiredProtocol.META_PACKAGE_REVISION),
	)
	_check(
		rebuilt.get_meta(WiredProtocol.META_PACKAGE_ARTIFACT_KEY) == "k2",
		"the rebuilt entity must carry the new artifact key",
	)
	_check(
		_state_of(rebuilt).get("position") == [5.0, 6.0],
		"the rebuilt entity must load the snapshot state, got %s"
		% [_state_of(rebuilt).get("position")],
	)


# --- helpers --------------------------------------------------------------


func _make_registry(options: Dictionary = {}) -> WiredPackageRegistry:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	registry.register_context(PACKAGE_ID, _make_context(PACKAGE_ID))
	var registration := WiredPackageRegistration.new()
	registration.package_id = PACKAGE_ID
	registration.add_dynamic_entity(
		CRATE_SCENE.get_basename(), CRATE_SCENE, options
	)
	registry.add_registration(registration)
	return registry


func _register_other_package(registry: WiredPackageRegistry) -> void:
	registry.register_context(OTHER_PACKAGE_ID, _make_context(OTHER_PACKAGE_ID))
	var registration := WiredPackageRegistration.new()
	registration.package_id = OTHER_PACKAGE_ID
	registration.add_dynamic_entity(CRATE_SCENE.get_basename(), CRATE_SCENE)
	registry.add_registration(registration)


## Package with a numeric id, like a real backend package. The stamp of a
## dynamic entity is derived from its `<package_id>/<local_type>` prefix, so a
## numeric id is required to exercise the reload and prune paths.
func _make_stamp_registry(
	revision := 0, artifact_key := ""
) -> WiredPackageRegistry:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	registry.register_context(
		STAMP_PACKAGE_ID, _make_stamp_context(revision, artifact_key)
	)
	var registration := WiredPackageRegistration.new()
	registration.package_id = STAMP_PACKAGE_ID
	registration.add_dynamic_entity("box", CRATE_SCENE)
	registry.add_registration(registration)
	return registry


func _make_stamp_context(
	revision := 0, artifact_key := ""
) -> WiredPackageContext:
	var context := _make_context(STAMP_PACKAGE_ID)
	context.revision = revision
	context.artifact_key = artifact_key
	return context


## Package map as the server authors it into a world snapshot.
func _stamp_map(revision := 0, artifact_key := "") -> Dictionary:
	return {
		STAMP_PACKAGE_ID: {"revision": revision, "artifact_key": artifact_key},
	}


## Persisted state of an entity, read through its package hook.
func _state_of(entity: Variant) -> Dictionary:
	var state: Variant = entity.call("_wired_save_state")
	if typeof(state) != TYPE_DICTIONARY:
		return {}
	return state


func _make_context(package_id: String) -> WiredPackageContext:
	var context := WiredPackageContext.new()
	context.package_id = package_id
	context.root_path = FIXTURE_ROOT
	return context


func _make_world() -> DynamicWorldContainer:
	var world := DynamicWorldContainer.new()
	root.add_child(world)
	_owned.append(world)
	return world


## Entities still in the tree; queued-for-deletion nodes do not count, so the
## suite can check despawn/restore without waiting for a frame.
func _live_entities(world: DynamicWorldContainer) -> Array[Node]:
	var entities: Array[Node] = []
	for child: Node in world.get_children():
		if child is WiredDynamicEntity and not child.is_queued_for_deletion():
			entities.append(child)
	return entities


func _free_owned() -> void:
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
		print("DYNAMIC_WORLD_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("DYNAMIC_WORLD_SMOKE_FAILED %s" % message)
	quit(1)
