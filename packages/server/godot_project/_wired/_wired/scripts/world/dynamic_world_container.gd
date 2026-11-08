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
## Restore path: `load_state`/`seed_pending`/`restore_pending` are server-only
## and only spawn records whose type is registered. A record whose package has
## not been applied yet stays parked, which lets `main_scene` call
## `restore_pending` after every `package_applied` without knowing the package
## arrival order.
##
## Package reload: `park_package` moves every entity of a package out of the
## tree and keeps its record, so the previous revision's nodes never keep
## running. `restore_pending` brings the records back on the new revision, and
## `purge_package`/`purge_missing_packages` drop the records of a package that is
## gone. `drop_package` is the client path: it frees the local copies without
## keeping a record.
##
## Stamped snapshot: `apply_snapshot` rebuilds an entity whose package revision
## or artifact key is older than the snapshot's, and prunes an entity whose
## package is missing from the snapshot's package map.

const SPAWNER_NAME := "Spawner"
## Set on an entity this peer recreated from a late-join snapshot instead of
## receiving it from the spawner. Nothing else owns its lifetime here.
const META_SNAPSHOT_REPAIR := "_wired_snapshot_repair"
const STATE_KEYS: Array[String] = ["position", "rotation", "linear_velocity"]
const RECORD_KEYS: Array[String] = [
	WiredProtocol.KEY_ENTITY_ID,
	WiredProtocol.KEY_TYPE_ID,
	WiredProtocol.KEY_OWNER_PLAYER_ID,
	WiredProtocol.KEY_RESTORE,
	WiredProtocol.KEY_STATE,
	WiredProtocol.KEY_SPAWN_DATA,
]

var _registry: WiredPackageRegistry = null
var _spawner: MultiplayerSpawner = null
# entity_id -> WiredDynamicEntity
var _entities: Dictionary = {}
# entity_id -> true, so repeated restore_pending calls never duplicate records
var _restored_ids: Dictionary = {}
# Records of entities parked for a package reload, in the persisted shape plus
# their `persistent` flag. Every parked entity is kept, so restoring resumes a
# non-persistent one too; `save_state` persists only the persistent ones.
var _parked: Array[Dictionary] = []
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
	# Only server-authoritative dynamic types can be spawned: a client-owned
	# dynamic entity has no trusted simulation or persistence path in v1.
	if str(descriptor.get("authority", "server")) != "server":
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=authority_not_server"
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
	var entity_id := int(data.get(WiredProtocol.KEY_ENTITY_ID, 0))
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


## Any peer. The index entry always goes: a client that frees nothing here must
## still stop tracking a node the server despawned, otherwise the next snapshot
## or save reads a dead instance. Only the server frees the node itself; freeing
## it tells the spawner to despawn the matching instance on every peer.
func despawn_entity(entity_id: int) -> void:
	var entity: Variant = _entities.get(entity_id)
	_entities.erase(entity_id)
	# `_restored_ids` is intentionally kept: a restored record must not be
	# resurrected by the next `package_applied` after an explicit despawn.
	if not _is_server():
		return
	if not is_instance_valid(entity):
		return
	var node := entity as Node
	if node.is_queued_for_deletion():
		return
	node.queue_free()


## Live entities in id order, one persisted record each, plus the parked ones
## that must survive a reload. The transient spawn data and the restore flag are
## deliberately dropped. Entities registered with `persist: false` are part of
## the world but not of the save file, parked or live.
func save_state() -> Array[Dictionary]:
	var records := _state_records(true)
	var seen: Dictionary = {}
	for record: Dictionary in records:
		seen[int(record.get(WiredProtocol.KEY_ENTITY_ID, 0))] = true
	for record: Dictionary in _parked:
		if not bool(record.get("persistent", true)):
			continue
		var entity_id := int(record.get(WiredProtocol.KEY_ENTITY_ID, 0))
		if entity_id <= 0 or seen.has(entity_id):
			# Live wins: the same record is already represented by its node.
			continue
		seen[entity_id] = true
		records.append(_saved_record(record))
	records.sort_custom(_record_id_before)
	return records


