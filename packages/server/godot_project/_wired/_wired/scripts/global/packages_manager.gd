extends Node
class_name PackagesManager

## Downloads published package runtime artifacts from the Wired backend and
## materializes them under
## user://wired/rooms/<room>/packages/<package_id>/<revision>-<artifact_key>/.
##
## `user://` is a single directory per Godot project name, so every room runtime
## on the machine shares it. The room code is therefore part of the path: two
## rooms never see or overwrite each other's package files, and a room's data
## can be cleaned up on its own.
##
## The artifact key is the backend's identity of the package's resolved
## closure. A same-revision publish of any dependency changes it, so the bytes
## of two different library states never share a path and the engine's resource
## cache can never mix them.
##
## Rules that keep the game and editor consistent:
##   * a runtime manifest pins the exact revision and artifact key of every
##     dependency, so the whole closure is applied before a scene can reference
##     it;
##   * every file is downloaded and verified (size + sha256) in memory first, so
##     a failed or partial download never replaces the previous revision;
##   * files are written only inside the managed package directory;
##   * the previous artifact is kept next to the current one and older ones are
##     removed only after a successful apply, never arbitrary project files.
##
## Manifests and files travel over plain HTTP, separately from the multiplayer
## WebSocket traffic.
##
## Three responsibilities were extracted, so this script stays about the apply
## state machine: `PackageManifest` (parsing/validation), `AssetDeriver` (the
## runtime form of raw assets) and `ArtifactStore` (staging, swap, pruning).

signal package_applied(package_id: int, revision: int, changed_files: PackedStringArray)
signal package_failed(package_id: int, error: String)

const PROTOCOL_VERSION := 1
const DEFAULT_API_URL := "http://127.0.0.1:3000"
const PACKAGES_ROOT := "user://wired/rooms"
const UNASSIGNED_ROOM := "_unknown"
## How long a sync waits for another coroutine that is applying the same package.
const APPLY_LOCK_TIMEOUT_MS := 300_000
## A lock held longer than this is leaked: the applying coroutine aborted (an
## engine error inside `await` never resumes, so no cleanup line can run), and a
## waiter must take over instead of blocking the package for the full timeout.
const APPLY_LOCK_STALE_MS := 30_000

## Result of trying to take the per-package apply lock.
enum ApplyLock { ACQUIRED, WAITED, TIMEOUT }

var base_url := DEFAULT_API_URL
## Room code the loader works for. Safe as a single path segment.
var room := UNASSIGNED_ROOM
## Test seam: when set, replaces the HTTP transport. It receives the relative
## request path and must return the same shape as `_request`.
var request_override: Callable = Callable()
## Test seam: when true, `_sync_package` records package ids in apply order.
## Disabled by default: the apply path is not a place for diagnostics nobody
## asked for, and a headless test can opt in explicitly.
var trace_sync_order := false

# package id -> applied revision
var _current_revisions: Dictionary = {}
# package id -> artifact key of the applied revision
var _current_artifact_keys: Dictionary = {}
# package id -> { scene filepath: ["<package id>:<filepath>", ...] }
var _scene_dependencies: Dictionary = {}
# package id -> { filepath: sha256 } of the applied runtime artifact
var _file_hashes: Dictionary = {}
# package id -> Time.get_ticks_msec() while a coroutine applies that package
var _applying: Dictionary = {}
## File-system side of an artifact. The root is resolved lazily, so a room
## change needs no reconfiguration.
var _artifacts: ArtifactStore
## Test seam, only filled while `trace_sync_order` is true.
var _sync_order: Array = []


func _init() -> void:
	_artifacts = ArtifactStore.new(Callable(self, "packages_root"))


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
	_current_artifact_keys.clear()
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
	return _artifacts.package_dir(package_id)


## Directory of one applied artifact. An empty `artifact_key` falls back to the
## key of the currently applied revision, or to the plain revision number when
## that revision was never applied by this process.
func revision_dir(
	package_id: int, revision: int, artifact_key: String = ""
) -> String:
	var key := artifact_key
	if key.is_empty() and current_revision(package_id) == revision:
		key = current_artifact_key(package_id)
	return _artifacts.revision_dir(package_id, revision, key)


## Absolute (user://) location of a file of an applied runtime artifact.
## `artifact_key` may be passed explicitly; otherwise the current key is used.
func runtime_path(
	package_id: int, revision: int, filepath: String, artifact_key: String = ""
) -> String:
	return revision_dir(package_id, revision, artifact_key).path_join(filepath)


