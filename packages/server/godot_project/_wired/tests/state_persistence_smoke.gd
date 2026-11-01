extends SceneTree

## Headless smoke test for the main-scene save/load integration.
##
## `main_scene._save_state` writes `players` and `dynamic_world` into
## `state.json`; `_load_state` seeds the dynamic records into the world's parked
## list (they are spawned later, after their package is applied) and hands player
## records to `PlayersManager`. The suite also proves that `main.tscn` reuses its
## authored dynamic spawner instead of adding a second one, that
## `Global.dynamic_world` is typed and registered, and that a parked record
## survives a save/load cycle.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/state_persistence_smoke.gd --quit-after 2

const MAIN_SCENE := "res://_wired/scenes/main.tscn"
const CRATE_TYPE := "pkg.state/crate"
const STATE_DIR := "user://wired_state_persistence_smoke"
## Save/load of a parked record needs a real dynamic type: the numeric package id
## and the fixture are the same ones `dynamic_world_smoke` uses.
const DYNAMIC_FIXTURE_ROOT := "res://tests/fixtures/dynamic_root"
const CRATE_SCENE := "crate.tscn"
const STAMP_PACKAGE_ID := "42"
const STAMP_PACKAGE_NUMBER := 42
const STAMP_CRATE_TYPE := "42/box"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _registries: Array[Node] = []


## Minimal dynamic record source: persistence plumbing does not need a physics
## body or a synchronizer (the dynamic world suite owns that path).
class FakeDynamicEntity extends Node:

	var entity_id := 0
	var type_id := ""
	var owner_player_id := 0

	func _wired_save_state() -> Dictionary:
		return {
			"position": [16.0, 32.0],
			"rotation": 0.0,
			"linear_velocity": [0.0, 0.0],
		}


## Records the parsed id list that `_apply_room_packages` hands to the players
## manager, so the suite proves both purges receive the same authoritative list.
class FakePlayersManager extends PlayersManager:

	var purged_missing: Array = []

	func purge_missing_packages(package_ids: PackedStringArray) -> void:
		purged_missing.append(package_ids)


## Source of the package-op probe. It must be compiled at runtime: this suite is
## the `--script` entry point, so a parse-time `extends` of `main_scene.gd` is
## resolved before the `Global` autoload exists and fails with
## "Identifier not found: Global". The probe never enters the tree and never
## calls `_ready`; it only overrides the two operations and the reconcile.
const PACKAGE_OP_PROBE_SOURCE := """
extends "res://_wired/scripts/main_scene.gd"

var order: Array[String] = []
## Emitted by the test to let the suspended operation finish.
signal gate

func _apply_package_revision(package_id: int, revision: int) -> void:
	order.append("apply:start:%d:%d" % [package_id, revision])
	await gate
	order.append("apply:end:%d:%d" % [package_id, revision])

func _apply_client_package(package_id: int, revision: int) -> void:
	order.append("client_apply:start:%d:%d" % [package_id, revision])
	await gate
	order.append("client_apply:end:%d:%d" % [package_id, revision])

func _apply_package_removal(
	package_id: int, purge: bool, _request_snapshot := true
) -> void:
	order.append("unload:%d:%s" % [package_id, purge])

func _reconcile_client_packages(_remote: Dictionary) -> bool:
	return true
"""


