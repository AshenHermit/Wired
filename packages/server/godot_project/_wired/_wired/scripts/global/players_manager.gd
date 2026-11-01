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
##
## Late join. `MultiplayerSpawner` replays tracked spawns immediately after the
## transport connects, which is *before* a client reports package readiness. The
## client preloads its packages before connecting, so the replay normally finds a
## complete registry; `apply_snapshot` is the fallback for a replay a peer could
## not build.
##
## Replication of a repaired node. Godot resolves synchronizer updates either by
## the spawn net id of the node (assigned when the spawn packet is built) or, for
## a synchronizer that never went through a spawn, by node path
## (`SceneReplicationInterface::_verify_synchronizer` + the multiplayer object
## cache). A repaired root and its rebuilt components therefore keep the spawn
## record's exact name under the spawner's `spawn_path`: any synchronizer the
## authority created *after* its spawn -- a hot-reloaded component, a repaired
## entity -- then reaches every peer that has the same path. What cannot be
## repaired client-side is a node the authority spawned: its net-id updates are
## meaningless to a peer that never received that packet, and Godot 4.x offers no
## per-peer spawn resend (`MultiplayerSpawner.spawn` is authority-only and spawn
## visibility is global). Such a root stays display-only until the server
## respawns it; the two-client check must confirm the supported cases.

