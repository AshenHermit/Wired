extends Node
class_name WiredNetwork

## Minimal game transport on top of WebSocketMultiplayerPeer:
##
## 1. WebSocket opens -> server registers the peer as *pending*, creates nothing.
## 2. Client sends `cli_hello` with a short-lived ticket (first application
##    message: browsers cannot set an Authorization header on WebSocket).
## 3. Server verifies the ticket, burns the nonce, assigns a player id and sends
##    `srv_auth_ok`. Only after that the peer is admitted to the game.
## 4. Server sends `srv_event` (world_state); the client acknowledges it with
##    `cli_ack_event`, which the server logs as the confirmed game event.
##
## Every gameplay RPC re-checks authentication, so an unauthenticated peer can
## never create a player or act in the room.

signal status_changed(text: String)
signal log_line(text: String)
signal server_event(event: Dictionary)
signal authenticated(player_id: int)
signal auth_failed(reason: String)
signal connection_failed()
signal disconnected()
# Server side: a peer completed ticket auth and entered the game.
signal peer_authenticated(peer_id: int, player_id: int, name: String)
# Server side: every announced package revision reported ready for that peer.
# This is the initial-spawn gate only; later revisions do not re-emit it.
signal peer_packages_ready(peer_id: int)
# Server side: gameplay input/action arrived from an authenticated peer.
signal player_input_received(peer_id: int, input: Dictionary)
signal player_action_received(peer_id: int, action: String, payload: Dictionary)
# Server side: an authenticated, package-ready peer asked for a fresh world
# snapshot (for example after a revision mismatch).
signal world_snapshot_requested(peer_id: int)
# Client side: an authenticated server-authored snapshot arrived.
signal world_snapshot_received(snapshot: Dictionary)
# Server side: an authenticated peer disconnected and left the game.
signal peer_left(peer_id: int)

const PROTOCOL_VERSION := 1
const AUTH_TIMEOUT_SEC := 5.0
const SERVER_PEER_ID := 1
## Godot's WebSocket default is 64 KiB. A background tab throttles the main
## loop while spawner/synchronizer packets keep arriving; the default buffer
## overflows and drops packets, which desynchronizes every live entity. 4 MiB
## keeps normal tab switches lossless and gives the focus resync time to run.
const NETWORK_BUFFER_SIZE := 4 * 1024 * 1024

## Protocol vocabulary. The values live in `WiredProtocol`; the aliases keep the
## transport's own API readable at its call sites.
const KEY_PLAYER_ID := WiredProtocol.KEY_PLAYER_ID
const KEY_STATE := WiredProtocol.KEY_STATE
const KEY_TYPE := WiredProtocol.KEY_TYPE
const EVENT_WORLD_STATE := WiredProtocol.EVENT_WORLD_STATE
const EVENT_PLAYER_JOINED := WiredProtocol.EVENT_PLAYER_JOINED
const EVENT_PLAYER_READY := WiredProtocol.EVENT_PLAYER_READY
const EVENT_PLAYER_LEFT := WiredProtocol.EVENT_PLAYER_LEFT
const EVENT_PACKAGE_REVISION := WiredProtocol.EVENT_PACKAGE_REVISION
const EVENT_PACKAGE_REMOVED := WiredProtocol.EVENT_PACKAGE_REMOVED
const EVENT_WORLD_SNAPSHOT := WiredProtocol.EVENT_WORLD_SNAPSHOT
const EVENT_ERROR := WiredProtocol.EVENT_ERROR

var mode := ""
var room_code := ""
var player_id := 0
var _authenticated := false

