extends Node

## Entry point for both runtime modes of the game build:
##
##   server: godot --headless --path . --server --port <p> --room <room>
##           [--api-url <url>]   (package files are fetched over HTTP)
##   client: godot --path . --url ws://host:port --ticket <ticket> --room <room>
##   web:    loaded inside the Wired Game tab; endpoint, ticket and room arrive
##           over the same-origin postMessage bridge, never in the URL.
##
## The server never receives the ticket secret through argv: it is read from
## the WIRED_GAME_TICKET_SECRET environment variable set by the backend.

const DEFAULT_ROOM := "local-room"
const DEFAULT_PORT := 19001
const DEFAULT_BIND := "127.0.0.1"
## The host may spend a while starting the native runtime and applying the
## room's package revisions before it can mint a ticket. Wait longer than that
## startup, otherwise a cold reconnect fails with a misleading "no config".
const BRIDGE_CONFIG_TIMEOUT_SEC := 120.0
## Preloaded by path: a newly added `class_name` is not in the global class
## cache until the editor imports it, and headless `--script` runs must not
## depend on that import step.
const SnapshotRules := preload("res://_wired/scripts/network/world_snapshot.gd")
## `default_game_root` is typed `Node` rather than `WiredGameScene`: a new
## `class_name` is absent from the global class cache until the editor imports
## it, and headless `--script` runs must not depend on that import step.
const WiredGameSceneScript := preload("res://_wired/scripts/world/wired_game_scene.gd")

@export var default_game_root: Node
@export var net: WiredNetwork
@export var ui: CanvasLayer
@export var status_label: Label
@export var log_label: RichTextLabel
@export var static_world: StaticWorldContainer
@export var dynamic_world: DynamicWorldContainer
@export var dynamic_spawner: MultiplayerSpawner
@export var players_manager: PlayersManager
@export var players_spawner: MultiplayerSpawner

var _server_port := 0
var _state_dir := ""
var _control_thread: Thread = null
var _state_save_timer: Timer = null
var _state_save_interval_ms := 30_000
var _shutdown_in_progress := false
var _authenticated_once := false
var _auth_error_reported := false
var _packages: PackagesManager
var _registry: WiredPackageRegistry
## Корень, который сейчас стоит под `Main`: штатный Game или сцена пакета.
var _game_root: Node
## Штатный `Main/Game`, снятый с дерева, но сохранённый для fallback.
var _default_game_root: Node
## Идентичность установленной main-сцены; пусто для штатного Game.
var _game_scene_key := ""
## Names owned by the core inside `world_viewport`. A package scene that
## authors one of them would make Godot rename the live service to a
## non-deterministic `@Node@N`, so the server and client would disagree on the
## multiplayer node paths. Such a scene is rejected instead of installed.
var _reserved_service_names: PackedStringArray = PackedStringArray()
## Package apply/unload operations are serialized: two overlapping applies would
## interleave registry clears with entry loads and restores, and a removal that
## arrives during an apply would run against a half-applied registry.
var _package_ops_busy := false
var _package_ops_queue: Array[Dictionary] = []
## Server side: package ids the room still publishes, as announced by the
## backend. Dynamic records are spawned only after this chain is fully applied:
## a later package in the same chain may author the static world they stand on.
var _room_package_ids: PackedStringArray = PackedStringArray()
var _room_packages_known := false
## Client side: one package retry chain at a time. Every failed download must
## converge instead of stacking a timer per snapshot.
var _package_retry_in_flight := false
var _package_retry_attempts := 0
## Client side: a snapshot whose package map did not match the local registry.
## It is retried after the next package application, never applied blindly.
var _pending_world_snapshot: Dictionary = {}
## Applied-package signature at the last snapshot request. A permanently
## different closure must not turn into an endless request/response loop: a
## fresh request is sent only when the local applied map actually changes.
var _snapshot_request_signature := ""
## Server side: revisions whose client acknowledgements have not released the
## post-apply snapshot barrier yet.
var _hot_reload_barriers: Dictionary = {}

func _is_wired_game_scene(root: Node) -> bool:
	return root != null and root is WiredGameSceneScript


func _world_viewport_of(root: Node) -> SubViewport:
	if not _is_wired_game_scene(root):
		return null
	var viewport: Variant = root.get("world_viewport")
	return viewport as SubViewport


## Package main scenes are commonly authored as a wrapper (`CustomMain/Game`).
## The multiplayer root must be the inner Game node, otherwise installing the
## wrapper under Main/Game creates Main/Game/Game and invalidates replication
## paths cached by MultiplayerSpawner and MultiplayerSynchronizer.
func _normalize_game_scene_root(root: Node) -> Node:
	var viewport := _world_viewport_of(root)
	if viewport == null:
		return root
	var inner := root.get_node_or_null("Game")
	if inner == null or not inner.is_ancestor_of(viewport):
		return root
	if not (inner is SubViewportContainer):
		return root
	for child: Node in root.get_children():
		if child == inner:
			continue
		if inner.get_node_or_null(NodePath(str(child.name))) != null:
			push_warning(
				"WIRED_MAIN_SCENE_NORMALIZE_COLLISION name=%s" % child.name
			)
			return root
	root.remove_child(inner)
	inner.owner = null
	for child: Node in root.get_children():
		root.remove_child(child)
		child.owner = null
		inner.add_child(child)
		child.owner = inner
	inner.set_script(WiredGameSceneScript)
	inner.set("world_viewport", viewport)
	root.free()
	return inner


func _validate_exports() -> bool:
	var missing: PackedStringArray = []
	if default_game_root == null:
		missing.append("default_game_root")
	if net == null:
		missing.append("net")
	if ui == null:
		missing.append("ui")
	if status_label == null:
		missing.append("status_label")
	if log_label == null:
		missing.append("log_label")
	if static_world == null:
		missing.append("static_world")
	if dynamic_world == null:
		missing.append("dynamic_world")
	if dynamic_spawner == null:
		missing.append("dynamic_spawner")
	if players_manager == null:
		missing.append("players_manager")
	if players_spawner == null:
		missing.append("players_spawner")
	for name: String in missing:
		push_error("WIRED_MAIN_SCENE_MISSING_EXPORT name=%s" % name)
	if not missing.is_empty():
		return false
	if not _is_wired_game_scene(default_game_root):
		push_error(
			"WIRED_MAIN_SCENE_INVALID package=<default> path=%s reason=not_wired_game_scene"
			% default_game_root.scene_file_path
		)
		return false
	if _world_viewport_of(default_game_root) == null:
		push_error(
			"WIRED_MAIN_SCENE_INVALID package=<default> path=%s reason=missing_world_viewport"
			% default_game_root.scene_file_path
		)
		return false
	return true