## Source of the entry-path probe. It exercises `_reconcile_client_packages`,
## `_apply_package_removal` and `_schedule_package_retry` themselves, so it does
## NOT override them: the collaborators are replaced by stub subclasses instead.
##
## The stub classes are subclasses of the real ones because `main_scene.gd` types
## its fields (`_packages: PackagesManager`, `_net: WiredNetwork`, ...): GDScript
## rejects assigning a plain duck-typed object there. The probe overrides
## `_ready` (the startup path is not under test) and its `StubNetwork` overrides
## `_enter_tree` so the probe's child does not reconfigure `/root`'s multiplayer
## API. `_schedule_package_retry` needs a real `get_tree()` (a native method that
## cannot be overridden), so this probe is attached to `root` with stub children
## that satisfy the scene's `@onready` lookups.
const ENTRY_PROBE_SOURCE := """
extends "res://_wired/scripts/main_scene.gd"

var removal_calls: Array = []

class StubNetwork extends WiredNetwork:
	var removed: Array[int] = []
	var snapshot_requests := 0
	func _enter_tree() -> void:
		pass
	func remove_package_revision(package_id: int) -> void:
		removed.append(package_id)
	func request_world_snapshot() -> void:
		snapshot_requests += 1

class StubPackages extends PackagesManager:
	var applied: Dictionary = {}
	var forgotten: Array = []
	var sync_calls: Array = []
	var sync_result: Dictionary = {"ok": true, "revision": 1}
	func applied_packages() -> Dictionary:
		return applied.duplicate(true)
	func forget_package(package_id: int, purge := false) -> void:
		forgotten.append([package_id, purge])
		applied.erase(str(package_id))
	func sync_package(package_id: int, revision_hint := 0) -> Dictionary:
		sync_calls.append([package_id, revision_hint])
		if bool(sync_result.get("ok", false)):
			applied[str(package_id)] = {
				"revision": revision_hint,
				"artifact_key": "synced",
			}
		return sync_result

class StubRegistry extends WiredPackageRegistry:
	var cleared: Array[String] = []
	func clear_package(package_id: String) -> void:
		cleared.append(package_id)

class StubStaticWorld extends StaticWorldContainer:
	var rebuilds := 0
	func rebuild() -> void:
		rebuilds += 1

class StubPlayers extends PlayersManager:
	var rebuilds := 0
	var purged: Array[int] = []
	func rebuild_live_components() -> int:
		rebuilds += 1
		return 0
	func purge_package(package_id: int) -> void:
		purged.append(package_id)

class StubDynamicWorld extends DynamicWorldContainer:
	var parked: Array[int] = []
	var dropped: Array[int] = []
	var purged: Array[int] = []
	func park_package(package_id: int) -> int:
		parked.append(package_id)
		return 0
	func drop_package(package_id: int) -> int:
		dropped.append(package_id)
		return 0
	func purge_package(package_id: int) -> int:
		purged.append(package_id)
		return 0

func _ready() -> void:
	pass

## Records what `_reconcile_client_packages` asks for, then runs the real removal.
func _apply_package_removal(
	package_id: int, purge: bool, request_snapshot := true
) -> void:
	removal_calls.append([package_id, purge, request_snapshot])
	super._apply_package_removal(package_id, purge, request_snapshot)

## Builds the stubs and the children the scene's `@onready` fields resolve.
func make_stubs() -> void:
	var net := StubNetwork.new()
	net.name = "Net"
	add_child(net)
	var ui := Node.new()
	ui.name = "UI"
	add_child(ui)
	var margin := Node.new()
	margin.name = "Margin"
	ui.add_child(margin)
	var vbox := Node.new()
	vbox.name = "VBox"
	margin.add_child(vbox)
	var status := Label.new()
	status.name = "Status"
	vbox.add_child(status)
	var log_view := RichTextLabel.new()
	log_view.name = "Log"
	vbox.add_child(log_view)
	_registry = StubRegistry.new()
	_packages = StubPackages.new()
	_static_world = StubStaticWorld.new()
	_players = StubPlayers.new()
	_dynamic_world = StubDynamicWorld.new()
"""


