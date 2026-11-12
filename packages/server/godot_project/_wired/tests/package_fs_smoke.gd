extends SceneTree

## Headless smoke test for the package file operations of the editor bridge.
##
## `WiredPackageFs` owns `res://packages` inside the editor project: it reports
## the current files, stages a replacement, swaps it in atomically, deletes a
## package and deletes selected files or directories inside a package. Editor
## metadata (dot directories, `*.uid`, `*.import`) is never part of the reported
## tree but must survive a swap.
##
## Packages are addressed by slug: `package_dir(slug)`. In production that
## helper returns exactly `res://packages/<slug>`; `op_delete_files` runs
## against [member WiredPackageFs.root_override] here, so the "editor paths"
## below use `package_dir(slug)` instead. Numeric slugs such as `"7"` are
## accepted for packages created before slugs existed.
##
## The dot-prefixed scenarios (`DirAccess.include_hidden`) only exercise
## production semantics on a POSIX host or the web editor: on Windows a dotfile
## is not `FILE_ATTRIBUTE_HIDDEN`, so the OS lists it even without the fix.
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
	_test_import_normalized()
	_test_import_paths()
	_test_import_in_snapshot_and_collect()
	_test_prepare_replace()
	_test_metadata_excluded()
	_test_replace_empty_staging()
	_test_replace_without_root()
	_test_metadata_preserved()
	_test_delete()
	_test_restore_previous()
	_test_snapshot_restores_previous()
	_test_collect_restores_previous()
	_test_dot_dir_survives_replace()
	_test_delete_with_dot_dir()
	_test_delete_files_selected_file()
	_test_delete_files_relative_path()
	_test_delete_files_selected_directory()
	_test_delete_files_keeps_metadata_of_selected_file()
	_test_delete_files_outside_package()
	_test_delete_files_traversal()
	_test_delete_files_missing_path()
	_test_valid_relative_path()
	_test_invalid_slug()
	_test_slug_regex_recovers_after_reload()
	_cleanup_root()
	_finish()


# --- scenarios ------------------------------------------------------------


func _test_empty_snapshot() -> void:
	var problems: Array = []
	var result := WiredPackageFs.op_snapshot("hero")
	var files: Variant = result.get("files")
	_expect(
		problems,
		files is Dictionary and (files as Dictionary).is_empty(),
		"a missing package must snapshot as {files: {}}, got %s" % [result],
	)
	_report("snapshot of a missing package is empty", problems)


func _test_create_dir() -> void:
	var problems: Array = []
	var created := WiredPackageFs.op_create_dir("hero")
	_expect(problems, created.is_empty(), "op_create_dir must return {}, got %s" % [created])
	_expect(
		problems,
		DirAccess.dir_exists_absolute(WiredPackageFs.package_dir("hero")),
		"op_create_dir must create %s" % WiredPackageFs.package_dir("hero"),
	)
	var exists := WiredPackageFs.op_exists("hero")
	_expect(problems, exists == {"exists": true}, "op_exists(\"hero\") must be {exists: true}, got %s" % [exists])
	_report("create_dir creates the package directory", problems)


func _test_import_normalized() -> void:
	var problems: Array = []
	var raw := """; machine note
[remap]

importer="scene"
importer_version=1
type="PackedScene"
uid="uid://abc"
path="res://.godot/imported/dude.glb-deadbeef.scn"
metadata={
"imported_formats": ["s3tc_bptc"]
}
valid=true

[deps]

source_file="res://packages/hero/dude.glb"
dest_files=["res://.godot/imported/dude.glb-deadbeef.scn"]

[params]

materials/extract=0
_subresources={
"animations": {
"Action": {
"settings/loop_mode": 1
}
}
}
"""
	var expected := """[remap]

importer="scene"
importer_version=1
type="PackedScene"
uid="uid://abc"

[params]

materials/extract=0
_subresources={
"animations": {
"Action": {
"settings/loop_mode": 1
}
}
}
"""
	var normalized: String = WiredPackageFs.normalize_import_text(raw)
	_expect(problems, normalized == expected, "нормализованный текст не совпал:\n%s" % normalized)
	_expect(problems, WiredPackageFs.normalize_import_text(normalized) == normalized, "нормализация не идемпотентна")
	_expect(
		problems,
		not WiredPackageFs.import_preset_is_empty(normalized),
		"непустой _subresources распознан как пустой",
	)
	_expect(
		problems,
		WiredPackageFs.import_preset_is_empty(
			"[remap]\n\nimporter=\"scene\"\n\n[params]\n\n_subresources={  }\n"
		),
		"пустой _subresources распознан как непустой",
	)
	_expect(
		problems,
		WiredPackageFs.import_preset_is_empty("[remap]\n\nimporter=\"scene\"\n\n[params]\n"),
		"отсутствующий _subresources распознан как непустой",
	)
	_report("import sidecar is normalized into a portable preset", problems)


