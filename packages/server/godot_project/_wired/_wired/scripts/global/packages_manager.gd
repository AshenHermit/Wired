extends Node
class_name PackagesManager

## Downloads published package revisions from the Wired backend and materializes
## them under user://wired/rooms/<room>/packages/<package_id>/<revision>/.
##
## `user://` is a single directory per Godot project name, so every room runtime
## on the machine shares it. The room code is therefore part of the path: two
## rooms never see or overwrite each other's package files, and a room's data
## can be cleaned up on its own.
##
## Rules that keep the game and editor consistent:
##   * every file is downloaded and verified (size + sha256) in memory first, so
##     a failed or partial download never replaces the previous revision;
##   * files are written only inside the managed package directory;
##   * directories of previous revisions are removed after a successful apply,
##     never arbitrary project files.
##
## Manifests and files travel over plain HTTP, separately from the multiplayer
## WebSocket traffic.

signal package_applied(package_id: int, revision: int, file_count: int)
signal package_failed(package_id: int, error: String)

const PROTOCOL_VERSION := 1
const DEFAULT_API_URL := "http://127.0.0.1:3000"
const PACKAGES_ROOT := "user://wired/rooms"
const UNASSIGNED_ROOM := "_unknown"
const STAGING_DIR := ".staging"
const MAX_FILES := 2000
const MAX_FILE_SIZE := 64 * 1024 * 1024

var base_url := DEFAULT_API_URL
## Room code the loader works for. Safe as a single path segment.
var room := UNASSIGNED_ROOM

var _syncing: Dictionary = {}


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
func set_room(room_id: String) -> void:
	var sanitized := _sanitize_room(room_id)
	if not sanitized.is_empty():
		room = sanitized


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


## Fetches the latest published manifest of a package. Returns an empty
## dictionary when the package has no published revision yet.
## Returns {ok: bool, error: String, manifest: Dictionary}. A missing package or
## a package without a published revision is reported as `ok` with an empty
## manifest; transport and format errors are reported as failures.
func fetch_manifest(package_id: int) -> Dictionary:
	var response := await _request("/scripting-packages/%d/manifest" % package_id)
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


## Downloads the latest published revision of a package and applies it.
## `revision_hint` is the revision the backend asked for; it is only used to
## label failures that happen before the manifest is known.
## Returns {ok: bool, error: String, revision: int, files: Array}.
func sync_package(package_id: int, revision_hint: int = 0) -> Dictionary:
	if _syncing.has(package_id):
		return _failure("package %d is already syncing" % package_id)
	_syncing[package_id] = true
	var result := await _sync_package(package_id)
	_syncing.erase(package_id)
	if result.ok:
		package_applied.emit(package_id, int(result.revision), int(result.files.size()))
	else:
		package_failed.emit(package_id, str(result.error))
		var revision := int(result.get("revision", 0))
		if revision <= 0:
			revision = revision_hint
		print(
			"WIRED_PACKAGES_SYNC_FAILED package=%d revision=%d error=%s"
			% [package_id, revision, _single_line(str(result.error))]
		)
	return result


func _single_line(text: String) -> String:
	return text.replace("\r", " ").replace("\n", " ")


