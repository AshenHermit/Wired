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
const PANEL_ID := 7
const FIXTURE := "fixture.tscn"
const SCRIPT := "fixture.gd"
const LIB_SCENE := "lib.tscn"
const LIB_SCRIPT := "lib.gd"
const PANEL_SCENE := "panel.tscn"
const PANEL_SCRIPT := "panel.gd"
const ROOM_ROOT := "user://wired/rooms/" + ROOM

var _manager: PackagesManager
var _reloader: PackageReloader
var _root: Node
var _panel_root: Node
## Exported resource assigned to the live root before the reload.
var _old_texture: Texture2D
# Package roots that entered the test tree since the counter was reset.
var _spawned := 0
# Lines the reloader emitted through its log sink.
var _logs := PackedStringArray()
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
	_write_library_revision()
	_seed(LIBRARY_ID, 1, LIB_SCENE, [LIB_SCENE, LIB_SCRIPT])
	_write_control_revision()
	_seed(PANEL_ID, 1, PANEL_SCENE, [PANEL_SCENE, PANEL_SCRIPT])

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
	# A Node reference, an exported Resource and containers holding live state
	# must not leak into the replacement.
	var buddy := Node.new()
	buddy.name = "Buddy"
	node.add_child(buddy)
	node.buddy = buddy
	node.score = 42
	node.tags = ["saved"]
	# Exported identity-bearing values must be re-read from the new scene.
	_old_texture = GradientTexture2D.new()
	node.texture = _old_texture
	var live_nodes: Array = node.get("nodes")
	live_nodes.append(buddy)
	node.position = Vector2(3, 4)
	node.rotation = 0.5
	node.scale = Vector2(2, 3)
	node.set_meta("owner_player", 7)

	_reloader = PackageReloader.new()
	_root.add_child(_reloader)
	_reloader.log_sink = _capture_log
	_spawned = 0

	# Before setup there is no manager to consult: any call must be a no-op.
	_reloader.reload_for(PACKAGE_ID, PackedStringArray())
	_reloader.reload_for(PACKAGE_ID, PackedStringArray([FIXTURE]))
	await _wait_debounce()
	_check(_spawned == 0, "reload_for before setup must be a no-op")

	_reloader.setup(_manager)
	_reloader.setup(_manager)  # a duplicate setup must not connect twice
	_spawned = 0
	_reloader.reload_for(PACKAGE_ID, PackedStringArray())
	await _wait_debounce()
	_check(_spawned == 0, "an empty change list must not reload anything")
	if not _test_setup():
		_finish()
		return

	node = await _test_same_revision_reload()
	if node == null:
		_finish()
		return
	node = await _test_artifact_key_reload()
	if node == null:
		_finish()
		return
	node = await _test_new_revision_reload()
	if node == null:
		_finish()
		return
	await _test_control_properties()
	node = await _test_library_without_roots()
	if node == null:
		_finish()
		return
	node = await _test_nested_roots()
	if node == null:
		_finish()
		return
	node = await _test_dropped_property_reload()
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
	# A different manager must take over the connection, not be ignored.
	var other := PackagesManager.new()
	_reloader.setup(other)
	_check(
		other.get_signal_connection_list("package_applied").size() == 1,
		"setup must connect a new manager"
	)
	_check(
		_manager.get_signal_connection_list("package_applied").is_empty(),
		"setup must disconnect the previous manager"
	)
	_reloader.setup(_manager)
	_check(
		_manager.get_signal_connection_list("package_applied").size() == 1
		and other.get_signal_connection_list("package_applied").is_empty(),
		"setup must rebind to the requested manager"
	)
	other.free()
	return connections.size() == 1