func _ready() -> void:
	if not _validate_exports():
		return
	var cfg := _read_config()
	var room := str(cfg.get("room", DEFAULT_ROOM))
	# The game services exist before a package can register anything.
	_setup_services()
	# Every overlay Control lets the mouse reach the game viewport.
	_setup_ui_input_passthrough()
	# The room is part of the package directory, so it has to be known before
	# the loader is configured.
	_setup_packages(room)
	net.status_changed.connect(_on_status_changed)
	net.log_line.connect(_on_log_line)
	net.authenticated.connect(_on_authenticated)
	net.auth_failed.connect(_on_auth_failed)
	net.connection_failed.connect(_on_connection_failed)
	net.disconnected.connect(_on_server_disconnected)
	net.server_event.connect(_on_server_event)
	# Late join: the server repairs spawns that the transport replayed before
	# the client had applied its packages, and answers retries after a revision
	# mismatch. PlayersManager was connected earlier, so its own player exists
	# by the time the snapshot is built.
	net.peer_packages_ready.connect(_on_peer_packages_ready)
	net.hot_reload_ready.connect(_on_hot_reload_ready)
	net.package_revision_removed.connect(_on_package_revision_removed)
	net.world_snapshot_requested.connect(_on_world_snapshot_requested)
	net.world_snapshot_received.connect(_on_world_snapshot_received)
	# The host waits for this before minting a ticket.
	_bridge_call("notifyReady", [])
	if str(cfg.get("mode", "")) == "server":
		_state_dir = str(cfg.get("state_dir", ""))
		# Restore before the server accepts clients: players get their saved
		# anchors on spawn, dynamic entities wait for their package entry.
		_load_state()
		_run_server(cfg)
	else:
		await _run_client(cfg)


## Publishes the services packages reach through the `Global` autoload. The
## registry is owned by the scene, so it is freed together with it.
func _setup_services() -> void:
	_registry = WiredPackageRegistry.new()
	_registry.name = "PackageRegistry"
	add_child(_registry)
	Global.package_registry = _registry
	# Players are built from the same registry and spawned through the
	# scene's MultiplayerSpawner once auth and package readiness both arrive.
	# The dynamic world reuses the spawner authored in `main.tscn`; `setup`
	# only creates one when none is passed, so no second spawner appears.
	if dynamic_world != null:
		dynamic_world.setup(_registry, dynamic_spawner)
	Global.register_scene_services(static_world, dynamic_world, players_manager, net)
	if static_world != null:
		static_world.setup(_registry)
	if players_manager != null:
		players_manager.setup(_registry, net, players_spawner)
	_default_game_root = default_game_root
	_game_root = default_game_root
	_reserved_service_names = PackedStringArray()
	for service: Node in [static_world, dynamic_world, players_manager]:
		if service != null and not service.name.is_empty():
			_reserved_service_names.append(str(service.name))


func _unbind_game_services() -> void:
	for service: Node in [static_world, dynamic_world, players_manager]:
		if service != null and service.get_parent() != null:
			service.get_parent().remove_child(service)
			# The services outlive the authored scene they came from. Clearing
			# the serialization owner keeps Godot from warning that `Main` no
			# longer owns a node living under a package scene.
			service.owner = null


## Returns the first reserved node the package scene already put into its
## `world_viewport`, or an empty string when the scene follows the contract.
func _reserved_service_conflict(viewport: SubViewport) -> String:
	for reserved: String in _reserved_service_names:
		if viewport.get_node_or_null(NodePath(reserved)) != null:
			return reserved
	return ""


func _bind_game_services(viewport: SubViewport) -> void:
	for service: Node in [static_world, dynamic_world, players_manager]:
		if service == null or service.get_parent() == viewport:
			continue
		if viewport.get_node_or_null(NodePath(service.name)) != null:
			push_warning("WIRED_MAIN_SCENE_SERVICE_COLLISION name=%s" % service.name)
		if service.get_parent() != null:
			service.get_parent().remove_child(service)
		viewport.add_child(service)


func _desired_game_scene() -> Dictionary:
	if _registry == null:
		return {}
	var descriptor := _registry.get_main_scene()
	if descriptor.is_empty():
		return {}
	var registrations := _registry.get_main_scenes()
	if registrations.size() > 1:
		push_warning(
			"WIRED_MAIN_SCENE_MULTIPLE package=%s ignored=%d"
			% [descriptor.get("package_id", ""), registrations.size() - 1]
		)
	var package_id := str(descriptor.get("package_id", ""))
	var path := str(descriptor.get(WiredProtocol.KEY_PATH, ""))
	var context := _registry.get_context(package_id)
	if context == null or path.is_empty():
		return {}
	return {
		"package_id": package_id,
		"path": path,
		"context": context,
		"key": "%s:%s:%d:%s"
		% [package_id, path, context.revision, context.artifact_key],
	}


func _merge_game_scene_revision(new_root: Node, new_viewport: SubViewport) -> bool:
	var stable_viewport := _world_viewport_of(_game_root)
	if stable_viewport == null or stable_viewport.get_parent() != _game_root:
		return false
	# Keep the live Game/SubViewport nodes in the tree. Replacing either node
	# invalidates MultiplayerSpawner/MultiplayerSynchronizer path caches.
	for child: Node in _game_root.get_children():
		if child != stable_viewport:
			child.free()
	for child: Node in new_root.get_children():
		if child == new_viewport:
			continue
		new_root.remove_child(child)
		child.owner = null
		_game_root.add_child(child)
	for child: Node in stable_viewport.get_children():
		if child.name in _reserved_service_names:
			continue
		child.free()
	for child: Node in new_viewport.get_children():
		new_viewport.remove_child(child)
		child.owner = null
		stable_viewport.add_child(child)
	new_root.free()
	_bind_game_services(stable_viewport)
	return true


