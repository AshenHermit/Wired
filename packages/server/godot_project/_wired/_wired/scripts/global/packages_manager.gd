extends Node
class_name PackagesManager

## Downloads published package runtime artifacts from the Wired backend and
## materializes them under user://wired/rooms/<room>/packages/<package_id>/<revision>/.
##
## `user://` is a single directory per Godot project name, so every room runtime
## on the machine shares it. The room code is therefore part of the path: two
## rooms never see or overwrite each other's package files, and a room's data
## can be cleaned up on its own.
##
## Rules that keep the game and editor consistent:
##   * a runtime manifest pins the exact revision of every dependency, so the
##     whole closure is applied before a scene can reference it;
##   * every file is downloaded and verified (size + sha256) in memory first, so
##     a failed or partial download never replaces the previous revision;
##   * files are written only inside the managed package directory;
##   * the previous revision directory is kept next to the current one and older
##     revisions are removed only after a successful apply, never arbitrary
##     project files.
##
## Manifests and files travel over plain HTTP, separately from the multiplayer
## WebSocket traffic.

signal package_applied(package_id: int, revision: int, changed_files: PackedStringArray)
signal package_failed(package_id: int, error: String)

const PROTOCOL_VERSION := 1
const DEFAULT_API_URL := "http://127.0.0.1:3000"
const PACKAGES_ROOT := "user://wired/rooms"
const UNASSIGNED_ROOM := "_unknown"
const STAGING_DIR := ".staging"
const PREVIOUS_DIR := ".previous"
const MAX_FILES := 2000
const MAX_FILE_SIZE := 64 * 1024 * 1024
## How long a sync waits for another coroutine that is applying the same package.
const APPLY_LOCK_TIMEOUT_MS := 300_000

## Result of trying to take the per-package apply lock.
enum ApplyLock { ACQUIRED, WAITED, TIMEOUT }

var base_url := DEFAULT_API_URL
## Room code the loader works for. Safe as a single path segment.
var room := UNASSIGNED_ROOM
## Test seam: when set, replaces the HTTP transport. It receives the relative
## request path and must return the same shape as `_request`.
var request_override: Callable = Callable()

# package id -> applied revision
var _current_revisions: Dictionary = {}
# package id -> { scene filepath: ["<package id>:<filepath>", ...] }
var _scene_dependencies: Dictionary = {}
# package id -> { filepath: sha256 } of the applied runtime artifact
var _file_hashes: Dictionary = {}
# package id -> true while a coroutine is applying a revision of that package
var _applying: Dictionary = {}
## Test seam: package ids in the order their files were applied. Dependencies
## are appended before the package that depends on them.
var _sync_order: Array = []


## Called by the runtime entry point once the backend API URL and the room are
## known. An empty room keeps the current value (web clients learn it from the
## host bridge later and call `set_room`).
func configure(url: String, room_id: String = "") -> void:
	var value := url.strip_edges()
	if value.is_empty():
		value = DEFAULT_API_URL
	base_url = value.trim_suffix("/")
	set_room(room_id)
	print("WIRED_PACKAGES_READY api=%s root=%s" % [base_url, packages_root()])


## Sets the room without touching the API URL. Ignored when the code is empty.
## Applied state belongs to one room, so a real change starts from scratch.
func set_room(room_id: String) -> void:
	var sanitized := _sanitize_room(room_id)
	if sanitized.is_empty() or sanitized == room:
		return
	room = sanitized
	_current_revisions.clear()
	_scene_dependencies.clear()
	_file_hashes.clear()


## Overrides the API root after `configure`. The Web build is served from the
## frontend origin and learns the backend only from the host bridge, so only an
## absolute http(s) URL is accepted. Returns false when the value is unusable,
## so the caller can report it instead of silently keeping the default.
func set_api_base(url: String) -> bool:
	var value := url.strip_edges()
	if value.is_empty():
		return false
	if not (value.begins_with("http://") or value.begins_with("https://")):
		return false
	var previous := base_url
	base_url = value.trim_suffix("/")
	print("WIRED_PACKAGES_API_OVERRIDE api=%s previous=%s" % [base_url, previous])
	return true


