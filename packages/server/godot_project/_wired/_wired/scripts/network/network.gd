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

const PROTOCOL_VERSION := 1
const AUTH_TIMEOUT_SEC := 10.0
const SERVER_PEER_ID := 1

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
var _used_nonces: Dictionary = {}
# server: latest applied revision per package id
var _package_revisions: Dictionary = {}
# server: peer -> { package_id: {revision, state} }
var _package_reports: Dictionary = {}


func _enter_tree() -> void:
	get_tree().set_multiplayer(
		MultiplayerAPI.create_default_interface(), NodePath("/root")
	)


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
	var peer := WebSocketMultiplayerPeer.new()
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
	_pending.erase(peer_id)
	_package_reports.erase(peer_id)
	if not _players.has(peer_id):
		print("WIRED_PEER_DISCONNECTED peer=%d (unauthenticated)" % peer_id)
		return
	var pid: int = _players[peer_id]["player_id"]
	_players.erase(peer_id)
	print("WIRED_PLAYER_LEFT peer=%d player=%d" % [peer_id, pid])
	_broadcast_event({"type": "player_left", "player_id": pid})


@rpc("any_peer", "call_remote", "reliable")
func cli_hello(payload_json: String) -> void:
	if mode != "server":
		return
	var peer_id := multiplayer.get_remote_sender_id()
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
	if _used_nonces.has(nonce):
		_reject(peer_id, "ticket_reused")
		return
	_used_nonces[nonce] = true
	_pending.erase(peer_id)
	var pid := _next_player_id
	_next_player_id += 1
	_players[peer_id] = {
		"player_id": pid,
		"ready": false,
		"name": str(payload.get("name", "player")),
	}
	_package_reports[peer_id] = {}
	var auth := {
		"protocol": PROTOCOL_VERSION,
		"room": room_code,
		"player_id": pid,
		"peer_id": peer_id,
		"server_time": Time.get_unix_time_from_system(),
	}
	rpc_id(peer_id, "srv_auth_ok", JSON.stringify(auth))
	print("WIRED_AUTH_OK peer=%d player=%d room=%s" % [peer_id, pid, room_code])
	var state := {
		"type": "world_state",
		"seq": _next_seq(),
		"room": room_code,
		"server_time": Time.get_unix_time_from_system(),
		"players": _player_list(),
	}
	rpc_id(peer_id, "srv_event", JSON.stringify(state))
	# A client that joins late (or reconnects after a lost notification) gets
	# the current revisions immediately; it then downloads and reports itself.
	_send_package_revisions(peer_id)
	_broadcast_event({"type": "player_joined", "player_id": pid})


@rpc("any_peer", "call_remote", "reliable")
func cli_ready() -> void:
	if mode != "server":
		return
	var peer_id := multiplayer.get_remote_sender_id()
	if not _players.has(peer_id):
		_deny(peer_id, "cli_ready")
		return
	_players[peer_id]["ready"] = true
	print(
		"WIRED_PLAYER_READY peer=%d player=%d"
		% [peer_id, int(_players[peer_id]["player_id"])]
	)
	_broadcast_event({"type": "player_ready", "player_id": _players[peer_id]["player_id"]})


@rpc("any_peer", "call_remote", "reliable")
func cli_ack_event(seq: int) -> void:
	if mode != "server":
		return
	var peer_id := multiplayer.get_remote_sender_id()
	if not _players.has(peer_id):
		_deny(peer_id, "cli_ack_event")
		return
	print(
		"WIRED_EVENT_ACK peer=%d player=%d seq=%d"
		% [peer_id, int(_players[peer_id]["player_id"]), seq]
	)


@rpc("any_peer", "call_remote", "reliable")
func cli_game_action(action_json: String) -> void:
	if mode != "server":
		return
	var peer_id := multiplayer.get_remote_sender_id()
	if not _players.has(peer_id):
		print(
			"WIRED_ACTION_REJECTED peer=%d reason=not_authenticated action=%s"
			% [peer_id, action_json]
		)
		_deny(peer_id, "cli_game_action")
		return
	print(
		"WIRED_ACTION_ACCEPTED peer=%d player=%d action=%s"
		% [peer_id, int(_players[peer_id]["player_id"]), action_json]
	)


## Announces an applied package revision to every authenticated client. Only
## the ids travel here; files are downloaded over HTTP by each receiver.
func set_package_revision(package_id: int, revision: int) -> void:
	if mode != "server" or package_id <= 0 or revision <= 0:
		return
	if int(_package_revisions.get(package_id, 0)) == revision:
		return
	_package_revisions[package_id] = revision
	print(
		"WIRED_PACKAGE_REVISION_ANNOUNCED package=%d revision=%d players=%d"
		% [package_id, revision, _players.size()]
	)
	_broadcast_event(
		{"type": "package_revision", "package_id": package_id, "revision": revision}
	)


func _send_package_revisions(peer_id: int) -> void:
	for package_id in _package_revisions:
		var event := {
			"type": "package_revision",
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
	var peer_id := multiplayer.get_remote_sender_id()
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


func _single_line(text: String) -> String:
	return text.replace("\r", " ").replace("\n", " ")


func _reject(peer_id: int, reason: String) -> void:
	print("WIRED_AUTH_REJECTED peer=%d reason=%s" % [peer_id, reason])
	_pending.erase(peer_id)
	if multiplayer.multiplayer_peer != null:
		rpc_id(peer_id, "srv_auth_error", reason)
	var timer := get_tree().create_timer(0.25)
	timer.timeout.connect(func() -> void: _disconnect_peer(peer_id))


func _disconnect_peer(peer_id: int) -> void:
	if multiplayer.multiplayer_peer == null:
		return
	if multiplayer.get_peers().has(peer_id):
		multiplayer.multiplayer_peer.disconnect_peer(peer_id)
		print("WIRED_PEER_DROPPED peer=%d" % peer_id)


func _deny(peer_id: int, method: String) -> void:
	print("WIRED_RPC_DENIED peer=%d method=%s reason=not_authenticated" % [peer_id, method])
	rpc_id(
		peer_id,
		"srv_event",
		JSON.stringify({"type": "error", "reason": "not_authenticated", "method": method})
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
				"player_id": _players[peer_id]["player_id"],
				"ready": _players[peer_id]["ready"],
			}
		)
	return list


func get_active_player_count() -> int:
	return _players.size()


func get_server_seq() -> int:
	return _server_seq


# --- client ---------------------------------------------------------------


func start_client(
	url: String,
	ticket: String,
	room: String,
	send_hello := true,
	probe_action := false
) -> Error:
	mode = "client"
	room_code = room
	_ticket = ticket
	_send_hello = send_hello
	_probe_action = probe_action
	_auth_error = ""
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)
	var peer := WebSocketMultiplayerPeer.new()
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
	player_id = int(payload.get("player_id", 0))
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
	var event_type := str(payload.get("type", "event"))
	log_line.emit("%s %s" % [event_type, payload_json])
	if event_type != "error" and payload.has("seq"):
		var seq := int(payload["seq"])
		rpc_id(SERVER_PEER_ID, "cli_ack_event", seq)
		print("WIRED_CLIENT_ACK_SENT seq=%d" % seq)
