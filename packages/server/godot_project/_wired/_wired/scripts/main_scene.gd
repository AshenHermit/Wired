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
	print(
		"WIRED_SERVER_STARTING room=%s port=%d bind=%s"
		% [cfg.room, cfg.port, cfg.bind]
	)
	var err := _net.start_server(int(cfg.port), str(cfg.room), secret, str(cfg.bind))
	if err != OK:
		_fail("server start failed: %s" % error_string(err))
		get_tree().quit(3)


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