func _swap_game_scene(new_root: Node) -> bool:
	var viewport := _world_viewport_of(new_root)
	if viewport == null:
		return false
	if new_root == _game_root:
		return true
	if not _game_scene_key.is_empty() and new_root != _default_game_root:
		return _merge_game_scene_revision(new_root, viewport)
	_unbind_game_services()
	var parent := _game_root.get_parent()
	var index := _game_root.get_index()
	# `add_child` warns when a node keeps an owner from its previous parent.
	# Clear it for the move and restore the authored owner afterwards.
	var new_root_owner := new_root.owner
	new_root.owner = null
	# The Game root is part of every MultiplayerSpawner/synchronizer path.
	# Package scenes may use any authored name (for example `CustomMain`), but
	# replacing that name would invalidate Godot's scene replication cache even
	# when Players and their `Sync` nodes keep the same relative structure.
	new_root.name = _game_root.name
	if parent != null:
		parent.remove_child(_game_root)
		parent.add_child(new_root)
		parent.move_child(new_root, index)
	else:
		add_child(new_root)
	new_root.owner = new_root_owner
	if _game_root != _default_game_root:
		_game_root.queue_free()
	_game_root = new_root
	_bind_game_services(viewport)
	Global.register_scene_services(static_world, dynamic_world, players_manager, net)
	return true


func _rebuild_game_scene_if_needed() -> void:
	var desired := _desired_game_scene()
	var key := str(desired.get("key", ""))
	if key == _game_scene_key:
		return
	if key.is_empty():
		if _game_root != _default_game_root and _swap_game_scene(_default_game_root):
			_game_scene_key = ""
		return
	var context := desired.get("context") as WiredPackageContext
	var path := str(desired.get("path", ""))
	var instance := context.instantiate(path) if context != null else null
	if instance == null:
		push_warning(
			"WIRED_MAIN_SCENE_INSTANTIATE_FAILED package=%s path=%s"
			% [desired.get("package_id", ""), path]
		)
		return
	if not _is_wired_game_scene(instance):
		push_warning(
			"WIRED_MAIN_SCENE_INVALID package=%s path=%s reason=not_wired_game_scene"
			% [desired.get("package_id", ""), path]
		)
		instance.free()
		return
	var viewport := _world_viewport_of(instance)
	if viewport == null:
		push_warning(
			"WIRED_MAIN_SCENE_INVALID package=%s path=%s reason=missing_world_viewport"
			% [desired.get("package_id", ""), path]
		)
		instance.free()
		return
	var conflict := _reserved_service_conflict(viewport)
	if not conflict.is_empty():
		push_warning(
			"WIRED_MAIN_SCENE_INVALID package=%s path=%s reason=reserved_node name=%s"
			% [desired.get("package_id", ""), path, conflict]
		)
		instance.free()
		return
	instance = _normalize_game_scene_root(instance)
	if not _swap_game_scene(instance):
		instance.free()
		return
	_game_scene_key = key


## Authored overlay controls already ignore the mouse, but `RichTextLabel`
## creates its scrollbar at runtime: enforce the rule for generated controls too,
## otherwise clicks over the log never reach the aim cursor.
func _setup_ui_input_passthrough() -> void:
	for child: Node in ui.find_children("*", "Control", true, false):
		(child as Control).mouse_filter = Control.MOUSE_FILTER_IGNORE


## Both runtime modes load published package files over plain HTTP, so the
## loader is created before the network starts.
func _setup_packages(room: String) -> void:
	_packages = PackagesManager.new()
	_packages.name = "Packages"
	add_child(_packages)
	Global.packages = _packages
	_packages.configure(_api_url(), room)
	if not _packages.package_applied.is_connected(_on_package_applied):
		_packages.package_applied.connect(_on_package_applied)


## An applied revision replaces that package's registry entries, its static
## content and the components of every live player. A stable-content root (a
## generic package scene outside the containers) is not replaced: the containers
## own every registry-created root, and nothing else may swap a live one.
func _on_package_applied(
	package_id: int, revision: int, _changed_files: PackedStringArray
) -> void:
	_apply_registered_package(package_id, revision)


func _apply_registered_package(package_id: int, revision: int) -> void:
	if _registry == null:
		push_warning(
			"WIRED_PACKAGE_ENTRY_SKIPPED package=%d revision=%d reason=no_registry"
			% [package_id, revision]
		)
		return
	# Client copies are still dropped before the authoritative snapshot. The
	# server captures records while old nodes still exist and parks/restores them
	# only at commit, after the new static layer is ready.
	var prepared_dynamic: Dictionary = {}
	if dynamic_world != null and net.mode == "server":
		prepared_dynamic = dynamic_world.prepare_package_reload(package_id)
		if not bool(prepared_dynamic.get("ok", false)):
			return
	var artifact_key := _packages.current_artifact_key(package_id)
	var context := WiredPackageContext.new()
	context.package_id = str(package_id)
	context.revision = revision
	context.artifact_key = artifact_key
	context.packages = _packages
	context.root_path = _packages.revision_dir(package_id, revision, artifact_key)
	_registry.clear_package(context.package_id)
	# A package without `wired_package.gd` is valid: it just contributes no
	# content. The old entries were already cleared above.
	PackageEntryLoader.load_entry(context.package_id, revision, context, _registry)
	if dynamic_world != null and net.mode != "server":
		dynamic_world.drop_package(package_id)
	var prepared_static: Dictionary = {}
	if static_world != null:
		prepared_static = static_world.prepare_rebuild()
		if not bool(prepared_static.get("ok", false)):
			static_world.discard_prepared(prepared_static)
			return
	_rebuild_game_scene_if_needed()
	if static_world != null:
		if not static_world.commit_prepared(prepared_static):
			static_world.discard_prepared(prepared_static)
			return
	if dynamic_world != null and net.mode == "server":
		if not dynamic_world.commit_package_reload(prepared_dynamic):
			return
	# Players already in the world keep running the previous revision's scripts
	# unless their components are rebuilt. The root stays (and keeps the
	# spawner's net id); only the components are replaced, with their state.
	if players_manager != null:
		players_manager.rebuild_live_components()
	# The chain is not necessarily complete yet (a ground package may still be
	# queued), so the server only restores the parked records once it is.
	if net.mode == "server":
		_restore_dynamic_if_ready()
	else:
		# A snapshot deferred on a revision mismatch can now be checked again.
		_retry_pending_world_snapshot()


