extends SceneTree

## Headless two-peer model of the late-join path.
##
## Godot's `MultiplayerSpawner` replays tracked spawns as soon as the transport
## peer connects, before `cli_hello`, package revisions and readiness. This
## suite reproduces that ordering without a socket:
##
## 1. the server owns a player with components and a dynamic crate;
## 2. a late client spawner replay reaches the client while its registry is
##    still empty: the player is built without components and the crate is
##    dropped because its type is unknown;
## 3. the client applies the package entries;
## 4. the server-authored snapshot repairs the player in place and recreates
##    the crate, exactly once, even when the snapshot is applied twice.
##
## The package-map guard (`SnapshotRules.packages_match`) is covered with a
## matching closure, a same-revision/different-artifact publish and a missing
## package. The real WebSocket transport is still covered only manually.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/late_join_smoke.gd --quit-after 2

const PLAYER_PACKAGE := "pkg.player"
const DYNAMIC_PACKAGE := "pkg.dynamic"
const PLAYER_ROOT := "res://tests/fixtures/player_root"
const DYNAMIC_ROOT := "res://tests/fixtures/dynamic_root"
const PLAYER_SCENE := "player_component.tscn"
const CRATE_SCENE := "crate.tscn"
const CRATE_TYPE := "pkg.dynamic/crate"
const SnapshotRules := preload("res://_wired/scripts/network/world_snapshot.gd")

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _registries: Array[Node] = []


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_late_client_is_repaired_once()
	_test_snapshot_package_map_guard()
	_test_empty_component_has_no_sync()
	_test_preloaded_client_builds_sync_before_snapshot()
	_free_owned()
	_finish()


func _test_empty_component_has_no_sync() -> void:
	var empty := WiredPlayerComponent.new()
	root.add_child(empty)
	_check(
		empty.get_node_or_null("Sync") == null,
		"a component without replicated properties must not create a synchronizer"
	)
	empty.queue_free()


func _test_preloaded_client_builds_sync_before_snapshot() -> void:
	var registry := _make_full_registry()
	var players := _make_players(registry)
	var player := players._spawn_player(
		{
			"player_id": 9,
			"peer_id": 9,
			"name": "preloaded",
			"spawn_position_2d": Vector2(10, 20),
		}
	) as WiredPlayer
	_check(
		player != null,
		"a preloaded client must build the player immediately"
	)
	if player == null:
		return
	_check(
		player.components.size() == 1,
		"the preloaded player must have its registered component"
	)
	if player.components.is_empty():
		return
	var component := player.components[0]
	var sync := component.get_node_or_null("Sync") as MultiplayerSynchronizer
	_check(
		sync != null,
		"the preloaded component must create its synchronizer before replication starts"
	)
	if sync != null:
		_check(
			sync.replication_config.get_properties().size() == 1,
			"the synchronizer must replicate the declared body property"
		)
	var body := component.get_node_or_null("Body") as Node2D
	_check(body != null, "the preloaded component must keep its body node")
	_check(
		player.get_anchor_position_2d() == Vector2(10, 20),
		"the preloaded player must start at the spawn anchor"
	)


