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

var _server_port := 0
var _state_dir := ""
var _control_thread: Thread = null
var _shutdown_in_progress := false
var _authenticated_once := false
var _auth_error_reported := false
var _packages: PackagesManager

@onready var _net: WiredNetwork = $Net
@onready var _status: Label = $UI/Margin/VBox/Status
@onready var _log: RichTextLabel = $UI/Margin/VBox/Log


func _ready() -> void:
	var cfg := _read_config()
	# The room is part of the package directory, so it has to be known before
	# the loader is configured.
	_setup_packages(str(cfg.get("room", DEFAULT_ROOM)))
	_net.status_changed.connect(_on_status_changed)
	_net.log_line.connect(_on_log_line)
	_net.authenticated.connect(_on_authenticated)
	_net.auth_failed.connect(_on_auth_failed)
	_net.connection_failed.connect(_on_connection_failed)
	_net.disconnected.connect(_on_server_disconnected)
	_net.server_event.connect(_on_server_event)
	# The host waits for this before minting a ticket.
	_bridge_call("notifyReady", [])
	if str(cfg.get("mode", "")) == "server":
		_run_server(cfg)
	else:
		await _run_client(cfg)


## Both runtime modes load published package files over plain HTTP, so the
## loader is created before the network starts.
func _setup_packages(room: String) -> void:
	_packages = PackagesManager.new()
	_packages.name = "Packages"
	add_child(_packages)
	_packages.configure(_api_url(), room)


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
	_server_port = int(cfg.port)
	_state_dir = str(cfg.get("state_dir", ""))
	print(
		"WIRED_SERVER_STARTING room=%s port=%d bind=%s"
		% [cfg.room, cfg.port, cfg.bind]
	)
	var err := _net.start_server(int(cfg.port), str(cfg.room), secret, str(cfg.bind))
	if err != OK:
		_fail("server start failed: %s" % error_string(err))
		get_tree().quit(3)
		return
	_start_control_listener()


## Backend sends one line over stdin: `shutdown`. The same thread also notices
## EOF, which happens when the backend dies, so a killed backend cannot leave
## an orphaned Godot server behind.
func _start_control_listener() -> void:
	_control_thread = Thread.new()
	var err := _control_thread.start(_control_loop)
	if err != OK:
		print("WIRED_CONTROL_ERROR cannot start stdin thread err=%d" % err)


func _control_loop() -> void:
	while not _shutdown_in_progress:
		var line := OS.read_string_from_stdin()
		if line.is_empty():
			call_deferred("_request_shutdown", "stdin_closed")
			return
		var command := line.strip_edges()
		if command == "shutdown":
			call_deferred("_request_shutdown", "shutdown_command")
			return
		if command.begins_with("package "):
			var parts := command.split(" ", false)
			if (
				parts.size() == 3
				and parts[1].is_valid_int()
				and parts[2].is_valid_int()
			):
				call_deferred(
					"_apply_package_revision", int(parts[1]), int(parts[2])
				)
			else:
				print("WIRED_CONTROL_ERROR invalid_package_command=%s" % command)


## Server side: the backend asked for a published revision. The loader fetches
## the manifest, verifies hashes and writes the files; only then is the
## revision announced to clients. File bytes never travel over the game socket.
func _apply_package_revision(package_id: int, revision: int) -> void:
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
	_net.set_package_revision(package_id, applied)


func _request_shutdown(reason: String) -> void:
	if _shutdown_in_progress:
		return
	_shutdown_in_progress = true
	print("WIRED_SHUTDOWN_REQUESTED reason=%s" % reason)
	_save_state(reason)
	print("WIRED_SHUTDOWN_ACK")
	get_tree().quit(0)


## The project owns its save format; the backend only waits for the process to
## exit. The file is written to the per-room directory passed by the backend.
func _save_state(reason: String) -> void:
	var state := {
		"room": _net.room_code,
		"port": _server_port,
		"reason": reason,
		"active_players": _net.get_active_player_count(),
		"server_seq": _net.get_server_seq(),
		"saved_at": Time.get_datetime_string_from_system(true),
	}
	var dir := _state_dir
	if dir.is_empty():
		dir = "user://"
	else:
		var dir_err := DirAccess.make_dir_recursive_absolute(dir)
		if dir_err != OK:
			print(
				"WIRED_STATE_SAVE_FAILED dir=%s err=%s"
				% [dir, error_string(dir_err)]
			)
			return
	var path := dir.path_join("state.json")
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


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST and not _shutdown_in_progress:
		_request_shutdown("window_close")


func _run_client(cfg: Dictionary) -> void:
	if str(cfg.get("source", "")) == "bridge":
		_bridge_status("waiting", "Waiting for the Wired host")
		var bridge_config: Dictionary = await _wait_for_bridge_config(15.0)
		if bridge_config.is_empty():
			_fail("No game configuration received from the Wired host")
			return
		cfg["url"] = str(bridge_config.get("endpoint", ""))
		cfg["ticket"] = str(bridge_config.get("ticket", ""))
		cfg["room"] = str(bridge_config.get("room", ""))
		# The Web build is served from the frontend origin and cannot reach the
		# backend by itself; the host passes an absolute same-origin API root.
		# Empty keeps the headless default.
		_packages.set_api_base(str(bridge_config.get("apiBase", "")))
	if str(cfg.url).is_empty():
		_fail("No game endpoint: pass --url or open the Game tab")
		return
	if str(cfg.ticket).is_empty():
		_fail("No game ticket: pass --ticket or open the Game tab")
		return
	# Web clients learn the room from the host bridge, after the loader was
	# configured; apply it before anything touches package files.
	_packages.set_room(str(cfg.get("room", "")))
	print("WIRED_CLIENT_STARTING room=%s url=%s" % [cfg.room, cfg.url])
	_bridge_status("connecting", str(cfg.url))
	var err := _net.start_client(
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
	_status.text = message
	_status.modulate = Color(1.0, 0.45, 0.45)
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
	var event_type := str(event.get("type", ""))
	if event_type == "world_state":
		_bridge_status("ready", "world_state")
	elif event_type == "package_revision":
		_apply_client_package(
			int(event.get("package_id", 0)), int(event.get("revision", 0))
		)


## Client side: download and verify the announced revision over HTTP, then tell
## the server whether this client applied it.
func _apply_client_package(package_id: int, revision: int) -> void:
	if package_id <= 0 or revision <= 0:
		return
	print(
		"WIRED_CLIENT_PACKAGES_SYNC_STARTED package=%d revision=%d"
		% [package_id, revision]
	)
	var result: Dictionary = await _packages.sync_package(package_id, revision)
	var ok := bool(result.get("ok", false))
	var applied := int(result.get("revision", 0))
	if applied <= 0:
		applied = revision
	var error := "" if ok else str(result.get("error", ""))
	_net.report_package_ready(package_id, applied, ok, error)
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
	_status.text = text
	print("WIRED_STATUS %s" % text)


func _on_log_line(text: String) -> void:
	_log.append_text(text + "\n")
	print("WIRED_LOG %s" % text)