## Revision currently materialized for a package, or 0 when it was never
## applied by this process.
func current_revision(package_id: int) -> int:
	return int(_current_revisions.get(package_id, 0))


## Artifact key of the revision currently materialized for a package, or an
## empty string when it was never applied by this process.
func current_artifact_key(package_id: int) -> String:
	return str(_current_artifact_keys.get(package_id, ""))


## Every package applied by this process: `{id: {revision, artifact_key}}`.
## The late-join snapshot compares this map with the peer's local map, because a
## same-revision dependency publish changes the artifact key without changing
## the revision number.
func applied_packages() -> Dictionary:
	var result := {}
	for package_id: Variant in _current_revisions:
		var id := int(package_id)
		result[str(id)] = {
			"revision": int(_current_revisions[package_id]),
			"artifact_key": str(_current_artifact_keys.get(package_id, "")),
		}
	return result


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
	scene.set_meta(WiredProtocol.META_PACKAGE_ID, package_id)
	scene.set_meta(WiredProtocol.META_PACKAGE_SCENE, scene_path)
	scene.set_meta(WiredProtocol.META_PACKAGE_REVISION, applied)
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
	if not PackageManifest.matches_revision(manifest, package_id, revision):
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
## never replace a newer working copy. Within one closure, `applied` records the
## dependencies already handled, so a diamond graph does not download, stage or
## re-emit the shared library once per path.
##
## Returns {ok: bool, error: String, revision: int, files: Array,
## changed_files: PackedStringArray}.
func sync_package(package_id: int, revision_hint: int = 0) -> Dictionary:
	return await _sync_package_chain(package_id, revision_hint, [], {})


## Applies one package unless its call chain already contains it (a dependency
## cycle), the package was already applied in this sync, or the package is
## already at this or a newer revision.
func _sync_package_chain(
	package_id: int, revision_hint: int, chain: Array, applied: Dictionary
) -> Dictionary:
	if package_id <= 0:
		return _report_failure(package_id, revision_hint, "invalid package id %d" % package_id)
	var revision := revision_hint
	if revision <= 0:
		var latest := await _latest_revision(package_id)
		if not bool(latest.get("ok", false)):
			return _report_failure(package_id, revision_hint, str(latest.get("error", "")))
		revision = int(latest.get("revision", 0))

	# Shared dependencies of a diamond are applied once per top-level sync.
	var already_applied := int(applied.get(package_id, 0))
	if already_applied >= revision:
		return _skipped(already_applied, current_artifact_key(package_id))

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
	var applied_revision := maxi(
		current_revision(package_id), _artifacts.highest_revision(package_id)
	)
	if applied_revision > revision or (lock == ApplyLock.WAITED and applied_revision == revision):
		_release_apply_lock(package_id)
		applied[package_id] = applied_revision
		return _skipped(applied_revision, current_artifact_key(package_id))
	var result := await _sync_package(package_id, revision, chain, applied)
	# Always released, successful or not: a failure result must not keep the
	# package locked. An *aborted* coroutine cannot reach this line, so the lock
	# also carries an acquisition timestamp and `_acquire_apply_lock` takes over
	# a leaked one after `APPLY_LOCK_STALE_MS`.
	_release_apply_lock(package_id)
	if not bool(result.get("ok", false)):
		return _report_failure(
			package_id, int(result.get("revision", revision)), str(result.get("error", ""))
		)
	applied[package_id] = int(result.get("revision", revision))
	var changed: PackedStringArray = result.get(
		"changed_files", PackedStringArray()
	)
	package_applied.emit(package_id, int(result.get("revision", revision)), changed)
	return result


## Takes the per-package apply lock. ACQUIRED means the lock was free (or was
## left behind by an aborted coroutine), WAITED means another coroutine's apply
## finished first, TIMEOUT means it never did.
func _acquire_apply_lock(package_id: int) -> int:
	if not _applying.has(package_id):
		_applying[package_id] = Time.get_ticks_msec()
		return ApplyLock.ACQUIRED
	var deadline := Time.get_ticks_msec() + APPLY_LOCK_TIMEOUT_MS
	while _applying.has(package_id):
		if _apply_lock_is_stale(package_id):
			push_warning(
				"WIRED_PACKAGES_LOCK_STALE package=%d reason=apply_aborted" % package_id
			)
			_applying[package_id] = Time.get_ticks_msec()
			return ApplyLock.ACQUIRED
		if Time.get_ticks_msec() >= deadline:
			return ApplyLock.TIMEOUT
		await _wait_idle_frame()
	_applying[package_id] = Time.get_ticks_msec()
	return ApplyLock.WAITED


