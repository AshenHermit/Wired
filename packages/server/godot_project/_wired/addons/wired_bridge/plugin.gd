@tool
extends EditorPlugin

## Bridges the Wired shell to the editor's filesystem scanner.
##
## The shell writes package files directly into the Emscripten filesystem. Godot
## serves those files immediately, but EditorFileSystem keeps its own cache and
## does not notice external writes until it rescans. This plugin exposes exactly
## one callback, `window.__wiredEditorBridge.rescan()`, so the shell can ask the
## running editor to refresh its cache without a project reload.

var _rescan_callback: Variant = null


func _enter_tree() -> void:
	if not OS.has_feature("web"):
		return

	var bridge: Object = Engine.get_singleton("JavaScriptBridge")
	if bridge == null:
		push_warning("Wired editor bridge: JavaScriptBridge is unavailable")
		return

	_rescan_callback = bridge.create_callback(_on_rescan_requested)
	var window: Object = bridge.get_interface("window")
	if window == null:
		push_warning("Wired editor bridge: window interface is unavailable")
		return

	window.__wiredEditorRescan = _rescan_callback
	bridge.eval(
		"window.__wiredEditorBridge = { rescan: window.__wiredEditorRescan };" +
		"delete window.__wiredEditorRescan;",
		true
	)
	print("WIRED_EDITOR_BRIDGE_READY")


func _exit_tree() -> void:
	if not OS.has_feature("web"):
		return

	var bridge: Object = Engine.get_singleton("JavaScriptBridge")
	if bridge != null:
		bridge.eval(
			"delete window.__wiredEditorBridge; delete window.__wiredEditorRescan;",
			true
		)
	_rescan_callback = null


func _on_rescan_requested(_args: Array) -> void:
	# The callback runs inside the JavaScript stack; defer the actual scan so
	# Godot does not re-enter its filesystem while JavaScript is still active.
	call_deferred("_scan_filesystem")


func _scan_filesystem() -> void:
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem == null:
		return
	filesystem.scan()
