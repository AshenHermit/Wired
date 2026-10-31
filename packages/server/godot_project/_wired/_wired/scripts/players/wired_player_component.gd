extends Node
class_name WiredPlayerComponent

## One package-provided piece of a player.
##
## Packages extend this class and override the `_wired_*` hooks instead of
## `_ready`/`_process`. The base owns the authority rules, input routing and the
## `MultiplayerSynchronizer` that replicates the properties a component
## declares. `PlayersManager` creates the component and attaches it as a direct
## child of its `WiredPlayer`.
##
## Authority:
## - `"server"`: only the server simulates; clients keep the component for
##   visuals and replication.
## - `"local"`: only the owning peer simulates, and the registry usually marks
##   the component `local_only`.
##
## `_wired_visual_process` always runs, on every peer, because it derives local
## state (an anchor or a camera position) from already replicated values.

const AUTHORITY_SERVER := "server"
const AUTHORITY_LOCAL := "local"
const SYNC_NAME := "Sync"

## Owner player, set by `WiredPlayer.add_component` before the node enters the
## tree so `_wired_ready` can register actions.
var player: WiredPlayer = null
## Package that registered this component. Required to qualify action and
## dynamic-type names.
var package_id: String = ""
## `"server"` or `"local"`; mirrors the registry descriptor.
var authority_mode: String = AUTHORITY_SERVER
## Registry option: the component exists only on its owner's peer.
var local_only := false


func _ready() -> void:
	_create_synchronizer()
	# Children are ready before this node, so a package scene may safely use
	# its @onready refs inside `_wired_ready`.
	_wired_ready()


func _process(delta: float) -> void:
	if player == null:
		return
	if _is_simulation_owner():
		_wired_process(delta)
	_wired_visual_process(delta)


func _physics_process(delta: float) -> void:
	if player == null or not _is_simulation_owner():
		return
	_wired_physics_process(delta)


func _unhandled_input(event: InputEvent) -> void:
	# Input intent travels through a server component too: the client instance
	# only calls `request_action`, the server instance handles it.
	if player == null or not player.is_local_player():
		return
	_wired_unhandled_input(event)


func is_local_player() -> bool:
	return player != null and player.is_local_player()


func is_server() -> bool:
	return player != null and player.is_server_authority()


## Registers a package-local action name. The package namespace is added here,
## exactly once; `WiredPlayer` only ever sees qualified names. Server only.
func register_action(local_name: String, handler: Callable) -> void:
	if player == null:
		push_warning(
			"WIRED_PLAYER_COMPONENT_NO_PLAYER package=%s action=%s"
			% [package_id, local_name]
		)
		return
	player.register_action(_qualify(local_name), handler)


## Sends an action intent to the server. The caller passes the package-local
## name; only the local player may send.
func request_action(local_name: String, payload: Dictionary = {}) -> void:
	if player == null:
		push_warning(
			"WIRED_PLAYER_COMPONENT_NO_PLAYER package=%s action=%s"
			% [package_id, local_name]
		)
		return
	player.request_action(_qualify(local_name), payload)


## Spawns a registered dynamic entity on the server. The caller passes the
## package-local type name; the package namespace is added here.
func spawn_dynamic(local_type: String, data: Dictionary = {}) -> Node:
	if player == null or not player.is_server_authority():
		return null
	var global := get_node_or_null("/root/Global")
	var world: Node = null
	if global != null:
		world = global.get("dynamic_world") as Node
	if world != null and world.has_method("spawn_entity"):
		return world.call("spawn_entity", _qualify(local_type), data) as Node
	# DynamicWorldContainer arrives in Task 8; until then packages can already
	# call this helper and get a clear diagnostic instead of a crash.
	push_warning(
		"WIRED_PLAYER_COMPONENT_NO_DYNAMIC_WORLD package=%s type=%s"
		% [package_id, local_type]
	)
	return null


## Builds the synchronization node once, after the component entered the tree.
## Property paths are relative to the component (`Body:position`), which is why
## the synchronizer's `root_path` points at its parent.
func _create_synchronizer() -> void:
	var sync := get_node_or_null(SYNC_NAME) as MultiplayerSynchronizer
	var created := false
	if sync == null:
		sync = MultiplayerSynchronizer.new()
		sync.name = SYNC_NAME
		created = true
	sync.root_path = NodePath("..")
	var config := SceneReplicationConfig.new()
	var seen: Dictionary = {}
	for property: String in _wired_replicated_properties():
		if property.is_empty() or seen.has(property):
			continue
		seen[property] = true
		var path := NodePath(property)
		config.add_property(path)
		config.property_set_spawn(path, true)
		config.property_set_replication_mode(
			path, SceneReplicationConfig.REPLICATION_MODE_ALWAYS
		)
	sync.replication_config = config
	sync.set_multiplayer_authority(get_multiplayer_authority())
	if created:
		add_child(sync)


## Whether this peer owns the simulation of this component.
func _is_simulation_owner() -> bool:
	if authority_mode == AUTHORITY_SERVER:
		return player.is_server_authority()
	return player.is_local_player()


func _qualify(local_name: String) -> String:
	return "%s/%s" % [package_id, local_name]


# --- package hooks --------------------------------------------------------


func _wired_ready() -> void:
	pass


func _wired_process(_delta: float) -> void:
	pass


func _wired_physics_process(_delta: float) -> void:
	pass


func _wired_visual_process(_delta: float) -> void:
	pass


func _wired_unhandled_input(_event: InputEvent) -> void:
	pass


func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray()


func _wired_save_state() -> Dictionary:
	return {}


func _wired_load_state(_state: Dictionary) -> void:
	pass