var _ticket_secret := ""
var _ticket := ""
var _send_hello := true
var _probe_action := false
var _auth_error := ""
var _next_player_id := 1
var _server_seq := 0
var _players: Dictionary = {}
var _pending: Dictionary = {}
## Burned ticket nonce -> unix expiry of that ticket. A nonce is only kept while
## its ticket could still pass verification, so the set cannot grow forever.
var _used_nonces: Dictionary = {}
# server: latest applied revision per package id
var _package_revisions: Dictionary = {}
# server: peer -> { package_id: {revision, state} }
var _package_reports: Dictionary = {}
# Web only: keep the JS callback and bridge alive for the life of the game.
var _web_bridge: Object = null
var _visibility_callback: Variant = null


func _enter_tree() -> void:
	get_tree().set_multiplayer(
		MultiplayerAPI.create_default_interface(), NodePath("/root")
	)


## A hidden tab stops processing packets, and Godot drops whatever does not fit
## in the WebSocket buffers. Returning to the tab is the recovery point: request
## an authoritative snapshot so the client repairs entities that lost updates.
## The Web export reports focus through `NOTIFICATION_WM_WINDOW_FOCUS_IN`;
## `NOTIFICATION_APPLICATION_FOCUS_IN` is only emitted by desktop platforms.
## `request_world_snapshot` is a no-op outside an authenticated client.
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_WINDOW_FOCUS_IN and mode == "client":
		request_world_snapshot()


## Web only: `NOTIFICATION_WM_WINDOW_FOCUS_IN` is tied to the canvas, so a tab
## switch does not emit it. `visibilitychange` is the reliable browser signal;
## it fires on the document even when the canvas never receives focus.
func _install_web_visibility_listener() -> void:
	if not OS.has_feature("web"):
		return
	var bridge: Object = Engine.get_singleton("JavaScriptBridge")
	if bridge == null:
		print("WIRED_VISIBILITY_LISTENER_UNAVAILABLE reason=no_bridge")
		return
	var document: Object = bridge.get_interface("document")
	if document == null:
		print("WIRED_VISIBILITY_LISTENER_UNAVAILABLE reason=no_document")
		return
	_web_bridge = bridge
	_visibility_callback = bridge.create_callback(_on_visibility_changed)
	document.addEventListener("visibilitychange", _visibility_callback)
	print("WIRED_VISIBILITY_LISTENER_READY")


func _on_visibility_changed(_args: Array) -> void:
	if _web_bridge == null:
		return
	var document: Object = _web_bridge.get_interface("document")
	if document == null:
		return
	# Leave the JavaScript callback stack before sending the RPC.
	call_deferred("_handle_visibility", not bool(document.hidden))


## The visible transition is the recovery point: the hidden tab may have
## dropped synchronizer/spawner packets. Hidden itself sends nothing.
func _handle_visibility(visible: bool) -> void:
	if visible and mode == "client":
		request_world_snapshot()


func _exit_tree() -> void:
	if _web_bridge == null or _visibility_callback == null:
		return
	var document: Object = _web_bridge.get_interface("document")
	if document != null:
		document.removeEventListener("visibilitychange", _visibility_callback)
	_visibility_callback = null
	_web_bridge = null


func _process(_delta: float) -> void:
	if mode != "server":
		return
	var now := Time.get_ticks_msec() / 1000.0
	var timed_out: Array = []
	for peer_id in _pending:
		if now - float(_pending[peer_id]) > AUTH_TIMEOUT_SEC:
			timed_out.append(peer_id)
	for peer_id in timed_out:
		print("WIRED_AUTH_TIMEOUT peer=%d" % peer_id)
		_reject(int(peer_id), "auth_timeout")


# --- server ---------------------------------------------------------------


func start_server(
	port: int, room: String, secret: String, bind_address: String
) -> Error:
	mode = "server"
	room_code = room
	_ticket_secret = secret
	var peer := _make_peer()
	var err := peer.create_server(port, bind_address)
	if err != OK:
		print("WIRED_SERVER_ERROR create_server err=%d" % err)
		return err
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.multiplayer_peer = peer
	print("WIRED_SERVER_READY room=%s port=%d bind=%s" % [room, port, bind_address])
	status_changed.emit("Server ready on %s:%d" % [bind_address, port])
	return OK