## Source of the room-packages probe. Runtime compilation is needed for the same
## reason as the other probes; only the two collaborators are replaced, and the
## real dynamic world is kept so its parked records stay observable.
const ROOM_PACKAGES_PROBE_SOURCE := """
extends "res://_wired/scripts/main_scene.gd"

func _ready() -> void:
	pass

func make_stubs(world: DynamicWorldContainer, players: PlayersManager) -> void:
	_dynamic_world = world
	_players = players
"""


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_main_scene_uses_the_authored_dynamic_spawner()
	_test_save_and_load_round_trip()
	_test_parked_dynamic_records_are_saved_and_reseeded()
	_test_room_packages_purges_only_unlisted_ids()
	await _test_package_ops_are_serialized()
	await _test_world_snapshot_waits_for_a_running_package_op()
	await _test_reconcile_unloads_a_package_missing_from_the_server()
	await _test_reconcile_syncs_a_changed_revision()
	await _test_reconcile_schedules_a_retry_when_a_download_fails()
	await _test_package_retry_is_single_flight()
	_test_package_removal_announces_on_server_and_requests_on_client()
	_free_owned()
	_finish()


func _test_main_scene_uses_the_authored_dynamic_spawner() -> void:
	var main: Variant = _instantiate_main()
	if main == null:
		return
	var dynamic_world: Variant = main.get_node_or_null(
		"Game/SubViewport/DynamicWorld"
	)
	_check(
		dynamic_world is DynamicWorldContainer,
		"main.tscn must attach DynamicWorldContainer to DynamicWorld",
	)
	if not (dynamic_world is DynamicWorldContainer):
		return
	_check(
		dynamic_world.get_node_or_null("Spawner") is MultiplayerSpawner,
		"main.tscn must keep its authored Spawner",
	)
	_check(
		_count_spawners(dynamic_world) == 1,
		"setup must never add a second dynamic spawner, got %d"
		% _count_spawners(dynamic_world),
	)
	var global := root.get_node_or_null("Global")
	_check(global != null, "the Global autoload must exist")
	if global != null:
		_check(
			global.get("dynamic_world") == dynamic_world,
			"Global.dynamic_world must reference the scene container",
		)


func _test_save_and_load_round_trip() -> void:
	var main: Variant = _instantiate_main()
	if main == null:
		return
	var dynamic_world := main._dynamic_world as DynamicWorldContainer
	var entity := FakeDynamicEntity.new()
	entity.entity_id = 77
	entity.type_id = CRATE_TYPE
	entity.owner_player_id = 5
	dynamic_world.add_child(entity)
	dynamic_world._entities[entity.entity_id] = entity

	main._state_dir = STATE_DIR
	_clean_state_dir()
	main._save_state("smoke")
	var saved := _read_state()
	_check(not saved.is_empty(), "save_state must write readable JSON")
	_check(
		saved.get("players", null) is Array,
		"state.json must contain a `players` array",
	)
	var dynamic_records: Variant = saved.get("dynamic_world", null)
	_check(
		dynamic_records is Array and dynamic_records.size() == 1,
		"state.json must contain the live dynamic record, got %s"
		% [dynamic_records],
	)
	if dynamic_records is Array and dynamic_records.size() == 1:
		var record: Dictionary = dynamic_records[0]
		_check(
			record.get("entity_id") == entity.entity_id,
			"the saved dynamic record must keep the entity id",
		)
		_check(
			record.get("type_id") == CRATE_TYPE,
			"the saved dynamic record must keep the qualified type",
		)
		_check(
			not record.has("spawn_data"),
			"the saved dynamic record must not contain transient spawn data",
		)

	# A fresh load only seeds the parked records; the entity itself is
	# restored after `package_applied`, not by `_load_state`.
	var reloaded: Variant = _instantiate_main()
	if reloaded == null:
		return
	reloaded._state_dir = STATE_DIR
	reloaded._load_state()
	_check(
		reloaded._dynamic_world.pending_records().size() == 1,
		"_load_state must seed the dynamic records, got %d"
		% reloaded._dynamic_world.pending_records().size(),
	)
	_check(
		reloaded._dynamic_world._entities.is_empty(),
		"_load_state must not spawn before the package is applied",
	)
	# Drop the record before teardown; nothing is replication-tracked here.
	dynamic_world._entities.erase(entity.entity_id)
	entity.free()


