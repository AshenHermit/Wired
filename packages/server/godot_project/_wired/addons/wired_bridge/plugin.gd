@tool
extends EditorPlugin

## Bridges the Wired shell to the editor.
##
## The shell writes package files directly into the Emscripten filesystem. Godot
## serves those files immediately, but EditorFileSystem keeps its own cache and
## does not notice external writes until it rescans. This plugin exposes two
## callbacks on `window.__wiredEditorBridge`:
## - `rescan()` asks the running editor to refresh its cache without a reload;
## - `request(requestId, op, paramsJson)` runs a package filesystem operation
##   and answers through `window.__wiredEditorBridgeResult({id, ok, value|error})`.
##
## Every request runs deferred: the callback itself only validates the
## arguments, so no filesystem work happens while JavaScript is still on the
## stack.

## Operations the shell may request. `sync` flushes the Emscripten filesystem
## and does not touch [WiredPackageFs].
const VALID_OPS := [
	"exists",
	"createDir",
	"snapshot",
	"collect",
	"prepareReplace",
	"replace",
	"delete",
	"sync",
]

var _bridge: Object = null
var _rescan_callback: Variant = null
var _request_callback: Variant = null


func _enter_tree() -> void:
	if not OS.has_feature("web"):
		return

	var bridge: Object = Engine.get_singleton("JavaScriptBridge")
	if bridge == null:
		push_warning("Wired editor bridge: JavaScriptBridge is unavailable")
		return
	_bridge = bridge

	_rescan_callback = bridge.create_callback(_on_rescan_requested)
	_request_callback = bridge.create_callback(_on_bridge_request)
	var window: Object = bridge.get_interface("window")
	if window == null:
		push_warning("Wired editor bridge: window interface is unavailable")
		return

	window.__wiredEditorRescan = _rescan_callback
	window.__wiredEditorRequest = _request_callback
	bridge.eval(
		"window.__wiredEditorBridge = { rescan: window.__wiredEditorRescan, request: window.__wiredEditorRequest };" +
		"delete window.__wiredEditorRescan; delete window.__wiredEditorRequest;",
		true
	)
	print("WIRED_EDITOR_BRIDGE_READY")


func _exit_tree() -> void:
	if not OS.has_feature("web"):
		return

	var bridge: Object = Engine.get_singleton("JavaScriptBridge")
	if bridge != null:
		bridge.eval(
			"delete window.__wiredEditorBridge; delete window.__wiredEditorRescan;" +
			"delete window.__wiredEditorRequest;",
			true
		)
	_rescan_callback = null
	_request_callback = null
	_bridge = null


func _on_rescan_requested(_args: Array) -> void:
	# The callback runs inside the JavaScript stack; defer the actual scan so
	# Godot does not re-enter its filesystem while JavaScript is still active.
	call_deferred("_scan_filesystem")


func _scan_filesystem() -> void:
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem == null:
		return
	filesystem.scan()


func _on_bridge_request(args: Array) -> void:
	# A JavaScript number arrives as a float, so the id is truncated to int.
	if args.size() < 3:
		_respond_error(0, "некорректный запрос: ожидались id, op и paramsJson")
		return

	var request_id := int(args[0])
	var op := str(args[1])
	var params_json := str(args[2])
	if request_id <= 0:
		_respond_error(request_id, "некорректный id запроса: %d" % request_id)
		return
	if not VALID_OPS.has(op):
		_respond_error(request_id, "Неизвестная операция: %s" % op)
		return

	var json := JSON.new()
	if json.parse(params_json) != OK or not json.data is Dictionary:
		_respond_error(request_id, "параметры запроса должны быть JSON-объектом")
		return
	var params: Dictionary = json.data

	# Never run filesystem work inside the JavaScript stack.
	call_deferred("_handle_request", request_id, op, params)


func _handle_request(request_id: int, op: String, params: Dictionary) -> void:
	var raw_package_id: Variant = params.get("packageId", 0)
	if not (raw_package_id is int or raw_package_id is float):
		_respond_error(request_id, "некорректный packageId")
		return
	var package_id := int(raw_package_id)

	var result: Dictionary
	match op:
		"exists":
			result = WiredPackageFs.op_exists(package_id)
		"createDir":
			result = WiredPackageFs.op_create_dir(package_id)
		"snapshot":
			result = WiredPackageFs.op_snapshot(package_id)
		"collect":
			result = WiredPackageFs.op_collect(package_id)
		"prepareReplace":
			result = WiredPackageFs.op_prepare_replace(package_id)
		"replace":
			result = WiredPackageFs.op_replace(package_id)
		"delete":
			result = WiredPackageFs.op_delete(package_id)
		"sync":
			JavaScriptBridge.force_fs_sync()
			result = {}
		_:
			_respond_error(request_id, "Неизвестная операция: %s" % op)
			return

	if result.has("error"):
		_respond_error(request_id, str(result["error"]))
		return
	_respond(request_id, result)


func _respond(request_id: int, value: Dictionary) -> void:
	_eval_result({"id": int(request_id), "ok": true, "value": value})


func _respond_error(request_id: int, message: String) -> void:
	_eval_result({"id": int(request_id), "ok": false, "error": message})


func _eval_result(message: Dictionary) -> void:
	var bridge: Object = _bridge
	if bridge == null:
		bridge = Engine.get_singleton("JavaScriptBridge")
	if bridge == null:
		return
	bridge.eval("window.__wiredEditorBridgeResult(%s)" % JSON.stringify(message), true)
