extends Node
class_name WiredDynamicEntity

## One replicated dynamic object owned by the server.
##
## The entity root never simulates physics itself: a package scene puts the
## `RigidBody2D`/`RigidBody3D` under it and the entity replicates the properties
## the package declares. `DynamicWorldContainer.spawn_function` fills the
## identity fields and the full spawn record before the node enters the tree,
## so `_ready()` can build the synchronizer and apply the spawn exactly once on
## every peer.
##
## `spawn_data` is transient: it carries the cursor impulse or any other
## one-shot input and is never part of the persisted state. Restoring a saved
## entity moves it through `_wired_load_state`, never through `_wired_apply_spawn`
## with a fresh-spawn impulse.
##
## Clients only render: `_wired_freeze_on_client` disables the physics bodies
## so the replicated transform is the single source of truth.

const SYNC_NAME := "Sync"

## Monotonic id assigned by `DynamicWorldContainer`, stable across save/load.
var entity_id: int = 0
## Qualified type, `<package_id>/<local_type>`.
var type_id: String = ""
## Player that caused the spawn, or 0 for world-owned entities.
var owner_player_id: int = 0
## Registry option `persist` (default true). When false the entity is part of
## the live world and the late-join snapshot, but never enters `state.json`.
var persistent: bool = true
## Full spawn record: `{entity_id, type_id, owner_player_id, restore, state,
## spawn_data}`. Set before the node enters the tree.
var spawn_data: Dictionary = {}


## Fills the identity fields. Called by `DynamicWorldContainer.spawn_function`
## before the spawner parents the entity.
func setup(
	new_entity_id: int, new_type_id: String, new_owner_player_id: int
) -> void:
	entity_id = new_entity_id
	type_id = new_type_id
	owner_player_id = new_owner_player_id


## Every peer builds the synchronizer first, then applies the spawn once. The
## spawner parents the node after `spawn_function` returns, so children (and
## `@onready` refs) are ready by now.
func _ready() -> void:
	_create_synchronizer()
	_wired_apply_spawn(spawn_data)
	if not _is_server():
		_wired_freeze_on_client()


## Builds the replication node for the properties this entity exposes. Paths are
## relative to the entity root (`RigidBody2D:position`), which is why the
## synchronizer's `root_path` points at the entity.
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


## Client copies must not simulate: the server owns the transform and velocity.
## Freezing every body under the entity keeps a late physics tick from fighting
## the replicated values.
func _wired_freeze_on_client() -> void:
	# `find_children` never returns the node itself, but a package may make the
	# RigidBody the entity root. Freeze it explicitly as well. The explicit
	# `Node` hop keeps the downcast valid in the script compiler.
	var self_node: Node = self
	_freeze_2d(self_node as RigidBody2D)
	_freeze_3d(self_node as RigidBody3D)
	for node: Node in find_children("*", "RigidBody2D", true, false):
		_freeze_2d(node as RigidBody2D)
	for node: Node in find_children("*", "RigidBody3D", true, false):
		_freeze_3d(node as RigidBody3D)


func _freeze_2d(body: RigidBody2D) -> void:
	if body == null:
		return
	body.freeze = true
	body.freeze_mode = RigidBody2D.FREEZE_MODE_STATIC
	body.sleeping = true


func _freeze_3d(body: RigidBody3D) -> void:
	if body == null:
		return
	body.freeze = true
	body.freeze_mode = RigidBody3D.FREEZE_MODE_STATIC
	body.sleeping = true


## Whether this peer owns the simulation. Outside the tree (tests, tooling) the
## offline peer is the server.
func _is_server() -> bool:
	var api := multiplayer
	if api == null:
		return true
	return api.is_server()


## Parses a serialized 2D vector. JSON state stores vectors as `[x, y]`.
func _as_vector2(value: Variant, fallback: Vector2 = Vector2.ZERO) -> Vector2:
	if value is Vector2:
		var vector: Vector2 = value
		return vector
	if value is Array and value.size() >= 2:
		return Vector2(float(value[0]), float(value[1]))
	return fallback


## Parses a serialized 3D vector. JSON state stores vectors as `[x, y, z]`.
func _as_vector3(value: Variant, fallback: Vector3 = Vector3.ZERO) -> Vector3:
	if value is Vector3:
		var vector: Vector3 = value
		return vector
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return fallback


# --- package hooks --------------------------------------------------------


## Applies the spawn record once on every peer. The base entity has no body, so
## packages override this to move their own nodes.
func _wired_apply_spawn(_data: Dictionary) -> void:
	pass


## Property paths replicated by the synchronizer, relative to the entity root.
func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray()


func _wired_save_state() -> Dictionary:
	return {}


func _wired_load_state(_state: Dictionary) -> void:
	pass