## A parked record is not lost by a save/load cycle: `save_state` persists it
## although it is not in the tree, and `seed_pending` brings it back to the
## parked list of a fresh world, where `restore_pending` spawns it again.
func _test_parked_dynamic_records_are_saved_and_reseeded() -> void:
	var world := _new_world()
	var entity := world.spawn_entity(
		STAMP_CRATE_TYPE, {"state": {"position": [16.0, 32.0]}}
	)
	_check(entity != null, "the parked-record test needs a spawned entity")
	if entity == null:
		return
	var entity_id: int = entity.entity_id
	_check(
		world.park_package(STAMP_PACKAGE_NUMBER) == 1,
		"park must take the entity out of the tree",
	)

	var saved := world.save_state()
	_check(
		saved.size() == 1,
		"a parked entity must still be saved, got %d records" % saved.size(),
	)
	if saved.size() != 1:
		return
	_check(
		saved[0].get("entity_id") == entity_id,
		"the saved parked record must keep the entity id, got %s"
		% [saved[0].get("entity_id")],
	)
	_check(
		not saved[0].has("persistent"),
		"the save format must not leak the parked bookkeeping flag, got %s"
		% [saved[0]],
	)

	var reloaded := _new_world()
	reloaded.seed_pending(saved)
	_check(
		reloaded.pending_records().size() == 1,
		"seed_pending must park the saved record, got %d"
		% reloaded.pending_records().size(),
	)
	_check(
		reloaded.restore_pending() == 1,
		"parked entity returns after a save/load cycle",
	)
	_check(
		reloaded._entities.has(entity_id),
		"the restored entity must keep its saved id, got %s"
		% [reloaded._entities.keys()],
	)


## `room-packages <csv>` carries the authoritative publish list: parked records
## of every package the room still lists must survive, records of a package that
## is gone must be dropped. Parse quirks of the wire format must not change it.
func _test_room_packages_purges_only_unlisted_ids() -> void:
	var probe: Variant = _make_room_packages_probe()
	if probe == null:
		return
	var world := probe._dynamic_world as DynamicWorldContainer
	var players: Variant = probe._players
	world.seed_pending(_room_package_records(10))

	probe._apply_room_packages("42,43")

	var kept := _pending_packages(world)
	_check(
		kept.has(42) and kept.has(43),
		"room-packages must keep the parked records of every listed package, got %s"
		% [kept],
	)
	_check(
		not kept.has(99),
		"room-packages must drop the parked record of an unlisted package, got %s"
		% [kept],
	)
	_check(
		players.purged_missing == [PackedStringArray(["42", "43"])],
		"room-packages must hand the parsed ids to the players manager, got %s"
		% [players.purged_missing],
	)

	# The command is a comma-separated wire string: surrounding spaces and empty
	# entries must be ignored instead of inventing or losing a package.
	world.seed_pending(_room_package_records(20))
	probe._apply_room_packages(" 42 , ,43 ")
	kept = _pending_packages(world)
	_check(
		kept.has(42) and kept.has(43) and not kept.has(99),
		"spaces and empty entries must not change the parsed package list, got %s"
		% [kept],
	)
	probe.free()