## Live entities for the late-join snapshot, including non-persistent ones:
## a late client must see the current world even when an entity is not saved.
## Parked entities are excluded: they are not in the world right now.
func snapshot_state() -> Array[Dictionary]:
	return _state_records(false)


## Server only. Replaces the saved-record list handed over by `state.json` with
## parked records. Nothing spawns here: `restore_pending` retries them after
## every applied package.
func seed_pending(records: Array) -> void:
	if not _server_only("seed_pending"):
		return
	_parked.clear()
	for record: Variant in records:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		_parked.append(_parked_record(record))
	# Reserve first: a fresh entity spawned before the saved package arrives
	# must not take an id that a pending record still owns.
	_reserve_ids(_parked)


## Copy of the records still waiting for their package, so a caller can log or
## persist them without aliasing the container state.
func pending_records() -> Array:
	return _parked.duplicate(true)


## Server only. Moves every live entity of a package out of the tree and keeps
## its record, so the previous revision's nodes stop running while their world
## state survives the reload.
func park_package(package_id: int) -> int:
	if not _server_only("park_package"):
		return 0
	var parked := 0
	for id: Variant in _entities.keys():
		var entity: Variant = _entities[id]
		if not is_instance_valid(entity):
			_entities.erase(id)
			continue
		if _package_of(str(entity.type_id)) != package_id:
			continue
		_parked.append(
			_parked_record(
				{
					WiredProtocol.KEY_ENTITY_ID: int(id),
					WiredProtocol.KEY_TYPE_ID: str(entity.type_id),
					WiredProtocol.KEY_OWNER_PLAYER_ID:
					int(entity.owner_player_id),
					WiredProtocol.KEY_STATE: entity._wired_save_state(),
					"persistent": bool(entity.persistent),
				}
			)
		)
		_entities.erase(id)
		# The entity is parked, not despawned: its saved record must be able to
		# restore it, so the "already restored" guard is released.
		_restored_ids.erase(
			int(entity.get_meta(WiredProtocol.META_SOURCE_ENTITY_ID, 0))
		)
		_detach_and_free(entity)
		parked += 1
	print("WIRED_DYNAMIC_PARKED package=%d entities=%d" % [package_id, parked])
	return parked


## Client path. Frees this peer's copies of a package's entities without
## keeping a record, and forgets the parked records of that package too.
## Returns the number of live entities dropped.
func drop_package(package_id: int) -> int:
	var dropped := 0
	for id: Variant in _entities.keys():
		var entity: Variant = _entities[id]
		if not is_instance_valid(entity):
			_entities.erase(id)
			continue
		if _package_of(str(entity.type_id)) != package_id:
			continue
		_entities.erase(id)
		_restored_ids.erase(
			int(entity.get_meta(WiredProtocol.META_SOURCE_ENTITY_ID, 0))
		)
		_detach_and_free(entity)
		dropped += 1
	_drop_parked({package_id: true})
	print("WIRED_DYNAMIC_DROPPED package=%d entities=%d" % [package_id, dropped])
	return dropped


## Server only. Stages a package replacement while the current entities remain
## active. The prepared records are restored only during commit.
func prepare_package_reload(package_id: int) -> Dictionary:
	if not _server_only("prepare_package_reload"):
		return {"ok": false}
	var records: Array[Dictionary] = []
	for id: Variant in _entities.keys():
		var entity: Variant = _entities[id]
		if not is_instance_valid(entity) or _package_of(str(entity.type_id)) != package_id:
			continue
		records.append(_parked_record({
			WiredProtocol.KEY_ENTITY_ID: int(id),
			WiredProtocol.KEY_TYPE_ID: str(entity.type_id),
			WiredProtocol.KEY_OWNER_PLAYER_ID: int(entity.owner_player_id),
			WiredProtocol.KEY_STATE: entity._wired_save_state(),
			"persistent": bool(entity.persistent),
		}))
	return {"ok": true, "records": records}


