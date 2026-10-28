extends Node

## Entry point for both runtime modes of the game build:
##
##   server: godot --headless --path . --server --port <p> --room <room>
##   client: godot --path . --url ws://host:port --ticket <ticket> --room <room>
##   web:    index.html?ws=ws://host:port&ticket=<ticket>&room=<room>
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

@onready var _net: WiredNetwork = $Net
@onready var _status: Label = $UI/Margin/VBox/Status
@onready var _log: RichTextLabel = $UI/Margin/VBox/Log


func _ready() -> void:
	_net.status_changed.connect(_on_status_changed)
	_net.log_line.connect(_on_log_line)
	var cfg := _read_config()
	if str(cfg.get("mode", "")) == "server":
		_run_server(cfg)
	else:
		_run_client(cfg)


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
		cfg["url"] = _web_param("ws")
		cfg["ticket"] = _web_param("ticket")
		cfg["room"] = _web_param("room")
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
		if line.strip_edges() == "shutdown":
			call_deferred("_request_shutdown", "shutdown_command")
			return


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
	if str(cfg.url).is_empty():
		_fail("No game endpoint: pass --url or ?ws=…")
		return
	if str(cfg.ticket).is_empty():
		_fail("No game ticket: pass --ticket or ?ticket=…")
		return
	print("WIRED_CLIENT_STARTING room=%s url=%s" % [cfg.room, cfg.url])
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


func _web_param(name: String) -> String:
	if not OS.has_feature("web"):
		return ""
	return str(
		JavaScriptBridge.eval(
			"(new URLSearchParams(window.location.search).get('%s') || '')" % name,
			true,
		)
	)


func _fail(message: String) -> void:
	print("WIRED_CLIENT_ERROR %s" % message)
	_status.text = message
	_status.modulate = Color(1.0, 0.45, 0.45)
	_on_log_line(message)


func _on_status_changed(text: String) -> void:
	_status.text = text
	print("WIRED_STATUS %s" % text)


func _on_log_line(text: String) -> void:
	_log.append_text(text + "\n")
	print("WIRED_LOG %s" % text)
