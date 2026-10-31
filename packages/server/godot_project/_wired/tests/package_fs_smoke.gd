extends SceneTree

## Headless smoke test for the package file operations of the editor bridge.
##
## `WiredPackageFs` owns `res://packages` inside the editor project: it reports
## the current files, stages a replacement, swaps it in atomically and deletes a
## package. Editor metadata (dot directories, `*.uid`, `*.import`) is never part
## of the reported tree but must survive a swap.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/package_fs_smoke.gd --quit-after 600

const PARENT := "user://package_fs_smoke"
const ROOT := PARENT + "/packages"

var _failures: PackedStringArray = []
var _passed := 0


func _initialize() -> void:
	WiredPackageFs.root_override = ROOT
	_cleanup_root()
	_test_empty_snapshot()
	_test_create_dir()
	_test_prepare_replace()
	_test_metadata_excluded()
	_test_replace_empty_staging()
	_test_replace_without_root()
	_test_metadata_preserved()
	_test_delete()
	_test_restore_previous()
	_test_valid_relative_path()
	_cleanup_root()
	_finish()


# --- scenarios ------------------------------------------------------------


func _test_empty_snapshot() -> void:
	var problems: Array = []
	var result := WiredPackageFs.op_snapshot(1)
	var files: Variant = result.get("files")
	_expect(
		problems,
		files is Dictionary and (files as Dictionary).is_empty(),
		"a missing package must snapshot as {files: {}}, got %s" % [result],
	)
	_report("snapshot of a missing package is empty", problems)


func _test_create_dir() -> void:
	var problems: Array = []
	var created := WiredPackageFs.op_create_dir(7)
	_expect(problems, created.is_empty(), "op_create_dir must return {}, got %s" % [created])
	_expect(
		problems,
		DirAccess.dir_exists_absolute(WiredPackageFs.package_dir(7)),
		"op_create_dir must create %s" % WiredPackageFs.package_dir(7),
	)
	var exists := WiredPackageFs.op_exists(7)
	_expect(problems, exists == {"exists": true}, "op_exists(7) must be {exists: true}, got %s" % [exists])
	_report("create_dir creates the package directory", problems)


func _test_prepare_replace() -> void:
	var problems: Array = []
	var result := WiredPackageFs.op_prepare_replace(7)
	var staging_path := String(result.get("staging_path", ""))
	_expect(problems, result.has("staging_path"), "op_prepare_replace must return staging_path, got %s" % [result])
	_expect(
		problems,
		staging_path.ends_with("/package_fs_smoke/packages/.7.staging"),
		"staging_path must end with /package_fs_smoke/packages/.7.staging, got %s" % staging_path,
	)
	_expect(
		problems,
		not staging_path.begins_with("user://") and not staging_path.begins_with("res://"),
		"staging_path must be an absolute filesystem path, got %s" % staging_path,
	)
	_expect(
		problems,
		DirAccess.dir_exists_absolute(WiredPackageFs.staging_dir(7)),
		"op_prepare_replace must create %s" % WiredPackageFs.staging_dir(7),
	)
	_report("prepare_replace creates .<id>.staging and returns an absolute path", problems)