func _on_peer_connected(peer_id: int) -> void:
	# Transport is up, but the peer is NOT part of the game yet.
	_pending[peer_id] = Time.get_ticks_msec() / 1000.0
	print("WIRED_PEER_CONNECTED peer=%d pending=1" % peer_id)


func _on_peer_disconnected(peer_id: int) -> void:
	# The transport callback is only connected by `start_server`, but keep the
	# server-only contract explicit: clients never own player lifecycle state.
	if mode != "server":
		return
	_pending.erase(peer_id)
	_package_reports.erase(peer_id)
	if not _players.has(peer_id):
		print("WIRED_PEER_DISCONNECTED peer=%d (unauthenticated)" % peer_id)
		return
	var pid: int = _players[peer_id][KEY_PLAYER_ID]
	_players.erase(peer_id)
	print("WIRED_PLAYER_LEFT peer=%d player=%d" % [peer_id, pid])
	_broadcast_event({KEY_TYPE: EVENT_PLAYER_LEFT, KEY_PLAYER_ID: pid})
	# Emitted after the peer is gone from `_players`, so the player manager can
	# free the node and drop the auth record exactly once.
	peer_left.emit(peer_id)


@rpc("any_peer", "call_remote", "reliable")
func cli_hello(payload_json: String) -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if _players.has(peer_id):
		return
	var payload: Variant = JSON.parse_string(payload_json)
	if typeof(payload) != TYPE_DICTIONARY:
		_reject(peer_id, "malformed_hello")
		return
	if int(payload.get("protocol", 0)) != PROTOCOL_VERSION:
		_reject(peer_id, "protocol_mismatch")
		return
	var ticket := str(payload.get("ticket", ""))
	var result := WiredTicket.verify(
		ticket, _ticket_secret, room_code, Time.get_unix_time_from_system()
	)
	if not result.ok:
		_reject(peer_id, str(result.reason))
		return
	var nonce := str(result.nonce)
	_prune_used_nonces(Time.get_unix_time_from_system())
	if _used_nonces.has(nonce):
		_reject(peer_id, "ticket_reused")
		return
	# The nonce is kept only until its ticket expires: `WiredTicket.verify`
	# rejects an expired ticket anyway, so burning it after that point is
	# pointless and would grow the set for the life of the process.
	_used_nonces[nonce] = int(result.get("exp", 0))
	_pending.erase(peer_id)
	var pid := _next_player_id
	_next_player_id += 1
	_players[peer_id] = {
		KEY_PLAYER_ID: pid,
		"ready": false,
		"packages_ready": false,
		"name": str(payload.get("name", "player")),
	}
	_package_reports[peer_id] = {}
	var auth := {
		"protocol": PROTOCOL_VERSION,
		"room": room_code,
		KEY_PLAYER_ID: pid,
		"peer_id": peer_id,
		"server_time": Time.get_unix_time_from_system(),
	}
	rpc_id(peer_id, "srv_auth_ok", JSON.stringify(auth))
	print("WIRED_AUTH_OK peer=%d player=%d room=%s" % [peer_id, pid, room_code])
	var state := {
		KEY_TYPE: EVENT_WORLD_STATE,
		"seq": _next_seq(),
		"room": room_code,
		"server_time": Time.get_unix_time_from_system(),
		"players": _player_list(),
	}
	rpc_id(peer_id, "srv_event", JSON.stringify(state))
	# A client that joins late (or reconnects after a lost notification) gets
	# the current revisions immediately; it then downloads and reports itself.
	_send_package_revisions(peer_id)
	peer_authenticated.emit(peer_id, pid, str(_players[peer_id]["name"]))
	_broadcast_event({KEY_TYPE: EVENT_PLAYER_JOINED, KEY_PLAYER_ID: pid})