## Commits a staged package replacement, preserving the saved entity ids.
func commit_package_reload(prepared: Dictionary) -> bool:
	if not bool(prepared.get("ok", false)) or not _is_server():
		return false
	var records: Variant = prepared.get("records", [])
	if typeof(records) != TYPE_ARRAY:
		return false
	var package_ids: Dictionary = {}
	for record: Dictionary in records:
		package_ids[_package_of(str(record.get(WiredProtocol.KEY_TYPE_ID, "")))] = true
	for package_id: Variant in package_ids:
		park_package(int(package_id))
	var restored := 0
	for record: Dictionary in records:
		restored += _restore_records([record])
	if restored != records.size():
		return false
	return true


## Server only. Restores every parked record whose package is registered again,
## and keeps the records that still wait. Returns how many entities it spawned.
func restore_pending() -> int:
	if not _is_server() or _registry == null:
		return 0
	var restored := 0
	var remaining: Array[Dictionary] = []
	for record: Dictionary in _parked:
		var spawned := _restore_records([record])
		if spawned <= 0:
			remaining.append(record)
			continue
		restored += spawned
	_parked = remaining
	print(
		"WIRED_DYNAMIC_RESTORED restored=%d pending=%d"
		% [restored, _parked.size()]
	)
	return restored


## Server only. Drops every parked record of one package, whose revision will
## never come back. Returns the number of records dropped.
func purge_package(package_id: int) -> int:
	if not _server_only("purge_package"):
		return 0
	var purged := _drop_parked({package_id: true})
	print("WIRED_DYNAMIC_PURGED package=%d records=%d" % [package_id, purged])
	return purged


## Server only. Keeps the parked records whose package is still published;
## everything else belongs to a package that no longer exists.
func purge_missing_packages(package_ids: PackedStringArray) -> int:
	if not _server_only("purge_missing_packages"):
		return 0
	var allowed: Dictionary = {}
	for package_id: String in package_ids:
		if package_id.is_valid_int():
			allowed[package_id.to_int()] = true
	var stale: Dictionary = {}
	for record: Dictionary in _parked:
		var package_id := _package_of(
			str(record.get(WiredProtocol.KEY_TYPE_ID, ""))
		)
		if not allowed.has(package_id):
			stale[package_id] = true
	var purged := _drop_parked(stale)
	print(
		"WIRED_DYNAMIC_PURGED_MISSING packages=%d records=%d"
		% [package_ids.size(), purged]
	)
	return purged


## Removes the parked records whose package id is a key of `package_ids` and
## returns how many went.
func _drop_parked(package_ids: Dictionary) -> int:
	var kept: Array[Dictionary] = []
	for record: Dictionary in _parked:
		var package_id := _package_of(
			str(record.get(WiredProtocol.KEY_TYPE_ID, ""))
		)
		if package_ids.has(package_id):
			continue
		kept.append(record)
	var dropped := _parked.size() - kept.size()
	_parked = kept
	return dropped


func _record_id_before(left: Dictionary, right: Dictionary) -> bool:
	return int(left.get(WiredProtocol.KEY_ENTITY_ID, 0)) < int(
		right.get(WiredProtocol.KEY_ENTITY_ID, 0)
	)


## Numeric package id of a qualified type (`"<package_id>/<local_type>"`), or
## -1 when the prefix is not numeric. Package ids are numeric on the wire.
func _package_of(type_id: String) -> int:
	var separator := type_id.find("/")
	if separator <= 0:
		return -1
	var prefix := type_id.substr(0, separator)
	if not prefix.is_valid_int():
		return -1
	return prefix.to_int()


## Removes the node from the tree before freeing it, so `MultiplayerSpawner`
## despawns it on every peer and the deterministic node name is immediately
## reusable by the entity that replaces it.
func _detach_and_free(entity: Node) -> void:
	if not is_instance_valid(entity):
		return
	var parent := entity.get_parent()
	if parent != null:
		parent.remove_child(entity)
	entity.queue_free()


