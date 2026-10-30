extends SceneTree

## Headless smoke test for PackageReloader hot scene replacement.
##
## The fixture room is written by hand under the real package layout and the
## manager's revision/scene map is seeded directly, so no network is involved.
## `PackagesManager.instantiate_scene` therefore runs unchanged against the
## files on disk.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/package_reloader_smoke.gd --quit-after 600

const ROOM := "7"
const PACKAGE_ID := 5
const LIBRARY_ID := 6
const FIXTURE := "fixture.tscn"
const SCRIPT := "fixture.gd"
const ROOM_ROOT := "user://wired/rooms/" + ROOM

var _manager: PackagesManager
var _reloader: PackageReloader
var _root: Node
# Package roots that entered the test tree since the counter was reset.
var _spawned := 0
var _failures: PackedStringArray = []


func _initialize() -> void:
	# Deferred so the tree is running before the first await.
	_run.call_deferred()


func _run() -> void:
	_remove_tree(ROOM_ROOT)
	_manager = PackagesManager.new()
	_manager.configure("http://127.0.0.1:1", ROOM)
	_write_revision(PACKAGE_ID, 1, 1)
	_seed(PACKAGE_ID, 1, FIXTURE, [FIXTURE, SCRIPT])
	# A library package is applied as well, but nothing in the tree uses it yet.
	_seed(LIBRARY_ID, 1, "lib.tscn", ["lib.gd"])

	_root = Node.new()
	_root.name = "ReloaderTestRoot"
	get_root().add_child(_root)
	_root.child_entered_tree.connect(_on_child_entered_tree)
	# The replacement must keep its position in the parent, so the fixture is
	# not the first child.
	var marker := Node.new()
	marker.name = "Marker"
	_root.add_child(marker)

	var node := _manager.instantiate_scene(PACKAGE_ID, FIXTURE)
	_check(node != null, "the fixture must instantiate from the seeded package")
	if node == null:
		_finish()
		return
	_root.add_child(node)
	node.score = 42
	node.position = Vector2(3, 4)

	_reloader = PackageReloader.new()
	_root.add_child(_reloader)
	_reloader.setup(_manager)
	_reloader.setup(_manager)  # a duplicate setup must not connect twice
	_spawned = 0
	if not _test_setup():
		_finish()
		return

	node = await _test_same_revision_reload()
	if node == null:
		_finish()
		return
	node = await _test_new_revision_reload()
	if node == null:
		_finish()
		return
	node = await _test_library_without_roots(node)
	node = await _test_dependency_change_reload()
	if node == null:
		_finish()
		return
	node = await _test_coalesced_reload()
	if node == null:
		_finish()
		return
	await _test_failed_reload()
	_finish()


# --- tests ----------------------------------------------------------------


func _test_setup() -> bool:
	_check(
		is_equal_approx(PackageReloader.RELOAD_DEBOUNCE_SEC, 0.2),
		"PackageReloader.RELOAD_DEBOUNCE_SEC must stay 0.2"
	)
	var connections := _manager.get_signal_connection_list("package_applied")
	_check(
		connections.size() == 1,
		"setup must connect package_applied exactly once, got %d" % connections.size()
	)
	return connections.size() == 1


## A same-revision change recreates the root and keeps its live state.
func _test_same_revision_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the first reload")
		return null
	var old_id := previous.get_instance_id()
	_spawned = 0

	_reloader.reload_for(PACKAGE_ID, PackedStringArray([FIXTURE]))
	var replaced := await _wait_until(func() -> bool: return _spawned > 0)
	_check(replaced, "a changed scene must be re-instantiated")
	await _settle()

	var current := _single_package_root()
	_check(current != null, "exactly one package root must stay in the tree")
	if current == null:
		return null
	_check(_spawned == 1, "one change must produce one replacement, got %d" % _spawned)
	_check(not is_instance_id_valid(old_id), "the old package root must be freed")
	_check(
		current.get_instance_id() != old_id,
		"the new package root must be a different instance"
	)
	_check(current.name == "Fixture", "the replacement must keep the old name")
	_check(current.get_parent() == _root, "the replacement must stay in the old parent")
	_check(current.get_index() == 1, "the replacement must keep the old child index")
	_check(
		int(current.get_meta("_wired_package_id", 0)) == PACKAGE_ID,
		"the replacement must keep the package metadata"
	)
	_check(
		str(current.get_meta("_wired_package_scene", "")) == FIXTURE,
		"the replacement must keep the scene metadata"
	)
	_check(
		int(current.get_meta("_wired_package_revision", 0)) == 1,
		"the replacement must carry the applied revision"
	)
	_check(
		int(current.get("score")) == 42,
		"exported script values must survive the reload, got %s" % current.get("score")
	)
	_check(
		(current.get("position") as Vector2).is_equal_approx(Vector2(3, 4)),
		"the transform must survive the reload, got %s" % current.get("position")
	)
	return current


