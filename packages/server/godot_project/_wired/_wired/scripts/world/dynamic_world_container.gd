extends Node
class_name DynamicWorldContainer

## Server-owned dynamic content for a room.
##
## Packages register dynamic types in `WiredPackageRegistry`; the server spawns
## them through the scene's `MultiplayerSpawner`, which replicates the spawn to
## every peer (and replays it to late joiners). The container only generates the
## ids, normalizes the spawn record and keeps the entity index for save/load.
##
## Spawn record, produced here and consumed by `spawn_function` on every peer:
## `{entity_id, type_id, owner_player_id, restore, state, spawn_data}`.
## `spawn_data` is one-shot input (a cursor impulse); it is never persisted.
##
## Persisted record: `{entity_id, type_id, owner_player_id, state}`.
##
## Restore path: `load_state`/`restore_pending` are server-only and only spawn
## records whose type is registered. A record whose package has not been
## applied yet stays pending, which lets `main_scene` call `restore_pending`
## after every `package_applied` without knowing the package arrival order.

const SPAWNER_NAME := "Spawner"
const META_ENTITY_ID := "_wired_entity_id"
const META_SOURCE_ENTITY_ID := "_wired_source_entity_id"
const STATE_KEYS: Array[String] = ["position", "rotation", "linear_velocity"]
const RECORD_KEYS: Array[String] = [
	"entity_id",
	"type_id",
	"owner_player_id",
	"restore",
	"state",
	"spawn_data",
]

var _registry: WiredPackageRegistry = null
var _spawner: MultiplayerSpawner = null
# entity_id -> WiredDynamicEntity
var _entities: Dictionary = {}
# entity_id -> true, so repeated restore_pending calls never duplicate records
var _restored_ids: Dictionary = {}
# Next free id. Saved ids are reserved as soon as records are known, before any
# fresh spawn can take one.
var _next_entity_id: int = 1


## Attaches the registry and the scene's spawner. An authored spawner is always
## reused; only a container without one creates its own child. Re-running setup
## is safe and never adds a second spawner.
func setup(registry: WiredPackageRegistry, spawner: MultiplayerSpawner) -> void:
	_registry = registry
	_spawner = spawner
	if _spawner == null:
		_spawner = get_node_or_null(SPAWNER_NAME) as MultiplayerSpawner
	if _spawner == null:
		_spawner = MultiplayerSpawner.new()
		_spawner.name = SPAWNER_NAME
		add_child(_spawner)
	_spawner.spawn_path = NodePath("..")
	_spawner.spawn_function = spawn_function


## Server only. Spawns a registered dynamic type and returns the entity that the
## spawner parented under this container. `data` may use the full record shape
## or the flat form package components use (`position`, `direction`, ...).
func spawn_entity(qualified_type: String, data: Dictionary = {}) -> Node:
	if not _is_server():
		return null
	if _registry == null:
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=no_registry"
			% qualified_type
		)
		return null
	if _spawner == null:
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=no_spawner"
			% qualified_type
		)
		return null
	var descriptor := _registry.find_dynamic_entity(qualified_type)
	if descriptor.is_empty():
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=unknown_type"
			% qualified_type
		)
		return null
	var package_id := str(descriptor.get("package_id", ""))
	if _registry.get_context(package_id) == null:
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s package=%s reason=no_context"
			% [qualified_type, package_id]
		)
		return null
	var entity_id := int(data.get("entity_id", 0))
	if entity_id > 0 and _entities.has(entity_id):
		# Never overwrite the index entry: the old node would stay in the tree
		# untracked and the next save would drop it.
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s entity_id=%d reason=id_in_use"
			% [qualified_type, entity_id]
		)
		return null
	if entity_id <= 0:
		entity_id = _next_entity_id
	_next_entity_id = maxi(_next_entity_id, entity_id + 1)
	var record := _spawn_record(entity_id, qualified_type, data)
	var entity: Node = _spawner.spawn(record)
	if entity == null:
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=spawner_rejected"
			% qualified_type
		)
		return null
	_entities[entity_id] = entity
	return entity