@rpc("any_peer", "call_remote", "reliable")
func cli_ready() -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if not _players.has(peer_id):
		_deny(peer_id, "cli_ready")
		return
	_players[peer_id]["ready"] = true
	print(
		"WIRED_PLAYER_READY peer=%d player=%d"
		% [peer_id, int(_players[peer_id][KEY_PLAYER_ID])]
	)
	_broadcast_event(
		{KEY_TYPE: EVENT_PLAYER_READY, KEY_PLAYER_ID: _players[peer_id][KEY_PLAYER_ID]}
	)
	# A room without packages has nothing to download: spawning is gated only
	# by `cli_ready`, as specified. With packages, `cli_package_ready` emits.
	if _package_revisions.is_empty():
		_mark_packages_ready(peer_id)


@rpc("any_peer", "call_remote", "reliable")
func cli_ack_event(seq: int) -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if not _players.has(peer_id):
		_deny(peer_id, "cli_ack_event")
		return
	print(
		"WIRED_EVENT_ACK peer=%d player=%d seq=%d"
		% [peer_id, int(_players[peer_id][KEY_PLAYER_ID]), seq]
	)


@rpc("any_peer", "call_remote", "reliable")
func cli_game_action(action_json: String) -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if not _players.has(peer_id):
		print(
			"WIRED_ACTION_REJECTED peer=%d reason=not_authenticated action=%s"
			% [peer_id, action_json]
		)
		_deny(peer_id, "cli_game_action")
		return
	print(
		"WIRED_ACTION_ACCEPTED peer=%d player=%d action=%s"
		% [peer_id, int(_players[peer_id][KEY_PLAYER_ID]), action_json]
	)


## Gameplay input travels on the unreliable-ordered channel: a dropped frame is
## preferable to a stale one, and the sender is always re-checked here.
@rpc("any_peer", "call_remote", "unreliable_ordered")
func cli_player_input(input: Dictionary) -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if not _players.has(peer_id):
		print("WIRED_PLAYER_INPUT_REJECTED peer=%d reason=not_authenticated" % peer_id)
		_deny(peer_id, "cli_player_input")
		return
	player_input_received.emit(peer_id, input)


## Gameplay actions are reliable and only accepted from authenticated peers.
@rpc("any_peer", "call_remote", "reliable")
func cli_player_action(action: String, payload: Dictionary) -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if not _players.has(peer_id):
		print("WIRED_PLAYER_ACTION_REJECTED peer=%d reason=not_authenticated" % peer_id)
		_deny(peer_id, "cli_player_action")
		return
	if action.is_empty():
		print("WIRED_PLAYER_ACTION_REJECTED peer=%d reason=empty_action" % peer_id)
		return
	player_action_received.emit(peer_id, action, payload)


## A late joiner may have missed a package revision between the initial snapshot
## and its own readiness. It asks again; the answer is still server-authored and
## is only sent to a peer that completed auth and the initial package gate.
@rpc("any_peer", "call_remote", "reliable")
func cli_world_snapshot() -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if not _players.has(peer_id):
		print("WIRED_SNAPSHOT_REJECTED peer=%d reason=not_authenticated" % peer_id)
		_deny(peer_id, "cli_world_snapshot")
		return
	if not is_peer_packages_ready(peer_id):
		print("WIRED_SNAPSHOT_REJECTED peer=%d reason=packages_not_ready" % peer_id)
		return
	world_snapshot_requested.emit(peer_id)