func _test_import_paths() -> void:
	var problems: Array = []
	_expect(
		problems,
		WiredPackageFs.import_source_rel_path("a/b.png.import") == "a/b.png",
		"путь исходника вычислен неверно",
	)
	_expect(
		problems,
		WiredPackageFs.import_source_rel_path("root.import") == "root",
		"путь исходника в корне вычислен неверно",
	)
	_report("import sidecar source path is derived from the sidecar path", problems)


func _test_import_in_snapshot_and_collect() -> void:
	var problems: Array = []
	var slug := "hero_import"
	var root := WiredPackageFs.package_dir(slug)
	_write(root.path_join("dude.glb"), "glb")
	_write(
		root.path_join("dude.glb.import"),
		"[remap]\n\nimporter=\"scene\"\ntype=\"PackedScene\"\npath=\"res://.godot/imported/x.scn\"\n\n[deps]\n\nsource_file=\"res://packages/hero_import/dude.glb\"\n\n[params]\n\n_subresources={  }\n",
	)
	# сирота: исходника нет
	_write(root.path_join("ghost.import"), "[remap]\n\nimporter=\"scene\"\n")

	var snapshot: Dictionary = WiredPackageFs.op_snapshot(slug)
	var names: Array = snapshot.get("files", {}).keys()
	names.sort()
	_expect(problems, names == ["dude.glb", "dude.glb.import"], "snapshot содержит %s" % [names])

	var collected: Dictionary = WiredPackageFs.op_collect(slug)
	var entries: Array = collected.get("files", [])
	var by_path := {}
	for entry: Dictionary in entries:
		by_path[str(entry["filepath"])] = entry
	_expect(problems, not by_path.has("ghost.import"), "сирота попала в collect")
	var import_entry: Dictionary = by_path.get("dude.glb.import", {})
	var normalized: String = WiredPackageFs.normalize_import_text(
		FileAccess.get_file_as_string(root.path_join("dude.glb.import"))
	)
	var bytes := normalized.to_utf8_buffer()
	_expect(
		problems,
		int(import_entry.get("size", -1)) == bytes.size(),
		"размер считается не по нормализованному тексту",
	)
	_expect(
		problems,
		str(import_entry.get("sha256", "")) == normalized.sha256_text(),
		"sha collect не совпадает с нормализованным текстом",
	)
	_expect(
		problems,
		str(snapshot["files"].get("dude.glb.import", "")) == normalized.sha256_text(),
		"sha snapshot и collect расходятся",
	)
	_expect(
		problems,
		Marshalls.base64_to_raw(str(import_entry.get("contents_base64", ""))) == bytes,
		"collect отдаёт не нормализованный текст",
	)
	_report("import sidecars are shipped normalized and orphans are dropped", problems)