func _test_metadata_excluded() -> void:
	var problems: Array = []
	var root := WiredPackageFs.package_dir(7)
	_write(root.path_join(".config/x.tres"), "config")
	_write(root.path_join("a.uid"), "uid://a")
	_write(root.path_join("b.import"), "[remap]")
	_write(root.path_join("main.gd"), "extends Node\n")
	_write(root.path_join("sub/helper.gd"), "extends RefCounted\n")

	var snapshot := WiredPackageFs.op_snapshot(7)
	var names: Array = snapshot.get("files", {}).keys()
	names.sort()
	_expect(
		problems,
		names == ["main.gd", "sub/helper.gd"],
		"snapshot must list only data files, got %s" % [names],
	)

	var collected := WiredPackageFs.op_collect(7)
	var paths: Array = []
	var main_entry: Dictionary = {}
	for entry: Dictionary in collected.get("files", []):
		var filepath := String(entry.get("filepath", ""))
		paths.append(filepath)
		if filepath == "main.gd":
			main_entry = entry
	paths.sort()
	_expect(
		problems,
		paths == ["main.gd", "sub/helper.gd"],
		"collect must list only data files, got %s" % [paths],
	)
	var main_bytes := "extends Node\n".to_utf8_buffer()
	_expect(
		problems,
		main_entry.get("size", -1) == main_bytes.size(),
		"collect must report the file size as bytes, got %s" % [main_entry.get("size", -1)],
	)
	_expect(
		problems,
		main_entry.get("sha256", "") == FileAccess.get_sha256(root.path_join("main.gd")),
		"collect must report the sha256 of the file, got %s" % [main_entry.get("sha256", "")],
	)
	_expect(
		problems,
		Marshalls.base64_to_raw(String(main_entry.get("contents_base64", ""))) == main_bytes,
		"collect must return the contents as base64",
	)
	_report("editor metadata stays out of snapshot and collect", problems)


func _test_replace_empty_staging() -> void:
	var problems: Array = []
	var result := WiredPackageFs.op_replace(7)
	_expect(problems, not result.has("error"), "op_replace(7) failed: %s" % [result.get("error", "")])
	var written: Array = result.get("written", [])
	var deleted: Array = result.get("deleted", [])
	deleted.sort()
	_expect(problems, written.is_empty(), "written must be empty for an empty staging, got %s" % [written])
	_expect(
		problems,
		deleted == ["main.gd", "sub/helper.gd"],
		"deleted must list the previous data files, got %s" % [deleted],
	)
	_expect(
		problems,
		DirAccess.dir_exists_absolute(WiredPackageFs.package_dir(7)),
		"the package directory must exist after the swap",
	)
	var snapshot := WiredPackageFs.op_snapshot(7)
	_expect(problems, snapshot.get("files", {}) == {}, "the new tree must be empty, got %s" % [snapshot])
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.previous_dir(7)),
		"previous must be removed after a successful swap",
	)
	_report("replace with empty staging drops the previous tree", problems)


func _test_replace_without_root() -> void:
	var problems: Array = []
	var missing := WiredPackageFs.op_replace(8)
	_expect(
		problems,
		String(missing.get("error", "")).contains("staging"),
		"replace without staging must report the missing staging, got %s" % [missing],
	)

	var prepared := WiredPackageFs.op_prepare_replace(8)
	_expect(problems, not prepared.has("error"), "op_prepare_replace(8) failed: %s" % [prepared.get("error", "")])
	var staging := WiredPackageFs.staging_dir(8)
	_write(staging.path_join("main.gd"), "extends Node\n")

	var result := WiredPackageFs.op_replace(8)
	_expect(problems, not result.has("error"), "op_replace(8) failed: %s" % [result.get("error", "")])
	_expect(
		problems,
		WiredPackageFs.op_exists(8) == {"exists": true},
		"package 8 must exist after the swap",
	)
	_expect(
		problems,
		result.get("deleted", []) == [],
		"deleted must be empty for a new package, got %s" % [result.get("deleted", [])],
	)
	_expect(
		problems,
		result.get("written", []) == ["main.gd"],
		"written must list the staged file, got %s" % [result.get("written", [])],
	)
	_expect(
		problems,
		FileAccess.get_file_as_string(WiredPackageFs.package_dir(8).path_join("main.gd")) == "extends Node\n",
		"the staged file must land in the package directory",
	)
	_report("replace creates a package that had no root", problems)