## Client side: asks the server for a fresh snapshot. Guarded so a package
## callback that also runs on a server (or before auth) never sends an RPC.
func _request_world_snapshot() -> void:
	if net == null or net.mode != "client":
		return
	net.request_world_snapshot()


## Server side: sends the late-join snapshot after the peer's initial package
## gate opened. Deferred by one frame so the joining player's normal spawner
## packet is queued first; the receiver is idempotent anyway.
func _on_peer_packages_ready(peer_id: int) -> void:
	if net.mode != "server" or _shutdown_in_progress or not _hot_reload_barriers.is_empty():
		return
	_send_world_snapshot.call_deferred(peer_id)


func _on_hot_reload_ready(package_id: int, revision: int) -> void:
	if net.mode != "server" or _shutdown_in_progress:
		return
	var key := "%d:%d" % [package_id, revision]
	_hot_reload_barriers.erase(key)
	if not _hot_reload_barriers.is_empty():
		return
	_restore_dynamic_if_ready()
	for peer_id: int in multiplayer.get_peers():
		if net.is_peer_packages_ready(peer_id):
			_send_world_snapshot(peer_id)


func _on_package_revision_removed(package_id: int) -> void:
	if net.mode != "server":
		return
	for key: String in _hot_reload_barriers.keys():
		if key.begins_with("%d:" % package_id):
			_hot_reload_barriers.erase(key)


func _on_world_snapshot_requested(peer_id: int) -> void:
	if net.mode != "server" or _shutdown_in_progress:
		return
	_send_world_snapshot(peer_id)


func _send_world_snapshot(peer_id: int) -> void:
	if net.mode != "server" or _packages == null:
		return
	var snapshot := {
		WiredProtocol.KEY_PACKAGES: _packages.applied_packages(),
		WiredProtocol.KEY_PLAYERS:
		players_manager.snapshot_players() if players_manager != null else [],
		WiredProtocol.KEY_DYNAMIC_WORLD:
		dynamic_world.snapshot_state() if dynamic_world != null else [],
	}
	net.send_world_snapshot(peer_id, snapshot)


func _on_world_snapshot_received(snapshot: Dictionary) -> void:
	if net.mode != "client":
		return
	_apply_world_snapshot(snapshot)


## Client side: reconciles the applied package set with the server's map, then
## applies the snapshot only when both peers ended on the same applied closure
## (revision and artifact key). Otherwise the snapshot stays pending and a fresh
## one is requested. Called from a signal, so it can await but cannot be awaited.
##
## The reconcile downloads and unloads packages, so it must own the package-op
## mutex: a snapshot arriving while a queued apply is suspended is stored and
## replayed by `_pump_package_ops` instead of interleaving with it.
func _apply_world_snapshot(snapshot: Dictionary) -> void:
	if _package_ops_busy:
		_pending_world_snapshot = snapshot
		return
	_package_ops_busy = true
	await _apply_world_snapshot_owned(snapshot)
	_package_ops_busy = false
	# The snapshot may have queued a retry or left work behind: the pump decides
	# whether a queued operation or the pending snapshot runs next.
	call_deferred("_pump_package_ops")


## Body of `_apply_world_snapshot`, called only while it holds the package-op
## mutex. Every early return is safe: the caller always clears the flag.
func _apply_world_snapshot_owned(snapshot: Dictionary) -> void:
	var remote_packages: Variant = snapshot.get(WiredProtocol.KEY_PACKAGES, {})
	if typeof(remote_packages) != TYPE_DICTIONARY:
		remote_packages = {}
	var packages: Dictionary = remote_packages
	if not await _reconcile_client_packages(packages):
		# The retry chain schedules another snapshot; applying this one would
		# run against the packages that are still downloading.
		_pending_world_snapshot = snapshot
		return
	# The reconcile completed without a failed download: the backoff starts from
	# the first delay again on the next unrelated failure.
	_package_retry_attempts = 0
	var local_packages := _packages.applied_packages()
	if not SnapshotRules.packages_match(packages, local_packages):
		_pending_world_snapshot = snapshot.duplicate(true)
		print(
			"WIRED_WORLD_SNAPSHOT_DEFERRED reason=package_mismatch remote=%s local=%s"
			% [packages, local_packages]
		)
		var signature := str(local_packages)
		if _snapshot_request_signature != signature:
			_snapshot_request_signature = signature
			_request_world_snapshot()
		return
	_pending_world_snapshot = {}
	_snapshot_request_signature = ""
	var players: Variant = snapshot.get(WiredProtocol.KEY_PLAYERS, [])
	if players is Array and players_manager != null:
		players_manager.apply_snapshot(players)
	var dynamic_records: Variant = snapshot.get(WiredProtocol.KEY_DYNAMIC_WORLD, [])
	if dynamic_records is Array and dynamic_world != null:
		dynamic_world.apply_snapshot(dynamic_records, packages)
	print(
		"WIRED_WORLD_SNAPSHOT_APPLIED players=%d dynamic=%d"
		% [
			(players as Array).size() if players is Array else 0,
			(dynamic_records as Array).size() if dynamic_records is Array else 0,
		]
	)


## Client side: makes the applied package set match the server's map before a
## snapshot is applied. A package the server no longer lists is unloaded; a
## package whose revision or artifact key differs is synced over HTTP. Returns
## false when a download failed (the retry chain is already scheduled then).
func _reconcile_client_packages(remote: Dictionary) -> bool:
	if net == null or net.mode != "client":
		return true
	# Snapshot before mutating: `_apply_package_removal` erases entries from the
	# applied map while it runs.
	var applied := _packages.applied_packages()
	for id: Variant in applied:
		if not remote.has(str(id)):
			_apply_package_removal(int(id), false, false)
	for id: Variant in remote:
		var want: Variant = remote[id]
		if typeof(want) != TYPE_DICTIONARY:
			continue
		var desired: Dictionary = want
		var have: Dictionary = _packages.applied_packages().get(str(id), {})
		if (
			int(have.get("revision", 0)) == int(desired.get("revision", 0))
			and str(have.get("artifact_key", "")) == str(desired.get("artifact_key", ""))
		):
			continue
		var result: Dictionary = await _packages.sync_package(
			int(id), int(desired.get("revision", 0))
		)
		if not bool(result.get("ok", false)):
			_schedule_package_retry(int(id), str(result.get("error", "")))
			return false
	return true


