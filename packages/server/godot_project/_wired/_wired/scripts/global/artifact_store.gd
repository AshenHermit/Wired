extends RefCounted
class_name ArtifactStore

## File-system side of a package artifact: staging, swap and pruning.
##
## `PackagesManager` decides *what* to apply; this script owns *how* a verified
## artifact lands on disk. The layout is
## `<packages root>/<slug>/<revision>-<artifact key>/`, so the bytes of two
## different closure states never share a path and the engine's resource cache
## can never mix them.
##
## The folder of a package is its slug, not its numeric id: the runtime manifest
## names it, and the id stays the identity in every state dictionary, signal and
## snapshot. A numeric legacy slug (`"7"`) is a valid folder name, so packages
## created before slugs existed keep their directory. An invalid or missing slug
## is an error: there is no `str(id)` fallback, because that would silently address
## a different package's bytes.
##
## Rules:
##   * a new artifact is written into `.staging` and only swapped in when it is
##     complete, so a failed apply keeps a working package on disk;
##   * the previous artifact is moved to `.previous` first and restored if the
##     rename fails;
##   * only numeric/artifact directories of that one slug are ever removed, so no
##     other project file is touched.
##
## The packages root is read through a callable on every access: the runtime
## learns its room after construction, and a room change must not require a new
## store.

const STAGING_DIR := ".staging"
const PREVIOUS_DIR := ".previous"
## Written into an artifact directory after everything else, so a directory that
## carries it is a completed apply and not a partially written one.
const MARKER_FILE := ".wired-artifact.json"
const MARKER_FORMAT_VERSION := 1
## The backend slug contract. It becomes a path segment, so it is validated
## before it is joined to the packages root.
const SLUG_PATTERN := "^[a-z0-9_]{1,64}$"

static var _slug_regex := RegEx.create_from_string(SLUG_PATTERN)

var _packages_root: Callable


## `packages_root` returns the room's packages directory
## (`user://wired/rooms/<room>/packages`).
func _init(packages_root: Callable) -> void:
	_packages_root = packages_root


## Whether `slug` is a safe package folder name. Numeric slugs are valid for
## packages created before slugs existed.
static func is_valid_slug(slug: String) -> bool:
	var found := _slug_regex.search(slug)
	# Require the match to consume the whole input: PCRE2's `$` also matches
	# before a trailing newline, which would accept `"hero\n"`.
	return found != null and found.get_string() == slug


## Directory of one package, or an empty string for an invalid slug. Everything
## else derives from this path.
func package_dir(slug: String) -> String:
	if not is_valid_slug(slug):
		return ""
	return str(_packages_root.call()).path_join(slug)


func staging_dir(slug: String) -> String:
	var root := package_dir(slug)
	if root.is_empty():
		return ""
	return root.path_join(STAGING_DIR)


## Directory of one artifact. An empty `artifact_key` selects the plain
## `<revision>` directory of a revision applied without a key.
func revision_dir(slug: String, revision: int, artifact_key: String) -> String:
	var root := package_dir(slug)
	if root.is_empty():
		return ""
	return root.path_join(revision_dir_name(revision, artifact_key))


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
func stage(slug: String, files: Array) -> String:
	var staging := staging_dir(slug)
	if staging.is_empty():
		return "package %s: invalid slug" % slug
	remove_tree(staging)
	for file: Dictionary in files:
		var target := staging.path_join(str(file.filepath))
		var dir_error := DirAccess.make_dir_recursive_absolute(target.get_base_dir())
		if dir_error != OK:
			remove_tree(staging)
			return (
				"package %s: cannot create %s: %s"
				% [slug, target.get_base_dir(), error_string(dir_error)]
			)
		var handle := FileAccess.open(target, FileAccess.WRITE)
		if handle == null:
			remove_tree(staging)
			return (
				"package %s: cannot write %s: %s"
				% [slug, target, error_string(FileAccess.get_open_error())]
			)
		handle.store_buffer(file.body)
		handle.close()
	return ""


## Replaces the keyed artifact directory only after the staged copy is complete,
## so a failed swap keeps a working package on disk. Returns an empty string on
## success.
func swap(slug: String, revision: int, artifact_key: String) -> String:
	var root := package_dir(slug)
	var target_dir := revision_dir(slug, revision, artifact_key)
	var staging := staging_dir(slug)
	if root.is_empty() or target_dir.is_empty() or staging.is_empty():
		return "package %s: invalid slug" % slug
	var backup_dir := root.path_join(PREVIOUS_DIR)
	remove_tree(backup_dir)
	# Re-applying the same artifact (a retry) overwrites it; move the old copy
	# aside first so it survives a failed rename.
	if DirAccess.dir_exists_absolute(target_dir):
		var backup_error := DirAccess.rename_absolute(target_dir, backup_dir)
		if backup_error != OK:
			remove_tree(staging)
			return (
				"package %s: cannot replace revision %d: %s"
				% [slug, revision, error_string(backup_error)]
			)

	var rename_error := DirAccess.rename_absolute(staging, target_dir)
	if rename_error != OK:
		if DirAccess.dir_exists_absolute(backup_dir):
			DirAccess.rename_absolute(backup_dir, target_dir)
		remove_tree(staging)
		return (
			"package %s: cannot publish revision %d: %s"
			% [slug, revision, error_string(rename_error)]
		)

	remove_tree(backup_dir)
	prune(slug, revision, target_dir.get_file())
	return ""