func _state_records(only_persistent: bool) -> Array[Dictionary]:
	var records: Array[Dictionary] = []
	var ids := _entities.keys()
	ids.sort()
	for entity_id: Variant in ids:
		var entity: Variant = _entities[entity_id]
		if not _is_live_entity(entity):
			# The engine may free a replicated entity on its own (a despawn
			# packet matched by net id), so the index is pruned here rather than
			# keeping a dead reference for the life of the process.
			_entities.erase(entity_id)
			continue
		var node := entity as Node
		var persistent: Variant = node.get("persistent")
		if only_persistent and persistent != null and not bool(persistent):
			continue
		records.append(
			{
				WiredProtocol.KEY_ENTITY_ID: int(node.get("entity_id")),
				WiredProtocol.KEY_TYPE_ID: str(node.get("type_id")),
				WiredProtocol.KEY_OWNER_PLAYER_ID: int(node.get("owner_player_id")),
				WiredProtocol.KEY_STATE: node.call("_wired_save_state"),
			}
		)
	return records


func _is_live_entity(entity: Variant) -> bool:
	if not is_instance_valid(entity):
		return false
	var node := entity as Node
	return node != null and not node.is_queued_for_deletion()


## Server only. Full restore of a saved world: every record is re-evaluated
## (live ids are still skipped, so the call stays idempotent). Compare with
## `restore_pending`, which only retries the parked records and never
## resurrects an entity that was explicitly despawned.
func load_state(records: Array) -> void:
	_reserve_ids(records)
	_restored_ids.clear()
	_restore_records(records)


## Called by `MultiplayerSpawner` on every peer. Fills the identity and the
## spawn record, then returns the node without adding it: the spawner owns
## parenting, and the entity's `_ready()` applies the spawn exactly once.
func spawn_function(data: Dictionary) -> Node:
	var entity_id := int(data.get(WiredProtocol.KEY_ENTITY_ID, 0))
	if entity_id > 0 and _entities.has(entity_id):
		# A package reload respawns the entity under the same id, and the spawner
		# delivers that packet while the peer may still hold the previous copy.
		# `MultiplayerSpawner` requires a Node from this function, so replace the
		# tracked copy instead of rejecting the spawn: returning null would drop
		# the entity and abort the rest of the replication packet.
		var previous = _entities[entity_id]
		_entities.erase(entity_id)
		if is_instance_valid(previous):
			_detach_and_free(previous)
	var entity := _instantiate_entity(data)
	if entity == null:
		return null
	# Track client-side entities too, so a following snapshot can tell which
	# entities the spawner already delivered. On the server `spawn_entity`
	# records the same node after `spawn()` returns.
	_entities[entity.entity_id] = entity
	return entity