## The queue is the only entry point that mutates packages, so a suspended apply
## must block a client apply and an unload behind it.
func _test_package_ops_are_serialized() -> void:
	var probe: Variant = _make_package_op_probe()
	if probe == null:
		return
	probe._enqueue_package_op({"kind": "apply", "id": 42, "revision": 1})
	probe._enqueue_package_op({"kind": "client_apply", "id": 42, "revision": 2})
	probe._enqueue_package_op({"kind": "unload", "id": 43, "purge": false})
	_check(
		probe.order == ["apply:start:42:1"],
		"only the first package op may start while it is suspended, got %s"
		% [probe.order],
	)
	_check(
		probe._package_ops_busy,
		"the queue must report itself busy while an op is suspended",
	)
	_check(
		probe._package_ops_queue.size() == 2,
		"the queued ops must wait behind the suspended one, got %d"
		% probe._package_ops_queue.size(),
	)

	probe.gate.emit()
	await process_frame
	await process_frame
	_check(
		probe.order
		== ["apply:start:42:1", "apply:end:42:1", "client_apply:start:42:2"],
		"a client apply must start only after the apply finished, got %s"
		% [probe.order],
	)

	probe.gate.emit()
	await process_frame
	await process_frame
	_check(
		probe.order
		== [
			"apply:start:42:1",
			"apply:end:42:1",
			"client_apply:start:42:2",
			"client_apply:end:42:2",
			"unload:43:false",
		],
		"the queue must run apply, client_apply and unload in order, got %s"
		% [probe.order],
	)
	_check(not probe._package_ops_busy, "the queue must clear its busy flag")
	probe.free()


## A snapshot arriving during a suspended op must be stored, not applied: its
## reconcile could otherwise unload a package the running op is still applying.
func _test_world_snapshot_waits_for_a_running_package_op() -> void:
	var probe: Variant = _make_package_op_probe()
	if probe == null:
		return
	# The replay reaches `applied_packages()`; an empty manager matches the empty
	# remote map without any network access.
	probe._packages = PackagesManager.new()
	probe._enqueue_package_op({"kind": "apply", "id": 42, "revision": 1})
	var snapshot := {WiredProtocol.KEY_PACKAGES: {}}
	probe._apply_world_snapshot(snapshot)
	_check(
		probe._pending_world_snapshot == snapshot,
		"a snapshot must be deferred while a package op is suspended, got %s"
		% [probe._pending_world_snapshot],
	)
	_check(
		probe._package_ops_busy,
		"a deferred snapshot must not clear the busy flag",
	)

	probe.gate.emit()
	await process_frame
	await process_frame
	await process_frame
	_check(
		probe._pending_world_snapshot.is_empty(),
		"the deferred snapshot must be replayed after the op finishes, got %s"
		% [probe._pending_world_snapshot],
	)
	_check(not probe._package_ops_busy, "the replay must release the mutex")
	probe._packages.free()
	probe.free()


## The server map is authoritative: a package this peer applied but the server no
## longer lists must be removed before the snapshot is applied, and the removal
## must not request a snapshot of its own.
func _test_reconcile_unloads_a_package_missing_from_the_server() -> void:
	var probe: Variant = _make_entry_probe()
	if probe == null:
		return
	var net: Variant = probe._net
	var packages: Variant = probe._packages
	net.mode = "client"
	packages.applied = {
		"43": {"revision": 1, "artifact_key": "k43"},
		"44": {"revision": 2, "artifact_key": "k44"},
	}
	var remote := {"44": {"revision": 2, "artifact_key": "k44"}}

	var ok: bool = await probe._reconcile_client_packages(remote)

	_check(ok, "a reconcile without downloads must succeed")
	_check(
		probe.removal_calls == [[43, false, false]],
		"the missing package must be removed without purge and snapshot, got %s"
		% [probe.removal_calls],
	)
	_check(
		not packages.applied_packages().has("43"),
		"the unloaded package must leave the applied map, got %s"
		% [packages.applied_packages()],
	)
	_check(
		probe._registry.cleared == ["43"],
		"the registry must forget the removed package, got %s"
		% [probe._registry.cleared],
	)
	_check(
		probe._dynamic_world.dropped == [43],
		"a client must drop the removed package's entities, got %s"
		% [probe._dynamic_world.dropped],
	)
	_check(
		probe._players.rebuilds == 1 and probe._static_world.rebuilds == 1,
		"the removal must rebuild players and static content exactly once",
	)
	_check(
		int(net.snapshot_requests) == 0,
		"a reconcile removal must not request a snapshot, got %d"
		% net.snapshot_requests,
	)
	_check(net.removed.is_empty(), "a client removal must not announce a revision")
	_free_entry_probe(probe)