## A same-revision change recreates the root and keeps its safe live state.
func _test_same_revision_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the first reload")
		return null
	var old_id := previous.get_instance_id()
	var old_tags: Array = previous.get("tags")
	_logs.clear()
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
		int(current.get_meta("owner_player", 0)) == 7,
		"custom metadata must survive the reload"
	)
	_check(
		int(current.get("score")) == 42,
		"exported script values must survive the reload, got %s" % current.get("score")
	)
	_check(
		(current.get("position") as Vector2).is_equal_approx(Vector2(3, 4)),
		"the position must survive the reload, got %s" % current.get("position")
	)
	_check(
		is_equal_approx(float(current.get("rotation")), 0.5),
		"the rotation must survive the reload, got %s" % current.get("rotation")
	)
	_check(
		(current.get("scale") as Vector2).is_equal_approx(Vector2(2, 3)),
		"the scale must survive the reload, got %s" % current.get("scale")
	)
	var buddy: Variant = current.get("buddy")
	_check(
		buddy == null,
		"an exported Node reference must not be copied to the replacement, got %s" % buddy
	)
	var tags: Array = current.get("tags")
	_check(tags == ["saved"], "exported containers must survive the reload, got %s" % tags)
	_check(
		not is_same(tags, old_tags),
		"exported containers must be duplicated, not shared with the old instance"
	)
	var texture: Variant = current.get("texture")
	_check(
		not is_same(texture, _old_texture),
		"an exported Resource must come from the new scene, not the old instance"
	)
	_check(
		texture is GradientTexture2D,
		"the new scene's exported texture must be loaded, got %s" % texture
	)
	var nodes: Array = current.get("nodes")
	_check(
		nodes.is_empty(),
		"an exported Array[Node] must be skipped, got %s" % [nodes]
	)
	_check(
		_logs.has("WIRED_PACKAGE_RELOADED package=5 scene=fixture.tscn revision=1"),
		"a successful reload must log the reload marker, got %s" % [_logs]
	)
	return current


## A same-revision rebuild gets a different artifact key. The reloader must
## load the script from the new keyed directory, not the cached old one.
func _test_artifact_key_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the artifact-key reload")
		return null
	var old_id := previous.get_instance_id()
	var old_key := _manager.current_artifact_key(PACKAGE_ID)
	var new_key := "same-revision-v2".sha256_text()
	_write_revision(PACKAGE_ID, 1, 11, "fresh-key", new_key)
	_check(new_key != old_key, "the fixture must use a different artifact key")
	_manager._current_revisions[PACKAGE_ID] = 1
	_manager._current_artifact_keys[PACKAGE_ID] = new_key
	_logs.clear()
	_spawned = 0

	_reloader.reload_for(PACKAGE_ID, PackedStringArray([SCRIPT]))
	var replaced := await _wait_until(func() -> bool: return _spawned > 0)
	_check(replaced, "a keyed same-revision rebuild must be re-instantiated")
	await _settle()

	var current := _single_package_root()
	if current == null:
		_check(false, "the keyed reload must leave one package root")
		return null
	_check(not is_instance_id_valid(old_id), "the old keyed root must be freed")
	_check(
		int(current.get_meta("_wired_package_revision", 0)) == 1,
		"the keyed replacement must keep revision 1"
	)
	_check(
		str(current.get("label")) == "fresh-key",
		"a same-revision key change must load the new script, got %s"
		% current.get("label")
	)
	_check(
		current.has_method("revision_marker")
		and str(current.revision_marker()) == "fresh-key",
		"a same-revision key change must execute the new script"
	)
	_check(int(current.get("score")) == 42, "state must be captured from the live root")
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
	_manager._current_artifact_keys[PACKAGE_ID] = _key(2)
	_logs.clear()
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
		current.has_method("revision_marker")
		and str(current.revision_marker()) == "v2",
		"the replacement must run the new revision's script, got %s"
		% current.get("label")
	)
	_check(
		_logs.has("WIRED_PACKAGE_RELOADED package=5 scene=fixture.tscn revision=2"),
		"a revision reload must log the new revision, got %s" % [_logs]
	)
	return current