## Client side. Applies a world snapshot stamped with the package map it was
## authored against. Recreates the entities that the spawner dropped because the
## late client's registry was still empty when it replayed the spawns, rebuilds
## an entity whose revision or artifact key is older than the snapshot's, and
## prunes an entity whose package is missing from the map. An entity that is
## already tracked and still current only adopts the fresh authoritative state.
##
## A recreated entity keeps the spawn record's exact name under the spawner's
## `spawn_path` (see the replication note in `PlayersManager`). The *root* was
## never announced by the spawner, so a later authoritative despawn cannot be
## matched by net id; `_entities` is pruned whenever the engine frees the node.
func apply_snapshot(records: Array, packages: Dictionary = {}) -> void:
	if _registry == null:
		push_warning("WIRED_DYNAMIC_SNAPSHOT_SKIPPED reason=no_registry")
		return
	if packages.is_empty() and not records.is_empty():
		# A caller that forgot the package map makes every entity look stale:
		# the snapshot would silently rebuild and prune the whole client world.
		# This is a loud signal, not a fallback: pass the server's map.
		push_warning(
			"WIRED_DYNAMIC_SNAPSHOT_UNSTAMPED records=%d reason=no_package_map"
			% records.size()
		)
	var applied := 0
	var refreshed := 0
	var replaced := 0
	var pruned := 0
	var seen: Dictionary = {}
	for record: Variant in records:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var source := _parked_record(record)
		var entity_id := int(source.get(WiredProtocol.KEY_ENTITY_ID, 0))
		var type_id := str(source.get(WiredProtocol.KEY_TYPE_ID, ""))
		if entity_id <= 0 or type_id.is_empty():
			continue
		# Seen before anything can fail: a record that is rejected here still
		# owns its id, so the prune pass must not treat it as vanished.
		seen[entity_id] = true
		if _entities.has(entity_id):
			var current: Variant = _entities[entity_id]
			if is_instance_valid(current) and not current.is_queued_for_deletion():
				# The snapshot is also the repair path after dropped
				# synchronizer packets (a throttled background tab).
				if not _stamp_stale(current, type_id, packages):
					current._wired_load_state(
						source.get(WiredProtocol.KEY_STATE, {})
					)
					refreshed += 1
					continue
				# The entity is still running the previous package revision:
				# its script and its state layout are stale, so rebuild it.
				_detach_and_free(current)
				replaced += 1
			# A dead tracked instance must not block the repair below.
			_entities.erase(entity_id)
		var entity := _instantiate_entity(
			_restore_payload(source), type_id
		)
		if entity == null:
			continue
		_adopt_repaired_entity(entity)
		print(
			"WIRED_DYNAMIC_REPAIRED_LOCAL type=%s entity_id=%d reason=spawner_spawn_missed"
			% [type_id, entity_id]
		)
		_entities[entity_id] = entity
		applied += 1
	# Prune the local entities the snapshot no longer names, but only when their
	# package is missing from or differs from the snapshot's package map.
	for entity_id: Variant in _entities.keys():
		if seen.has(int(entity_id)):
			continue
		var entity: Variant = _entities[entity_id]
		if not is_instance_valid(entity) or entity.is_queued_for_deletion():
			_entities.erase(entity_id)
			continue
		if _prune_allowed(entity, packages):
			_detach_and_free(entity)
			_entities.erase(entity_id)
			pruned += 1
	print(
		"WIRED_DYNAMIC_SNAPSHOT_APPLIED entities=%d refreshed=%d replaced=%d pruned=%d"
		% [applied, refreshed, replaced, pruned]
	)


## Whether an existing entity must be rebuilt from a snapshot record: its
## package is missing from the map, or the map reports another revision or
## artifact key. `type_id` is the record's type, which may differ from the
## entity's own type after a package moved the entity.
func _stamp_stale(entity: Node, type_id: String, packages: Dictionary) -> bool:
	var stamp: Variant = packages.get(str(_package_of(type_id)))
	if stamp == null:
		return true
	return _stamp_differs(entity, stamp)


## Whether a local entity the snapshot does not name may be pruned: its package
## is missing from the map, or the map reports another revision or artifact key.
func _prune_allowed(entity: Node, packages: Dictionary) -> bool:
	var package_id := str(
		entity.get_meta(WiredProtocol.META_PACKAGE_ID, "")
	)
	var stamp: Variant = packages.get(package_id)
	if stamp == null:
		return true
	return _stamp_differs(entity, stamp)


## Whether the entity was built from another revision or artifact key than the
## snapshot's stamp for its package.
func _stamp_differs(entity: Node, stamp: Variant) -> bool:
	if typeof(stamp) != TYPE_DICTIONARY:
		return true
	var values: Dictionary = stamp
	return (
		int(entity.get_meta(WiredProtocol.META_PACKAGE_REVISION, -1))
		!= int(values.get("revision", -1))
		or str(entity.get_meta(WiredProtocol.META_PACKAGE_ARTIFACT_KEY, ""))
		!= str(values.get("artifact_key", ""))
	)


## Parents a replicated entity that the spawner did not deliver to this peer,
## under the same parent and with the same name the spawner would use.
func _adopt_repaired_entity(entity: WiredDynamicEntity) -> void:
	entity.set_multiplayer_authority(1)
	entity.set_meta(META_SNAPSHOT_REPAIR, true)
	_spawn_parent().add_child(entity)


## The node that owns spawned entities: the spawner's `spawn_path`, or this
## container when no spawner is configured (tests, headless tools).
func _spawn_parent() -> Node:
	if _spawner != null:
		var path := _spawner.spawn_path
		if not path.is_empty():
			var parent := _spawner.get_node_or_null(path)
			if parent != null:
				return parent
	return self