func _test_late_client_is_repaired_once() -> void:
	var server_registry := _make_full_registry()
	var server_players := _make_players(server_registry)
	server_players._authenticated[10] = {"player_id": 3, "name": "late"}
	server_players.spawn_player(10)
	var server_player := server_players.get_player_by_id(3)
	_check(server_player != null, "the server must own the seeded player")
	if server_player == null:
		return
	var server_body: Variant = server_player.components[0]
	server_body.body.position = Vector2(64, 96)
	var player_record := server_players.snapshot_players()
	_check(player_record.size() == 1, "the snapshot must carry the live player")

	var server_world := _make_world(server_registry)
	var crate := server_world.spawn_entity(
		CRATE_TYPE, {"state": {"position": [48.0, 72.0]}}
	)
	_check(crate != null, "the server must own the seeded crate")
	if crate == null:
		return
	var dynamic_records := server_world.snapshot_state()

	# --- late client ------------------------------------------------------
	# The transport replay arrives first, while the registry is empty.
	var client_registry := _new_registry()
	var client_players := _make_players(client_registry)
	var replay_data: Dictionary = player_record[0]
	var replayed := client_players._spawn_player(replay_data) as WiredPlayer
	_check(replayed != null, "the spawner replay must create the player root")
	if replayed != null:
		_check(
			replayed.components.is_empty(),
			"with an empty registry the replayed player has no components",
		)
	var client_world := _make_world(client_registry)
	_check(
		client_world.spawn_function(
			{
				"entity_id": crate.entity_id,
				"type_id": CRATE_TYPE,
				"owner_player_id": 0,
				"restore": true,
				"state": dynamic_records[0]["state"],
			}
		)
		== null,
		"with an empty registry the crate spawn is dropped",
	)

	# Package entries finish applying, then the readiness snapshot arrives.
	_add_full_packages(client_registry)
	var snapshot := {
		"packages": {
			PLAYER_PACKAGE: {"revision": 1, "artifact_key": "player-a"},
			DYNAMIC_PACKAGE: {"revision": 1, "artifact_key": "dynamic-a"},
		},
		"players": player_record,
		"dynamic_world": dynamic_records,
	}

	_apply_snapshot(client_players, client_world, snapshot)
	var repaired := client_players.get_player_by_id(3)
	_check(repaired != null, "the snapshot must keep the replayed player")
	if repaired != null:
		_check(
			repaired.get_instance_id() == replayed.get_instance_id(),
			"the player root must be repaired in place, not replaced",
		)
		_check(
			repaired.components.size() == server_player.components.size(),
			"the repaired player must have every registered component, got %d"
			% repaired.components.size(),
		)
		_check(
			repaired.display_name == "late",
			"the repaired player must keep its display name",
		)
		for component: WiredPlayerComponent in repaired.components:
			_check(
				bool(component.get_meta("_wired_registered", false)),
				"a repaired component must carry _wired_registered",
			)
			_check(
				not component.relative_path.is_empty(),
				"a repaired component must keep its relative scene path",
			)
		if not repaired.components.is_empty():
			var repaired_body: Variant = repaired.components[0]
			_check(
				repaired_body.body.position == Vector2(64, 96),
				"the repaired body must receive the snapshot state, got %s"
				% repaired_body.body.position,
			)
	_check(
		client_world._entities.has(crate.entity_id),
		"the snapshot must recreate the dropped crate",
	)
	var restored_crate := client_world._entities.get(
		crate.entity_id
	) as WiredDynamicEntity
	_check(restored_crate != null, "the recreated crate must be tracked by id")
	if restored_crate != null:
		var restored_body := restored_crate.get_node_or_null(
			"RigidBody2D"
		) as RigidBody2D
		_check(
			restored_body != null and restored_body.position == Vector2(48, 72),
			"the recreated crate must load its state, got %s"
			% (restored_body.position if restored_body != null else Vector2.ZERO),
		)
		_check(
			bool(restored_crate.get_meta("_wired_registered", false)),
			"the recreated crate must carry _wired_registered",
		)

	# A live registry-created player component and crate must never be collected
	# by PackageReloader: a revision may rebuild static roots, not live entities.
	var reloader := PackageReloader.new()
	root.add_child(reloader)
	_owned.append(reloader)
	var reload_roots := reloader._collect_roots()
	_check(
		not reload_roots.has(repaired),
		"a live player root must not be a PackageReloader candidate",
	)
	_check(
		not reload_roots.has(restored_crate),
		"a live dynamic entity must not be a PackageReloader candidate",
	)
	if repaired != null:
		for component: WiredPlayerComponent in repaired.components:
			_check(
				not reload_roots.has(component),
				"a live player component must not be a PackageReloader candidate",
			)

	# Applying the same snapshot again must not duplicate anything.
	_apply_snapshot(client_players, client_world, snapshot)
	_check(
		client_players.get_player_by_id(3) == repaired,
		"a repeated snapshot must not replace the player",
	)
	_check(
		_live_players(client_players).size() == 1,
		"a repeated snapshot must not duplicate players, got %d"
		% _live_players(client_players).size(),
	)
	_check(
		_live_entities(client_world).size() == 1,
		"a repeated snapshot must not duplicate dynamic entities, got %d"
		% _live_entities(client_world).size(),
	)