func packages_root() -> String:
	return PACKAGES_ROOT.path_join(room).path_join("packages")


func packages_dir(package_id: int) -> String:
	return packages_root().path_join(str(package_id))


func revision_dir(package_id: int, revision: int) -> String:
	return packages_dir(package_id).path_join(str(revision))


## Absolute (user://) location of a file of an applied runtime artifact.
func runtime_path(package_id: int, revision: int, filepath: String) -> String:
	return revision_dir(package_id, revision).path_join(filepath)


## Revision currently materialized for a package, or 0 when it was never
## applied by this process.
func current_revision(package_id: int) -> int:
	return int(_current_revisions.get(package_id, 0))


## Dependencies of one scene of an applied artifact, as "<package id>:<filepath>"
## entries. Returns an empty array for an unknown package or scene.
func scene_dependencies(package_id: int, scene_path: String) -> PackedStringArray:
	var result := PackedStringArray()
	var scenes: Variant = _scene_dependencies.get(package_id, {})
	if typeof(scenes) != TYPE_DICTIONARY:
		return result
	var entries: Variant = scenes.get(scene_path, [])
	if typeof(entries) != TYPE_ARRAY:
		return result
	for entry: Variant in entries:
		result.append(str(entry))
	return result


## Loads and instantiates a scene of an applied artifact. `revision` 0 means the
## revision currently materialized for the package. Returns null when the
## package or the scene is not available.
func instantiate_scene(package_id: int, scene_path: String, revision: int = 0) -> Node:
	var applied := revision
	if applied <= 0:
		applied = current_revision(package_id)
	if applied <= 0 or scene_path.is_empty():
		return null
	var path := runtime_path(package_id, applied, scene_path)
	# Guards the load below: a missing artifact would otherwise log an error.
	if not ResourceLoader.exists(path):
		return null
	var packed := ResourceLoader.load(
		path,
		"PackedScene",
		ResourceLoader.CACHE_MODE_IGNORE,
	) as PackedScene
	if packed == null:
		return null
	var scene := packed.instantiate()
	if scene == null:
		return null
	scene.set_meta("_wired_package_id", package_id)
	scene.set_meta("_wired_package_scene", scene_path)
	scene.set_meta("_wired_package_revision", applied)
	return scene