func _release_apply_lock(package_id: int) -> void:
	_applying.erase(package_id)


func _apply_lock_is_stale(package_id: int) -> bool:
	if not _applying.has(package_id):
		return false
	var acquired := int(_applying.get(package_id, 0))
	if acquired <= 0:
		# A lock without a usable timestamp can never become valid again, so a
		# waiter treats it as abandoned instead of blocking on it.
		return true
	return Time.get_ticks_msec() - acquired >= APPLY_LOCK_STALE_MS


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
func _skipped(revision: int, artifact_key: String = "") -> Dictionary:
	return {
		"ok": true,
		"error": "",
		"revision": revision,
		"artifact_key": artifact_key,
		"files": [],
		"changed_files": PackedStringArray(),
		"skipped": true,
	}


func _sync_package(
	package_id: int, revision: int, chain: Array, applied: Dictionary
) -> Dictionary:
	var manifest_result := await fetch_runtime_manifest(package_id, revision)
	if not bool(manifest_result.get("ok", false)):
		return _failure(
			"package %d revision %d: cannot read the runtime manifest: %s"
			% [package_id, revision, manifest_result.get("error", "")],
			revision,
		)
	var manifest: Dictionary = manifest_result.get("manifest", {})
	var validated := PackageManifest.validate_runtime(manifest, package_id)
	if not bool(validated.get("ok", false)):
		return _failure(str(validated.get("error", "")), revision)
	var artifact_key := str(validated.get("artifact_key", ""))
	var declared: Array = validated.get("files", [])
	var token := str(validated.get("token", ""))

	# Dependencies first: their files have to exist before a dependent scene is
	# loaded, and the manifest pins each of them to an exact revision and key.
	var next_chain := chain.duplicate()
	next_chain.append("%d:%d" % [package_id, revision])
	var dependency_error := await _sync_dependencies(
		package_id, manifest, next_chain, applied
	)
	if not dependency_error.is_empty():
		return _failure(dependency_error, revision)
	if trace_sync_order:
		_sync_order.append(package_id)

	# 1. Download and verify everything in memory before touching the disk.
	var download := await _download_files(
		package_id, revision, declared, token, artifact_key
	)
	if not bool(download.get("ok", false)):
		return _failure(str(download.get("error", "")), revision)
	var verified: Array = download.get("files", [])
	var hashes: Dictionary = download.get("hashes", {})

	# 2. Stage the new artifact next to the old one, derive the runtime form of
	# its raw images and audio, then swap. The final directory is keyed, so a
	# refreshed closure never overwrites the bytes of the previous one.
	var target_dir := revision_dir(package_id, revision, artifact_key)
	var staging_error := _artifacts.stage(package_id, verified)
	if not staging_error.is_empty():
		return _failure(staging_error, revision)
	var derive_result := AssetDeriver.derive(
		_artifacts.staging_dir(package_id),
		target_dir,
		verified.map(func(file: Dictionary) -> String: return str(file.filepath)),
	)
	if not bool(derive_result.get("ok", false)):
		# Nothing derived stays in staging, so dropping it keeps the current
		# artifact untouched.
		_artifacts.remove_tree(_artifacts.staging_dir(package_id))
		return _failure(str(derive_result.get("error", "")), revision)
	var swap_error := _artifacts.swap(package_id, revision, artifact_key)
	if not swap_error.is_empty():
		return _failure(swap_error, revision)

	# 3. Publish the new state only after every file is in place. A dependency
	# that changed under an unchanged revision still refreshes the scene map and
	# the hashes here, even when `changed` is empty.
	var changed := _changed_files(_file_hashes.get(package_id, {}), hashes)
	_current_revisions[package_id] = revision
	_current_artifact_keys[package_id] = artifact_key
	_scene_dependencies[package_id] = PackageManifest.scene_map(manifest)
	_file_hashes[package_id] = hashes

	print(
		"WIRED_PACKAGES_APPLIED package=%d revision=%d artifact=%s files=%d"
		% [package_id, revision, artifact_key.left(12), verified.size()]
	)
	return {
		"ok": true,
		"error": "",
		"revision": revision,
		"artifact_key": artifact_key,
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
## so a cycle is detected before it can wait forever, and the already-applied
## map so a diamond's shared library is handled exactly once. Returns an empty
## string on success, or the error that stopped the closure.
func _sync_dependencies(
	package_id: int, manifest: Dictionary, chain: Array, applied: Dictionary
) -> String:
	var declared := PackageManifest.validate_dependencies(manifest, package_id)
	if not bool(declared.get("ok", false)):
		return str(declared.get("error", ""))
	var dependencies: Array = declared.get("dependencies", [])
	for dependency: Dictionary in dependencies:
		var dependency_id := int(dependency.get("package_id", 0))
		var dependency_revision := int(dependency.get("revision", 0))
		var expected_key := str(dependency.get("artifact_key", ""))
		if int(applied.get(dependency_id, 0)) >= dependency_revision:
			var applied_key := current_artifact_key(dependency_id)
			if not applied_key.is_empty() and applied_key != expected_key:
				return (
					"package %d: dependency %d artifact changed during sync"
					% [package_id, dependency_id]
				)
			continue
		var result := await _sync_package_chain(
			dependency_id, dependency_revision, chain, applied
		)
		if not bool(result.get("ok", false)):
			return (
				"package %d: dependency %d revision %d failed: %s"
				% [package_id, dependency_id, dependency_revision, result.get("error", "")]
			)
		var actual_key := str(result.get("artifact_key", ""))
		if actual_key.is_empty():
			actual_key = current_artifact_key(dependency_id)
		if not actual_key.is_empty() and actual_key != expected_key:
			# A publish between the dependent's manifest and the dependency's
			# manifest would mix two closure states; retry instead of loading
			# paths that do not exist on disk.
			return (
				"package %d: dependency %d artifact changed during sync"
				% [package_id, dependency_id]
			)
	return ""


## Downloads and verifies an artifact's files in memory. The manifest hashes
## describe the rewritten artifact, so they are verified as they arrive. The
## artifact key is part of the URL: the backend resolves exactly this artifact
## and never re-resolves the closure between two file requests. `declared` is
## already validated by `PackageManifest`, so every entry is safe to use.
func _download_files(
	package_id: int,
	revision: int,
	declared: Array,
	token: String,
	artifact_key: String,
) -> Dictionary:
	var files: Array = []
	var hashes: Dictionary = {}
	for item: Dictionary in declared:
		var filepath := str(item.get("filepath", ""))
		var expected_size := int(item.get("size", -1))
		var expected_hash := str(item.get("sha256", ""))
		var download := await _fetch(
			"/scripting-packages/%d/revisions/%d/runtime-files/%s?room=%d&key=%s&token=%s"
			% [
				package_id,
				revision,
				PackageManifest.encode_path(filepath),
				_room_id(),
				artifact_key.uri_encode(),
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


## File paths of `new` whose hash is missing or different in `old`, sorted.
func _changed_files(old: Dictionary, new: Dictionary) -> PackedStringArray:
	var changed := PackedStringArray()
	for filepath: Variant in new:
		var key := str(filepath)
		if not old.has(key) or str(old[key]) != str(new[key]):
			changed.append(key)
	changed.sort()
	return changed


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
	# The browser already decompresses gzip responses before Godot sees them.
	# Leaving this on makes the web build try to gunzip the decoded body and
	# fail with `request failed (8)` / stream_peer_gzip when a proxy (Next.js
	# in dev, nginx in production) compresses a large JSON manifest.
	http.accept_gzip = false
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


## JSON numbers arrive from the browser bridge as floats, so `7` becomes
## `7.0`. Normalize integral values before they become a path segment: sanitizing
## `7.0` into `7_0` would make `to_int()` return 70.
func _normalize_numeric_room(value: String) -> String:
	if value.is_valid_int():
		var integer := value.to_int()
		return str(integer) if integer > 0 else ""
	if value.is_valid_float():
		var number := value.to_float()
		if number > 0.0 and number == floor(number):
			return str(int(number))
	return ""


## Room codes come from the backend, but here they become one path segment, so
## only characters that cannot escape the packages root are kept.
func _sanitize_room(room_id: String) -> String:
	var value := room_id.strip_edges()
	if value.is_empty():
		return ""
	var numeric := _normalize_numeric_room(value)
	if not numeric.is_empty():
		return numeric
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


func _sha256(data: PackedByteArray) -> String:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(data)
	return context.finish().hex_encode()


## Kept as a thin seam for callers and tests that prune by path; the store owns
## the implementation.
func _remove_tree(path: String) -> void:
	_artifacts.remove_tree(path)


## Kept as a thin seam for tests that inspect the on-disk layout.
func _revision_of_dir_name(name: String) -> int:
	return ArtifactStore.revision_of_dir_name(name)


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