## One retry chain per client, with a bounded fast backoff: 2 s, 5 s, 10 s, then
## every 10 s. Each attempt re-requests a snapshot, which re-enters
## `_reconcile_client_packages` and retries the missing download.
func _schedule_package_retry(package_id: int, error: String) -> void:
	if net == null or net.mode != "client":
		return
	if _package_retry_in_flight:
		return
	_package_retry_in_flight = true
	var delays: Array[float] = [2.0, 5.0, 10.0]
	var delay := 10.0
	if _package_retry_attempts < delays.size():
		delay = delays[_package_retry_attempts]
	_package_retry_attempts += 1
	print(
		"WIRED_PACKAGE_SYNC_FAILED package=%d error=%s retry=%.1f"
		% [package_id, error, delay]
	)
	await get_tree().create_timer(delay).timeout
	_package_retry_in_flight = false
	print(
		"WIRED_PACKAGE_SYNC_RETRY package=%d attempt=%d delay=%.1f"
		% [package_id, _package_retry_attempts, delay]
	)
	_request_world_snapshot()


func _retry_pending_world_snapshot() -> void:
	if _pending_world_snapshot.is_empty():
		return
	# Take the snapshot out before applying it: a re-entrant replay (the apply
	# path itself may store a pending snapshot again) must not apply a snapshot
	# that is already being applied.
	var snapshot := _pending_world_snapshot
	_pending_world_snapshot = {}
	_apply_world_snapshot(snapshot)


func _api_url() -> String:
	var from_args := _arg_value(OS.get_cmdline_args(), "--api-url", "")
	if not from_args.is_empty():
		return from_args
	var from_env := OS.get_environment("WIRED_API_URL")
	if not from_env.is_empty():
		return from_env
	return PackagesManager.DEFAULT_API_URL


func get_packages_manager() -> PackagesManager:
	return _packages


func _read_config() -> Dictionary:
	var args := OS.get_cmdline_args()
	if args.has("--server"):
		return {
			"mode": "server",
			"port": int(_arg_value(args, "--port", str(DEFAULT_PORT))),
			"room": _arg_value(args, "--room", DEFAULT_ROOM),
			"bind": _arg_value(args, "--bind", DEFAULT_BIND),
			"state_dir": _arg_value(args, "--state-dir", ""),
			"state_save_interval_ms": int(
				_arg_value(args, "--state-save-interval-ms", "30000")
			),
		}
	var cfg := {
		"mode": "client",
		"url": _arg_value(args, "--url", ""),
		"ticket": _arg_value(args, "--ticket", ""),
		"room": _arg_value(args, "--room", DEFAULT_ROOM),
		"no_hello": args.has("--probe-no-hello"),
		"probe_action": args.has("--probe-action"),
	}
	if OS.has_feature("web"):
		cfg = {
			"mode": "client",
			"source": "bridge",
			"no_hello": false,
			"probe_action": false,
		}
	return cfg


func _run_server(cfg: Dictionary) -> void:
	var secret := OS.get_environment("WIRED_GAME_TICKET_SECRET")
	if secret.is_empty():
		_fail("WIRED_GAME_TICKET_SECRET is not set")
		get_tree().quit(2)
		return
	# The backend injects a room-scoped token; package routes reject requests
	# without it.
	_packages.set_api_token(OS.get_environment("WIRED_RUNTIME_API_TOKEN"))
	_server_port = int(cfg.port)
	print(
		"WIRED_SERVER_STARTING room=%s port=%d bind=%s"
		% [cfg.room, cfg.port, cfg.bind]
	)
	var err := net.start_server(int(cfg.port), str(cfg.room), secret, str(cfg.bind))
	if err != OK:
		_fail("server start failed: %s" % error_string(err))
		get_tree().quit(3)
		return
	_state_save_interval_ms = maxi(
		1, int(cfg.get("state_save_interval_ms", _state_save_interval_ms))
	)
	_state_save_timer = Timer.new()
	_state_save_timer.name = "StateSaveTimer"
	_state_save_timer.wait_time = _state_save_interval_ms / 1000.0
	_state_save_timer.one_shot = false
	_state_save_timer.timeout.connect(_on_state_save_timer_timeout)
	add_child(_state_save_timer)
	_state_save_timer.start()
	_start_control_listener()


func _on_state_save_timer_timeout() -> void:
	if _shutdown_in_progress:
		return
	_save_state("periodic")


## Backend sends one line over stdin: `shutdown`.  The same thread also notices
## EOF, which happens when the backend dies, so a killed backend cannot leave
## an orphaned Godot server behind.
func _start_control_listener() -> void:
	_control_thread = Thread.new()
	var err := _control_thread.start(_control_loop)
	if err != OK:
		print("WIRED_CONTROL_ERROR cannot start stdin thread err=%d" % err)


func _control_loop() -> void:
	while not _shutdown_in_progress:
		var chunk := OS.read_string_from_stdin()
		if chunk.is_empty():
			call_deferred("_request_shutdown", "stdin_closed")
			return
		# `read_string_from_stdin()` returns every buffered write joined by
		# newlines. Treat each line as a command: reading the chunk as one
		# command silently dropped all but the first package dispatch, which
		# made every cold start wait for the retry tick.
		for raw_line: String in chunk.split("\n"):
			var command := raw_line.strip_edges()
			if command.is_empty():
				continue
			var parts := command.split(" ", false)
			match parts[0]:
				"shutdown":
					call_deferred("_request_shutdown", "shutdown_command")
					return
				"package":
					# The queue lives on the main thread: the control thread only
					# hands the operation over.
					if (
						parts.size() == 3
						and parts[1].is_valid_int()
						and parts[2].is_valid_int()
					):
						call_deferred(
							"_enqueue_package_op",
							{
								"kind": "apply",
								"id": parts[1].to_int(),
								"revision": parts[2].to_int(),
							}
						)
					else:
						print(
							"WIRED_CONTROL_ERROR invalid_package_command=%s"
							% command
						)
				"unload":
					if parts.size() in [2, 3] and parts[1].is_valid_int():
						call_deferred(
							"_enqueue_package_op",
							{
								"kind": "unload",
								"id": parts[1].to_int(),
								"purge": parts.size() == 3 and parts[2] == "purge",
							}
						)
					else:
						print(
							"WIRED_CONTROL_ERROR invalid_unload_command=%s"
							% command
						)
				"room-packages":
					call_deferred(
						"_apply_room_packages",
						parts[1] if parts.size() > 1 else ""
					)
				_:
					print("WIRED_CONTROL_ERROR unknown_command=%s" % command)