## Builds one entity from a spawn record without parenting it. `type_override`
## mirrors the record shape used by the late-join snapshot, where `type_id` is
## a sibling of the restore payload.
func _instantiate_entity(data: Dictionary, type_override := "") -> WiredDynamicEntity:
	if _registry == null:
		push_warning("WIRED_DYNAMIC_SPAWN_FAILED reason=no_registry")
		return null
	var type_id := (
		type_override
		if not type_override.is_empty()
		else str(data.get(WiredProtocol.KEY_TYPE_ID, ""))
	)
	var descriptor := _registry.find_dynamic_entity(type_id)
	if descriptor.is_empty():
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s reason=unknown_type" % type_id
		)
		return null
	var entity_id := int(data.get(WiredProtocol.KEY_ENTITY_ID, 0))
	if entity_id > 0 and _entities.has(entity_id):
		push_warning(
			"WIRED_DYNAMIC_SPAWN_DUPLICATE type=%s entity_id=%d"
			% [type_id, entity_id]
		)
		return null
	var package_id := str(descriptor.get(WiredProtocol.KEY_PACKAGE_ID, ""))
	var context := _registry.get_context(package_id)
	if context == null:
		push_warning(
			"WIRED_DYNAMIC_SPAWN_FAILED type=%s package=%s reason=no_context"
			% [type_id, package_id]
		)
		return null
	var instance := context.instantiate(str(descriptor.get(WiredProtocol.KEY_PATH, "")))
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
		entity_id,
		type_id,
		int(data.get(WiredProtocol.KEY_OWNER_PLAYER_ID, 0))
	)
	entity.persistent = _descriptor_persists(descriptor)
	entity.spawn_data = data.duplicate(true)
	entity.spawn_data[WiredProtocol.KEY_TYPE_ID] = type_id
	entity.name = entity_name(entity.entity_id)
	entity.set_meta(WiredProtocol.META_ENTITY_ID, entity.entity_id)
	# Registry-created dynamic roots are owned by the container: a revision must
	# never replace a live entity and drop its id, spawn record or spawner
	# tracking.
	entity.set_meta(WiredProtocol.META_REGISTERED, true)
	# Stamp of the package revision the entity was built from. A snapshot with
	# another revision or artifact key rebuilds it instead of reusing it.
	entity.set_meta(WiredProtocol.META_PACKAGE_ID, package_id)
	entity.set_meta(
		WiredProtocol.META_PACKAGE_REVISION,
		context.revision if context != null else 0
	)
	entity.set_meta(
		WiredProtocol.META_PACKAGE_ARTIFACT_KEY,
		context.artifact_key if context != null else ""
	)
	return entity


## Deterministic name of a dynamic entity node. The server's spawn packet and a
## repaired local root must agree, because path-based synchronization resolves
## the synchronizer by node path.
func entity_name(entity_id: int) -> String:
	return "Dynamic%d" % entity_id


func _descriptor_persists(descriptor: Dictionary) -> bool:
	var options: Variant = descriptor.get(WiredProtocol.KEY_OPTIONS, {})
	if typeof(options) != TYPE_DICTIONARY:
		return true
	return bool((options as Dictionary).get("persist", true))


