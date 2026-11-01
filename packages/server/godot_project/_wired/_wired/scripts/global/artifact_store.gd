extends RefCounted
class_name ArtifactStore

## File-system side of a package artifact: staging, swap and pruning.
##
## `PackagesManager` decides *what* to apply; this script owns *how* a verified
## artifact lands on disk. The layout is
## `<packages root>/<package id>/<revision>-<artifact key>/`, so the bytes of two
## different closure states never share a path and the engine's resource cache
## can never mix them.
##
## Rules:
##   * a new artifact is written into `.staging` and only swapped in when it is
##     complete, so a failed apply keeps a working package on disk;
##   * the previous artifact is moved to `.previous` first and restored if the
##     rename fails;
##   * only numeric/artifact directories of that one package are ever removed,
##     so no other project file is touched.
##
## The packages root is read through a callable on every access: the runtime
## learns its room after construction, and a room change must not require a new
## store.

const STAGING_DIR := ".staging"
const PREVIOUS_DIR := ".previous"

var _packages_root: Callable


## `packages_root` returns the room's packages directory
## (`user://wired/rooms/<room>/packages`).
func _init(packages_root: Callable) -> void:
	_packages_root = packages_root


func package_dir(package_id: int) -> String:
	return str(_packages_root.call()).path_join(str(package_id))


func staging_dir(package_id: int) -> String:
	return package_dir(package_id).path_join(STAGING_DIR)


## Directory of one artifact. An empty `artifact_key` selects the plain
## `<revision>` directory of a revision applied without a key.
func revision_dir(package_id: int, revision: int, artifact_key: String) -> String:
	return package_dir(package_id).path_join(
		revision_dir_name(revision, artifact_key)
	)


static func revision_dir_name(revision: int, artifact_key: String) -> String:
	if artifact_key.is_empty():
		return str(revision)
	return "%d-%s" % [revision, artifact_key]


## Revision encoded in a `<revision>` or `<revision>-<artifact_key>` directory
## name, or 0 for anything else (staging, `.previous`, arbitrary files).
static func revision_of_dir_name(name: String) -> int:
	var base := name.get_slice("-", 0)
	return base.to_int() if base.is_valid_int() else 0


## Writes the verified files into the staging directory. Returns an empty string
## on success; a partially written staging directory is always removed.
func stage(package_id: int, files: Array) -> String:
	var staging := staging_dir(package_id)
	remove_tree(staging)
	for file: Dictionary in files:
		var target := staging.path_join(str(file.filepath))
		var dir_error := DirAccess.make_dir_recursive_absolute(target.get_base_dir())
		if dir_error != OK:
			remove_tree(staging)
			return (
				"package %d: cannot create %s: %s"
				% [package_id, target.get_base_dir(), error_string(dir_error)]
			)
		var handle := FileAccess.open(target, FileAccess.WRITE)
		if handle == null:
			remove_tree(staging)
			return (
				"package %d: cannot write %s: %s"
				% [package_id, target, error_string(FileAccess.get_open_error())]
			)
		handle.store_buffer(file.body)
		handle.close()
	return ""


## Replaces the keyed artifact directory only after the staged copy is complete,
## so a failed swap keeps a working package on disk. Returns an empty string on
## success.
func swap(package_id: int, revision: int, artifact_key: String) -> String:
	var target_dir := revision_dir(package_id, revision, artifact_key)
	var staging := staging_dir(package_id)
	var backup_dir := package_dir(package_id).path_join(PREVIOUS_DIR)
	remove_tree(backup_dir)
	# Re-applying the same artifact (a retry) overwrites it; move the old copy
	# aside first so it survives a failed rename.
	if DirAccess.dir_exists_absolute(target_dir):
		var backup_error := DirAccess.rename_absolute(target_dir, backup_dir)
		if backup_error != OK:
			remove_tree(staging)
			return (
				"package %d: cannot replace revision %d: %s"
				% [package_id, revision, error_string(backup_error)]
			)

	var rename_error := DirAccess.rename_absolute(staging, target_dir)
	if rename_error != OK:
		if DirAccess.dir_exists_absolute(backup_dir):
			DirAccess.rename_absolute(backup_dir, target_dir)
		remove_tree(staging)
		return (
			"package %d: cannot publish revision %d: %s"
			% [package_id, revision, error_string(rename_error)]
		)

	remove_tree(backup_dir)
	prune(package_id, revision, target_dir.get_file())
	return ""


## Keeps the applied artifact and the newest other revision on disk. Older
## artifacts of the same revision are removed: their bytes belong to a closure
## that is no longer pinned. Deriving the previous revision from the directory
## instead of memory keeps it correct after a restart and after a same-revision
## refresh.
func prune(package_id: int, keep_revision: int, keep_dir_name: String) -> void:
	var keep_previous := highest_revision(package_id, keep_revision)
	var root := package_dir(package_id)
	var dir := DirAccess.open(root)
	if dir == null:
		return
	for name: String in dir.get_directories():
		if name == STAGING_DIR or name == PREVIOUS_DIR:
			continue
		var value := revision_of_dir_name(name)
		if value <= 0:
			continue
		if name == keep_dir_name:
			continue
		if value == keep_previous:
			continue
		remove_tree(root.path_join(name))


## Highest numeric revision directory of a package, ignoring `exclude`.
func highest_revision(package_id: int, exclude: int = 0) -> int:
	var highest := 0
	var dir := DirAccess.open(package_dir(package_id))
	if dir == null:
		return highest
	for name: String in dir.get_directories():
		var value := revision_of_dir_name(name)
		if value != 0 and value != exclude:
			highest = maxi(highest, value)
	return highest


func remove_files(paths: PackedStringArray) -> void:
	for path: String in paths:
		DirAccess.remove_absolute(path)


func remove_tree(path: String) -> void:
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
			remove_tree(child)
		else:
			DirAccess.remove_absolute(child)
	DirAccess.remove_absolute(path)