const DEFAULT_AUTHORITY := "server"
const DEFAULT_PLAYER_ID := 1
const SPAWN_OFFSET_STEP_2D := 48.0
const SPAWN_OFFSET_STEP_3D := 48.0
## Set on a player root this peer created from a late-join snapshot instead of
## receiving it from the spawner. Nothing else owns its lifetime here.
const META_SNAPSHOT_REPAIR := "_wired_snapshot_repair"

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
	var spawn_2d := WiredProtocol.as_vector2(
		data.get(WiredProtocol.KEY_SPAWN_POSITION_2D, Vector2.ZERO)
	)
	var spawn_3d := WiredProtocol.as_vector3(
		data.get(WiredProtocol.KEY_SPAWN_POSITION_3D, Vector3.ZERO)
	)
	player.setup(
		int(data.get(WiredProtocol.KEY_PLAYER_ID, 0)),
		int(data.get(WiredProtocol.KEY_PEER_ID, 0)),
		_player_display_name(data),
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
## component root is tagged `_wired_registered`, so no generic reloader replaces
## a live player component: its lifetime belongs to the player.
func _add_registered_components(
	player: WiredPlayer, registry: WiredPackageRegistry
) -> void:
	var own_peer := _current_peer_id()
	for descriptor: Dictionary in registry.get_player_components():
		var package_id := str(descriptor.get(WiredProtocol.KEY_PACKAGE_ID, ""))
		var path := str(descriptor.get(WiredProtocol.KEY_PATH, ""))
		var local_only := bool(descriptor.get(WiredProtocol.KEY_LOCAL_ONLY, false))
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
		component.set_meta(WiredProtocol.META_REGISTERED, true)
		player.add_component(
			component,
			str(descriptor.get(WiredProtocol.KEY_AUTHORITY, DEFAULT_AUTHORITY)),
			local_only
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
				WiredProtocol.KEY_PLAYER_ID: player.player_id,
				WiredProtocol.KEY_PEER_ID: player.peer_id,
				WiredProtocol.KEY_NAME: player.display_name,
				WiredProtocol.KEY_SPAWN_POSITION_2D: player.spawn_position_2d,
				WiredProtocol.KEY_SPAWN_POSITION_3D: player.spawn_position_3d,
				WiredProtocol.KEY_STATE: player.save_state(),
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
		var player_id := int(data.get(WiredProtocol.KEY_PLAYER_ID, 0))
		if player_id <= 0:
			continue
		var player := get_player_by_id(player_id)
		if player == null:
			player = build_player(data, _registry)
			player.name = player_name(player_id)
			_adopt_repaired_player(player)
			_spawned[player.peer_id] = player
		elif not _components_match(player):
			_rebuild_components(player)
		var state: Variant = data.get(WiredProtocol.KEY_STATE, null)
		if typeof(state) == TYPE_DICTIONARY:
			player.load_state(state)
		else:
			player.apply_saved_anchor(
				{
					WiredProtocol.KEY_ANCHOR_POSITION_2D:
					data.get(WiredProtocol.KEY_SPAWN_POSITION_2D, Vector2.ZERO),
					WiredProtocol.KEY_ANCHOR_POSITION_3D:
					data.get(WiredProtocol.KEY_SPAWN_POSITION_3D, Vector3.ZERO),
				}
			)
		applied += 1
	print("WIRED_PLAYER_SNAPSHOT_APPLIED players=%d" % applied)


## Deterministic name of a player node. The server's spawn packet and a repaired
## local root must agree, because path-based synchronization resolves the
## synchronizer by node path.
func player_name(player_id: int) -> String:
	return "Player%d" % player_id


## Parents a player root that the spawner did not deliver to this peer, under the
## same parent and with the same name the spawner would use.
func _adopt_repaired_player(player: WiredPlayer) -> void:
	player.set_multiplayer_authority(DEFAULT_PLAYER_ID)
	player.set_meta(META_SNAPSHOT_REPAIR, true)
	_spawn_parent().add_child(player)
	print(
		"WIRED_PLAYER_REPAIRED_LOCAL player=%d reason=spawner_spawn_missed"
		% player.player_id
	)


## The node that owns spawned players: the spawner's `spawn_path`, or this
## manager when no spawner is configured (tests, headless tools).
func _spawn_parent() -> Node:
	if _spawner != null:
		var path := _spawner.spawn_path
		if not path.is_empty():
			var parent := _spawner.get_node_or_null(path)
			if parent != null:
				return parent
	return self


## Drops one player that left, in both runtime modes. The server despawns it
## through the spawner; a client only learns the player id from the `player_left`
## server event, because the engine despawn packet is matched by spawn net id and
## a snapshot-repaired root has none.
func forget_player(player_id: int) -> void:
	for peer_id: Variant in _spawned.keys():
		var player: WiredPlayer = _spawned[peer_id]
		if not is_instance_valid(player) or player.player_id != player_id:
			continue
		_spawned.erase(peer_id)
		# A spawner-tracked root frees itself; a repaired one is ours alone.
		if (
			bool(player.get_meta(META_SNAPSHOT_REPAIR, false))
			and not player.is_queued_for_deletion()
		):
			player.queue_free()
		return


## Rebuilds every live player's components from the current registry.
##
## Called after a package revision is applied: without it, players that were
## already spawned keep running the previous revision's scripts while the static
## world is rebuilt, so a hot reload produced a mixed world. The root (and the
## spawner's net id) is preserved; component state is captured and re-applied to
## the new instances, so a reload does not teleport bodies back to their anchor.
##
## Returns the number of rebuilt players.
func rebuild_live_components() -> int:
	var rebuilt := 0
	var peer_ids := _spawned.keys()
	peer_ids.sort()
	for peer_id: Variant in peer_ids:
		var player: WiredPlayer = _spawned[peer_id]
		if not is_instance_valid(player):
			continue
		var state := player.save_state()
		_rebuild_components(player)
		player.load_state(state)
		rebuilt += 1
	if rebuilt > 0:
		print("WIRED_PLAYER_COMPONENTS_REBUILT players=%d" % rebuilt)
	return rebuilt


## Whether the live component list already matches the registry (including the
## local-only rule for this peer). A replayed pre-package player has zero
## components and is therefore rebuilt.
func _components_match(player: WiredPlayer) -> bool:
	var expected: Array[Dictionary] = []
	var own_peer := _current_peer_id()
	for descriptor: Dictionary in _registry.get_player_components():
		if (
			bool(descriptor.get(WiredProtocol.KEY_LOCAL_ONLY, false))
			and player.peer_id != own_peer
		):
			continue
		expected.append(descriptor)
	if player.components.size() != expected.size():
		return false
	for index in expected.size():
		var component := player.components[index]
		if not is_instance_valid(component):
			return false
		if component.package_id != str(
			expected[index].get(WiredProtocol.KEY_PACKAGE_ID, "")
		):
			return false
		if component.relative_path != str(
			expected[index].get(WiredProtocol.KEY_PATH, "")
		):
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
	var existing := get_player_by_id(
		int(data.get(WiredProtocol.KEY_PLAYER_ID, 0))
	)
	if existing != null:
		# A snapshot may have repaired this player while the spawner replay was
		# still in flight. Never build a second node for the same player.
		push_warning(
			"WIRED_PLAYER_SPAWN_DUPLICATE player=%d reason=already_present"
			% int(data.get(WiredProtocol.KEY_PLAYER_ID, 0))
		)
		return null
	var player := build_player(data, _registry)
	if player == null:
		return null
	player.name = player_name(player.player_id)
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
	return {WiredProtocol.KEY_PLAYERS: records}


## Restores the players found in `state.json`. Already spawned players receive
## the state immediately; the rest is applied when that `player_id` spawns.
func load_state(state: Dictionary) -> void:
	var records: Variant = state.get(WiredProtocol.KEY_PLAYERS, [])
	if not (records is Array):
		return
	var record_list: Array = records
	for record: Variant in record_list:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var player_id := int(record.get(WiredProtocol.KEY_PLAYER_ID, 0))
		if player_id <= 0:
			continue
		var existing := get_player_by_id(player_id)
		if existing != null:
			existing.load_state(record)
		else:
			_saved_states[player_id] = record


func _on_peer_authenticated(peer_id: int, player_id: int, name: String) -> void:
	_authenticated[peer_id] = {
		WiredProtocol.KEY_PLAYER_ID: player_id,
		WiredProtocol.KEY_NAME: name,
	}
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
	var player_id := int(info.get(WiredProtocol.KEY_PLAYER_ID, DEFAULT_PLAYER_ID))
	var index := maxi(player_id - 1, 0)
	return {
		WiredProtocol.KEY_PLAYER_ID: player_id,
		WiredProtocol.KEY_PEER_ID: peer_id,
		WiredProtocol.KEY_NAME: str(info.get(WiredProtocol.KEY_NAME, "")),
		WiredProtocol.KEY_SPAWN_POSITION_2D: _spawn_position_2d(index),
		WiredProtocol.KEY_SPAWN_POSITION_3D: _spawn_position_3d(index),
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


## `name` is the spawn record key; `display_name` is what a saved state uses.
func _player_display_name(data: Dictionary) -> String:
	if data.has(WiredProtocol.KEY_NAME):
		return str(data.get(WiredProtocol.KEY_NAME, ""))
	return str(data.get(WiredProtocol.KEY_DISPLAY_NAME, ""))


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