## Appends one package operation and starts the pump. Every package mutation
## goes through here - server apply, client apply (`client_apply`, whose download
## awaits) and unload - so an unload that arrives while an apply is downloading
## is queued behind it instead of removing the package the apply is re-adding.
func _enqueue_package_op(op: Dictionary) -> void:
	_package_ops_queue.append(op)
	_pump_package_ops()


func _pump_package_ops() -> void:
	if _package_ops_busy:
		return
	if _package_ops_queue.is_empty():
		# The chain is settled: static content of every applied package is in the
		# tree, so parked dynamic records can finally be spawned on top of it.
		_restore_dynamic_if_ready()
		return
	_package_ops_busy = true
	var op: Dictionary = _package_ops_queue.pop_front()
	var package_id := int(op.get("id", 0))
	match str(op.get("kind", "")):
		"apply":
			await _apply_package_revision(package_id, int(op.get("revision", 0)))
		"client_apply":
			await _apply_client_package(package_id, int(op.get("revision", 0)))
		"unload":
			_apply_package_removal(package_id, bool(op.get("purge", false)))
	_package_ops_busy = false
	# The mutex is free again: when nothing else is queued, this may have been
	# the last package of the startup chain and the parked records can spawn.
	_restore_dynamic_if_ready()
	# A snapshot deferred while this operation held the mutex is replayed first:
	# it may unload a package this operation just applied, or vice versa, and the
	# two must never interleave. Its own apply schedules the pump again.
	if not _pending_world_snapshot.is_empty():
		call_deferred("_retry_pending_world_snapshot")
	elif not _package_ops_queue.is_empty():
		call_deferred("_pump_package_ops")


## Removes one package from the running world. Server: the entities are parked so
## a re-add can restore them, and the announced revision is dropped. Client: the
## local copies are dropped and, unless the caller is already reconciling, a
## fresh snapshot is requested.
func _apply_package_removal(
	package_id: int, purge: bool, request_snapshot := true
) -> void:
	if package_id <= 0:
		return
	if dynamic_world != null:
		if net.mode == "server":
			dynamic_world.park_package(package_id)
		else:
			dynamic_world.drop_package(package_id)
	_registry.clear_package(str(package_id))
	_packages.forget_package(package_id, purge)
	_rebuild_game_scene_if_needed()
	if static_world != null:
		static_world.rebuild()
	if players_manager != null:
		players_manager.rebuild_live_components()
	if purge:
		if dynamic_world != null:
			dynamic_world.purge_package(package_id)
		if players_manager != null:
			players_manager.purge_package(package_id)
	if net.mode == "server":
		net.remove_package_revision(package_id)
	elif request_snapshot:
		_request_world_snapshot()


## `room-packages <csv>`: the backend reports which packages the room still
## publishes. Parked records and player component state of any other package
## belong to a package that no longer exists and are dropped.
func _apply_room_packages(csv: String) -> void:
	var ids := PackedStringArray()
	for raw_id: String in csv.split(",", false):
		var value := raw_id.strip_edges()
		if not value.is_valid_int() or value.to_int() <= 0:
			continue
		ids.append(str(value.to_int()))
	_room_package_ids = ids
	_room_packages_known = true
	if dynamic_world != null:
		dynamic_world.purge_missing_packages(ids)
	if players_manager != null:
		players_manager.purge_missing_packages(ids)
	# The announcement can also arrive after every package was applied already.
	_restore_dynamic_if_ready()


## Server side. Parked records are spawned only when no package operation is
## queued and every package the room still publishes has been applied. Spawning
## as soon as the entity's own package is applied is not enough: a later package
## in the same startup chain may author the static world the body stands on, and
## a body restored into an empty world free-falls through the missing ground
## long before that package is downloaded and instantiated.
func _restore_dynamic_if_ready() -> void:
	if net == null or net.mode != "server" or dynamic_world == null:
		return
	if _package_ops_busy or not _package_ops_queue.is_empty():
		return
	if not _hot_reload_barriers.is_empty():
		return
	if _room_packages_known:
		var applied: Dictionary = (
			_packages.applied_packages() if _packages != null else {}
		)
		for package_id: String in _room_package_ids:
			if not applied.has(package_id):
				return
	var restored := dynamic_world.restore_pending()
	# A peer that finished its package gate before the restore saw an empty
	# world in its first snapshot. Resend it once the entities actually exist.
	if restored > 0 and _hot_reload_barriers.is_empty():
		for peer_id: int in multiplayer.get_peers():
			if net.is_peer_packages_ready(peer_id):
				_send_world_snapshot(peer_id)


## Server side: the backend asked for a published revision. The loader fetches
## the manifest, verifies hashes and writes the files; only then is the
## revision announced to clients. File bytes never travel over the game socket.
func _apply_package_revision(package_id: int, revision: int) -> void:
	# Establish the barrier before downloading/applying the revision: the package
	# callback parks live entities and may rebuild the world synchronously.
	# Snapshot gating alone cannot stop the spawner packets emitted by that work.
	for old_key: String in _hot_reload_barriers.keys():
		if old_key.begins_with("%d:" % package_id):
			_hot_reload_barriers.erase(old_key)
	var pending_key := "%d:%d" % [package_id, revision]
	_hot_reload_barriers[pending_key] = true
	net.begin_hot_reload(package_id, revision)
	print(
		"WIRED_PACKAGES_SYNC_STARTED package=%d revision=%d"
		% [package_id, revision]
	)
	var result: Dictionary = await _packages.sync_package(package_id, revision)
	if not bool(result.get("ok", false)):
		# PackagesManager already printed WIRED_PACKAGES_SYNC_FAILED with the
		# requested revision; the backend owns retries.
		return
	var applied := int(result.get("revision", revision))
	if applied != revision:
		_hot_reload_barriers.erase(pending_key)
		pending_key = "%d:%d" % [package_id, applied]
		_hot_reload_barriers[pending_key] = true
		net.begin_hot_reload(package_id, applied)
	net.set_package_revision(package_id, applied)