func _test_metadata_preserved() -> void:
	var problems: Array = []
	var root := WiredPackageFs.package_dir(8)
	_write(root.path_join(".uid"), "uid://legacy")
	_write(root.path_join("b.import"), "[remap]")
	_write(root.path_join(".import/legacy.res"), "legacy")
	_write(root.path_join("old.gd"), "extends Node\n")

	var prepared := WiredPackageFs.op_prepare_replace(8)
	_expect(problems, not prepared.has("error"), "op_prepare_replace(8) failed: %s" % [prepared.get("error", "")])
	_write(WiredPackageFs.staging_dir(8).path_join("new.gd"), "extends RefCounted\n")

	var result := WiredPackageFs.op_replace(8)
	_expect(problems, not result.has("error"), "op_replace(8) failed: %s" % [result.get("error", "")])
	_expect(problems, FileAccess.file_exists(root.path_join(".uid")), ".uid must survive the swap")
	_expect(problems, FileAccess.file_exists(root.path_join("b.import")), ".import sidecar must survive the swap")
	_expect(
		problems,
		FileAccess.file_exists(root.path_join(".import/legacy.res")),
		".import directory contents must survive the swap",
	)
	_expect(problems, FileAccess.file_exists(root.path_join("new.gd")), "the staged file must land in package 8")
	_expect(problems, not FileAccess.file_exists(root.path_join("old.gd")), "old data files must be dropped")

	var written: Array = result.get("written", [])
	written.sort()
	_expect(problems, written == ["new.gd"], "written must exclude editor metadata, got %s" % [written])
	var deleted: Array = result.get("deleted", [])
	deleted.sort()
	_expect(
		problems,
		deleted == ["main.gd", "old.gd"],
		"deleted must exclude editor metadata, got %s" % [deleted],
	)
	_report("service files survive replace while data files are replaced", problems)


func _test_delete() -> void:
	var problems: Array = []
	DirAccess.make_dir_recursive_absolute(WiredPackageFs.staging_dir(8))
	DirAccess.make_dir_recursive_absolute(WiredPackageFs.previous_dir(8))

	var result := WiredPackageFs.op_delete(8)
	_expect(problems, result.is_empty(), "op_delete must return {}, got %s" % [result])
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.package_dir(8)),
		"op_delete must remove the package root",
	)
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.staging_dir(8)),
		"op_delete must remove staging",
	)
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.previous_dir(8)),
		"op_delete must remove previous",
	)
	_report("delete removes root, staging and previous", problems)


func _test_restore_previous() -> void:
	var problems: Array = []
	var root := WiredPackageFs.package_dir(9)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("keep.gd"), "extends Node\n")
	_expect(
		problems,
		DirAccess.rename_absolute(root, WiredPackageFs.previous_dir(9)) == OK,
		"the test must be able to rename the root to previous",
	)

	var result := WiredPackageFs.op_exists(9)
	_expect(problems, result == {"exists": true}, "op_exists(9) must restore and report the package, got %s" % [result])
	_expect(problems, DirAccess.dir_exists_absolute(root), "the interrupted swap must be rolled back")
	_expect(
		problems,
		FileAccess.file_exists(root.path_join("keep.gd")),
		"the restored tree must keep its files",
	)
	_report("exists restores an interrupted swap", problems)


func _test_valid_relative_path() -> void:
	var problems: Array = []
	_expect(problems, WiredPackageFs.is_valid_relative_path("a/b.gd"), "a/b.gd must be a valid relative path")
	for path: String in ["", "/a", "a\\b", "a/../b", "a//b"]:
		_expect(
			problems,
			not WiredPackageFs.is_valid_relative_path(path),
			"\"%s\" must be rejected as a relative path" % path,
		)
	_report("relative path validation", problems)


# --- helpers --------------------------------------------------------------


func _expect(problems: Array, condition: bool, message: String) -> void:
	if not condition:
		problems.append(message)


func _report(name: String, problems: Array) -> void:
	if problems.is_empty():
		_passed += 1
		return
	_failures.append("%s: %s" % [name, ", ".join(PackedStringArray(problems))])


func _finish() -> void:
	if _failures.is_empty():
		print("OK %d checks" % _passed)
		quit(0)
		return
	for message: String in _failures:
		printerr("FAILED %s" % message)
	quit(1)


func _write(path: String, contents: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		_failures.append("cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())])
		return
	file.store_string(contents)
	file.close()


func _cleanup_root() -> void:
	_remove_tree(PARENT)


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