## Control roots keep the full transform and `size`.
func _test_control_properties() -> void:
	var panel := _manager.instantiate_scene(PANEL_ID, PANEL_SCENE)
	_check(panel != null, "the control fixture must instantiate from the seeded package")
	if panel == null:
		return
	_panel_root = Node.new()
	_panel_root.name = "PanelRoot"
	get_root().add_child(_panel_root)
	_panel_root.add_child(panel)
	panel.position = Vector2(5, 6)
	panel.rotation = 0.25
	panel.scale = Vector2(2, 2)
	panel.size = Vector2(120, 40)
	panel.title = "hello"
	var old_id := panel.get_instance_id()
	_logs.clear()

	_reloader.reload_for(PANEL_ID, PackedStringArray([PANEL_SCENE]))
	var replaced := await _wait_until(
		func() -> bool:
			return (
				_panel_root.get_child_count() == 1
				and _panel_root.get_child(0).get_instance_id() != old_id
			)
	)
	_check(replaced, "a changed control scene must be re-instantiated")
	await _settle()
	_check(not is_instance_id_valid(old_id), "the old control root must be freed")
	if _panel_root.get_child_count() != 1:
		_check(false, "the control reload must leave one root")
		return
	var current := _panel_root.get_child(0)
	_check(current.name == "Panel", "the control replacement must keep its name")
	_check(
		(current.get("position") as Vector2).is_equal_approx(Vector2(5, 6)),
		"a control position must survive the reload"
	)
	_check(
		is_equal_approx(float(current.get("rotation")), 0.25),
		"a control rotation must survive the reload"
	)
	_check(
		(current.get("scale") as Vector2).is_equal_approx(Vector2(2, 2)),
		"a control scale must survive the reload"
	)
	_check(
		(current.get("size") as Vector2).is_equal_approx(Vector2(120, 40)),
		"Control.size must survive the reload, got %s" % current.get("size")
	)
	_check(
		str(current.get("title")) == "hello",
		"a control script value must survive the reload"
	)
	_panel_root.free()
	_panel_root = null


## A library package without a live root changes nothing and does not error.
func _test_library_without_roots() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the library test")
		return null
	var old_id := previous.get_instance_id()
	_logs.clear()
	_spawned = 0
	_reloader.reload_for(LIBRARY_ID, PackedStringArray([LIB_SCRIPT]))
	await _wait_debounce()
	var current := _single_package_root()
	_check(
		current != null and current.get_instance_id() == old_id,
		"a library without live roots must leave the tree untouched"
	)
	_check(_spawned == 0, "a library without live roots must not add a node")
	_check(_logs.is_empty(), "a library without live roots must not log a reload")
	return current


## Nested package roots are replaced only together with their outer scene.
func _test_nested_roots() -> Node:
	var outer := _single_package_root()
	if outer == null:
		_check(false, "the fixture root must be live before the nested test")
		return null
	var outer_id := outer.get_instance_id()
	var library := _manager.instantiate_scene(LIBRARY_ID, LIB_SCENE)
	_check(library != null, "the library scene must instantiate from the seeded package")
	if library == null:
		return outer
	outer.add_child(library)
	var library_id := library.get_instance_id()
	_check(_library_child(outer) != null, "the outer root must contain the nested library")
	_logs.clear()
	_spawned = 0

	# Nothing declares the library as a dependency of the outer scene yet, so
	# the nested root must not be visited on its own.
	_reloader.reload_for(LIBRARY_ID, PackedStringArray([LIB_SCRIPT]))
	await _wait_debounce()
	var untouched := _single_package_root()
	_check(
		untouched != null and untouched.get_instance_id() == outer_id,
		"a nested package change must not reload the outer root"
	)
	var nested := _library_child(outer)
	_check(
		nested != null and nested.get_instance_id() == library_id,
		"a nested package root must not be reloaded on its own"
	)
	_check(is_instance_id_valid(library_id), "a nested package root must stay alive on its own")
	_check(_spawned == 0, "a nested package change must not add a package root")
	_check(_logs.is_empty(), "a nested package change must not log a reload")

	# Declaring the dependency makes the outer scene the reload unit: exactly
	# one replacement, and the nested root goes with the old outer scene.
	var scenes: Dictionary = _manager._scene_dependencies[PACKAGE_ID]
	var dependencies: Array = scenes[FIXTURE]
	dependencies.append("%d:%s" % [LIBRARY_ID, LIB_SCRIPT])
	_manager._scene_dependencies[PACKAGE_ID] = scenes
	_logs.clear()
	_spawned = 0

	_reloader.reload_for(LIBRARY_ID, PackedStringArray([LIB_SCRIPT]))
	var replaced := await _wait_until(func() -> bool: return _spawned > 0)
	_check(replaced, "a dependency change must reload the outer scene")
	await _settle()

	var current := _single_package_root()
	if current == null:
		_check(false, "the nested reload must leave one outer package root")
		return null
	_check(
		_spawned == 1,
		"a nested dependency change must replace only the outer root, got %d" % _spawned
	)
	_check(not is_instance_id_valid(outer_id), "the old outer root must be freed")
	_check(not is_instance_id_valid(library_id), "the nested root must go with the old outer scene")
	_check(_library_child(current) == null, "the nested root must not be recreated separately")
	_check(int(current.get("score")) == 42, "state must survive a nested dependency reload")
	return current


