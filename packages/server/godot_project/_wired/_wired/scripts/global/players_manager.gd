extends Node
class_name PlayersManager

## Server-side owner of the players, and the container clients spawn into.
##
## A peer becomes a player only when both gates are open:
## `peer_authenticated` (identity) and `peer_packages_ready` (the client applied
## the same revisions, so it can build the same components). The spawn record is
## handed to `MultiplayerSpawner`, which calls `_spawn_player` on every peer, so
## each side builds the player from its own registry in the same order.
##
## `build_player` is public and does not touch the tree: it turns one spawn
## record plus the registry into a `WiredPlayer` with deterministic components.

const DEFAULT_AUTHORITY := "server"
const DEFAULT_PLAYER_ID := 1
const SPAWN_OFFSET_STEP_2D := 48.0
const SPAWN_OFFSET_STEP_3D := 48.0

var _registry: WiredPackageRegistry = null
var _network: WiredNetwork = null
var _spawner: MultiplayerSpawner = null
# peer_id -> {player_id, name}
var _authenticated: Dictionary = {}
# peer_id -> WiredPlayer
var _spawned: Dictionary = {}
# player_id -> saved player state, applied on (re)spawn
var _saved_states: Dictionary = {}
# One diagnostic is enough: spawn lookups happen twice per player.
var _warned_missing_static_world := false


func setup(
	registry: WiredPackageRegistry,
	network: WiredNetwork,
	spawner: MultiplayerSpawner
) -> void:
	_registry = registry
	_network = network
	_spawner = spawner
	if _spawner != null:
		# `MultiplayerSpawner` replays tracked custom spawns to late joiners
		# through `spawn_function` (`SceneReplicationInterface::on_peer_change`
		# sends the spawn packet and the receiver calls `spawn_function`), so no
		# backfill code is needed. The real two-client check is Task 10.
		_spawner.spawn_path = NodePath("..")
		_spawner.spawn_function = _spawn_player
	if _network != null:
		if not _network.peer_authenticated.is_connected(_on_peer_authenticated):
			_network.peer_authenticated.connect(_on_peer_authenticated)
		if not _network.peer_packages_ready.is_connected(_on_peer_packages_ready):
			_network.peer_packages_ready.connect(_on_peer_packages_ready)
		if not _network.player_action_received.is_connected(
			_on_player_action_received
		):
			_network.player_action_received.connect(_on_player_action_received)
		# `peer_left` is only emitted by the server; the handler still checks
		# `_is_server()` so a client can never despawn a replicated player.
		if not _network.peer_left.is_connected(_on_peer_left):
			_network.peer_left.connect(_on_peer_left)


func get_player_by_peer(peer_id: int) -> WiredPlayer:
	var player: Variant = _spawned.get(peer_id)
	if not is_instance_valid(player):
		return null
	return player as WiredPlayer


func get_player_by_id(player_id: int) -> WiredPlayer:
	for peer_id in _spawned:
		var player: WiredPlayer = _spawned[peer_id]
		if is_instance_valid(player) and player.player_id == player_id:
			return player
	return null


## Builds one player and its registered components without adding them to the
## scene tree. The spawner (or the caller, in tests) owns parenting.
func build_player(data: Dictionary, registry: WiredPackageRegistry) -> WiredPlayer:
	var player := WiredPlayer.new()
	var spawn_2d := _as_vector2(data.get("spawn_position_2d", Vector2.ZERO))
	var spawn_3d := _as_vector3(data.get("spawn_position_3d", Vector3.ZERO))
	player.setup(
		int(data.get("player_id", 0)),
		int(data.get("peer_id", 0)),
		str(data.get("name", data.get("display_name", ""))),
		_network
	)
	player.spawn_position_2d = spawn_2d
	player.spawn_position_3d = spawn_3d
	player.set_anchor_position_2d(spawn_2d)
	player.set_anchor_position_3d(spawn_3d)
	if registry == null:
		push_warning(
			"WIRED_PLAYER_BUILD_SKIPPED player=%d reason=no_registry"
			% player.player_id
		)
		return player
	_add_registered_components(player, registry)
	return player