## Server side: sends the current players and dynamic entities to one peer.
## This is the fallback for spawns that `MultiplayerSpawner` replayed before the
## late client had applied its packages; it is idempotent on the receiver.
func send_world_snapshot(peer_id: int, snapshot: Dictionary) -> void:
	if mode != "server" or not _players.has(peer_id):
		return
	if not is_peer_packages_ready(peer_id):
		return
	var payload := snapshot.duplicate(true)
	payload[KEY_TYPE] = EVENT_WORLD_SNAPSHOT
	payload["seq"] = _next_seq()
	rpc_id(peer_id, "srv_world_snapshot", payload)
	var players: Variant = payload.get(WiredProtocol.KEY_PLAYERS, [])
	var dynamic_records: Variant = payload.get(WiredProtocol.KEY_DYNAMIC_WORLD, [])
	print(
		"WIRED_WORLD_SNAPSHOT_SENT peer=%d players=%d dynamic=%d"
		% [
			peer_id,
			(players as Array).size() if players is Array else 0,
			(dynamic_records as Array).size() if dynamic_records is Array else 0,
		]
	)


## Client side: asks for a fresh snapshot after a package revision mismatch.
func request_world_snapshot() -> void:
	if mode != "client" or not _authenticated:
		return
	rpc_id(SERVER_PEER_ID, "cli_world_snapshot")
	print("WIRED_CLIENT_SNAPSHOT_REQUESTED")


## Announces an applied package revision to every authenticated client. Only
## the ids travel here; files are downloaded over HTTP by each receiver.
##
## The same revision can carry different content: a runtime artifact embeds its
## dependencies, so a library update re-applies a dependent without bumping its
## own revision. An explicit apply is therefore always broadcast, while
## `_send_package_revisions` still gives new peers the latest revision only.
func set_package_revision(package_id: int, revision: int) -> void:
	if mode != "server" or package_id <= 0 or revision <= 0:
		return
	_package_revisions[package_id] = revision
	print(
		"WIRED_PACKAGE_REVISION_ANNOUNCED package=%d revision=%d players=%d"
		% [package_id, revision, _players.size()]
	)
	_broadcast_event(
		{KEY_TYPE: EVENT_PACKAGE_REVISION, "package_id": package_id, "revision": revision}
	)


## Drops a package from the announced set and tells every client to unload it.
## Reports of that package are erased too: readiness for a package that no
## longer exists must not keep a peer from becoming ready.
func remove_package_revision(package_id: int) -> void:
	if mode != "server" or package_id <= 0:
		return
	if not _package_revisions.has(package_id):
		return
	_package_revisions.erase(package_id)
	for peer_id in _package_reports:
		_package_reports[peer_id].erase(package_id)
	print("WIRED_PACKAGE_REVISION_REMOVED package=%d" % package_id)
	_broadcast_event(
		{KEY_TYPE: EVENT_PACKAGE_REMOVED, "package_id": package_id}
	)


func _send_package_revisions(peer_id: int) -> void:
	for package_id in _package_revisions:
		var event := {
			KEY_TYPE: EVENT_PACKAGE_REVISION,
			"package_id": int(package_id),
			"revision": int(_package_revisions[package_id]),
			"seq": _next_seq(),
		}
		rpc_id(peer_id, "srv_event", JSON.stringify(event))