## A package the server lists at another revision or artifact key must be synced
## before the snapshot is applied; an identical entry is skipped.
func _test_reconcile_syncs_a_changed_revision() -> void:
	var probe: Variant = _make_entry_probe()
	if probe == null:
		return
	var net: Variant = probe._net
	var packages: Variant = probe._packages
	net.mode = "client"
	packages.applied = {
		"41": {"revision": 1, "artifact_key": "same"},
		"42": {"revision": 2, "artifact_key": "old"},
	}
	var remote := {
		"41": {"revision": 1, "artifact_key": "same"},
		"42": {"revision": 2, "artifact_key": "new"},
	}

	var ok: bool = await probe._reconcile_client_packages(remote)

	_check(ok, "a successful sync must make the reconcile return true")
	_check(
		packages.sync_calls == [[42, 2]],
		"only the package with a changed artifact key may be synced, got %s"
		% [packages.sync_calls],
	)
	_check(
		str(packages.applied_packages().get("42", {}).get("artifact_key", ""))
		== "synced",
		"the applied map must report the synced artifact, got %s"
		% [packages.applied_packages()],
	)
	_check(probe.removal_calls.is_empty(), "a matching package must not be unloaded")
	_free_entry_probe(probe)


## A failed download must make the reconcile return false and start exactly one
## retry chain; the backoff is time-scaled so the real timer path still runs.
func _test_reconcile_schedules_a_retry_when_a_download_fails() -> void:
	var probe: Variant = _make_entry_probe()
	if probe == null:
		return
	var net: Variant = probe._net
	var packages: Variant = probe._packages
	net.mode = "client"
	packages.applied = {}
	packages.sync_result = {"ok": false, "error": "boom"}
	var previous_scale := Engine.time_scale
	Engine.time_scale = 10000.0

	var ok: bool = await probe._reconcile_client_packages(
		{"42": {"revision": 3, "artifact_key": "k3"}}
	)

	_check(not ok, "a failed download must make the reconcile return false")
	_check(
		packages.sync_calls == [[42, 3]],
		"the failed package must be attempted once, got %s"
		% [packages.sync_calls],
	)
	_check(
		probe._package_retry_in_flight,
		"a failed download must start the retry chain",
	)
	_check(
		probe._package_retry_attempts == 1,
		"the first failure must count one attempt, got %d"
		% probe._package_retry_attempts,
	)
	await process_frame
	await process_frame
	await process_frame
	Engine.time_scale = previous_scale
	_check(
		int(net.snapshot_requests) == 1,
		"the fired retry must request exactly one snapshot, got %d"
		% net.snapshot_requests,
	)
	_check(
		not probe._package_retry_in_flight,
		"the fired retry must clear its single-flight flag",
	)
	_free_entry_probe(probe)


## Two failures in a row must not stack retry chains: the second call returns at
## the in-flight guard, so only one attempt is counted and one request is sent.
func _test_package_retry_is_single_flight() -> void:
	var probe: Variant = _make_entry_probe()
	if probe == null:
		return
	var net: Variant = probe._net
	net.mode = "client"
	var previous_scale := Engine.time_scale
	Engine.time_scale = 10000.0

	probe._schedule_package_retry(42, "boom")
	_check(
		probe._package_retry_in_flight,
		"the first call must start the retry chain",
	)
	_check(
		probe._package_retry_attempts == 1,
		"the first call must count one attempt, got %d"
		% probe._package_retry_attempts,
	)
	_check(
		int(net.snapshot_requests) == 0,
		"the request happens only after the backoff",
	)

	probe._schedule_package_retry(42, "boom")
	_check(
		probe._package_retry_attempts == 1,
		"a call while the chain is in flight must not count an attempt, got %d"
		% probe._package_retry_attempts,
	)
	_check(
		int(net.snapshot_requests) == 0,
		"a call while the chain is in flight must not send a request, got %d"
		% net.snapshot_requests,
	)

	await process_frame
	await process_frame
	await process_frame
	Engine.time_scale = previous_scale
	_check(
		int(net.snapshot_requests) == 1,
		"the two calls must produce exactly one snapshot request, got %d"
		% net.snapshot_requests,
	)
	_check(
		not probe._package_retry_in_flight,
		"the fired retry must clear its single-flight flag",
	)
	_free_entry_probe(probe)