func _sync_package(package_id: int) -> Dictionary:
	var manifest_result := await fetch_manifest(package_id)
	if not bool(manifest_result.get("ok", false)):
		return _failure(
			"package %d: cannot read the manifest: %s" % [package_id, manifest_result.get("error", "")]
		)
	var manifest: Dictionary = manifest_result.get("manifest", {})
	if manifest.is_empty():
		return _failure("package %d has no published revision" % package_id)

	var revision := int(manifest.get("revision", 0))
	if revision <= 0:
		return _failure("manifest of package %d has no revision" % package_id)

	var declared: Variant = manifest.get("files", [])
	if typeof(declared) != TYPE_ARRAY:
		return _failure("manifest of package %d has no file list" % package_id)
	if declared.size() > MAX_FILES:
		return _failure("package %d declares too many files" % package_id)

	# 1. Download and verify everything in memory before touching the disk.
	var verified: Array = []
	for item: Variant in declared:
		if typeof(item) != TYPE_DICTIONARY:
			return _failure("package %d has a malformed manifest entry" % package_id)
		var filepath := str(item.get("filepath", ""))
		var path_error := _validate_relative_path(filepath)
		if not path_error.is_empty():
			return _failure(path_error)
		var expected_size := int(item.get("size", -1))
		var expected_hash := str(item.get("sha256", "")).to_lower()
		if expected_size < 0 or expected_size > MAX_FILE_SIZE:
			return _failure("package %d: invalid size for %s" % [package_id, filepath])
		if expected_hash.length() != 64:
			return _failure("package %d: invalid sha256 for %s" % [package_id, filepath])

		var download := await _request(
			"/scripting-packages/%d/revisions/%d/files/%s"
			% [package_id, revision, _encode_path(filepath)]
		)
		if not download.ok:
			return _failure(
				"package %d: cannot download %s: %s" % [package_id, filepath, download.error]
			)
		if download.body.size() != expected_size:
			return _failure(
				"package %d: size mismatch for %s (expected %d, got %d)"
				% [package_id, filepath, expected_size, download.body.size()]
			)
		var actual_hash := _sha256(download.body)
		if actual_hash != expected_hash:
			return _failure(
				"package %d: sha256 mismatch for %s" % [package_id, filepath]
			)
		verified.append({"filepath": filepath, "body": download.body})

	# 2. Stage the new revision next to the old one, then swap.
	var staging := packages_dir(package_id).path_join(STAGING_DIR)
	_remove_tree(staging)
	for file: Dictionary in verified:
		var target := staging.path_join(str(file.filepath))
		var dir_error := DirAccess.make_dir_recursive_absolute(target.get_base_dir())
		if dir_error != OK:
			return _failure(
				"package %d: cannot create %s: %s"
				% [package_id, target.get_base_dir(), error_string(dir_error)]
			)
		var handle := FileAccess.open(target, FileAccess.WRITE)
		if handle == null:
			return _failure(
				"package %d: cannot write %s: %s"
				% [package_id, target, error_string(FileAccess.get_open_error())]
			)
		handle.store_buffer(file.body)
		handle.close()

	# 3. Replace the previous revision only after the new one is in place, so a
	# failed swap keeps a working package on disk.
	var target_dir := revision_dir(package_id, revision)
	var backup_dir := packages_dir(package_id).path_join(".previous")
	_remove_tree(backup_dir)
	if DirAccess.dir_exists_absolute(target_dir):
		var backup_error := DirAccess.rename_absolute(target_dir, backup_dir)
		if backup_error != OK:
			_remove_tree(staging)
			return _failure(
				"package %d: cannot replace revision %d: %s"
				% [package_id, revision, error_string(backup_error)]
			)

	var rename_error := DirAccess.rename_absolute(staging, target_dir)
	if rename_error != OK:
		if DirAccess.dir_exists_absolute(backup_dir):
			DirAccess.rename_absolute(backup_dir, target_dir)
		_remove_tree(staging)
		return _failure(
			"package %d: cannot publish revision %d: %s"
			% [package_id, revision, error_string(rename_error)]
		)

	_remove_tree(backup_dir)
	_remove_other_revisions(package_id, revision)

	print(
		"WIRED_PACKAGES_APPLIED package=%d revision=%d files=%d"
		% [package_id, revision, verified.size()]
	)
	return {
		"ok": true,
		"error": "",
		"revision": revision,
		"files": verified.map(func(file: Dictionary) -> String: return str(file.filepath)),
	}


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


## Removes revisions of this package that are not the one being applied.
func _remove_other_revisions(package_id: int, keep_revision: int) -> void:
	var root := packages_dir(package_id)
	var dir := DirAccess.open(root)
	if dir == null:
		return
	for name: String in dir.get_directories():
		if name == STAGING_DIR or name == ".previous" or name == str(keep_revision):
			continue
		_remove_tree(root.path_join(name))


func _failure(message: String, revision: int = 0) -> Dictionary:
	return {"ok": false, "error": message, "revision": revision, "files": []}
