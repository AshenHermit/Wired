class_name WiredPackageFs
extends RefCounted

## File operations for downloadable packages inside the editor project.
##
## Every package lives in its own directory under [member packages_root]. A
## replacement never writes into the live directory: [method op_prepare_replace]
## creates a staging directory, the shell copies the new revision there, and
## [method op_replace] swaps it in with two renames. If the editor dies between
## the renames, the previous directory is still there and
## [method restore_previous_if_needed] rolls the swap back on the next call.
##
## Editor metadata (dot directories, `*.uid` and `*.import` files) is generated
## by the editor itself. It is hidden from snapshots and collection, but copied
## from the old tree into the new one so the editor does not lose its cache.
##
## [member root_override] is set by the headless smoke test only; an empty value
## means [constant DEFAULT_ROOT].

const DEFAULT_ROOT := "res://packages"

static var root_override: String = ""


## Root directory that holds one subdirectory per package.
static func packages_root() -> String:
	return root_override if not root_override.is_empty() else DEFAULT_ROOT


## Project path of the live directory of a package.
static func package_dir(package_id: int) -> String:
	return packages_root().path_join(str(package_id))


## Project path of the directory that receives the next revision.
static func staging_dir(package_id: int) -> String:
	return packages_root().path_join(".%d.staging" % package_id)


## Project path of the backup kept while a swap is in flight.
static func previous_dir(package_id: int) -> String:
	return packages_root().path_join(".%d.previous" % package_id)


## A package id is a positive database id.
static func is_valid_id(package_id: int) -> bool:
	return package_id > 0


## A package file path must stay inside the package directory.
static func is_valid_relative_path(path: String) -> bool:
	if path.is_empty() or path.begins_with("/") or path.contains("\\"):
		return false
	for segment: String in path.split("/"):
		if segment.is_empty() or segment == "." or segment == "..":
			return false
	return true


## Files the editor owns: any path segment starting with a dot, `*.uid` and
## `*.import`.
static func is_editor_metadata(rel_path: String) -> bool:
	if rel_path.ends_with(".uid") or rel_path.ends_with(".import"):
		return true
	for segment: String in rel_path.split("/"):
		if segment.begins_with("."):
			return true
	return false


## Undoes a swap that was interrupted between the two renames.
static func restore_previous_if_needed(package_id: int) -> void:
	var previous := previous_dir(package_id)
	if not DirAccess.dir_exists_absolute(previous):
		return
	var root := package_dir(package_id)
	if DirAccess.dir_exists_absolute(root):
		return
	DirAccess.rename_absolute(previous, root)


# --- operations -----------------------------------------------------------


static func op_exists(package_id: int) -> Dictionary:
	var invalid := _invalid_id(package_id)
	if not invalid.is_empty():
		return {"error": invalid}
	restore_previous_if_needed(package_id)
	return {"exists": DirAccess.dir_exists_absolute(package_dir(package_id))}


static func op_create_dir(package_id: int) -> Dictionary:
	var invalid := _invalid_id(package_id)
	if not invalid.is_empty():
		return {"error": invalid}
	var error := DirAccess.make_dir_recursive_absolute(package_dir(package_id))
	if error != OK:
		return {
			"error": "не удалось создать каталог пакета %d: %s" % [package_id, error_string(error)],
		}
	return {}


static func op_snapshot(package_id: int) -> Dictionary:
	var invalid := _invalid_id(package_id)
	if not invalid.is_empty():
		return {"error": invalid}
	var files := {}
	var root := package_dir(package_id)
	if not DirAccess.dir_exists_absolute(root):
		return {"files": files}
	for rel_path: String in _list_files(root):
		if is_editor_metadata(rel_path):
			continue
		files[rel_path] = FileAccess.get_sha256(root.path_join(rel_path))
	return {"files": files}


static func op_collect(package_id: int) -> Dictionary:
	var invalid := _invalid_id(package_id)
	if not invalid.is_empty():
		return {"error": invalid}
	var files: Array = []
	var root := package_dir(package_id)
	if not DirAccess.dir_exists_absolute(root):
		return {"files": files}
	for rel_path: String in _list_files(root):
		if is_editor_metadata(rel_path):
			continue
		var abs_path := root.path_join(rel_path)
		var contents := FileAccess.get_file_as_bytes(abs_path)
		files.append(
			{
				"filepath": rel_path,
				"size": contents.size(),
				"sha256": FileAccess.get_sha256(abs_path),
				"contents_base64": Marshalls.raw_to_base64(contents),
			}
		)
	return {"files": files}


static func op_prepare_replace(package_id: int) -> Dictionary:
	var invalid := _invalid_id(package_id)
	if not invalid.is_empty():
		return {"error": invalid}
	restore_previous_if_needed(package_id)
	var prepare_error := _remove_tree(previous_dir(package_id))
	if prepare_error != OK:
		return {
			"error": "не удалось удалить previous пакета %d: %s"
			% [package_id, error_string(prepare_error)],
		}
	prepare_error = _remove_tree(staging_dir(package_id))
	if prepare_error != OK:
		return {
			"error": "не удалось удалить staging пакета %d: %s"
			% [package_id, error_string(prepare_error)],
		}
	var staging := staging_dir(package_id)
	var error := DirAccess.make_dir_recursive_absolute(staging)
	if error != OK:
		return {"error": "не удалось создать staging пакета %d: %s" % [package_id, error_string(error)]}
	return {"staging_path": ProjectSettings.globalize_path(staging)}