## Server: the removal parks the entities, purges them when asked and announces
## the dropped revision. Client: it drops local copies and asks for a snapshot,
## never announcing a revision.
func _test_package_removal_announces_on_server_and_requests_on_client() -> void:
	var probe: Variant = _make_entry_probe()
	if probe == null:
		return
	var net: Variant = probe._net
	var packages: Variant = probe._packages
	var dynamic_world: Variant = probe._dynamic_world
	var players: Variant = probe._players

	net.mode = "server"
	probe._apply_package_removal(42, true)
	_check(
		net.removed == [42],
		"the server must announce the removed revision, got %s" % [net.removed],
	)
	_check(
		dynamic_world.parked == [42],
		"the server must park the package's entities, got %s"
		% [dynamic_world.parked],
	)
	_check(
		dynamic_world.purged == [42],
		"a purging removal must drop the parked records, got %s"
		% [dynamic_world.purged],
	)
	_check(
		players.purged == [42],
		"a purging removal must drop the player component state, got %s"
		% [players.purged],
	)
	_check(
		probe._registry.cleared == ["42"],
		"the registry must forget the removed package, got %s"
		% [probe._registry.cleared],
	)
	_check(
		packages.forgotten == [[42, true]],
		"the package must be forgotten with purge=true, got %s"
		% [packages.forgotten],
	)
	_check(
		probe._static_world.rebuilds == 1 and players.rebuilds == 1,
		"the removal must rebuild static content and live players once",
	)
	_check(
		int(net.snapshot_requests) == 0,
		"a server removal must not request a snapshot, got %d"
		% net.snapshot_requests,
	)

	net.mode = "client"
	probe._apply_package_removal(43, false)
	_check(
		net.removed == [42],
		"a client removal must not announce a revision, got %s" % [net.removed],
	)
	_check(
		dynamic_world.dropped == [43],
		"a client must drop the removed package's entities, got %s"
		% [dynamic_world.dropped],
	)
	_check(
		int(net.snapshot_requests) == 1,
		"a client removal must request a snapshot, got %d" % net.snapshot_requests,
	)
	_check(
		packages.forgotten == [[42, true], [43, false]],
		"the client must forget without purge, got %s" % [packages.forgotten],
	)
	_free_entry_probe(probe)


# --- helpers --------------------------------------------------------------


## Compiles the package-op probe at runtime. See `PACKAGE_OP_PROBE_SOURCE` for
## why a parse-time inner class cannot be used in this `--script` suite.
func _make_package_op_probe() -> Node:
	var script := GDScript.new()
	script.source_code = PACKAGE_OP_PROBE_SOURCE
	var err := script.reload()
	_check(err == OK, "the package-op probe must compile, err=%d" % err)
	if err != OK:
		return null
	var probe := script.new() as Node
	_check(probe != null, "the package-op probe must instantiate")
	return probe


## Compiles the entry-path probe at runtime (see `ENTRY_PROBE_SOURCE`), builds
## its stubs and attaches it to the tree: `_schedule_package_retry` awaits a real
## `get_tree().create_timer(...)`, and `get_tree()` cannot be overridden.
func _make_entry_probe() -> Variant:
	var script := GDScript.new()
	script.source_code = ENTRY_PROBE_SOURCE
	var err := script.reload()
	_check(err == OK, "the entry probe must compile, err=%d" % err)
	if err != OK:
		return null
	var probe: Variant = script.new()
	_check(probe != null, "the entry probe must instantiate")
	if probe == null:
		return null
	probe.make_stubs()
	root.add_child(probe)
	return probe


