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

	world.restore_pending(records)
	_check(
		world._entities.has(43),
		"a registered record must restore immediately",
	)
	_check(
		not world._entities.has(42),
		"a record whose package is missing must stay pending",
	)
	world.restore_pending(records)
	_check(
		_live_entities(world).size() == 1,
		"restore_pending must not duplicate an already restored record, got %d"
		% _live_entities(world).size(),
	)

	_register_other_package(registry)
	world.restore_pending(records)
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
	world.restore_pending(records)
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


# --- helpers --------------------------------------------------------------


func _make_registry() -> WiredPackageRegistry:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	registry.register_context(PACKAGE_ID, _make_context(PACKAGE_ID))
	var registration := WiredPackageRegistration.new()
	registration.package_id = PACKAGE_ID
	registration.add_dynamic_entity(CRATE_SCENE.get_basename(), CRATE_SCENE)
	registry.add_registration(registration)
	return registry


func _register_other_package(registry: WiredPackageRegistry) -> void:
	registry.register_context(OTHER_PACKAGE_ID, _make_context(OTHER_PACKAGE_ID))
	var registration := WiredPackageRegistration.new()
	registration.package_id = OTHER_PACKAGE_ID
	registration.add_dynamic_entity(CRATE_SCENE.get_basename(), CRATE_SCENE)
	registry.add_registration(registration)


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
