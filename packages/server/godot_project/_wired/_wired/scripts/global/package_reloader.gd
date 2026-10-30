extends Node
class_name PackageReloader

## Recreates live package scene roots after a package revision was applied.
##
## A root is a topmost node that `PackagesManager.instantiate_scene` created:
## nothing above it belongs to a package scene. A nested package root is part
## of the outer scene, so it is recreated together with that outer root and is
## never replaced on its own.
##
## Only a root whose scene declares one of the changed files as a dependency is
## replaced (`scene_dependencies` includes the scene file itself). A library
## package without live roots is therefore a no-op.
##
## Replaced roots keep their name, parent index, exported script values and
## transform; children, Node references and external references are not carried
## over, they belong to the scene. Package metadata comes from the new
## instantiation, so the new revision is never overwritten by the old one.
##
## Autoloads and global `class_name` scripts are not reloaded: a runtime restart
## is required for those.

## Window in which applied changes are folded into one flush.
const RELOAD_DEBOUNCE_SEC := 0.2
## Properties kept across a replacement when the node has them. Exported script
## variables are captured separately through their property usage flags.
const PRESERVED_PROPERTIES := ["position", "rotation", "scale", "size"]

## Test seam: when set, also receives every printed reload log line.
var log_sink: Callable = Callable()

var _packages: PackagesManager
## package id -> { filepath: true } of the changes gathered in this window.
var _pending: Dictionary = {}
var _flush_scheduled := false


## Connects the reloader to a packages manager. Re-setting the same manager is a
## no-op; a different manager replaces the previous connection.
func setup(packages: PackagesManager) -> void:
	if packages == null or packages == _packages:
		return
	if _packages != null and is_instance_valid(_packages):
		if _packages.package_applied.is_connected(_on_package_applied):
			_packages.package_applied.disconnect(_on_package_applied)
	_packages = packages
	if not _packages.package_applied.is_connected(_on_package_applied):
		_packages.package_applied.connect(_on_package_applied)


## Records changed files of a package and schedules the single deferred flush
## of the current debounce window.
func reload_for(package_id: int, changed_files: PackedStringArray) -> void:
	if _packages == null or package_id <= 0 or changed_files.is_empty():
		return
	var files: Dictionary = _pending.get(package_id, {})
	for filepath: String in changed_files:
		files[filepath] = true
	_pending[package_id] = files
	_schedule_flush()


func _on_package_applied(
	package_id: int, _revision: int, changed_files: PackedStringArray
) -> void:
	reload_for(package_id, changed_files)


## The first change of a window starts the timer; later changes only extend the
## pending set, so a burst of applies produces exactly one flush.
func _schedule_flush() -> void:
	if _flush_scheduled:
		return
	var tree := get_tree()
	if tree == null:
		return
	_flush_scheduled = true
	await tree.create_timer(RELOAD_DEBOUNCE_SEC).timeout
	_flush_scheduled = false
	_flush()


func _flush() -> void:
	if _pending.is_empty():
		return
	var changed := _changed_entries(_pending)
	for root: Node in _collect_roots():
		_reload_root(root, changed)


## Flattens and clears the pending per-package changes into the
## "<package id>:<filepath>" entries used by the scene dependency map.
func _changed_entries(pending: Dictionary) -> Dictionary:
	var entries := {}
	for package_id: Variant in pending:
		var files: Dictionary = pending[package_id]
		for filepath: Variant in files:
			entries["%d:%s" % [int(package_id), str(filepath)]] = true
	pending.clear()
	return entries


## Topmost package scene roots of the live tree, in tree order.
func _collect_roots() -> Array[Node]:
	var roots: Array[Node] = []
	var tree := get_tree()
	if tree != null:
		_collect_roots_under(tree.root, roots)
	return roots


## A package root ends the descent: its nested package scenes belong to it.
func _collect_roots_under(node: Node, roots: Array[Node]) -> void:
	for child: Node in node.get_children():
		if child.has_meta("_wired_package_id"):
			roots.append(child)
			continue
		_collect_roots_under(child, roots)


