extends Node
class_name PackagesManager

## Downloads published package revisions from the Wired backend and materializes
## them under user://wired/packages/<package_id>/<revision>/.
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
const PACKAGES_ROOT := "user://wired/packages"
const STAGING_DIR := ".staging"
const MAX_FILES := 2000
const MAX_FILE_SIZE := 64 * 1024 * 1024

var base_url := DEFAULT_API_URL

var _http: HTTPRequest
var _syncing: Dictionary = {}


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = 30.0
	add_child(_http)
	print("WIRED_PACKAGES_INIT root=%s" % PACKAGES_ROOT)


## Called by the runtime entry point once the backend API URL is known.
func configure(url: String) -> void:
	var value := url.strip_edges()
	if value.is_empty():
		value = DEFAULT_API_URL
	base_url = value.trim_suffix("/")
	print("WIRED_PACKAGES_READY api=%s" % base_url)


func packages_dir(package_id: int) -> String:
	return PACKAGES_ROOT.path_join(str(package_id))


func revision_dir(package_id: int, revision: int) -> String:
	return packages_dir(package_id).path_join(str(revision))


## Fetches the latest published manifest of a package. Returns an empty
## dictionary when the package has no published revision yet.
func fetch_manifest(package_id: int) -> Dictionary:
	var response := await _request("/scripting-packages/%d/manifest" % package_id)
	if response.status == 404:
		return {}
	if not response.ok:
		push_warning("WIRED_PACKAGES_MANIFEST_FAILED package=%d %s" % [package_id, response.error])
		return {}
	var parsed: Variant = JSON.parse_string(response.text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("WIRED_PACKAGES_MANIFEST_INVALID package=%d" % package_id)
		return {}
	return parsed


## Downloads the latest published revision of a package and applies it.
## Returns {ok: bool, error: String, revision: int, files: Array}.
func sync_package(package_id: int) -> Dictionary:
	if _syncing.has(package_id):
		return _failure("package %d is already syncing" % package_id)
	_syncing[package_id] = true
	var result := await _sync_package(package_id)
	_syncing.erase(package_id)
	if result.ok:
		package_applied.emit(package_id, int(result.revision), int(result.files.size()))
	else:
		package_failed.emit(package_id, str(result.error))
		push_warning("WIRED_PACKAGES_SYNC_FAILED package=%d %s" % [package_id, result.error])
	return result


func _sync_package(package_id: int) -> Dictionary:
	var manifest := await fetch_manifest(package_id)
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

	# 3. Replace previous revisions inside the managed package directory only.
	var target_dir := revision_dir(package_id, revision)
	_remove_tree(target_dir)
	_remove_other_revisions(package_id, revision)
	var rename_error := DirAccess.rename_absolute(staging, target_dir)
	if rename_error != OK:
		return _failure(
			"package %d: cannot publish revision %d: %s"
			% [package_id, revision, error_string(rename_error)]
		)

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
	var url := base_url + path
	var error := _http.request(url)
	if error != OK:
		return {"ok": false, "status": 0, "error": error_string(error), "body": PackedByteArray()}
	var response: Array = await _http.request_completed
	var result := int(response[0])
	var status := int(response[1])
	var body: PackedByteArray = response[3]
	if result != HTTPRequest.RESULT_SUCCESS:
		return {"ok": false, "status": status, "error": "request failed (%d)" % result, "body": PackedByteArray()}
	if status < 200 or status >= 300:
		return {"ok": false, "status": status, "error": "HTTP %d" % status, "body": body}
	return {"ok": true, "status": status, "error": "", "body": body, "text": body.get_string_from_utf8()}


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
	dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		var child := path.path_join(name)
		if dir.current_is_dir():
			_remove_tree(child)
			DirAccess.remove_absolute(child)
		else:
			DirAccess.remove_absolute(child)
		name = dir.get_next()
	dir.list_dir_end()
	DirAccess.remove_absolute(path)


## Removes revisions of this package that are not the one being applied.
func _remove_other_revisions(package_id: int, keep_revision: int) -> void:
	var root := packages_dir(package_id)
	var dir := DirAccess.open(root)
	if dir == null:
		return
	for name: String in dir.get_directories():
		if name == STAGING_DIR or name == str(keep_revision):
			continue
		_remove_tree(root.path_join(name))


func _failure(message: String) -> Dictionary:
	return {"ok": false, "error": message, "revision": 0, "files": []}