## A client reports whether it applied the announced revision. Unauthenticated,
## unknown and obsolete reports are rejected; the server tracks each peer
## separately so one slow or broken client cannot mask another's readiness.
@rpc("any_peer", "call_remote", "reliable")
func cli_package_ready(payload_json: String) -> void:
	if mode != "server":
		return
	var peer_id := _remote_sender_id()
	if not _players.has(peer_id):
		print(
			"WIRED_PACKAGES_REPORT_REJECTED peer=%d reason=not_authenticated" % peer_id
		)
		_deny(peer_id, "cli_package_ready")
		return
	var payload: Variant = JSON.parse_string(payload_json)
	if typeof(payload) != TYPE_DICTIONARY:
		print("WIRED_PACKAGES_REPORT_REJECTED peer=%d reason=malformed" % peer_id)
		return
	var package_id := int(payload.get("package_id", 0))
	var revision := int(payload.get("revision", 0))
	if not _package_revisions.has(package_id):
		print(
			"WIRED_PACKAGES_REPORT_REJECTED peer=%d package=%d reason=unknown_package"
			% [peer_id, package_id]
		)
		return
	var current_revision := int(_package_revisions[package_id])
	if revision < current_revision:
		print(
			"WIRED_PACKAGES_REPORT_REJECTED peer=%d package=%d reason=stale_revision current=%d"
			% [peer_id, package_id, current_revision]
		)
		return
	# A client may see a newer manifest than the runtime (publish raced the
	# apply). Accept it so the report is not silently lost, and track it.
	if revision > current_revision:
		_package_revisions[package_id] = revision
	var ok := bool(payload.get("ok", false))
	var error := _single_line(str(payload.get("error", "")))
	_package_reports[peer_id][package_id] = {
		"revision": revision,
		"state": "ready" if ok else "failed",
	}
	if ok:
		print(
			"WIRED_CLIENT_PACKAGES_READY peer=%d package=%d revision=%d"
			% [peer_id, package_id, revision]
		)
	else:
		print(
			"WIRED_CLIENT_PACKAGES_FAILED peer=%d package=%d revision=%d error=%s"
			% [peer_id, package_id, revision, error]
		)
	if PackageReadiness.is_ready(_package_revisions, _package_reports[peer_id]):
		_mark_packages_ready(peer_id)


## Emits the initial-spawn gate at most once per peer. Readiness is never reset:
## later revisions are applied while the player already exists.
func _mark_packages_ready(peer_id: int) -> void:
	if not _players.has(peer_id):
		return
	var player: Dictionary = _players[peer_id]
	if bool(player.get("packages_ready", false)):
		return
	player["packages_ready"] = true
	print(
		"WIRED_PEER_PACKAGES_READY peer=%d player=%d"
		% [peer_id, int(player[KEY_PLAYER_ID])]
	)
	peer_packages_ready.emit(peer_id)


## Drops burned nonces whose ticket can no longer pass verification. Called
## before every hello, so the set stays bounded by the connection rate inside
## one ticket lifetime instead of growing for the life of the process.
func _prune_used_nonces(now_unix: float) -> void:
	for nonce: Variant in _used_nonces.keys():
		if int(_used_nonces[nonce]) <= int(now_unix):
			_used_nonces.erase(nonce)


func _single_line(text: String) -> String:
	return text.replace("\r", " ").replace("\n", " ")


func _reject(peer_id: int, reason: String) -> void:
	print("WIRED_AUTH_REJECTED peer=%d reason=%s" % [peer_id, reason])
	_pending.erase(peer_id)
	if multiplayer != null and multiplayer.multiplayer_peer != null:
		rpc_id(peer_id, "srv_auth_error", reason)
	var timer := get_tree().create_timer(0.25)
	timer.timeout.connect(func() -> void: _disconnect_peer(peer_id))


func _disconnect_peer(peer_id: int) -> void:
	if multiplayer == null or multiplayer.multiplayer_peer == null:
		return
	if multiplayer.get_peers().has(peer_id):
		multiplayer.multiplayer_peer.disconnect_peer(peer_id)
		print("WIRED_PEER_DROPPED peer=%d" % peer_id)


## The sender of the RPC being handled, or 0 when called outside a transport
## (headless tests and direct handler probes). Never indexes a null API.
func _remote_sender_id() -> int:
	var api := multiplayer
	if api == null:
		return 0
	return api.get_remote_sender_id()


func _deny(peer_id: int, method: String) -> void:
	print("WIRED_RPC_DENIED peer=%d method=%s reason=not_authenticated" % [peer_id, method])
	if multiplayer == null:
		return
	rpc_id(
		peer_id,
		"srv_event",
		JSON.stringify(
			{KEY_TYPE: EVENT_ERROR, "reason": "not_authenticated", "method": method}
		)
	)


func _next_seq() -> int:
	_server_seq += 1
	return _server_seq


func _broadcast_event(event: Dictionary) -> void:
	event["seq"] = _next_seq()
	var payload := JSON.stringify(event)
	for peer_id in _players:
		rpc_id(int(peer_id), "srv_event", payload)