func _test_prepare_replace() -> void:
	var problems: Array = []
	var result := WiredPackageFs.op_prepare_replace("hero")
	var staging_path := String(result.get("staging_path", ""))
	_expect(problems, result.has("staging_path"), "op_prepare_replace must return staging_path, got %s" % [result])
	_expect(
		problems,
		staging_path.ends_with("/package_fs_smoke/packages/.hero.staging"),
		"staging_path must end with /package_fs_smoke/packages/.hero.staging, got %s" % staging_path,
	)
	_expect(
		problems,
		not staging_path.begins_with("user://") and not staging_path.begins_with("res://"),
		"staging_path must be an absolute filesystem path, got %s" % staging_path,
	)
	_expect(
		problems,
		DirAccess.dir_exists_absolute(WiredPackageFs.staging_dir("hero")),
		"op_prepare_replace must create %s" % WiredPackageFs.staging_dir("hero"),
	)
	_report("prepare_replace creates .<slug>.staging and returns an absolute path", problems)


func _test_metadata_excluded() -> void:
	var problems: Array = []
	var root := WiredPackageFs.package_dir("hero")
	_write(root.path_join(".config/x.tres"), "config")
	_write(root.path_join("a.uid"), "uid://a")
	_write(root.path_join("b.import"), "[remap]")
	_write(root.path_join("main.gd"), "extends Node\n")
	_write(root.path_join("sub/helper.gd"), "extends RefCounted\n")

	var snapshot := WiredPackageFs.op_snapshot("hero")
	var names: Array = snapshot.get("files", {}).keys()
	names.sort()
	_expect(
		problems,
		names == ["main.gd", "sub/helper.gd"],
		"snapshot must list only data files, got %s" % [names],
	)

	var collected := WiredPackageFs.op_collect("hero")
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
	var result := WiredPackageFs.op_replace("hero")
	_expect(problems, not result.has("error"), "op_replace(\"hero\") failed: %s" % [result.get("error", "")])
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
		DirAccess.dir_exists_absolute(WiredPackageFs.package_dir("hero")),
		"the package directory must exist after the swap",
	)
	var snapshot := WiredPackageFs.op_snapshot("hero")
	_expect(problems, snapshot.get("files", {}) == {}, "the new tree must be empty, got %s" % [snapshot])
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.previous_dir("hero")),
		"previous must be removed after a successful swap",
	)
	_report("replace with empty staging drops the previous tree", problems)


func _test_replace_without_root() -> void:
	var problems: Array = []
	var missing := WiredPackageFs.op_replace("7")
	_expect(
		problems,
		String(missing.get("error", "")).contains("staging"),
		"replace without staging must report the missing staging, got %s" % [missing],
	)

	var prepared := WiredPackageFs.op_prepare_replace("7")
	_expect(problems, not prepared.has("error"), "op_prepare_replace(\"7\") failed: %s" % [prepared.get("error", "")])
	var staging := WiredPackageFs.staging_dir("7")
	_write(staging.path_join("main.gd"), "extends Node\n")

	var result := WiredPackageFs.op_replace("7")
	_expect(problems, not result.has("error"), "op_replace(\"7\") failed: %s" % [result.get("error", "")])
	_expect(
		problems,
		WiredPackageFs.op_exists("7") == {"exists": true},
		"package \"7\" must exist after the swap",
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
		FileAccess.get_file_as_string(WiredPackageFs.package_dir("7").path_join("main.gd")) == "extends Node\n",
		"the staged file must land in the package directory",
	)
	_report("replace creates a numeric-slug package that had no root", problems)


func _test_metadata_preserved() -> void:
	var problems: Array = []
	var root := WiredPackageFs.package_dir("7")
	_write(root.path_join(".uid"), "uid://legacy")
	_write(root.path_join("b.import"), "[remap]")
	_write(root.path_join(".import/legacy.res"), "legacy")
	_write(root.path_join("old.gd"), "extends Node\n")

	var prepared := WiredPackageFs.op_prepare_replace("7")
	_expect(problems, not prepared.has("error"), "op_prepare_replace(\"7\") failed: %s" % [prepared.get("error", "")])
	_write(WiredPackageFs.staging_dir("7").path_join("new.gd"), "extends RefCounted\n")

	var result := WiredPackageFs.op_replace("7")
	_expect(problems, not result.has("error"), "op_replace(\"7\") failed: %s" % [result.get("error", "")])
	_expect(problems, FileAccess.file_exists(root.path_join(".uid")), ".uid must survive the swap")
	_expect(
		problems,
		not FileAccess.file_exists(root.path_join("b.import")),
		"an orphan .import sidecar must not survive the swap",
	)
	_expect(
		problems,
		FileAccess.file_exists(root.path_join(".import/legacy.res")),
		".import directory contents must survive the swap",
	)
	_expect(problems, FileAccess.file_exists(root.path_join("new.gd")), "the staged file must land in package \"7\"")
	_expect(problems, not FileAccess.file_exists(root.path_join("old.gd")), "old data files must be dropped")

	var written: Array = result.get("written", [])
	written.sort()
	_expect(problems, written == ["new.gd"], "written must exclude editor metadata, got %s" % [written])
	var deleted: Array = result.get("deleted", [])
	deleted.sort()
	_expect(
		problems,
		deleted == ["main.gd", "old.gd"],
		"deleted must exclude editor metadata and orphan sidecars, got %s" % [deleted],
	)
	_report("service files survive replace while data files are replaced", problems)