func _request_shutdown(reason: String) -> void:
	if _shutdown_in_progress:
		return
	_shutdown_in_progress = true
	if _state_save_timer != null:
		_state_save_timer.stop()
	print("WIRED_SHUTDOWN_REQUESTED reason=%s" % reason)
	_save_state(reason)
	print("WIRED_SHUTDOWN_ACK")
	get_tree().quit(0)


## The project owns its save format; the backend only waits for the process to
## exit. The file is written to the per-room directory passed by the backend.
func _save_state(reason: String) -> void:
	# Players and dynamic entities are server-owned; both keep their own
	# persistence shape so a package only sees its `_wired_*_state` dictionary.
	var players: Array = []
	if players_manager != null:
		players = players_manager.save_state().get(WiredProtocol.KEY_PLAYERS, [])
	var state := {
		"room": net.room_code,
		"port": _server_port,
		"reason": reason,
		"active_players": net.get_active_player_count(),
		"server_seq": net.get_server_seq(),
		"saved_at": Time.get_datetime_string_from_system(true),
		WiredProtocol.KEY_PLAYERS: players,
		WiredProtocol.KEY_DYNAMIC_WORLD:
		dynamic_world.save_state() if dynamic_world != null else [],
	}
	var dir := _state_dir
	if not dir.is_empty():
		var dir_err := DirAccess.make_dir_recursive_absolute(dir)
		if dir_err != OK:
			print(
				"WIRED_STATE_SAVE_FAILED dir=%s err=%s"
				% [dir, error_string(dir_err)]
			)
			return
	var path := _state_path()
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		print(
			"WIRED_STATE_SAVE_FAILED path=%s err=%s"
			% [path, error_string(FileAccess.get_open_error())]
		)
		return
	file.store_string(JSON.stringify(state, "  "))
	file.close()
	print("WIRED_STATE_SAVED path=%s" % path)


## Server side. Reads the previous `state.json` before the runtime starts.
## Dynamic records are not spawned here: their package entry may not be
## registered yet, so they are seeded into the world's parked list and
## `restore_pending` runs once the startup package chain has been applied.
func _load_state() -> void:
	var path := _state_path()
	if not FileAccess.file_exists(path):
		return
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		print(
			"WIRED_STATE_LOAD_FAILED path=%s err=%s"
			% [path, error_string(FileAccess.get_open_error())]
		)
		return
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		print("WIRED_STATE_LOAD_FAILED path=%s reason=invalid_json" % path)
		return
	var state: Dictionary = parsed
	var dynamic_records: Variant = state.get(WiredProtocol.KEY_DYNAMIC_WORLD, [])
	if dynamic_records is Array and dynamic_world != null:
		dynamic_world.seed_pending(dynamic_records)
	var player_records: Variant = state.get(WiredProtocol.KEY_PLAYERS, [])
	if player_records is Array and players_manager != null:
		# Applied immediately to live players, or on that player's next spawn.
		players_manager.load_state({WiredProtocol.KEY_PLAYERS: player_records})
	print(
		"WIRED_STATE_LOADED path=%s dynamic=%d players=%d"
		% [
			path,
			(
				dynamic_world.pending_records().size()
				if dynamic_world != null
				else 0
			),
			player_records.size() if player_records is Array else 0,
		]
	)


func _state_path() -> String:
	var dir := _state_dir
	if dir.is_empty():
		dir = "user://"
	return dir.path_join("state.json")


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST and not _shutdown_in_progress:
		_request_shutdown("window_close")


func _run_client(cfg: Dictionary) -> void:
	if str(cfg.get("source", "")) == "bridge":
		_bridge_status("waiting", "Waiting for the Wired host")
		var bridge_config: Dictionary = await _wait_for_bridge_config(
			BRIDGE_CONFIG_TIMEOUT_SEC
		)
		if bridge_config.is_empty():
			_fail("No game configuration received from the Wired host")
			return
		cfg["url"] = str(bridge_config.get("endpoint", ""))
		cfg["ticket"] = str(bridge_config.get("ticket", ""))
		# JSON numbers arrive as floats: `7` becomes `7.0`. The room is an
		# integer id everywhere, so normalize it before the package manager or
		# network sees it.
		var bridge_room: Variant = bridge_config.get("room", 0)
		if typeof(bridge_room) != TYPE_INT and typeof(bridge_room) != TYPE_FLOAT:
			_fail("Invalid room received from the Wired host")
			return
		var room_id := int(bridge_room)
		if room_id <= 0 or float(bridge_room) != float(room_id):
			_fail("Invalid room received from the Wired host")
			return
		cfg["room"] = str(room_id)
		# The Web build is served from the frontend origin and cannot reach the
		# backend by itself. A build that does not get an API root must fail
		# loudly: falling back to the loader default would silently fetch
		# 127.0.0.1:3000 from the visitor's browser.
		var api_base := str(bridge_config.get("apiBase", ""))
		if api_base.is_empty():
			_fail("No API base received from the Wired host")
			return
		if not _packages.set_api_base(api_base):
			_fail("Invalid API base received from the Wired host")
			return
		# The browser is logged in, so package requests carry the user's access
		# token. Without it the runtime routes answer 401.
		_packages.set_api_token(str(bridge_config.get("apiToken", "")))
		cfg["packages"] = bridge_config.get("packages", [])
	if str(cfg.url).is_empty():
		_fail("No game endpoint: pass --url or open the Game tab")
		return
	if str(cfg.ticket).is_empty():
		_fail("No game ticket: pass --ticket or open the Game tab")
		return
	# Web clients learn the room from the host bridge, after the loader was
	# configured; apply it before anything touches package files.
	_packages.set_room(str(cfg.get("room", "")))
	# Preload the room's current package revisions before the WebSocket opens.
	# MultiplayerSpawner replays spawn packets immediately after connect; if the
	# registry is still empty then, the spawned players and entities have no
	# synchronizers and the spawn packet's sync net IDs are discarded.
	for entry: Variant in cfg.get("packages", []):
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var package_entry: Dictionary = entry
		var package_id := int(package_entry.get("packageId", 0))
		var revision := int(package_entry.get("revision", 0))
		if package_id <= 0 or revision <= 0:
			continue
		print(
			"WIRED_CLIENT_PACKAGE_PRELOAD package=%d revision=%d"
			% [package_id, revision]
		)
		var preload_result: Dictionary = await _packages.sync_package(package_id, revision)
		if bool(preload_result.get("ok", false)):
			print(
				"WIRED_CLIENT_PACKAGE_PRELOAD_OK package=%d revision=%d"
				% [package_id, int(preload_result.get("revision", revision))]
			)
		else:
			print(
				"WIRED_CLIENT_PACKAGE_PRELOAD_FAILED package=%d revision=%d error=%s"
				% [package_id, revision, str(preload_result.get("error", ""))]
			)
	print("WIRED_CLIENT_STARTING room=%s url=%s" % [cfg.room, cfg.url])
	_bridge_status("connecting", str(cfg.url))
	var err := net.start_client(
		str(cfg.url),
		str(cfg.ticket),
		str(cfg.room),
		not bool(cfg.get("no_hello", false)),
		bool(cfg.get("probe_action", false)),
	)
	if err != OK:
		_fail("client start failed: %s" % error_string(err))