## Adds every registered component in registry order. Each registry-created
## component root is tagged `_wired_registered`, so `PackageReloader` never
## replaces a live player component when a package revision is applied.
func _add_registered_components(
	player: WiredPlayer, registry: WiredPackageRegistry
) -> void:
	var own_peer := _current_peer_id()
	for descriptor: Dictionary in registry.get_player_components():
		var package_id := str(descriptor.get("package_id", ""))
		var path := str(descriptor.get("path", ""))
		var local_only := bool(descriptor.get("local_only", false))
		# A local-only component exists solely on its owner's peer, so the other
		# peers never spend nodes on it.
		if local_only and player.peer_id != own_peer:
			continue
		var context := registry.get_context(package_id)
		if context == null:
			push_warning(
				"WIRED_PLAYER_COMPONENT_SKIPPED package=%s path=%s reason=no_context"
				% [package_id, path]
			)
			continue
		var instance := context.instantiate(path)
		if instance == null:
			# WiredPackageContext already reported why it failed.
			continue
		var component := instance as WiredPlayerComponent
		if component == null:
			push_warning(
				"WIRED_PLAYER_COMPONENT_SKIPPED package=%s path=%s reason=not_player_component"
				% [package_id, path]
			)
			instance.free()
			continue
		component.package_id = package_id
		component.relative_path = path
		component.set_meta("_wired_registered", true)
		player.add_component(
			component, str(descriptor.get("authority", DEFAULT_AUTHORITY)), local_only
		)


## Server-authored late-join snapshot: every live player with its spawn record
## and persisted component state. Vectors stay Variants because the snapshot
## travels through a Dictionary RPC, not JSON.
func snapshot_players() -> Array[Dictionary]:
	var records: Array[Dictionary] = []
	var peer_ids := _spawned.keys()
	peer_ids.sort()
	for peer_id: Variant in peer_ids:
		var player: WiredPlayer = _spawned[peer_id]
		if not is_instance_valid(player):
			continue
		records.append(
			{
				"player_id": player.player_id,
				"peer_id": player.peer_id,
				"name": player.display_name,
				"spawn_position_2d": player.spawn_position_2d,
				"spawn_position_3d": player.spawn_position_3d,
				"state": player.save_state(),
			}
		)
	return records


## Client side. Repairs players that the spawner replayed before packages were
## ready and creates any player missing from the replay. Idempotent: applying
## the same snapshot again rebuilds nothing and never adds a duplicate.
func apply_snapshot(records: Array) -> void:
	if _registry == null:
		push_warning("WIRED_PLAYER_SNAPSHOT_SKIPPED reason=no_registry")
		return
	var applied := 0
	for record: Variant in records:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var data: Dictionary = record
		var player_id := int(data.get("player_id", 0))
		if player_id <= 0:
			continue
		var player := get_player_by_id(player_id)
		if player == null:
			player = build_player(data, _registry)
			player.name = "Player%d" % player.player_id
			_spawned[player.peer_id] = player
			# Snapshot players are not spawned through the scene's spawner, so
			# the manager owns parenting here.
			add_child(player)
		elif not _components_match(player):
			_rebuild_components(player)
		var state: Variant = data.get("state", null)
		if typeof(state) == TYPE_DICTIONARY:
			player.load_state(state)
		else:
			player.apply_saved_anchor(
				{
					"anchor_position_2d": data.get("spawn_position_2d", Vector2.ZERO),
					"anchor_position_3d": data.get("spawn_position_3d", Vector3.ZERO),
				}
			)
		applied += 1
	print("WIRED_PLAYER_SNAPSHOT_APPLIED players=%d" % applied)


## Whether the live component list already matches the registry (including the
## local-only rule for this peer). A replayed pre-package player has zero
## components and is therefore rebuilt.
func _components_match(player: WiredPlayer) -> bool:
	var expected: Array[Dictionary] = []
	var own_peer := _current_peer_id()
	for descriptor: Dictionary in _registry.get_player_components():
		if bool(descriptor.get("local_only", false)) and player.peer_id != own_peer:
			continue
		expected.append(descriptor)
	if player.components.size() != expected.size():
		return false
	for index in expected.size():
		var component := player.components[index]
		if not is_instance_valid(component):
			return false
		if component.package_id != str(expected[index].get("package_id", "")):
			return false
		if component.relative_path != str(expected[index].get("path", "")):
			return false
	return true