## Server only. Freeing the node tells the spawner to despawn the matching
## instance on every peer.
func despawn_entity(entity_id: int) -> void:
	if not _is_server():
		return
	var entity: Variant = _entities.get(entity_id)
	_entities.erase(entity_id)
	# `_restored_ids` is intentionally kept: a restored record must not be
	# resurrected by the next `package_applied` after an explicit despawn.
	if not is_instance_valid(entity):
		return
	var node := entity as Node
	if node.is_queued_for_deletion():
		return
	node.queue_free()


## Live entities in id order, one persisted record each. The transient spawn
## data and the restore flag are deliberately dropped.
func save_state() -> Array[Dictionary]:
	var records: Array[Dictionary] = []
	var ids := _entities.keys()
	ids.sort()
	for entity_id: Variant in ids:
		var entity: Variant = _entities[entity_id]
		if not is_instance_valid(entity):
			continue
		var node := entity as Node
		if node.is_queued_for_deletion():
			continue
		records.append(
			{
				"entity_id": int(node.get("entity_id")),
				"type_id": str(node.get("type_id")),
				"owner_player_id": int(node.get("owner_player_id")),
				"state": node.call("_wired_save_state"),
			}
		)
	return records


## Server only. Full restore of a saved world: every record is re-evaluated
## (live ids are still skipped, so the call stays idempotent). Compare with
## `restore_pending`, which never resurrects an already restored record.
func load_state(records: Array) -> void:
	_reserve_ids(records)
	_restored_ids.clear()
	_restore_records(records)


## Server only. Incremental restore used after every `package_applied`: records
## of packages that are not registered yet simply stay pending.
func restore_pending(records: Array) -> void:
	# Reserve first: a fresh entity spawned before the saved package arrives
	# must not take an id that a pending record still owns.
	_reserve_ids(records)
	_restore_records(records)


## Called by `MultiplayerSpawner` on every peer. Fills the identity and the
## spawn record, then returns the node without adding it: the spawner owns
## parenting, and the entity's `_ready()` applies the spawn exactly once.
func spawn_function(data: Dictionary) -> Node:
	if _registry == null:
		push_warning("WIRED_DYNAMIC_SPAWN_FAILED reason=no_registry")
		return null
	var type_id := str(data.get("type_id", ""))
	var descriptor := _registry.find_dynamic_entity(type_id)
	if descriptor.is_empty():
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=unknown_type" % type_id
		)
		return null
	var package_id := str(descriptor.get("package_id", ""))
	var context := _registry.get_context(package_id)
	if context == null:
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s package=%s reason=no_context"
			% [type_id, package_id]
		)
		return null
	var instance := context.instantiate(str(descriptor.get("path", "")))
	if instance == null:
		# WiredPackageContext already reported why it failed.
		return null
	var entity := instance as WiredDynamicEntity
	if entity == null:
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=not_dynamic_entity"
			% type_id
		)
		instance.free()
		return null
	entity.setup(
		int(data.get("entity_id", 0)),
		type_id,
		int(data.get("owner_player_id", 0))
	)
	entity.spawn_data = data.duplicate(true)
	entity.name = "Dynamic%d" % entity.entity_id
	entity.set_meta(META_ENTITY_ID, entity.entity_id)
	return entity