func _test_delete() -> void:
	var problems: Array = []
	DirAccess.make_dir_recursive_absolute(WiredPackageFs.staging_dir("7"))
	DirAccess.make_dir_recursive_absolute(WiredPackageFs.previous_dir("7"))

	var result := WiredPackageFs.op_delete("7")
	_expect(problems, result.is_empty(), "op_delete must return {}, got %s" % [result])
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.package_dir("7")),
		"op_delete must remove the package root",
	)
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.staging_dir("7")),
		"op_delete must remove staging",
	)
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(WiredPackageFs.previous_dir("7")),
		"op_delete must remove previous",
	)
	_report("delete removes root, staging and previous", problems)


func _test_restore_previous() -> void:
	var problems: Array = []
	var root := WiredPackageFs.package_dir("hero_9")
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("keep.gd"), "extends Node\n")
	_expect(
		problems,
		DirAccess.rename_absolute(root, WiredPackageFs.previous_dir("hero_9")) == OK,
		"the test must be able to rename the root to previous",
	)

	var result := WiredPackageFs.op_exists("hero_9")
	_expect(
		problems,
		result == {"exists": true},
		"op_exists(\"hero_9\") must restore and report the package, got %s" % [result],
	)
	_expect(problems, DirAccess.dir_exists_absolute(root), "the interrupted swap must be rolled back")
	_expect(
		problems,
		FileAccess.file_exists(root.path_join("keep.gd")),
		"the restored tree must keep its files",
	)
	_report("exists restores an interrupted swap", problems)


func _test_snapshot_restores_previous() -> void:
	var problems: Array = []
	var package_slug := "hero_10"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("keep.gd"), "extends Node\n")
	_expect(
		problems,
		DirAccess.rename_absolute(root, WiredPackageFs.previous_dir(package_slug)) == OK,
		"the test must be able to rename the root to previous",
	)

	var snapshot := WiredPackageFs.op_snapshot(package_slug)
	_expect(problems, not snapshot.has("error"), "op_snapshot failed: %s" % [snapshot.get("error", "")])
	var files: Dictionary = snapshot.get("files", {})
	_expect(
		problems,
		files.has("keep.gd"),
		"snapshot must restore previous and report keep.gd, got %s" % [snapshot],
	)
	_expect(problems, DirAccess.dir_exists_absolute(root), "snapshot must roll the swap back")
	_report("snapshot restores an interrupted swap", problems)


func _test_collect_restores_previous() -> void:
	var problems: Array = []
	var package_slug := "hero_11"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("keep.gd"), "extends Node\n")
	_expect(
		problems,
		DirAccess.rename_absolute(root, WiredPackageFs.previous_dir(package_slug)) == OK,
		"the test must be able to rename the root to previous",
	)

	var collected := WiredPackageFs.op_collect(package_slug)
	_expect(problems, not collected.has("error"), "op_collect failed: %s" % [collected.get("error", "")])
	var paths: Array = []
	for entry: Dictionary in collected.get("files", []):
		paths.append(String(entry.get("filepath", "")))
	paths.sort()
	_expect(
		problems,
		paths == ["keep.gd"],
		"collect must restore previous and report keep.gd, got %s" % [collected],
	)
	_expect(problems, DirAccess.dir_exists_absolute(root), "collect must roll the swap back")
	_report("collect restores an interrupted swap", problems)