func _rebuild_components(player: WiredPlayer) -> void:
	for component: WiredPlayerComponent in player.components:
		if is_instance_valid(component):
			# Detach first so the component stops processing this frame and a
			# same-named replacement cannot collide with the pending free.
			player.remove_child(component)
			component.queue_free()
	player.components.clear()
	_add_registered_components(player, _registry)


## Server only. Spawns through the scene's `MultiplayerSpawner`, which calls
## `_spawn_player` on every peer. Without a spawner (tests, headless tools) the
## player is built and added locally.
func spawn_player(peer_id: int) -> void:
	if not _is_server():
		return
	if _spawned.has(peer_id):
		return
	if not _authenticated.has(peer_id):
		return
	if _network != null and not _network.is_peer_packages_ready(peer_id):
		return
	var data := _spawn_data(peer_id)
	if _spawner != null:
		var node := _spawner.spawn(data)
		if node == null:
			push_warning(
				"WIRED_PLAYER_SPAWN_FAILED peer=%d reason=spawner_rejected"
				% peer_id
			)
		return
	_spawn_player(data)


func despawn_player(peer_id: int) -> void:
	var player := get_player_by_peer(peer_id)
	_spawned.erase(peer_id)
	if player == null:
		return
	# Freeing the node in the tree both releases it locally and tells the
	# MultiplayerSpawner to despawn the matching instance on every peer.
	player.queue_free()


## Called by `MultiplayerSpawner` on every peer. The spawner parents the
## returned node, so this method must not add it to the tree when a spawner is
## configured. It still records the instance so routing works immediately.
func _spawn_player(data: Dictionary) -> Node:
	var existing := get_player_by_id(int(data.get("player_id", 0)))
	if existing != null:
		# A snapshot may have repaired this player while the spawner replay was
		# still in flight. Never build a second node for the same player.
		push_warning(
			"WIRED_PLAYER_SPAWN_DUPLICATE player=%d reason=already_present"
			% int(data.get("player_id", 0))
		)
		return null
	var player := build_player(data, _registry)
	if player == null:
		return null
	player.name = "Player%d" % player.player_id
	_spawned[player.peer_id] = player
	# The saved anchor is available before the subtree is ready, so a body
	# component without its own saved state still starts at the right place.
	if _saved_states.has(player.player_id):
		player.apply_saved_anchor(_saved_states[player.player_id])
		# Component hooks may use @onready refs, so the rest of the restored
		# state is applied only after the spawned subtree reports ready. The
		# spawner parents the node after this call returns.
		player.ready.connect(_apply_saved_state.bind(player), CONNECT_ONE_SHOT)
	if _spawner == null:
		add_child(player)
	return player


func save_state() -> Dictionary:
	var records: Array = []
	var peer_ids := _spawned.keys()
	peer_ids.sort()
	for peer_id in peer_ids:
		var player: WiredPlayer = _spawned[peer_id]
		if is_instance_valid(player):
			records.append(player.save_state())
	return {"players": records}


## Restores the players found in `state.json`. Already spawned players receive
## the state immediately; the rest is applied when that `player_id` spawns.
func load_state(state: Dictionary) -> void:
	var records: Variant = state.get("players", [])
	if not (records is Array):
		return
	var record_list: Array = records
	for record: Variant in record_list:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var player_id := int(record.get("player_id", 0))
		if player_id <= 0:
			continue
		var existing := get_player_by_id(player_id)
		if existing != null:
			existing.load_state(record)
		else:
			_saved_states[player_id] = record


func _on_peer_authenticated(peer_id: int, player_id: int, name: String) -> void:
	_authenticated[peer_id] = {"player_id": player_id, "name": name}
	_try_spawn(peer_id)


func _on_peer_packages_ready(peer_id: int) -> void:
	_try_spawn(peer_id)