## A newer revision is loaded while the state of the old root is kept.
func _test_new_revision_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the revision reload")
		return null
	var old_id := previous.get_instance_id()
	_write_revision(PACKAGE_ID, 2, 7, "v2")
	_manager._current_revisions[PACKAGE_ID] = 2
	_spawned = 0

	_reloader.reload_for(PACKAGE_ID, PackedStringArray([SCRIPT]))
	var replaced := await _wait_until(func() -> bool: return _spawned > 0)
	_check(replaced, "a newer revision of a live scene must be re-instantiated")
	await _settle()

	var current := _single_package_root()
	if current == null:
		_check(false, "the reloaded root must stay in the tree")
		return null
	_check(not is_instance_id_valid(old_id), "the old revision root must be freed")
	_check(
		int(current.get_meta("_wired_package_revision", 0)) == 2,
		"the replacement must carry the new revision, got %s"
		% current.get_meta("_wired_package_revision", 0)
	)
	_check(
		int(current.get("score")) == 42,
		"an exported value must survive a revision reload"
	)
	_check(
		str(current.get("label")) == "v2",
		"the replacement must run the new revision's script, got %s"
		% current.get("label")
	)
	return current


## A library package without a live root changes nothing and does not error.
func _test_library_without_roots(previous: Node) -> Node:
	var old_id := previous.get_instance_id()
	_spawned = 0
	_reloader.reload_for(LIBRARY_ID, PackedStringArray(["lib.gd"]))
	await _wait_debounce()
	var current := _single_package_root()
	_check(
		current != null and current.get_instance_id() == old_id,
		"a library without live roots must leave the tree untouched"
	)
	_check(_spawned == 0, "a library without live roots must not add a node")
	return current


## A change in a dependency package reloads the scenes that depend on it.
func _test_dependency_change_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the dependency reload")
		return null
	var old_id := previous.get_instance_id()
	var scenes: Dictionary = _manager._scene_dependencies[PACKAGE_ID]
	var dependencies: Array = scenes[FIXTURE]
	dependencies.append("%d:lib.gd" % LIBRARY_ID)
	_manager._scene_dependencies[PACKAGE_ID] = scenes
	_spawned = 0

	_reloader.reload_for(LIBRARY_ID, PackedStringArray(["lib.gd"]))
	var replaced := await _wait_until(func() -> bool: return _spawned > 0)
	_check(replaced, "a changed dependency must reload the scene that uses it")
	await _settle()

	var current := _single_package_root()
	if current == null:
		_check(false, "the dependency reload must leave one package root")
		return null
	_check(_spawned == 1, "a dependency change must produce one replacement")
	_check(not is_instance_id_valid(old_id), "the old dependency root must be freed")
	_check(
		int(current.get("score")) == 42,
		"state must survive a dependency-triggered reload"
	)
	return current


## Changes that land inside one debounce window coalesce into one replacement.
func _test_coalesced_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the coalescing test")
		return null
	var old_id := previous.get_instance_id()
	_spawned = 0

	_reloader.reload_for(PACKAGE_ID, PackedStringArray([SCRIPT]))
	_reloader.reload_for(PACKAGE_ID, PackedStringArray([FIXTURE]))
	_reloader.reload_for(PACKAGE_ID, PackedStringArray([SCRIPT]))
	var replaced := await _wait_until(func() -> bool: return _spawned > 0)
	_check(replaced, "coalesced changes must still reload the scene")
	await _settle()

	var current := _single_package_root()
	if current == null:
		_check(false, "the coalesced reload must leave one package root")
		return null
	_check(
		_spawned == 1,
		"changes inside one debounce window must coalesce, got %d replacements"
		% _spawned
	)
	_check(not is_instance_id_valid(old_id), "the old coalesced root must be freed")
	_check(int(current.get("score")) == 42, "state must survive a coalesced reload")
	return current