func _test_dot_dir_survives_replace() -> void:
	var problems: Array = []
	var package_slug := "hero_12"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join(".config/settings.tres"), "[gd_resource]\n")
	_write(root.path_join("old.gd"), "extends Node\n")

	var prepared := WiredPackageFs.op_prepare_replace(package_slug)
	_expect(problems, not prepared.has("error"), "op_prepare_replace failed: %s" % [prepared.get("error", "")])
	_write(WiredPackageFs.staging_dir(package_slug).path_join("new.gd"), "extends RefCounted\n")

	var result := WiredPackageFs.op_replace(package_slug)
	_expect(problems, not result.has("error"), "op_replace failed: %s" % [result.get("error", "")])
	_expect(
		problems,
		FileAccess.file_exists(root.path_join(".config/settings.tres")),
		"a dot directory from the old root must be carried into the new root",
	)
	_expect(
		problems,
		FileAccess.get_file_as_string(root.path_join(".config/settings.tres")) == "[gd_resource]\n",
		"the metadata file must survive byte-for-byte",
	)
	var written: Array = result.get("written", [])
	written.sort()
	_expect(problems, written == ["new.gd"], "written must exclude dot metadata, got %s" % [written])
	var deleted: Array = result.get("deleted", [])
	deleted.sort()
	_expect(problems, deleted == ["old.gd"], "deleted must exclude dot metadata, got %s" % [deleted])
	_report("a nested dot directory survives replace", problems)


func _test_delete_with_dot_dir() -> void:
	var problems: Array = []
	var package_slug := "hero_13"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join(".config/settings.tres"), "[gd_resource]\n")
	_write(root.path_join("main.gd"), "extends Node\n")

	var result := WiredPackageFs.op_delete(package_slug)
	_expect(problems, result.is_empty(), "op_delete must return {}, got %s" % [result])
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(root),
		"op_delete must remove a package directory that contains .config",
	)
	_report("delete removes a package directory containing .config", problems)


func _test_delete_files_selected_file() -> void:
	var problems: Array = []
	var package_slug := "hero_14"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("static/platform.tscn"), "[gd_scene]\n")
	_write(root.path_join("main.gd"), "extends Node\n")

	var selected := WiredPackageFs.package_dir(package_slug).path_join("static/platform.tscn")
	var result := WiredPackageFs.op_delete_files(package_slug, [selected])
	_expect(problems, not result.has("error"), "op_delete_files failed: %s" % [result.get("error", "")])
	_expect(
		problems,
		result.get("deleted", []) == [selected],
		"deleted must report the editor path, got %s" % [result.get("deleted", [])],
	)
	_expect(
		problems,
		not FileAccess.file_exists(root.path_join("static/platform.tscn")),
		"the selected file must be removed",
	)
	_expect(problems, FileAccess.file_exists(root.path_join("main.gd")), "unselected files must survive")
	_report("delete_files removes a selected file", problems)


func _test_delete_files_relative_path() -> void:
	var problems: Array = []
	var package_slug := "hero_15"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("static/platform.tscn"), "[gd_scene]\n")

	var result := WiredPackageFs.op_delete_files(package_slug, ["static/platform.tscn"])
	var expected := WiredPackageFs.package_dir(package_slug).path_join("static/platform.tscn")
	_expect(problems, not result.has("error"), "op_delete_files failed: %s" % [result.get("error", "")])
	_expect(
		problems,
		result.get("deleted", []) == [expected],
		"a relative path must be reported as an editor path, got %s" % [result.get("deleted", [])],
	)
	_expect(
		problems,
		not FileAccess.file_exists(root.path_join("static/platform.tscn")),
		"the relative path must point at the package file",
	)
	_report("delete_files accepts a package-relative path", problems)