## Server side: the peer is already gone from `WiredNetwork._players`, so drop
## its auth record and free the player node there.
func _on_peer_left(peer_id: int) -> void:
	if not _is_server():
		return
	_authenticated.erase(peer_id)
	despawn_player(peer_id)


func _on_player_action_received(
	peer_id: int, action: String, payload: Dictionary
) -> void:
	var player := get_player_by_peer(peer_id)
	if player == null:
		push_warning(
			"WIRED_PLAYER_ACTION_NO_PLAYER peer=%d action=%s" % [peer_id, action]
		)
		return
	player.handle_action(action, payload, peer_id)


## Requires both the identity and the package gate, and spawns at most once.
func _try_spawn(peer_id: int) -> void:
	if not _is_server():
		return
	if _spawned.has(peer_id) or not _authenticated.has(peer_id):
		return
	if _network == null or not _network.is_peer_packages_ready(peer_id):
		return
	spawn_player(peer_id)


func _spawn_data(peer_id: int) -> Dictionary:
	var info: Dictionary = _authenticated[peer_id]
	var player_id := int(info.get("player_id", DEFAULT_PLAYER_ID))
	var index := maxi(player_id - 1, 0)
	return {
		"player_id": player_id,
		"peer_id": peer_id,
		"name": str(info.get("name", "")),
		"spawn_position_2d": _spawn_position_2d(index),
		"spawn_position_3d": _spawn_position_3d(index),
	}


## Markers are indexed by join order. When a world has fewer markers than
## players, later players share the first marker with a small deterministic
## offset instead of stacking on one point.
func _spawn_position_2d(index: int) -> Vector2:
	var world := _static_world()
	if world == null or not world.has_method("get_spawn_position_2d"):
		return Vector2.ZERO
	var position: Vector2 = world.call("get_spawn_position_2d", index)
	if position == Vector2.ZERO and index > 0:
		var origin: Vector2 = world.call("get_spawn_position_2d", 0)
		if origin != Vector2.ZERO:
			position = origin + Vector2(SPAWN_OFFSET_STEP_2D * index, 0.0)
	return position


func _spawn_position_3d(index: int) -> Vector3:
	var world := _static_world()
	if world == null or not world.has_method("get_spawn_position_3d"):
		return Vector3.ZERO
	var position: Vector3 = world.call("get_spawn_position_3d", index)
	if position == Vector3.ZERO and index > 0:
		var origin: Vector3 = world.call("get_spawn_position_3d", 0)
		if origin != Vector3.ZERO:
			position = origin + Vector3(SPAWN_OFFSET_STEP_3D * index, 0.0, 0.0)
	return position


## The autoload node itself; looked up by path rather than through the `Global`
## identifier so headless smoke scripts can compile the same core scripts.
func _static_world() -> Node:
	var global := get_node_or_null("/root/Global")
	if global == null:
		_warn_missing_static_world()
		return null
	var world := global.get("static_world") as Node
	if world == null:
		_warn_missing_static_world()
	return world


func _warn_missing_static_world() -> void:
	if _warned_missing_static_world:
		return
	_warned_missing_static_world = true
	push_warning("WIRED_PLAYERS_NO_STATIC_WORLD reason=spawn_position_unavailable")


func _apply_saved_state(player: WiredPlayer) -> void:
	if not _saved_states.has(player.player_id):
		return
	player.load_state(_saved_states[player.player_id])
	_saved_states.erase(player.player_id)


func _as_vector2(value: Variant) -> Vector2:
	if value is Vector2:
		var vector: Vector2 = value
		return vector
	if value is Array and value.size() >= 2:
		return Vector2(float(value[0]), float(value[1]))
	return Vector2.ZERO


func _as_vector3(value: Variant) -> Vector3:
	if value is Vector3:
		var vector: Vector3 = value
		return vector
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return Vector3.ZERO


func _current_peer_id() -> int:
	var api := multiplayer
	if api == null:
		return DEFAULT_PLAYER_ID
	return api.get_unique_id()


func _is_server() -> bool:
	var api := multiplayer
	if api == null:
		return true
	return api.is_server()