## Server only. Spawns every record whose type is registered and returns how
## many entities it actually created. Records that are already represented stay
## untouched, so callers may hand the same list in again.
func _restore_records(records: Array) -> int:
	if not _is_server():
		return 0
	if _registry == null:
		return 0
	var restored := 0
	for record: Variant in records:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var source := _parked_record(record)
		var source_id := int(source.get(WiredProtocol.KEY_ENTITY_ID, 0))
		var type_id := str(source.get(WiredProtocol.KEY_TYPE_ID, ""))
		if source_id <= 0 or type_id.is_empty():
			continue
		if _restored_ids.has(source_id):
			continue
		# An entity already representing this record (same id or a reassigned
		# one) means the record is restored; never spawn a duplicate.
		if _restored_entity_id(source_id) > 0:
			continue
		# A record whose package has not been applied yet stays parked: the
		# registry cannot instantiate its scene before the entry is registered.
		if _registry.find_dynamic_entity(type_id).is_empty():
			continue
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
			WiredProtocol.KEY_OWNER_PLAYER_ID:
			int(source.get(WiredProtocol.KEY_OWNER_PLAYER_ID, 0)),
			WiredProtocol.KEY_RESTORE: true,
			WiredProtocol.KEY_STATE: source.get(WiredProtocol.KEY_STATE, {}),
		}
		if entity_id > 0:
			payload[WiredProtocol.KEY_ENTITY_ID] = entity_id
		var entity := spawn_entity(type_id, payload)
		if entity == null:
			continue
		# Keep the persisted id on the entity so a later full load recognizes
		# this node even when a collision forced a fresh live id.
		entity.set_meta(WiredProtocol.META_SOURCE_ENTITY_ID, source_id)
		_restored_ids[source_id] = true
		restored += 1
	return restored


## The one persisted record shape: `{entity_id, type_id, owner_player_id,
## state}` plus the `persistent` flag a parked record carries. Every caller
## (`state.json`, a parked record, a world snapshot) is normalized through here,
## so a stray key never reaches the spawn path.
func _parked_record(record: Dictionary) -> Dictionary:
	var state: Variant = record.get(WiredProtocol.KEY_STATE, {})
	return {
		WiredProtocol.KEY_ENTITY_ID: int(
			record.get(WiredProtocol.KEY_ENTITY_ID, 0)
		),
		WiredProtocol.KEY_TYPE_ID: str(record.get(WiredProtocol.KEY_TYPE_ID, "")),
		WiredProtocol.KEY_OWNER_PLAYER_ID: int(
			record.get(WiredProtocol.KEY_OWNER_PLAYER_ID, 0)
		),
		WiredProtocol.KEY_STATE: (
			(state as Dictionary).duplicate(true)
			if typeof(state) == TYPE_DICTIONARY
			else {}
		),
		"persistent": bool(record.get("persistent", true)),
	}


## Persisted form of a parked record: the `persistent` bookkeeping flag never
## reaches `state.json`.
func _saved_record(record: Dictionary) -> Dictionary:
	var saved := _parked_record(record)
	saved.erase("persistent")
	return saved


## Spawn payload of a snapshot record. The restore flag keeps the entity off the
## fresh-spawn path, so a one-shot input is never replayed.
func _restore_payload(record: Dictionary) -> Dictionary:
	return {
		WiredProtocol.KEY_ENTITY_ID: int(record.get(WiredProtocol.KEY_ENTITY_ID, 0)),
		WiredProtocol.KEY_OWNER_PLAYER_ID: int(
			record.get(WiredProtocol.KEY_OWNER_PLAYER_ID, 0)
		),
		WiredProtocol.KEY_RESTORE: true,
		WiredProtocol.KEY_STATE: record.get(WiredProtocol.KEY_STATE, {}),
	}


## Advances the allocator past every saved id, including records still waiting
## for their package, so a fresh spawn can never steal a pending id.
func _reserve_ids(records: Array) -> void:
	for record: Variant in records:
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var source: Dictionary = record
		var entity_id := int(source.get(WiredProtocol.KEY_ENTITY_ID, 0))
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
		if int(node.get_meta(WiredProtocol.META_SOURCE_ENTITY_ID, -1)) == source_id:
			return int(entity_id)
	return 0


## Normalizes a caller payload into the replicated spawn record. The two shapes
## are separate constructors: package components send flat data (`position`,
## `direction`, `owner_player_id`), while tests and restore send the explicit
## `state`/`spawn_data` form. Merging both in one method made every key look
## optional; here each form has exactly one meaning.
func _spawn_record(
	entity_id: int, qualified_type: String, data: Dictionary
) -> Dictionary:
	if data.has(WiredProtocol.KEY_STATE) or data.has(WiredProtocol.KEY_SPAWN_DATA):
		return _explicit_spawn_record(entity_id, qualified_type, data)
	return _flat_spawn_record(entity_id, qualified_type, data)