func _test_snapshot_package_map_guard() -> void:
	var local := {
		"5": {"revision": 4, "artifact_key": "artifact-a"},
		"6": {"revision": 2, "artifact_key": "artifact-b"},
	}
	_check(
		SnapshotRules.packages_match(
			{
				5: {"revision": 4, "artifact_key": "artifact-a"},
				6: {"revision": 2, "artifact_key": "artifact-b"},
			},
			local,
		),
		"the same package closure must match across int/string keys",
	)
	_check(
		not SnapshotRules.packages_match(
			{"5": {"revision": 4, "artifact_key": "artifact-old"}},
			{"5": {"revision": 4, "artifact_key": "artifact-new"}},
		),
		"a same-revision dependency publish must be treated as a mismatch",
	)
	_check(
		not SnapshotRules.packages_match(
			{"5": {"revision": 4, "artifact_key": "artifact-a"}},
			local,
		),
		"a missing package must be treated as a mismatch",
	)
	_check(
		SnapshotRules.packages_match({}, {}),
		"a room without packages must match an empty local map",
	)


# --- helpers --------------------------------------------------------------


func _apply_snapshot(
	players: PlayersManager, world: DynamicWorldContainer, snapshot: Dictionary
) -> void:
	_check(
		SnapshotRules.packages_match(
			snapshot.get("packages", {}), snapshot.get("packages", {})
		),
		"the snapshot package map must be self-consistent",
	)
	players.apply_snapshot(snapshot.get("players", []))
	world.apply_snapshot(snapshot.get("dynamic_world", []))


func _make_full_registry() -> WiredPackageRegistry:
	var registry := _new_registry()
	_add_full_packages(registry)
	return registry


func _new_registry() -> WiredPackageRegistry:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	return registry


## Populates an existing registry, mirroring `PackageEntryLoader` applying the
## player and dynamic package entries into the client's live registry.
func _add_full_packages(registry: WiredPackageRegistry) -> void:
	var player_context := WiredPackageContext.new()
	player_context.package_id = PLAYER_PACKAGE
	player_context.root_path = PLAYER_ROOT
	registry.register_context(PLAYER_PACKAGE, player_context)
	var player_entry := WiredPackageRegistration.new()
	player_entry.package_id = PLAYER_PACKAGE
	player_entry.add_player_component(PLAYER_SCENE, {"order": 10})
	registry.add_registration(player_entry)

	var dynamic_context := WiredPackageContext.new()
	dynamic_context.package_id = DYNAMIC_PACKAGE
	dynamic_context.root_path = DYNAMIC_ROOT
	registry.register_context(DYNAMIC_PACKAGE, dynamic_context)
	var dynamic_entry := WiredPackageRegistration.new()
	dynamic_entry.package_id = DYNAMIC_PACKAGE
	dynamic_entry.add_dynamic_entity("crate", CRATE_SCENE)
	registry.add_registration(dynamic_entry)


func _make_players(registry: WiredPackageRegistry) -> PlayersManager:
	var manager := PlayersManager.new()
	root.add_child(manager)
	_owned.append(manager)
	manager.setup(registry, null, null)
	return manager


func _make_world(registry: WiredPackageRegistry) -> DynamicWorldContainer:
	var world := DynamicWorldContainer.new()
	root.add_child(world)
	_owned.append(world)
	world.setup(registry, null)
	return world


func _live_players(manager: PlayersManager) -> Array[Node]:
	var players: Array[Node] = []
	for child: Node in manager.get_children():
		if child is WiredPlayer and not child.is_queued_for_deletion():
			players.append(child)
	return players


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
		print("LATE_JOIN_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("LATE_JOIN_SMOKE_FAILED %s" % message)
	quit(1)