func _reload_root(node: Node, changed: Dictionary) -> void:
	var package_id := int(node.get_meta("_wired_package_id", 0))
	var scene_path := str(node.get_meta("_wired_package_scene", ""))
	if package_id <= 0 or scene_path.is_empty():
		return
	if not _is_affected(package_id, scene_path, changed):
		return
	var parent := node.get_parent()
	if parent == null:
		_log(
			"WIRED_PACKAGE_RELOAD_FAILED package=%d scene=%s reason=no_parent"
			% [package_id, scene_path]
		)
		return
	var state := _capture_state(node)
	# Instantiate before touching the live node: a scene that no longer loads
	# keeps the old root, including its state and package metadata.
	var replacement := _packages.instantiate_scene(package_id, scene_path)
	if replacement == null:
		_log(
			"WIRED_PACKAGE_RELOAD_FAILED package=%d scene=%s reason=instantiate_failed"
			% [package_id, scene_path]
		)
		return
	parent.remove_child(node)
	replacement.name = str(state.get("name", replacement.name))
	_copy_metadata(node, replacement)
	_apply_state(replacement, state)
	parent.add_child(replacement)
	parent.move_child(replacement, int(state.get("index", 0)))
	node.queue_free()
	_log(
		"WIRED_PACKAGE_RELOADED package=%d scene=%s revision=%d"
		% [package_id, scene_path, int(replacement.get_meta("_wired_package_revision", 0))]
	)


## A root is reloaded only when one of the changed files is a dependency of its
## scene. The dependency list contains the scene file itself.
func _is_affected(package_id: int, scene_path: String, changed: Dictionary) -> bool:
	for entry: String in _packages.scene_dependencies(package_id, scene_path):
		if changed.has(entry):
			return true
	return false


## Identity in the parent, the transform and the exported script values.
## Node references are deliberately dropped: they point into the scene that is
## about to be freed. Containers are duplicated so the old and the new instance
## never share live state.
func _capture_state(node: Node) -> Dictionary:
	var properties := {}
	for property: Dictionary in node.get_property_list():
		var name := str(property.get("name", ""))
		var usage := int(property.get("usage", 0))
		var exported := (
			(usage & PROPERTY_USAGE_SCRIPT_VARIABLE) != 0
			and (usage & PROPERTY_USAGE_STORAGE) != 0
		)
		if not exported and not PRESERVED_PROPERTIES.has(name):
			continue
		var value: Variant = node.get(name)
		if value is Node:
			continue
		if typeof(value) == TYPE_ARRAY:
			var array: Array = value
			value = array.duplicate(true)
		elif typeof(value) == TYPE_DICTIONARY:
			var dictionary: Dictionary = value
			value = dictionary.duplicate(true)
		properties[name] = value
	return {
		"name": node.name,
		"index": node.get_index(),
		"properties": properties,
	}


## Applies the captured properties that the new script still declares. A newer
## revision may drop an exported variable, which must not fail the reload.
func _apply_state(node: Node, state: Dictionary) -> void:
	var properties: Dictionary = state.get("properties", {})
	if properties.is_empty():
		return
	var accepted := {}
	for property: Dictionary in node.get_property_list():
		accepted[str(property.get("name", ""))] = true
	for name: String in properties:
		if accepted.has(name):
			node.set(name, properties[name])


## Copies user metadata to the replacement. `_wired_package_*` keys describe the
## package scene and are already set correctly by `instantiate_scene`. A Node
## value is skipped because it belongs to the scene that is being replaced.
func _copy_metadata(source: Node, target: Node) -> void:
	for key: StringName in source.get_meta_list():
		if str(key).begins_with("_wired_package_"):
			continue
		var value: Variant = source.get_meta(key)
		if value is Node:
			continue
		target.set_meta(key, value)


## Every lifecycle line is printed, so it stays directly parseable in logs.
func _log(line: String) -> void:
	print(line)
	if log_sink.is_valid():
		log_sink.call(line)