## A revision that drops an exported property must still reload without error.
func _test_dropped_property_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the dropped-property reload")
		return null
	var old_id := previous.get_instance_id()
	_write_dropped_revision(PACKAGE_ID, 3, 9)
	_manager._current_revisions[PACKAGE_ID] = 3
	_manager._current_artifact_keys[PACKAGE_ID] = _key(3)
	_logs.clear()
	_spawned = 0

	_reloader.reload_for(PACKAGE_ID, PackedStringArray([SCRIPT]))
	var replaced := await _wait_until(func() -> bool: return _spawned > 0)
	_check(replaced, "a revision that drops an exported property must still reload")
	await _settle()

	var current := _single_package_root()
	if current == null:
		_check(false, "the dropped-property reload must leave one package root")
		return null
	_check(not is_instance_id_valid(old_id), "the old dropped-property root must be freed")
	_check(
		int(current.get_meta("_wired_package_revision", 0)) == 3,
		"the dropped-property replacement must carry revision 3"
	)
	_check(int(current.get("score")) == 42, "surviving exports must still be restored")
	_check(not _has_property(current, "label"), "a dropped export must not be added back")
	_check(not _has_property(current, "tags"), "a dropped export must not be added back")
	_check(current.get("tags") == null, "state of a dropped property must be skipped")
	_check(
		not _has_log("WIRED_PACKAGE_RELOAD_FAILED"),
		"a dropped exported property must not fail the reload, got %s" % [_logs]
	)
	_check(
		_logs.has("WIRED_PACKAGE_RELOADED package=5 scene=fixture.tscn revision=3"),
		"the dropped-property reload must log success, got %s" % [_logs]
	)
	return current


## Changes that land inside one debounce window coalesce into one replacement.
func _test_coalesced_reload() -> Node:
	var previous := _single_package_root()
	if previous == null:
		_check(false, "the fixture root must be live before the coalescing test")
		return null
	var old_id := previous.get_instance_id()
	_logs.clear()
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
	_write_broken_revision(PACKAGE_ID, 4)
	_manager._current_revisions[PACKAGE_ID] = 4
	_manager._current_artifact_keys[PACKAGE_ID] = _key(4)
	_logs.clear()
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
	_check(
		_logs.has(
			"WIRED_PACKAGE_RELOAD_FAILED package=%d scene=%s reason=instantiate_failed"
			% [PACKAGE_ID, FIXTURE]
		),
		"a failed reload must log the failure marker, got %s" % [_logs]
	)


# --- fixtures -------------------------------------------------------------


func _write_revision(
	package_id: int, revision: int, score: int, label: String = "", key: String = ""
) -> void:
	var artifact_key := key if not key.is_empty() else _key(revision)
	var dir := _revision_dir(package_id, revision, artifact_key)
	DirAccess.make_dir_recursive_absolute(dir)
	var script_path := dir.path_join(SCRIPT)
	var source := "extends Node2D\n\n@export var score := %d\n" % score
	source += "@export var buddy: Node\n"
	source += "@export var nodes: Array[Node] = []\n"
	source += "@export var texture: Texture2D\n"
	source += "@export var tags: Array = []\n"
	if not label.is_empty():
		source += "@export var label := \"%s\"\n" % label
		source += "func revision_marker() -> String:\n\treturn \"%s\"\n" % label
	_write_text(script_path, source)
	_write_scene(dir, FIXTURE, "Fixture", "Node2D", script_path, true)


## A newer revision whose script dropped `label`, `tags`, `nodes` and `texture`:
## applying the old state must skip the missing properties instead of failing.
func _write_dropped_revision(package_id: int, revision: int, score: int) -> void:
	var dir := _revision_dir(package_id, revision, _key(revision))
	DirAccess.make_dir_recursive_absolute(dir)
	var script_path := dir.path_join(SCRIPT)
	_write_text(script_path, "extends Node2D\n\n@export var score := %d\n" % score)
	_write_scene(dir, FIXTURE, "Fixture", "Node2D", script_path)