func _test_delete_files_selected_directory() -> void:
	var problems: Array = []
	var package_slug := "hero_16"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("levels/level1.tscn"), "[gd_scene]\n")
	_write(root.path_join("levels/level1.tscn.uid"), "uid://level1")
	_write(root.path_join("levels/.cache/level1.res"), "cache")
	_write(root.path_join("levels/nested/level2.tscn"), "[gd_scene]\n")
	_write(root.path_join("levels/nested/level2.tscn.import"), "[remap]\n")
	_write(root.path_join("keep.gd"), "extends Node\n")

	var selected := WiredPackageFs.package_dir(package_slug).path_join("levels")
	var result := WiredPackageFs.op_delete_files(package_slug, [selected])
	_expect(problems, not result.has("error"), "op_delete_files failed: %s" % [result.get("error", "")])
	_expect(
		problems,
		result.get("deleted", []) == [selected],
		"deleted must report the selected directory, got %s" % [result.get("deleted", [])],
	)
	_expect(
		problems,
		not DirAccess.dir_exists_absolute(root.path_join("levels")),
		"the selected directory must be removed recursively",
	)
	_expect(
		problems,
		not FileAccess.file_exists(root.path_join("levels/nested/level2.tscn")),
		"nested content must be removed with the directory",
	)
	_expect(
		problems,
		not FileAccess.file_exists(root.path_join("levels/.cache/level1.res")),
		"nested dot metadata must be removed with the directory",
	)
	_expect(
		problems,
		not FileAccess.file_exists(root.path_join("levels/nested/level2.tscn.import")),
		"nested .import sidecars must be removed with the directory",
	)
	_expect(problems, FileAccess.file_exists(root.path_join("keep.gd")), "unselected files must survive")
	_report("delete_files removes a selected directory with its metadata", problems)


func _test_delete_files_keeps_metadata_of_selected_file() -> void:
	var problems: Array = []
	var package_slug := "hero_17"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("main.gd"), "extends Node\n")
	_write(root.path_join("main.gd.uid"), "uid://main")
	_write(root.path_join("main.gd.import"), "[remap]\n")
	_write(root.path_join(".config/settings.tres"), "[gd_resource]\n")

	var selected := WiredPackageFs.package_dir(package_slug).path_join("main.gd")
	var result := WiredPackageFs.op_delete_files(package_slug, [selected])
	_expect(problems, not result.has("error"), "op_delete_files failed: %s" % [result.get("error", "")])
	_expect(
		problems,
		result.get("deleted", []) == [selected],
		"deleted must report only the selected file, got %s" % [result.get("deleted", [])],
	)
	_expect(problems, not FileAccess.file_exists(root.path_join("main.gd")), "the selected file must be removed")
	_expect(
		problems,
		FileAccess.file_exists(root.path_join("main.gd.uid")),
		"the .uid sidecar must survive a single-file selection",
	)
	_expect(
		problems,
		FileAccess.file_exists(root.path_join("main.gd.import")),
		"the .import sidecar must survive a single-file selection",
	)
	_expect(
		problems,
		FileAccess.file_exists(root.path_join(".config/settings.tres")),
		"dot metadata must survive a single-file selection",
	)
	_report("delete_files keeps editor metadata when a single file is selected", problems)


func _test_delete_files_outside_package() -> void:
	var problems: Array = []
	var package_slug := "hero_18"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("keep.gd"), "extends Node\n")
	var other := WiredPackageFs.packages_root().path_join("hero_19/other.gd")
	_write(other, "extends Node\n")

	var rejected := [
		WiredPackageFs.packages_root().path_join("hero_19/other.gd"),
		"res://other/other.gd",
		"C:/Windows/win.ini",
		"user://elsewhere/file.gd",
	]
	for path: String in rejected:
		var result := WiredPackageFs.op_delete_files(package_slug, [path])
		_expect(problems, result.has("error"), "\"%s\" must be rejected, got %s" % [path, result])
	_expect(
		problems,
		FileAccess.file_exists(other),
		"a path in another package must not be deleted",
	)
	_expect(
		problems,
		FileAccess.file_exists(root.path_join("keep.gd")),
		"the package must be untouched after rejected paths",
	)

	var root_result := WiredPackageFs.op_delete_files(package_slug, [WiredPackageFs.package_dir(package_slug)])
	_expect(
		problems,
		String(root_result.get("error", "")).contains("delete"),
		"deleting the package root must point at the whole-package delete, got %s" % [root_result],
	)
	_expect(
		problems,
		FileAccess.file_exists(root.path_join("keep.gd")),
		"the package root must survive a rejected root deletion",
	)
	_report("delete_files rejects paths outside the package", problems)