## Records the identity and the on-disk shape of a completed artifact. Written
## after every other file, so its presence is what tells a later run that the
## directory is whole.
##
## `stored_sizes` maps a manifest filepath to the size the file actually has on
## disk, for the bytes rewritten after the manifest was published (a relocated
## `user://` prefix). An empty map leaves the marker byte-identical to one
## written before that map existed. Returns an empty string on success.
func write_marker(
	dir: String,
	package_id: int,
	slug: String,
	revision: int,
	artifact_key: String,
	total_size: int,
	file_count: int,
	stored_sizes: Dictionary = {},
) -> String:
	if dir.is_empty():
		return "invalid marker directory"
	var marker := {
		"formatVersion": MARKER_FORMAT_VERSION,
		"packageId": package_id,
		"slug": slug,
		"revision": revision,
		"artifactKey": artifact_key,
		"totalSize": total_size,
		"fileCount": file_count,
		"deriveVersion": AssetDeriver.VERSION,
	}
	if not stored_sizes.is_empty():
		marker["storedSizes"] = stored_sizes
	var path := dir.path_join(MARKER_FILE)
	var handle := FileAccess.open(path, FileAccess.WRITE)
	if handle == null:
		return "cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())]
	handle.store_string(JSON.stringify(marker))
	var write_error := handle.get_error()
	handle.close()
	if write_error != OK:
		return "cannot write %s: %s" % [path, error_string(write_error)]
	return ""


## Whether `dir` already holds exactly what `files` describes: a marker of this
## package, slug, revision and artifact key, and every file at the size it was
## written with.
##
## A hit still reports what the marker says about derivation, so a caller can
## finish a stale artifact without downloading it again. Every result carries
## `dir` (a miss has to be replaced by an ordinary `swap`) and `stored_sizes`
## (so a marker rewrite keeps the relocated sizes).
func reusable_artifact(
	package_id: int, slug: String, revision: int, artifact_key: String, files: Array
) -> Dictionary:
	var result := {
		"reusable": false,
		"dir": "",
		"derive_current": false,
		"missing_derived": PackedStringArray(),
		"stored_sizes": {},
		"error": "",
	}
	if artifact_key.is_empty():
		result["error"] = "no_key"
		return result
	var dir := revision_dir(slug, revision, artifact_key)
	result["dir"] = dir
	if dir.is_empty():
		result["error"] = "invalid_slug"
		return result
	if not DirAccess.dir_exists_absolute(dir):
		result["error"] = "missing"
		return result
	var marker_path := dir.path_join(MARKER_FILE)
	if not FileAccess.file_exists(marker_path):
		result["error"] = "marker_missing"
		return result
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(marker_path))
	if typeof(parsed) != TYPE_DICTIONARY:
		result["error"] = "marker_missing"
		return result
	var marker: Dictionary = parsed
	if int(marker.get("formatVersion", 0)) != MARKER_FORMAT_VERSION:
		result["error"] = "marker_format"
		return result
	if (
		int(marker.get("packageId", 0)) != package_id
		or str(marker.get("slug", "")) != slug
		or int(marker.get("revision", 0)) != revision
		or str(marker.get("artifactKey", "")) != artifact_key
	):
		result["error"] = "marker_mismatch"
		return result
	# A malformed map is ignored: the manifest sizes then decide, and a marker
	# whose sizes cannot be read must not make an artifact reusable.
	var raw_sizes: Variant = marker.get("storedSizes", {})
	var stored_sizes: Dictionary = (
		raw_sizes if typeof(raw_sizes) == TYPE_DICTIONARY else {}
	)
	result["stored_sizes"] = stored_sizes
	var filepaths := PackedStringArray()
	for file: Dictionary in files:
		var filepath := str(file.get("filepath", ""))
		if filepath.is_empty():
			result["error"] = "file_size"
			return result
		filepaths.append(filepath)
		var expected_size := int(
			stored_sizes.get(filepath, int(file.get("size", -1)))
		)
		if _file_size(dir.path_join(filepath)) != expected_size:
			result["error"] = "file_size"
			return result
	var missing := PackedStringArray()
	for name: String in AssetDeriver.derived_files(filepaths):
		if not FileAccess.file_exists(dir.path_join(name)):
			missing.append(name)
	return {
		"reusable": true,
		"dir": dir,
		"derive_current": int(marker.get("deriveVersion", 0)) == AssetDeriver.VERSION,
		"missing_derived": missing,
		"stored_sizes": stored_sizes,
		"error": "",
	}


## Keeps the applied artifact and the newest other revision on disk. Older
## artifacts of the same revision are removed: their bytes belong to a closure
## that is no longer pinned. Deriving the previous revision from the directory
## instead of memory keeps it correct after a restart and after a same-revision
## refresh.
func prune(slug: String, keep_revision: int, keep_dir_name: String) -> void:
	var root := package_dir(slug)
	if root.is_empty():
		return
	var keep_previous := highest_revision(slug, keep_revision)
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
func highest_revision(slug: String, exclude: int = 0) -> int:
	var highest := 0
	var root := package_dir(slug)
	if root.is_empty():
		return highest
	var dir := DirAccess.open(root)
	if dir == null:
		return highest
	for name: String in dir.get_directories():
		var value := revision_of_dir_name(name)
		if value != 0 and value != exclude:
			highest = maxi(highest, value)
	return highest


func remove_files(paths: PackedStringArray) -> void:
	for path: String in paths:
		if path.is_empty():
			continue
		DirAccess.remove_absolute(path)


func remove_tree(path: String) -> void:
	if path.is_empty():
		return
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


## Size of a file on disk, or -1 when it cannot be opened.
static func _file_size(path: String) -> int:
	var handle := FileAccess.open(path, FileAccess.READ)
	if handle == null:
		return -1
	var size := handle.get_length()
	handle.close()
	return size