## Record with `state`/`spawn_data` supplied by the caller. Extra non-record keys
## are still accepted into `spawn_data`, so a caller may mix a record shape with
## a flat one-shot input.
func _explicit_spawn_record(
	entity_id: int, qualified_type: String, data: Dictionary
) -> Dictionary:
	var record := _empty_spawn_record(entity_id, qualified_type, data)
	var explicit_state: Variant = data.get(WiredProtocol.KEY_STATE, null)
	if typeof(explicit_state) == TYPE_DICTIONARY:
		record[WiredProtocol.KEY_STATE] = (explicit_state as Dictionary).duplicate(true)
	var explicit_spawn: Variant = data.get(WiredProtocol.KEY_SPAWN_DATA, null)
	if typeof(explicit_spawn) == TYPE_DICTIONARY:
		record[WiredProtocol.KEY_SPAWN_DATA] = (
			(explicit_spawn as Dictionary).duplicate(true)
		)
	# A record that only names `spawn_data` still gets its flat state keys.
	if not data.has(WiredProtocol.KEY_STATE):
		_copy_flat_state(record, data)
	var spawn_data: Dictionary = record[WiredProtocol.KEY_SPAWN_DATA]
	_strip_reserved_keys(spawn_data)
	for key: Variant in data:
		if _is_reserved_key(key) or spawn_data.has(key):
			continue
		spawn_data[key] = data[key]
	return record


## Record for the flat form: `position`/`rotation`/`linear_velocity` are initial
## state, every other key (direction, impulse, ...) is one-shot spawn data.
func _flat_spawn_record(
	entity_id: int, qualified_type: String, data: Dictionary
) -> Dictionary:
	var record := _empty_spawn_record(entity_id, qualified_type, data)
	_copy_flat_state(record, data)
	var spawn_data: Dictionary = record[WiredProtocol.KEY_SPAWN_DATA]
	for key: Variant in data:
		if _is_reserved_key(key):
			continue
		spawn_data[key] = data[key]
	return record


func _empty_spawn_record(
	entity_id: int, qualified_type: String, data: Dictionary
) -> Dictionary:
	return {
		WiredProtocol.KEY_ENTITY_ID: entity_id,
		WiredProtocol.KEY_TYPE_ID: qualified_type,
		WiredProtocol.KEY_OWNER_PLAYER_ID:
		int(data.get(WiredProtocol.KEY_OWNER_PLAYER_ID, 0)),
		WiredProtocol.KEY_RESTORE: bool(data.get(WiredProtocol.KEY_RESTORE, false)),
		WiredProtocol.KEY_STATE: {},
		WiredProtocol.KEY_SPAWN_DATA: {},
	}


func _copy_flat_state(record: Dictionary, data: Dictionary) -> void:
	for key: String in STATE_KEYS:
		if data.has(key):
			record[WiredProtocol.KEY_STATE][key] = data[key]


## Record keys belong to the record itself and state keys are initial state, so
## neither may leak into the one-shot spawn data.
func _strip_reserved_keys(spawn_data: Dictionary) -> void:
	for key: String in RECORD_KEYS:
		spawn_data.erase(key)
	for key: String in STATE_KEYS:
		spawn_data.erase(key)


func _is_reserved_key(key: Variant) -> bool:
	var name := str(key)
	return RECORD_KEYS.has(name) or STATE_KEYS.has(name)


func _is_server() -> bool:
	var api := multiplayer
	if api == null:
		return true
	return api.is_server()


## Guard of the server-only mutators. A client that calls one of them is a
## programming error, not a no-op: both the runtime log and the warning stream
## name the operation, and the caller returns without touching the world.
func _server_only(op: String) -> bool:
	if _is_server():
		return true
	print("WIRED_DYNAMIC_SERVER_ONLY_OP op=%s" % op)
	push_warning("WIRED_DYNAMIC_SERVER_ONLY_OP op=%s" % op)
	return false