func _write_library_revision() -> void:
	var dir := _revision_dir(LIBRARY_ID, 1, _key(1))
	DirAccess.make_dir_recursive_absolute(dir)
	var script_path := dir.path_join(LIB_SCRIPT)
	_write_text(script_path, "extends Node2D\n\n@export var library_value := 1\n")
	_write_scene(dir, LIB_SCENE, "Library", "Node2D", script_path)


func _write_control_revision() -> void:
	var dir := _revision_dir(PANEL_ID, 1, _key(1))
	DirAccess.make_dir_recursive_absolute(dir)
	var script_path := dir.path_join(PANEL_SCRIPT)
	_write_text(script_path, "extends Control\n\n@export var title := \"panel\"\n")
	_write_scene(dir, PANEL_SCENE, "Panel", "Control", script_path)


## A revision whose scene file exists but cannot be parsed: the loader reports
## it as null, which is the failure path the reloader has to survive.
func _write_broken_revision(package_id: int, revision: int) -> void:
	var dir := _revision_dir(package_id, revision, _key(revision))
	DirAccess.make_dir_recursive_absolute(dir)
	_write_text(dir.path_join(FIXTURE), "[gd_scene\nthis is not a scene\n")


func _write_scene(
	dir: String,
	scene_file: String,
	root_name: String,
	root_type: String,
	script_path: String,
	with_texture: bool = false,
) -> void:
	var text := "[gd_scene load_steps=%d format=3]\n\n" % (5 if with_texture else 2)
	text += '[ext_resource type="Script" path="%s" id="1_script"]\n\n'
	if with_texture:
		text += '[sub_resource type="Gradient" id="1_gradient"]\n'
		text += "colors = PackedColorArray(1, 0, 0, 1)\n\n"
		text += '[sub_resource type="GradientTexture2D" id="2_texture"]\n'
		text += 'gradient = SubResource("1_gradient")\n\n'
	text += '[node name="%s" type="%s"]\nscript = ExtResource("1_script")\n'
	if with_texture:
		text += 'texture = SubResource("2_texture")\n'
	_write_text(dir.path_join(scene_file), text % [script_path, root_name, root_type])


func _revision_dir(package_id: int, revision: int, artifact_key: String) -> String:
	return "%s/packages/%d/%d-%s" % [ROOM_ROOT, package_id, revision, artifact_key]


## The fixture uses a deterministic 64-char hex key per revision.
func _key(seed: Variant) -> String:
	return str(seed).sha256_text()


## Seeds the manager's in-memory state so `instantiate_scene` needs no network.
func _seed(package_id: int, revision: int, scene: String, files: Array) -> void:
	_manager._current_revisions[package_id] = revision
	_manager._current_artifact_keys[package_id] = _key(revision)
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


func _capture_log(line: String) -> void:
	_logs.append(line)


func _has_log(prefix: String) -> bool:
	for line: String in _logs:
		if line.begins_with(prefix):
			return true
	return false


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


func _library_child(outer: Node) -> Node:
	for child: Node in outer.get_children():
		if int(child.get_meta("_wired_package_id", 0)) == LIBRARY_ID:
			return child
	return null


func _has_property(node: Node, name: String) -> bool:
	for property: Dictionary in node.get_property_list():
		if str(property.get("name", "")) == name:
			return true
	return false


## Waits for a condition with a hard deadline, so a regression cannot hang the
## headless run.
func _wait_until(condition: Callable) -> bool:
	var deadline := Time.get_ticks_msec() + 5_000
	while not bool(condition.call()) and Time.get_ticks_msec() < deadline:
		await process_frame
	return bool(condition.call())


## Waits past the debounce window without depending on a replacement happening.
## The margin is kept small because the whole smoke has a 600-frame budget.
func _wait_debounce() -> void:
	var deadline := (
		Time.get_ticks_msec()
		+ int(PackageReloader.RELOAD_DEBOUNCE_SEC * 1000.0)
		+ 100
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
	if _panel_root != null and is_instance_valid(_panel_root):
		_panel_root.free()
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