func _player_list() -> Array:
	var list: Array = []
	for peer_id in _players:
		list.append(
			{
				KEY_PLAYER_ID: _players[peer_id][KEY_PLAYER_ID],
				"ready": _players[peer_id]["ready"],
			}
		)
	return list


func get_active_player_count() -> int:
	return _players.size()


## Server side: whether the initial package gate opened for this peer. Unknown
## and unauthenticated peers are not ready.
func is_peer_packages_ready(peer_id: int) -> bool:
	if not _players.has(peer_id):
		return false
	var player: Dictionary = _players[peer_id]
	return bool(player.get("packages_ready", false))


## Server side: whether the peer completed ticket authentication. Used by the
## snapshot/audit paths; spawner/synchronizer traffic itself is transport-level
## and cannot be filtered per peer in Godot 4.7 (documented limitation).
func is_peer_authenticated(peer_id: int) -> bool:
	return _players.has(peer_id)


## Server side: copy of the announced revisions, for diagnostics and snapshots.
func get_package_revisions() -> Dictionary:
	return _package_revisions.duplicate(true)


func get_server_seq() -> int:
	return _server_seq


## Both modes create their peer through here so the buffers cannot drift apart.
## The sizes must be set before `create_client`/`create_server`, which propagate
## them to the underlying WebSocket peer.
func _make_peer() -> WebSocketMultiplayerPeer:
	var peer := WebSocketMultiplayerPeer.new()
	peer.inbound_buffer_size = NETWORK_BUFFER_SIZE
	peer.outbound_buffer_size = NETWORK_BUFFER_SIZE
	return peer


# --- client ---------------------------------------------------------------


func start_client(
	url: String,
	ticket: String,
	room: String,
	send_hello := true,
	probe_action := false
) -> Error:
	mode = "client"
	# The Web singleton is only guaranteed once the scene is ready, so install
	# the tab listener here rather than in `_enter_tree`.
	_install_web_visibility_listener()
	room_code = room
	_ticket = ticket
	_send_hello = send_hello
	_probe_action = probe_action
	_auth_error = ""
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)
	var peer := _make_peer()
	var err := peer.create_client(url)
	if err != OK:
		print("WIRED_CLIENT_ERROR create_client err=%d" % err)
		status_changed.emit("Cannot open %s: %s" % [url, error_string(err)])
		return err
	multiplayer.multiplayer_peer = peer
	print("WIRED_CLIENT_CONNECTING url=%s room=%s" % [url, room])
	status_changed.emit("Connecting to %s…" % url)
	return OK


## Client side: reports the outcome of applying an announced revision. Every
## report carries the revision it refers to; the server rejects stale ones.
func report_package_ready(
	package_id: int, revision: int, ok: bool, error := ""
) -> void:
	if mode != "client" or not _authenticated:
		return
	var payload := {
		"package_id": package_id,
		"revision": revision,
		"ok": ok,
		"error": _single_line(error),
	}
	rpc_id(SERVER_PEER_ID, "cli_package_ready", JSON.stringify(payload))
	print(
		"WIRED_CLIENT_PACKAGE_REPORT package=%d revision=%d ok=%s"
		% [package_id, revision, str(ok)]
	)


## Client side: sends the current local input snapshot. Only authenticated
## clients may send; the RPC itself uses the unreliable-ordered channel.
func send_player_input(input: Dictionary) -> void:
	if mode != "client" or not _authenticated:
		return
	rpc_id(SERVER_PEER_ID, "cli_player_input", input)


## Client side: sends a gameplay action reliably. Only authenticated clients
## may send, and an empty action is never forwarded.
func send_player_action(action: String, payload: Dictionary) -> void:
	if mode != "client" or not _authenticated:
		return
	if action.is_empty():
		return
	rpc_id(SERVER_PEER_ID, "cli_player_action", action, payload)