## Fetches the latest published manifest of a package. Returns an empty
## dictionary when the package has no published revision yet.
## Returns {ok: bool, error: String, manifest: Dictionary}. A missing package or
## a package without a published revision is reported as `ok` with an empty
## manifest; transport and format errors are reported as failures.
func fetch_manifest(package_id: int) -> Dictionary:
	var response := await _fetch("/scripting-packages/%d/manifest" % package_id)
	if response.status == 404:
		return {"ok": true, "error": "", "manifest": {}}
	if not response.ok:
		push_warning("WIRED_PACKAGES_MANIFEST_FAILED package=%d %s" % [package_id, response.error])
		return {"ok": false, "error": str(response.error), "manifest": {}}
	var parsed: Variant = JSON.parse_string(response.text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("WIRED_PACKAGES_MANIFEST_INVALID package=%d" % package_id)
		return {"ok": false, "error": "manifest is not a JSON object", "manifest": {}}
	return {"ok": true, "error": "", "manifest": parsed}


## Fetches the runtime manifest of an exact revision for this room. Unlike the
## raw manifest, it describes files whose package references were rewritten for
## this room and pins every direct dependency to a revision.
## Returns {ok, error, manifest}; an unpublished revision is reported as
## `runtime_manifest_missing`.
func fetch_runtime_manifest(package_id: int, revision: int) -> Dictionary:
	if package_id <= 0 or revision <= 0:
		return {"ok": false, "error": "invalid package revision", "manifest": {}}
	var response := await _fetch(
		"/scripting-packages/%d/revisions/%d/runtime-manifest?room=%d"
		% [package_id, revision, _room_id()]
	)
	if response.status == 404:
		return {"ok": false, "error": "runtime_manifest_missing", "manifest": {}}
	if not response.ok:
		push_warning(
			"WIRED_PACKAGES_RUNTIME_MANIFEST_FAILED package=%d revision=%d %s"
			% [package_id, revision, response.error]
		)
		return {"ok": false, "error": str(response.error), "manifest": {}}
	var parsed: Variant = JSON.parse_string(str(response.get("text", "")))
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning(
			"WIRED_PACKAGES_RUNTIME_MANIFEST_INVALID package=%d revision=%d"
			% [package_id, revision]
		)
		return {"ok": false, "error": "runtime manifest is not a JSON object", "manifest": {}}
	var manifest: Dictionary = parsed
	if (
		int(manifest.get("packageId", 0)) != package_id
		or int(manifest.get("revision", 0)) != revision
	):
		return {
			"ok": false,
			"error": "runtime manifest does not match the requested revision",
			"manifest": {},
		}
	return {"ok": true, "error": "", "manifest": manifest}


## Downloads and applies the runtime artifact of a package revision, together
## with every dependency it pins.
##
## `revision_hint` 0 means "the latest published revision": the raw manifest is
## read first to resolve the exact revision, then its runtime manifest is
## applied. An explicit revision is applied directly.
##
## Concurrent callers are serialized per package (`_acquire_apply_lock`), so a
## library shared by two packages is downloaded once and a stale revision can
## never replace a newer working copy.
##
## Returns {ok: bool, error: String, revision: int, files: Array,
## changed_files: PackedStringArray}.
func sync_package(package_id: int, revision_hint: int = 0) -> Dictionary:
	return await _sync_package_chain(package_id, revision_hint, [])


## Applies one package unless its call chain already contains it (a dependency
## cycle) or the package is already at this or a newer revision.
func _sync_package_chain(
	package_id: int, revision_hint: int, chain: Array
) -> Dictionary:
	if package_id <= 0:
		return _report_failure(package_id, revision_hint, "invalid package id %d" % package_id)
	var revision := revision_hint
	if revision <= 0:
		var latest := await _latest_revision(package_id)
		if not bool(latest.get("ok", false)):
			return _report_failure(package_id, revision_hint, str(latest.get("error", "")))
		revision = int(latest.get("revision", 0))

	# Checked before taking the lock: a cycle would otherwise wait on a lock
	# held by its own caller. Any revision of the package in the chain is a
	# cycle, because a package may only be applied once per closure.
	if _chain_contains_package(chain, package_id):
		var path := PackedStringArray()
		for entry: Variant in chain:
			path.append(str(entry))
		path.append("%d:%d" % [package_id, revision])
		return _report_failure(
			package_id,
			revision,
			"package_dependency_cycle:%s" % "->".join(path),
		)

	var lock := await _acquire_apply_lock(package_id)
	if lock == ApplyLock.TIMEOUT:
		return _report_failure(
			package_id,
			revision,
			"package %d revision %d: another apply did not finish in time"
			% [package_id, revision],
		)
	# A revision already on disk (or one that another coroutine applied while
	# this call waited) is not applied again. An older revision never replaces
	# a newer one; an equal one is only skipped for a caller that had to wait,
	# because a fresh call must still refresh a changed artifact.
	var applied := maxi(
		current_revision(package_id), _highest_revision_on_disk(package_id, 0)
	)
	if applied > revision or (lock == ApplyLock.WAITED and applied == revision):
		_release_apply_lock(package_id)
		return _skipped(applied)
	var result := await _sync_package(package_id, revision, chain)
	_release_apply_lock(package_id)
	if not bool(result.get("ok", false)):
		return _report_failure(
			package_id, int(result.get("revision", revision)), str(result.get("error", ""))
		)
	var changed: PackedStringArray = result.get(
		"changed_files", PackedStringArray()
	)
	package_applied.emit(package_id, int(result.get("revision", revision)), changed)
	return result


## Takes the per-package apply lock. ACQUIRED means the lock was free, WAITED
## means another coroutine's apply finished first, TIMEOUT means it never did.
func _acquire_apply_lock(package_id: int) -> int:
	if not _applying.has(package_id):
		_applying[package_id] = true
		return ApplyLock.ACQUIRED
	var deadline := Time.get_ticks_msec() + APPLY_LOCK_TIMEOUT_MS
	while _applying.has(package_id):
		if Time.get_ticks_msec() >= deadline:
			return ApplyLock.TIMEOUT
		await _wait_idle_frame()
	_applying[package_id] = true
	return ApplyLock.WAITED


func _release_apply_lock(package_id: int) -> void:
	_applying.erase(package_id)


func _wait_idle_frame() -> void:
	var loop := Engine.get_main_loop()
	if loop is SceneTree:
		await (loop as SceneTree).process_frame


func _chain_contains_package(chain: Array, package_id: int) -> bool:
	var prefix := "%d:" % package_id
	for entry: Variant in chain:
		if str(entry).begins_with(prefix):
			return true
	return false


## Successful no-op for a revision that is already applied or superseded.
func _skipped(revision: int) -> Dictionary:
	return {
		"ok": true,
		"error": "",
		"revision": revision,
		"files": [],
		"changed_files": PackedStringArray(),
		"skipped": true,
	}


func _sync_package(package_id: int, revision: int, chain: Array) -> Dictionary:
	var manifest_result := await fetch_runtime_manifest(package_id, revision)
	if not bool(manifest_result.get("ok", false)):
		return _failure(
			"package %d revision %d: cannot read the runtime manifest: %s"
			% [package_id, revision, manifest_result.get("error", "")],
			revision,
		)
	var manifest: Dictionary = manifest_result.get("manifest", {})
	var declared: Variant = manifest.get("files", [])
	if typeof(declared) != TYPE_ARRAY:
		return _failure(
			"runtime manifest of package %d has no file list" % package_id, revision
		)
	if declared.size() > MAX_FILES:
		return _failure("package %d declares too many files" % package_id, revision)
	var token := _download_token(manifest)
	if token.is_empty():
		return _failure(
			"runtime manifest of package %d has no download token" % package_id, revision
		)

	# Dependencies first: their files have to exist before a dependent scene is
	# loaded, and the manifest pins each of them to an exact revision.
	var next_chain := chain.duplicate()
	next_chain.append("%d:%d" % [package_id, revision])
	var dependency_error := await _sync_dependencies(package_id, manifest, next_chain)
	if not dependency_error.is_empty():
		return _failure(dependency_error, revision)
	# Test seam: records the apply order (dependencies before dependents).
	_sync_order.append(package_id)

	# 1. Download and verify everything in memory before touching the disk.
	var download := await _download_files(package_id, revision, declared, token)
	if not bool(download.get("ok", false)):
		return _failure(str(download.get("error", "")), revision)
	var verified: Array = download.get("files", [])
	var hashes: Dictionary = download.get("hashes", {})

	# 2. Stage the new revision next to the old one, then swap.
	var staging_error := _stage_files(package_id, verified)
	if not staging_error.is_empty():
		return _failure(staging_error, revision)
	var swap_error := _swap_revision(package_id, revision)
	if not swap_error.is_empty():
		return _failure(swap_error, revision)

	# 3. Publish the new state only after every file is in place. A dependency
	# that changed under an unchanged revision still refreshes the scene map and
	# the hashes here, even when `changed` is empty.
	var changed := _changed_files(_file_hashes.get(package_id, {}), hashes)
	_current_revisions[package_id] = revision
	_scene_dependencies[package_id] = _scene_map(manifest)
	_file_hashes[package_id] = hashes

	print(
		"WIRED_PACKAGES_APPLIED package=%d revision=%d files=%d"
		% [package_id, revision, verified.size()]
	)
	return {
		"ok": true,
		"error": "",
		"revision": revision,
		"files": verified.map(func(file: Dictionary) -> String: return str(file.filepath)),
		"changed_files": changed,
	}


## Resolves the latest published revision through the raw manifest, so a caller
## that only knows "apply the latest" still pins one exact revision.
func _latest_revision(package_id: int) -> Dictionary:
	var result := await fetch_manifest(package_id)
	if not bool(result.get("ok", false)):
		return {
			"ok": false,
			"error": "package %d: cannot read the manifest: %s"
			% [package_id, result.get("error", "")],
			"revision": 0,
		}
	var manifest: Dictionary = result.get("manifest", {})
	var revision := int(manifest.get("revision", 0))
	if revision <= 0:
		return {
			"ok": false,
			"error": "package %d has no published revision" % package_id,
			"revision": 0,
		}
	return {"ok": true, "error": "", "revision": revision}


## Applies every direct dependency of a manifest, passing the current call chain
## so a cycle is detected before it can wait forever. Returns an empty string on
## success, or the error that stopped the closure.
func _sync_dependencies(package_id: int, manifest: Dictionary, chain: Array) -> String:
	var dependencies: Variant = manifest.get("dependencies", [])
	if typeof(dependencies) != TYPE_ARRAY:
		return "runtime manifest of package %d has no dependency list" % package_id
	for dependency: Variant in dependencies:
		if typeof(dependency) != TYPE_DICTIONARY:
			return "package %d has a malformed dependency entry" % package_id
		var dependency_id := int(dependency.get("packageId", 0))
		var dependency_revision := int(dependency.get("revision", 0))
		if dependency_id <= 0 or dependency_revision <= 0:
			return "package %d has a malformed dependency entry" % package_id
		var result := await _sync_package_chain(
			dependency_id, dependency_revision, chain
		)
		if not bool(result.get("ok", false)):
			return (
				"package %d: dependency %d revision %d failed: %s"
				% [package_id, dependency_id, dependency_revision, result.get("error", "")]
			)
	return ""


func _download_token(manifest: Dictionary) -> String:
	var download: Variant = manifest.get("download", {})
	if typeof(download) != TYPE_DICTIONARY:
		return ""
	return str(download.get("token", ""))


## Downloads and verifies a revision's files in memory. The manifest hashes
## describe the rewritten artifact, so they are verified as they arrive.
func _download_files(
	package_id: int, revision: int, declared: Array, token: String
) -> Dictionary:
	var files: Array = []
	var hashes: Dictionary = {}
	for item: Variant in declared:
		if typeof(item) != TYPE_DICTIONARY:
			return {"ok": false, "error": "package %d has a malformed manifest entry" % package_id}
		var filepath := str(item.get("filepath", ""))
		var path_error := _validate_relative_path(filepath)
		if not path_error.is_empty():
			return {"ok": false, "error": path_error}
		var expected_size := int(item.get("size", -1))
		var expected_hash := str(item.get("sha256", "")).to_lower()
		if expected_size < 0 or expected_size > MAX_FILE_SIZE:
			return {
				"ok": false,
				"error": "package %d: invalid size for %s" % [package_id, filepath],
			}
		if expected_hash.length() != 64:
			return {
				"ok": false,
				"error": "package %d: invalid sha256 for %s" % [package_id, filepath],
			}

		var download := await _fetch(
			"/scripting-packages/%d/revisions/%d/runtime-files/%s?room=%d&token=%s"
			% [
				package_id,
				revision,
				_encode_path(filepath),
				_room_id(),
				token.uri_encode(),
			]
		)
		if not download.ok:
			return {
				"ok": false,
				"error": "package %d: cannot download %s: %s"
				% [package_id, filepath, download.error],
			}
		var body: PackedByteArray = download.body
		if body.size() != expected_size:
			return {
				"ok": false,
				"error":
				"package %d: size mismatch for %s (expected %d, got %d)"
				% [package_id, filepath, expected_size, body.size()],
			}
		if _sha256(body) != expected_hash:
			return {
				"ok": false,
				"error": "package %d: sha256 mismatch for %s" % [package_id, filepath],
			}
		files.append({"filepath": filepath, "body": body})
		hashes[filepath] = expected_hash
	return {"ok": true, "error": "", "files": files, "hashes": hashes}


## Writes the verified files into the staging directory. Returns an empty string
## on success; a partially written staging directory is always removed.
func _stage_files(package_id: int, files: Array) -> String:
	var staging := packages_dir(package_id).path_join(STAGING_DIR)
	_remove_tree(staging)
	for file: Dictionary in files:
		var target := staging.path_join(str(file.filepath))
		var dir_error := DirAccess.make_dir_recursive_absolute(target.get_base_dir())
		if dir_error != OK:
			_remove_tree(staging)
			return (
				"package %d: cannot create %s: %s"
				% [package_id, target.get_base_dir(), error_string(dir_error)]
			)
		var handle := FileAccess.open(target, FileAccess.WRITE)
		if handle == null:
			_remove_tree(staging)
			return (
				"package %d: cannot write %s: %s"
				% [package_id, target, error_string(FileAccess.get_open_error())]
			)
		handle.store_buffer(file.body)
		handle.close()
	return ""


## Replaces the revision directory only after the staged copy is complete, so a
## failed swap keeps a working package on disk. Returns an empty string on
## success.
func _swap_revision(package_id: int, revision: int) -> String:
	var target_dir := revision_dir(package_id, revision)
	var staging := packages_dir(package_id).path_join(STAGING_DIR)
	var backup_dir := packages_dir(package_id).path_join(PREVIOUS_DIR)
	_remove_tree(backup_dir)
	# Re-applying the same revision (a dependency changed) overwrites it; move
	# the old copy aside first so it survives a failed rename.
	if DirAccess.dir_exists_absolute(target_dir):
		var backup_error := DirAccess.rename_absolute(target_dir, backup_dir)
		if backup_error != OK:
			_remove_tree(staging)
			return (
				"package %d: cannot replace revision %d: %s"
				% [package_id, revision, error_string(backup_error)]
			)

	var rename_error := DirAccess.rename_absolute(staging, target_dir)
	if rename_error != OK:
		if DirAccess.dir_exists_absolute(backup_dir):
			DirAccess.rename_absolute(backup_dir, target_dir)
		_remove_tree(staging)
		return (
			"package %d: cannot publish revision %d: %s"
			% [package_id, revision, error_string(rename_error)]
		)

	_remove_tree(backup_dir)
	_prune_revisions(package_id, revision)
	return ""


## Keeps the applied revision and the newest other one on disk. Deriving the
## previous revision from the directory instead of memory keeps it correct
## after a restart and after a same-revision refresh. Only numeric revision
## directories of this package are removed, so no other project file is touched.
func _prune_revisions(package_id: int, keep_revision: int) -> void:
	var keep_previous := _highest_revision_on_disk(package_id, keep_revision)
	var root := packages_dir(package_id)
	var dir := DirAccess.open(root)
	if dir == null:
		return
	for name: String in dir.get_directories():
		if name == STAGING_DIR or name == PREVIOUS_DIR:
			continue
		if not name.is_valid_int():
			continue
		var value := name.to_int()
		if value == keep_revision or value == keep_previous:
			continue
		_remove_tree(root.path_join(name))


## Highest numeric revision directory of a package, ignoring `exclude`.
func _highest_revision_on_disk(package_id: int, exclude: int) -> int:
	var highest := 0
	var dir := DirAccess.open(packages_dir(package_id))
	if dir == null:
		return highest
	for name: String in dir.get_directories():
		if not name.is_valid_int():
			continue
		var value := name.to_int()
		if value != exclude:
			highest = maxi(highest, value)
	return highest


## File paths of `new` whose hash is missing or different in `old`, sorted.
func _changed_files(old: Dictionary, new: Dictionary) -> PackedStringArray:
	var changed := PackedStringArray()
	for filepath: Variant in new:
		var key := str(filepath)
		if not old.has(key) or str(old[key]) != str(new[key]):
			changed.append(key)
	changed.sort()
	return changed


func _scene_map(manifest: Dictionary) -> Dictionary:
	var scenes: Variant = manifest.get("sceneDependencies", {})
	if typeof(scenes) != TYPE_DICTIONARY:
		return {}
	return scenes


## Test seam wrapper: lets the smoke test supply responses without network.
func _fetch(path: String) -> Dictionary:
	if request_override.is_valid():
		var response: Variant = await request_override.call(path)
		if typeof(response) == TYPE_DICTIONARY:
			return response
		return {
			"ok": false,
			"status": 0,
			"error": "request override returned no response",
			"body": PackedByteArray(),
		}
	return await _request(path)


func _request(path: String) -> Dictionary:
	var http := HTTPRequest.new()
	http.timeout = 30.0
	add_child(http)
	# HTTPRequest builds its client only after entering the tree.
	if is_inside_tree():
		await get_tree().process_frame
	var error := http.request(base_url + path)
	if error != OK:
		http.queue_free()
		return {"ok": false, "status": 0, "error": error_string(error), "body": PackedByteArray()}
	var response: Array = await http.request_completed
	var result := int(response[0])
	var status := int(response[1])
	var body: PackedByteArray = response[3]
	http.queue_free()
	if result != HTTPRequest.RESULT_SUCCESS:
		return {"ok": false, "status": status, "error": "request failed (%d)" % result, "body": PackedByteArray()}
	if status < 200 or status >= 300:
		return {"ok": false, "status": status, "error": "HTTP %d" % status, "body": body}
	return {"ok": true, "status": status, "error": "", "body": body, "text": body.get_string_from_utf8()}


## The runtime room is the numeric room id (the backend passes it as --room);
## the manifest endpoints accept only an integer.
func _room_id() -> int:
	return room.to_int()


## Room codes come from the backend, but here they become one path segment, so
## only characters that cannot escape the packages root are kept.
func _sanitize_room(room_id: String) -> String:
	var value := room_id.strip_edges()
	if value.is_empty():
		return ""
	var out := ""
	for index in value.length():
		var ch := value[index]
		var allowed := (
			(ch >= "a" and ch <= "z")
			or (ch >= "A" and ch <= "Z")
			or (ch >= "0" and ch <= "9")
			or ch == "_"
			or ch == "-"
		)
		out += ch if allowed else "_"
	if out.length() > 64:
		out = out.substr(0, 64)
	return out


func _validate_relative_path(filepath: String) -> String:
	if filepath.is_empty():
		return "package manifest contains an empty file path"
	if filepath.begins_with("/") or filepath.contains("\\"):
		return "package manifest contains an unsafe path: %s" % filepath
	for part: String in filepath.split("/"):
		if part.is_empty() or part == "." or part == "..":
			return "package manifest contains an unsafe path: %s" % filepath
	if filepath.contains(":"):
		return "package manifest contains an unsafe path: %s" % filepath
	return ""


func _encode_path(filepath: String) -> String:
	var encoded := PackedStringArray()
	for part: String in filepath.split("/"):
		encoded.append(part.uri_encode())
	return "/".join(encoded)


func _sha256(data: PackedByteArray) -> String:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(data)
	return context.finish().hex_encode()


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


func _failure(message: String, revision: int = 0) -> Dictionary:
	return {"ok": false, "error": message, "revision": revision, "files": []}


func _report_failure(package_id: int, revision: int, message: String) -> Dictionary:
	package_failed.emit(package_id, message)
	print(
		"WIRED_PACKAGES_SYNC_FAILED package=%d revision=%d error=%s"
		% [package_id, revision, _single_line(message)]
	)
	return _failure(message, revision)


func _single_line(text: String) -> String:
	return text.replace("\r", " ").replace("\n", " ")