## A scene that cannot be instantiated leaves the old root alive.
func _test_failed_reload() -> void:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the failure test")
		return
	var old_id := previous.get_instance_id()
	_write_broken_revision(PACKAGE_ID, 3)
	_manager._current_revisions[PACKAGE_ID] = 3
	_spawned = 0

	_reloader.reload_for(PACKAGE_ID, PackedStringArray([FIXTURE]))
	await _wait_debounce()

	var current := _single_package_root()
	_check(
		current != null and current.get_instance_id() == old_id,
		"a failed reload must keep the old root"
	)
	_check(is_instance_id_valid(old_id), "a failed reload must not free the old root")
	_check(previous.is_inside_tree(), "a failed reload must leave the old root in the tree")
	_check(_spawned == 0, "a failed reload must not insert a replacement")
	# The reloader prints
	#   WIRED_PACKAGE_RELOAD_FAILED package=5 scene=fixture.tscn reason=...
	# The behavioural checks above decide the result, so a log wording change
	# cannot make this smoke brittle.


# --- fixtures -------------------------------------------------------------


func _write_revision(
	package_id: int, revision: int, score: int, label: String = ""
) -> void:
	var dir := "%s/packages/%d/%d" % [ROOM_ROOT, package_id, revision]
	DirAccess.make_dir_recursive_absolute(dir)
	var script_path := dir.path_join(SCRIPT)
	var source := "extends Node2D\n\n@export var score := %d\n" % score
	if not label.is_empty():
		source += "@export var label := \"%s\"\n" % label
	_write_text(script_path, source)
	_write_text(
		dir.path_join(FIXTURE),
		(
			"[gd_scene load_steps=2 format=3]\n\n"
			+ '[ext_resource type="Script" path="%s" id="1_fixture"]\n\n'
			+ '[node name="Fixture" type="Node2D"]\nscript = ExtResource("1_fixture")\n'
		) % script_path
	)


## A revision whose scene file exists but cannot be parsed: the loader reports
## it as null, which is the failure path the reloader has to survive.
func _write_broken_revision(package_id: int, revision: int) -> void:
	var dir := "%s/packages/%d/%d" % [ROOM_ROOT, package_id, revision]
	DirAccess.make_dir_recursive_absolute(dir)
	_write_text(dir.path_join(FIXTURE), "[gd_scene\nthis is not a scene\n")


## Seeds the manager's in-memory state so `instantiate_scene` needs no network.
func _seed(package_id: int, revision: int, scene: String, files: Array) -> void:
	_manager._current_revisions[package_id] = revision
	var dependencies: Array = []
	for filepath: String in files:
		dependencies.append("%d:%s" % [package_id, filepath])
	_manager._scene_dependencies[package_id] = {scene: dependencies}


func _write_text(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(text)
	file.close()


func _remove_tree(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	# Collect names first: deleting while enumerating can skip entries.
	var names := PackedStringArray()
	dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		names.append(name)
		name = dir.get_next()
	dir.list_dir_end()
	for child_name: String in names:
		var child := path.path_join(child_name)
		if DirAccess.dir_exists_absolute(child):
			_remove_tree(child)
		else:
			DirAccess.remove_absolute(child)
	DirAccess.remove_absolute(path)


# --- tree helpers ---------------------------------------------------------


func _on_child_entered_tree(node: Node) -> void:
	if node.has_meta("_wired_package_id"):
		_spawned += 1


func _package_roots() -> Array[Node]:
	var roots: Array[Node] = []
	for child: Node in _root.get_children():
		if child.has_meta("_wired_package_id"):
			roots.append(child)
	return roots


func _single_package_root() -> Node:
	var roots := _package_roots()
	if roots.size() != 1:
		return null
	return roots[0]


## Waits for a condition with a hard deadline, so a regression cannot hang the
## headless run.
func _wait_until(condition: Callable) -> bool:
	var deadline := Time.get_ticks_msec() + 5_000
	while not bool(condition.call()) and Time.get_ticks_msec() < deadline:
		await process_frame
	return bool(condition.call())


## Waits past the debounce window without depending on a replacement happening.
func _wait_debounce() -> void:
	var deadline := (
		Time.get_ticks_msec()
		+ int(PackageReloader.RELOAD_DEBOUNCE_SEC * 1000.0)
		+ 200
	)
	while Time.get_ticks_msec() < deadline:
		await process_frame
	await _settle()


## Lets the frame that frees the replaced node finish.
func _settle() -> void:
	await process_frame
	await process_frame


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _root != null and is_instance_valid(_root):
		_root.free()
	if _manager != null:
		_manager.free()
	_remove_tree(ROOM_ROOT)
	if _failures.is_empty():
		print("PACKAGE_RELOADER_SMOKE_OK")
		quit(0)
		return
	for message: String in _failures:
		printerr("PACKAGE_RELOADER_SMOKE_FAILED %s" % message)
	quit(1)
