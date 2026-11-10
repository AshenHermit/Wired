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
## Path of the component scene relative to the package root, set by
## `PlayersManager` from the registry descriptor. Together with `package_id` it
## forms the stable persistence key, so component reordering never moves state.
var relative_path: String = ""
## `"server"` or `"local"`; mirrors the registry descriptor.
var authority_mode: String = AUTHORITY_SERVER
## Registry option: the component exists only on its owner's peer.
var local_only := false

## Speed at which replicated properties are smoothed on non-authoritative
## peers instead of snapping to replicated values. Higher = snappier but less
## smooth. `0` disables interpolation entirely.
@export var interpolation_speed: float = 10.0

## Last smoothed visual value per interpolated property key. Used as the lerp
## source so the visual transform chases the replicated target smoothly.
var _wired_visual_current: Dictionary = {}


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
	_wired_apply_interpolation(delta)


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


## Stable persistence key required by the spec: `<package_id>:<relative_path>`.
## `id` in the registration options may override the path in a future version;
## the default is the scene path, never the array index.
func state_key() -> String:
	return "%s:%s" % [package_id, relative_path]


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


## Registers a package-local InputMap action (qualified with the package id so
## packages never collide). `events` is an Array of InputEvent. Call this in
## `_wired_ready()`; afterwards read it with `Input.is_action_pressed(name)` or
## `event.is_action(name)` in `_wired_unhandled_input`. Names are qualified the
## same way as gameplay actions, so use the local (unqualified) name here.
func register_input_action(local_name: String, events: Array = []) -> String:
	var qualified := _qualify(local_name)
	if not InputMap.has_action(qualified):
		InputMap.add_action(qualified)
	for event: Variant in events:
		if event is InputEvent:
			InputMap.action_add_event(qualified, event as InputEvent)
	return qualified

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
	var properties := _wired_replicated_properties()
	if properties.is_empty():
		# A component without replicated properties (a camera, an input
		# handler) must not advertise a synchronizer. The peer that owns it
		# would otherwise send a path cache for a node the other peers never
		# built, and the receiver logs `Node not found: .../Sync`.
		var existing := get_node_or_null(SYNC_NAME) as MultiplayerSynchronizer
		if existing != null:
			existing.queue_free()
		return
	var sync := get_node_or_null(SYNC_NAME) as MultiplayerSynchronizer
	var created := false
	if sync == null:
		sync = MultiplayerSynchronizer.new()
		sync.name = SYNC_NAME
		created = true
	sync.root_path = NodePath("..")
	var config := SceneReplicationConfig.new()
	var seen: Dictionary = {}
	for property: String in properties:
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


## Returns the package-qualified name for a local action/input action, so package
## authors never build the `"<package_id>/<name>"` string by hand.
func action_name(local_name: String) -> String:
	return _qualify(local_name)


## Convenience wrappers around `Input` that use the package-qualified name, so
## authors can write `is_action_pressed("move_left")` instead of qualifying.
func is_action_pressed(local_name: String) -> bool:
	return Input.is_action_pressed(_qualify(local_name))


func is_action_just_pressed(local_name: String) -> bool:
	return Input.is_action_just_pressed(_qualify(local_name))


func is_action_just_released(local_name: String) -> bool:
	return Input.is_action_just_released(_qualify(local_name))


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


## Property paths that should be interpolated (smoothed) on non-authoritative
## peers instead of snapping to replicated values. Paths follow the same format
## as `_wired_replicated_properties()` (`Body:position`, `:replicated_yaw`).
func _wired_interpolated_properties() -> PackedStringArray:
	return PackedStringArray()


func _wired_save_state() -> Dictionary:
	return {}


func _wired_load_state(_state: Dictionary) -> void:
	pass


# --- interpolation ----------------------------------------------------------

## Resolves a replicated property path into `[target_node, property_name]`.
## Paths follow the same format as `_wired_replicated_properties()`:
## - `"Body:position"` → node `Body` relative to this component, property `position`
## - `":replicated_yaw"` → property `replicated_yaw` on this component itself
func _wired_resolve_property(property: String) -> Array:
	var root: Node = self
	var target_node: Node = root
	var prop_name: String = ""
	if property.begins_with(":"):
		prop_name = property.substr(1, property.length() - 1)
		target_node = root
	else:
		var separator := property.find(":")
		if separator >= 0:
			var node_path_str := property.substr(0, separator)
			prop_name = property.substr(separator + 1, property.length() - separator - 1)
			if not node_path_str.is_empty():
				target_node = root.get_node_or_null(NodePath(node_path_str))
			if target_node == null:
				target_node = root
				prop_name = property
		else:
			prop_name = property
			target_node = root
	return [target_node, prop_name]


## Applies smooth interpolation to every property declared in
## `_wired_interpolated_properties()`. Runs after `_wired_visual_process` so
## packages can still override visuals first; the sim owner (server) is skipped
## because it simulates authoritatively.
func _wired_apply_interpolation(delta: float) -> void:
	if _is_simulation_owner():
		return
	var properties := _wired_interpolated_properties()
	if properties.is_empty() or interpolation_speed <= 0.0:
		return
	var step := delta * interpolation_speed
	for property: String in properties:
		if property.is_empty():
			continue
		var resolved := _wired_resolve_property(property)
		var target_node: Node = resolved[0]
		var prop_name: String = resolved[1]
		if target_node == null:
			continue
		var target: Variant = target_node.get(prop_name)
		var key := property
		var current: Variant = _wired_visual_current.get(key, target)
		if current == target:
			_wired_visual_current[key] = target
			continue
		var lerped := _wired_lerp_value(current, target, step)
		target_node.set(prop_name, lerped)
		_wired_visual_current[key] = lerped


## Linearly interpolates between two values. Vectors use `lerp`; floats are
## treated as angles and interpolated along the shortest arc (`-PI`..`PI`).
func _wired_lerp_value(from: Variant, to: Variant, t: float) -> Variant:
	if from is Vector3 and to is Vector3:
		return from.lerp(to, t)
	if from is Vector2 and to is Vector2:
		return from.lerp(to, t)
	if from is float or from is int:
		return _wired_lerp_angle(float(from), float(to), t)
	return to


## Interpolates one angle toward another along the shortest arc.
func _wired_lerp_angle(from: float, to: float, t: float) -> float:
	var diff := wrapf(to - from, -PI, PI)
	return wrapf(from + diff * t, -PI, PI)