func _on_connected_to_server() -> void:
	print("WIRED_CLIENT_WEBSOCKET_OPEN room=%s" % room_code)
	status_changed.emit("Connected, authenticating…")
	if _probe_action:
		# Probe-only: proves gameplay RPCs are denied before authentication.
		rpc_id(SERVER_PEER_ID, "cli_game_action", JSON.stringify({"type": "probe_move"}))
		print("WIRED_CLIENT_PROBE_ACTION_SENT")
	if not _send_hello:
		print("WIRED_CLIENT_HELLO_SUPPRESSED")
		return
	var payload := {
		"protocol": PROTOCOL_VERSION,
		"ticket": _ticket,
		"room": room_code,
		"name": "web-client",
	}
	rpc_id(SERVER_PEER_ID, "cli_hello", JSON.stringify(payload))


func _on_connection_failed() -> void:
	print("WIRED_CLIENT_CONNECTION_FAILED")
	status_changed.emit("Connection failed")
	connection_failed.emit()


func _on_server_disconnected() -> void:
	print("WIRED_CLIENT_SERVER_DISCONNECTED")
	_authenticated = false
	if _auth_error.is_empty():
		status_changed.emit("Disconnected from server")
	else:
		status_changed.emit("Authentication failed: %s" % _auth_error)
	disconnected.emit()


@rpc("authority", "call_remote", "reliable")
func srv_auth_ok(payload_json: String) -> void:
	if mode != "client":
		return
	var payload: Variant = JSON.parse_string(payload_json)
	if typeof(payload) != TYPE_DICTIONARY:
		status_changed.emit("Malformed auth response")
		return
	player_id = int(payload.get(KEY_PLAYER_ID, 0))
	_authenticated = true
	print(
		"WIRED_CLIENT_AUTH_OK player=%d room=%s"
		% [player_id, str(payload.get("room", ""))]
	)
	status_changed.emit("Authenticated as player %d" % player_id)
	authenticated.emit(player_id)
	rpc_id(SERVER_PEER_ID, "cli_ready")


@rpc("authority", "call_remote", "reliable")
func srv_auth_error(reason: String) -> void:
	if mode != "client":
		return
	print("WIRED_CLIENT_AUTH_ERROR reason=%s" % reason)
	_auth_error = reason
	status_changed.emit("Authentication failed: %s" % reason)
	auth_failed.emit(reason)


@rpc("authority", "call_remote", "reliable")
func srv_event(payload_json: String) -> void:
	if mode != "client":
		return
	var payload: Variant = JSON.parse_string(payload_json)
	if typeof(payload) != TYPE_DICTIONARY:
		return
	print("WIRED_CLIENT_EVENT " + payload_json)
	server_event.emit(payload)
	var event_type := str(payload.get(KEY_TYPE, "event"))
	log_line.emit("%s %s" % [event_type, payload_json])
	if event_type != EVENT_ERROR and payload.has("seq"):
		var seq := int(payload["seq"])
		rpc_id(SERVER_PEER_ID, "cli_ack_event", seq)
		print("WIRED_CLIENT_ACK_SENT seq=%d" % seq)


## The binary Variant channel carries Vector2/Vector3 state without the lossy
## string conversion JSON would apply.
@rpc("authority", "call_remote", "reliable")
func srv_world_snapshot(snapshot: Dictionary) -> void:
	if mode != "client":
		return
	var players: Variant = snapshot.get(WiredProtocol.KEY_PLAYERS, [])
	var dynamic_records: Variant = snapshot.get(WiredProtocol.KEY_DYNAMIC_WORLD, [])
	print(
		"WIRED_CLIENT_WORLD_SNAPSHOT players=%d dynamic=%d"
		% [
			(players as Array).size() if players is Array else 0,
			(dynamic_records as Array).size() if dynamic_records is Array else 0,
		]
	)
	world_snapshot_received.emit(snapshot)