static func op_replace(package_id: int) -> Dictionary:
	var invalid := _invalid_id(package_id)
	if not invalid.is_empty():
		return {"error": invalid}
	restore_previous_if_needed(package_id)

	var root := package_dir(package_id)
	var staging := staging_dir(package_id)
	var previous := previous_dir(package_id)
	if not DirAccess.dir_exists_absolute(staging):
		return {"error": "staging не найден"}

	var staging_files := _list_files(staging)
	var staged := {}
	for rel_path: String in staging_files:
		staged[rel_path] = true
	var had_root := DirAccess.dir_exists_absolute(root)
	var old_files: Array[String] = []
	if had_root:
		old_files = _list_files(root)

	# Keep the editor's own files: they are not part of the revision.
	if had_root:
		var copy_error := _copy_editor_metadata(root, staging, old_files, staged)
		if not copy_error.is_empty():
			return {"error": copy_error}

	if had_root:
		var backup_error := DirAccess.rename_absolute(root, previous)
		if backup_error != OK:
			return {
				"error": "не удалось освободить каталог пакета %d: %s"
				% [package_id, error_string(backup_error)],
			}
		var swap_error := DirAccess.rename_absolute(staging, root)
		if swap_error != OK:
			DirAccess.rename_absolute(previous, root)
			_remove_tree(staging)
			return {
				"error": "не удалось переключить staging пакета %d: %s"
				% [package_id, error_string(swap_error)],
			}
		_remove_tree(previous)
	else:
		var swap_error := DirAccess.rename_absolute(staging, root)
		if swap_error != OK:
			return {
				"error": "не удалось переключить staging пакета %d: %s"
				% [package_id, error_string(swap_error)],
			}

	var written: Array[String] = []
	for rel_path: String in staging_files:
		if not is_editor_metadata(rel_path):
			written.append(rel_path)
	var deleted: Array[String] = []
	for rel_path: String in old_files:
		if is_editor_metadata(rel_path) or staged.has(rel_path):
			continue
		deleted.append(rel_path)
	return {"written": written, "deleted": deleted}


static func op_delete(package_id: int) -> Dictionary:
	var invalid := _invalid_id(package_id)
	if not invalid.is_empty():
		return {"error": invalid}
	restore_previous_if_needed(package_id)
	for path: String in [package_dir(package_id), staging_dir(package_id), previous_dir(package_id)]:
		var error := _remove_tree(path)
		if error != OK:
			return {"error": "не удалось удалить %s: %s" % [path, error_string(error)]}
	return {}


# --- helpers --------------------------------------------------------------


static func _invalid_id(package_id: int) -> String:
	if is_valid_id(package_id):
		return ""
	return "некорректный id пакета: %d" % package_id


## Relative paths of every file below [param dir_path], recursively.
static func _list_files(dir_path: String) -> Array[String]:
	var files: Array[String] = []
	_collect_files(dir_path, "", files)
	return files


static func _collect_files(abs_dir: String, rel_dir: String, files: Array[String]) -> void:
	var dir := DirAccess.open(abs_dir)
	if dir == null:
		return
	dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		if name == "." or name == "..":
			name = dir.get_next()
			continue
		var rel_path := name if rel_dir.is_empty() else rel_dir.path_join(name)
		var child := abs_dir.path_join(name)
		if dir.current_is_dir():
			_collect_files(child, rel_path, files)
		else:
			files.append(rel_path)
		name = dir.get_next()
	dir.list_dir_end()


## Copies the editor's files from the old tree into staging unless staging
## already has them. [param staged] tracks the files staging already contains.
static func _copy_editor_metadata(
	root: String, staging: String, old_files: Array[String], staged: Dictionary
) -> String:
	for rel_path: String in old_files:
		if not is_editor_metadata(rel_path) or staged.has(rel_path):
			continue
		var target := staging.path_join(rel_path)
		var make_error := DirAccess.make_dir_recursive_absolute(target.get_base_dir())
		if make_error != OK:
			return "не удалось подготовить %s: %s" % [target, error_string(make_error)]
		var contents := FileAccess.get_file_as_bytes(root.path_join(rel_path))
		var file := FileAccess.open(target, FileAccess.WRITE)
		if file == null:
			return "не удалось записать %s: %s" % [target, error_string(FileAccess.get_open_error())]
		file.store_buffer(contents)
		file.close()
		staged[rel_path] = true
	return ""


## Recursively removes a file or directory; a missing path is not an error.
static func _remove_tree(path: String) -> Error:
	if not DirAccess.dir_exists_absolute(path):
		if FileAccess.file_exists(path):
			return DirAccess.remove_absolute(path)
		return OK
	var dir := DirAccess.open(path)
	if dir == null:
		return DirAccess.get_open_error()
	# Collect names first: deleting while enumerating can skip entries.
	var names := PackedStringArray()
	dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		if name != "." and name != "..":
			names.append(name)
		name = dir.get_next()
	dir.list_dir_end()
	for child_name: String in names:
		var error := _remove_tree(path.path_join(child_name))
		if error != OK:
			return error
	return DirAccess.remove_absolute(path)