func _arg_value(args: PackedStringArray, name: String, fallback: String) -> String:
	var idx := args.find(name)
	if idx == -1 or idx + 1 >= args.size():
		return fallback
	return args[idx + 1]


## Pulls the one-time configuration from the shell bridge. The bridge clears
## it on read, so the ticket lives only in this process afterwards.
func _wait_for_bridge_config(timeout_sec: float) -> Dictionary:
	if not OS.has_feature("web"):
		return {}
	var deadline := Time.get_ticks_msec() + int(timeout_sec * 1000.0)
	while Time.get_ticks_msec() < deadline:
		var raw := str(
			JavaScriptBridge.eval(
				"(window.__wiredGame && window.__wiredGame.takeConfig()) || ''",
				true
			)
		)
		if not raw.is_empty():
			var parsed: Variant = JSON.parse_string(raw)
			if typeof(parsed) == TYPE_DICTIONARY:
				return parsed
			print("WIRED_CLIENT_ERROR malformed bridge configuration")
			return {}
		await get_tree().create_timer(0.1).timeout
	return {}


func _bridge_call(method: String, args: Array = []) -> void:
	if not OS.has_feature("web"):
		return
	var encoded := PackedStringArray()
	for arg in args:
		encoded.append(JSON.stringify(arg))
	JavaScriptBridge.eval(
		"window.__wiredGame && window.__wiredGame.%s(%s)"
		% [method, ", ".join(encoded)],
		true
	)


func _bridge_status(stage: String, detail: String) -> void:
	_bridge_call("notifyStatus", [stage, detail])


func _bridge_error(message: String) -> void:
	_bridge_call("notifyError", [message])


func _fail(message: String) -> void:
	print("WIRED_CLIENT_ERROR %s" % message)
	status_label.text = message
	status_label.modulate = Color(1.0, 0.45, 0.45)
	_on_log_line(message)
	_bridge_error(message)


func _on_authenticated(player_id: int) -> void:
	_authenticated_once = true
	_bridge_status("authenticated", "player %d" % player_id)


func _on_auth_failed(reason: String) -> void:
	_auth_error_reported = true
	_bridge_error("Authentication failed: %s" % reason)


func _on_connection_failed() -> void:
	_bridge_status("connection_failed", "Connection failed")


func _on_server_disconnected() -> void:
	if _auth_error_reported:
		return
	var stage := "disconnected" if _authenticated_once else "connection_failed"
	_bridge_status(stage, "Disconnected from server")


func _on_server_event(event: Dictionary) -> void:
	_bridge_call("notifyEvent", [JSON.stringify(event)])
	var event_type := str(event.get(WiredProtocol.KEY_TYPE, ""))
	if event_type == WiredNetwork.EVENT_WORLD_STATE:
		_bridge_status("ready", WiredNetwork.EVENT_WORLD_STATE)
	elif event_type == WiredNetwork.EVENT_PACKAGE_REVISION:
		_enqueue_package_op(
			{
				"kind": "client_apply",
				"id": int(event.get(WiredProtocol.KEY_PACKAGE_ID, 0)),
				"revision": int(event.get(WiredProtocol.KEY_REVISION, 0)),
			}
		)
	elif event_type == WiredProtocol.EVENT_PACKAGE_REMOVED:
		_enqueue_package_op(
			{
				"kind": "unload",
				"id": int(event.get(WiredProtocol.KEY_PACKAGE_ID, 0)),
				"purge": false,
			}
		)
	elif event_type == WiredNetwork.EVENT_PLAYER_LEFT:
		# The despawn packet is matched by spawn net id, which a root built from
		# the late-join snapshot does not have: release it by player id.
		if players_manager != null:
			players_manager.forget_player(int(event.get(WiredProtocol.KEY_PLAYER_ID, 0)))


## Client side: download and verify the announced revision over HTTP, then tell
## the server whether this client applied it. Runs as a queued package operation,
## so its download cannot interleave with an unload of the same package.
func _apply_client_package(package_id: int, revision: int) -> void:
	if package_id <= 0 or revision <= 0:
		return
	print(
		"WIRED_CLIENT_PACKAGES_SYNC_STARTED package=%d revision=%d"
		% [package_id, revision]
	)
	# `sync_package` emits `package_applied` before it returns. The connected
	# `_on_package_applied` callback is synchronous, so this continuation is the
	# completion boundary: registry/static content and live player components
	# have already been rebuilt before the acknowledgement below is sent.
	var result: Dictionary = await _packages.sync_package(package_id, revision)
	var ok := bool(result.get("ok", false))
	var applied := int(result.get("revision", 0))
	if applied <= 0:
		applied = revision
	var error := "" if ok else str(result.get("error", ""))
	net.report_package_ready(package_id, applied, ok, error)
	if not ok:
		# The server keeps announcing the revision, but a transient download
		# failure must not leave this client permanently behind: retry the
		# package on a backoff and re-request the snapshot afterwards.
		_schedule_package_retry(package_id, error)
	_retry_pending_world_snapshot()
	_bridge_call(
		"notifyEvent",
		[
			JSON.stringify(
				{
					"type": "package_sync",
					"package_id": package_id,
					"revision": applied,
					"ok": ok,
					"error": error,
				}
			)
		]
	)


func _on_status_changed(text: String) -> void:
	status_label.text = text
	print("WIRED_STATUS %s" % text)


func _on_log_line(text: String) -> void:
	log_label.append_text(text + "\n")
	print("WIRED_LOG %s" % text)