func _test_delete_files_traversal() -> void:
	var problems: Array = []
	var package_slug := "hero_19"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("keep.gd"), "extends Node\n")
	var victim := WiredPackageFs.packages_root().path_join("hero_18/keep.gd")
	_write(victim, "extends Node\n")

	var rejected := [
		"../hero_18/keep.gd",
		"a/../../hero_18/keep.gd",
		WiredPackageFs.package_dir(package_slug).path_join("../hero_18/keep.gd"),
		"res://packages/%s/../../hero_18/keep.gd" % package_slug,
	]
	for path: String in rejected:
		var result := WiredPackageFs.op_delete_files(package_slug, [path])
		_expect(problems, result.has("error"), "\"%s\" must be rejected as traversal, got %s" % [path, result])
	_expect(problems, FileAccess.file_exists(victim), "traversal must not reach another package")
	_expect(problems, FileAccess.file_exists(root.path_join("keep.gd")), "traversal must not delete package files")
	_report("delete_files rejects traversal", problems)


func _test_delete_files_missing_path() -> void:
	var problems: Array = []
	var package_slug := "hero_20"
	var root := WiredPackageFs.package_dir(package_slug)
	DirAccess.make_dir_recursive_absolute(root)
	_write(root.path_join("keep.gd"), "extends Node\n")

	var result := WiredPackageFs.op_delete_files(
		package_slug,
		[
			"missing.gd",
			WiredPackageFs.package_dir(package_slug).path_join("nested/missing.tscn"),
		]
	)
	_expect(problems, not result.has("error"), "a missing path must not be an error, got %s" % [result])
	_expect(
		problems,
		result.get("deleted", []) == [],
		"missing paths must not be reported as deleted, got %s" % [result.get("deleted", [])],
	)
	_expect(problems, FileAccess.file_exists(root.path_join("keep.gd")), "the package must be untouched")
	_report("delete_files ignores missing paths", problems)


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


func _test_invalid_slug() -> void:
	var problems: Array = []
	_expect(problems, WiredPackageFs.is_valid_slug("hero"), "\"hero\" must be a valid slug")
	_expect(problems, WiredPackageFs.is_valid_slug("7"), "the numeric legacy slug \"7\" must be valid")
	for slug in ["", "../escape", "Hero", "hero-one", "hero one"]:
		_expect(
			problems,
			not WiredPackageFs.is_valid_slug(slug),
			"%s must be an invalid slug" % [slug],
		)
	var rejected := WiredPackageFs.op_exists("../escape")
	_expect(
		problems,
		rejected == {"error": "invalid_slug"},
		"an invalid slug must return {error: invalid_slug}, got %s" % [rejected],
	)
	_report("invalid slugs are rejected", problems)


func _test_slug_regex_recovers_after_reload() -> void:
	var problems: Array = []
	# The editor keeps this script alive across hot reloads; its static RegEx
	# can be reset to null even though the method itself is usable.
	WiredPackageFs._slug_regex = null
	_expect(
		problems,
		WiredPackageFs.is_valid_slug("hero"),
		"a valid slug must still work after the static regex is reset",
	)
	_expect(
		problems,
		WiredPackageFs.is_valid_slug("7"),
		"the numeric legacy slug must still work after the static regex is reset",
	)
	_expect(
		problems,
		not WiredPackageFs.is_valid_slug("../escape"),
		"path traversal must still be rejected after the static regex is reset",
	)
	_report("slug regex recovers after reload", problems)


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
	# Mirror the production helper: hidden metadata must be removable.
	dir.include_hidden = true
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