func _restore_records(records: Array) -> void:
	if not _is_server():
		return
	if _registry == null:
		return
	for record: Variant in records:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var source: Dictionary = record
		var source_id := int(source.get("entity_id", 0))
		var type_id := str(source.get("type_id", ""))
		if source_id <= 0 or type_id.is_empty():
			continue
		if _restored_ids.has(source_id):
			continue
		# An entity already representing this record (same id or a reassigned
		# one) means the record is restored; never spawn a duplicate.
		if _restored_entity_id(source_id) > 0:
			continue
		# A record whose package has not been applied yet stays pending: the
		# registry cannot instantiate its scene before the entry is registered.
		if _registry.find_dynamic_entity(type_id).is_empty():
			continue
		var state: Variant = source.get("state", {})
		if typeof(state) != TYPE_DICTIONARY:
			state = {}
		var entity_id := source_id
		if _entities.has(entity_id):
			# The id is occupied by a different entity (a fresh spawn that
			# predates the record, a duplicate save, ...). Preserve both: the
			# saved record gets a fresh id instead of being silently dropped.
			push_warning(
				"WIRED_DYNAMIC_RESTORE_ID_IN_USE type=%s entity_id=%d reason=reassigned"
				% [type_id, entity_id]
			)
			entity_id = 0
		var payload := {
			"owner_player_id": int(source.get("owner_player_id", 0)),
			"restore": true,
			"state": state,
		}
		if entity_id > 0:
			payload["entity_id"] = entity_id
		var entity := spawn_entity(type_id, payload)
		if entity == null:
			continue
		# Keep the persisted id on the entity so a later full load recognizes
		# this node even when a collision forced a fresh live id.
		entity.set_meta(META_SOURCE_ENTITY_ID, source_id)
		_restored_ids[source_id] = true


## Advances the allocator past every saved id, including records still waiting
## for their package, so a fresh spawn can never steal a pending id.
func _reserve_ids(records: Array) -> void:
	for record: Variant in records:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var source: Dictionary = record
		var entity_id := int(source.get("entity_id", 0))
		if entity_id <= 0:
			continue
		_next_entity_id = maxi(_next_entity_id, entity_id + 1)


## Live entity that represents a saved record, or 0. Restored entities carry
## `_wired_source_entity_id`, so this also finds records that were reassigned.
func _restored_entity_id(source_id: int) -> int:
	for entity_id: Variant in _entities:
		var node := _entities[entity_id] as Node
		if node == null:
			continue
		if int(node.get_meta(META_SOURCE_ENTITY_ID, -1)) == source_id:
			return int(entity_id)
	return 0


## Normalizes the two accepted payload shapes into the replicated spawn record.
## Package components send flat data (`position`, `direction`, `owner_player_id`)
## while tests and restore send the explicit `state`/`spawn_data` form.
func _spawn_record(
	entity_id: int, qualified_type: String, data: Dictionary
) -> Dictionary:
	var record := {
		"entity_id": entity_id,
		"type_id": qualified_type,
		"owner_player_id": int(data.get("owner_player_id", 0)),
		"restore": bool(data.get("restore", false)),
		"state": {},
		"spawn_data": {},
	}
	var explicit_state: Variant = data.get("state", null)
	if typeof(explicit_state) == TYPE_DICTIONARY:
		record["state"] = (explicit_state as Dictionary).duplicate(true)
	var explicit_spawn: Variant = data.get("spawn_data", null)
	if typeof(explicit_spawn) == TYPE_DICTIONARY:
		record["spawn_data"] = (explicit_spawn as Dictionary).duplicate(true)
	# Flat `position`/`rotation`/`linear_velocity` are initial state; every other
	# flat key (direction, impulse, ...) is one-shot spawn data.
	if not data.has("state"):
		for key: String in STATE_KEYS:
			if data.has(key):
				record["state"][key] = data[key]
	for key: String in RECORD_KEYS:
		record["spawn_data"].erase(key)
	for key: String in STATE_KEYS:
		record["spawn_data"].erase(key)
	for key: Variant in data:
		if RECORD_KEYS.has(str(key)) or STATE_KEYS.has(str(key)):
			continue
		if not record["spawn_data"].has(key):
			record["spawn_data"][key] = data[key]
	return record


func _is_server() -> bool:
	var api := multiplayer
	if api == null:
		return true
	return api.is_server()