## Compiles the room-packages probe (see `ROOM_PACKAGES_PROBE_SOURCE`) and wires
## a real dynamic world, whose parked records the suite inspects, plus a
## recording players manager so both purges are proven to receive the same ids.
func _make_room_packages_probe() -> Variant:
	var script := GDScript.new()
	script.source_code = ROOM_PACKAGES_PROBE_SOURCE
	var err := script.reload()
	_check(err == OK, "the room-packages probe must compile, err=%d" % err)
	if err != OK:
		return null
	var probe: Variant = script.new()
	_check(probe != null, "the room-packages probe must instantiate")
	if probe == null:
		return null
	var players := FakePlayersManager.new()
	_owned.append(players)
	probe.make_stubs(_new_world(), players)
	return probe


## Three parked records, one per package, with entity ids that stay unique when
## the suite seeds the world a second time.
func _room_package_records(first_entity_id: int) -> Array:
	return [
		{"entity_id": first_entity_id, "type_id": "42/x", "state": {}},
		{"entity_id": first_entity_id + 1, "type_id": "43/y", "state": {}},
		{"entity_id": first_entity_id + 2, "type_id": "99/z", "state": {}},
	]


## Numeric package ids of the parked records, in record order.
func _pending_packages(world: DynamicWorldContainer) -> Array:
	var ids: Array = []
	for record: Dictionary in world.pending_records():
		var prefix := str(record.get("type_id", "")).get_slice("/", 0)
		if prefix.is_valid_int():
			ids.append(prefix.to_int())
	return ids


## Frees the entry probe's stubs before the probe itself: they are not children,
## so freeing the probe alone would leak them (and Godot reports the leak).
func _free_entry_probe(probe: Variant) -> void:
	for field: String in [
		"_packages",
		"_registry",
		"_static_world",
		"_players",
		"_dynamic_world",
	]:
		var stub: Variant = probe.get(field)
		if stub != null and is_instance_valid(stub):
			stub.free()
	probe.free()


func _instantiate_main() -> Node:
	var packed := load(MAIN_SCENE) as PackedScene
	_check(packed != null, "main.tscn must load")
	if packed == null:
		return null
	var main := packed.instantiate()
	if main == null:
		_check(false, "main.tscn must instantiate")
		return null
	_owned.append(main)
	root.add_child(main)
	return main


## A headless world with one registered numeric package. The runtime package id
## must be numeric because component and entity keys are addressed by it.
func _new_world() -> DynamicWorldContainer:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var context := WiredPackageContext.new()
	context.package_id = STAMP_PACKAGE_ID
	context.root_path = DYNAMIC_FIXTURE_ROOT
	context.revision = 1
	context.artifact_key = "k1"
	registry.register_context(STAMP_PACKAGE_ID, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = STAMP_PACKAGE_ID
	registration.add_dynamic_entity("box", CRATE_SCENE)
	registry.add_registration(registration)
	var world := DynamicWorldContainer.new()
	root.add_child(world)
	_owned.append(world)
	world.setup(registry, null)
	return world


func _count_spawners(node: Node) -> int:
	var count := 0
	for child: Node in node.get_children():
		if child is MultiplayerSpawner:
			count += 1
	return count


func _clean_state_dir() -> void:
	var path := STATE_DIR.path_join("state.json")
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
	var dir := ProjectSettings.globalize_path(STATE_DIR)
	if DirAccess.dir_exists_absolute(dir):
		DirAccess.remove_absolute(dir)


func _read_state() -> Dictionary:
	var file := FileAccess.open(STATE_DIR.path_join("state.json"), FileAccess.READ)
	if file == null:
		return {}
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		return {}
	return parsed


func _free_owned() -> void:
	_clean_state_dir()
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
		print("STATE_PERSISTENCE_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("STATE_PERSISTENCE_SMOKE_FAILED %s" % message)
	quit(1)
