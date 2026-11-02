extends RefCounted
class_name PackageManifest

## Parsing and validation of the manifests the backend publishes.
##
## `PackagesManager` owns transport and apply state; this script owns every rule
## a manifest must satisfy before a single byte is downloaded or written. The
## functions are static: a manifest is validated against nothing but itself, so
## a test can check a fixture without a manager, a room or a file system.
##
## Two manifest shapes exist:
##   * the raw package manifest (`revision` only) — used to resolve "latest";
##   * the room runtime manifest (`files`, `dependencies`, `sceneDependencies`,
##     `artifactKey`, `download.token`) — everything `sync_package` applies.
##
## A runtime manifest declares a closed set of files inside the artifact, so
## every path is validated here, before it becomes a path segment on disk.

## A backend artifact key is a lowercase sha256 hex digest and becomes a path
## segment, so anything else is rejected.
const ARTIFACT_KEY_LENGTH := 64
## Local safety limits: a manifest that exceeds them is treated as malformed.
const MAX_FILES := 2000
const MAX_FILE_SIZE := 64 * 1024 * 1024
## sha256 digests are lowercase hex in the backend manifest.
const SHA256_HEX_LENGTH := 64
## A package slug becomes the runtime's on-disk folder name, so it is validated
## here before any path is resolved. Numeric legacy slugs (`"7"`) are valid.
const SLUG_PATTERN := "^[a-z0-9_]{1,64}$"

static var _slug_regex := RegEx.create_from_string(SLUG_PATTERN)


## Validates the slug, the file list, the artifact key and the download token of
## a runtime manifest. Returns
## `{ok, error, slug, artifact_key, token, files}` where every file is
## `{filepath, size, sha256}` and already safe to use as a relative path.
static func validate_runtime(manifest: Dictionary, package_id: int) -> Dictionary:
	var slug := str(manifest.get("slug", ""))
	if not is_valid_slug(slug):
		return _invalid("runtime manifest of package %d has no valid slug" % package_id)
	var artifact_key := str(manifest.get("artifactKey", ""))
	if not is_valid_artifact_key(artifact_key):
		return _invalid(
			"runtime manifest of package %d has no valid artifact key" % package_id
		)
	var declared: Variant = manifest.get("files", [])
	if typeof(declared) != TYPE_ARRAY:
		return _invalid(
			"runtime manifest of package %d has no file list" % package_id
		)
	var entries: Array = declared
	if entries.size() > MAX_FILES:
		return _invalid("package %d declares too many files" % package_id)
	var token := download_token(manifest)
	if token.is_empty():
		return _invalid(
			"runtime manifest of package %d has no download token" % package_id
		)
	var files: Array = []
	for item: Variant in entries:
		if typeof(item) != TYPE_DICTIONARY:
			return _invalid("package %d has a malformed manifest entry" % package_id)
		var entry: Dictionary = item
		var filepath := str(entry.get("filepath", ""))
		var path_error := validate_relative_path(filepath)
		if not path_error.is_empty():
			return _invalid(path_error)
		var size := int(entry.get("size", -1))
		var digest := str(entry.get("sha256", "")).to_lower()
		if size < 0 or size > MAX_FILE_SIZE:
			return _invalid("package %d: invalid size for %s" % [package_id, filepath])
		if digest.length() != SHA256_HEX_LENGTH:
			return _invalid(
				"package %d: invalid sha256 for %s" % [package_id, filepath]
			)
		files.append({"filepath": filepath, "size": size, "sha256": digest})
	return {
		"ok": true,
		"error": "",
		"slug": slug,
		"artifact_key": artifact_key,
		"token": token,
		"files": files,
	}


## Validates the pinned dependency list. Returns
## `{ok, error, dependencies}` where every dependency is
## `{package_id, revision, artifact_key}`.
static func validate_dependencies(
	manifest: Dictionary, package_id: int
) -> Dictionary:
	var declared: Variant = manifest.get("dependencies", [])
	if typeof(declared) != TYPE_ARRAY:
		return _invalid_dependencies(
			"runtime manifest of package %d has no dependency list" % package_id
		)
	var dependencies: Array = []
	for item: Variant in declared:
		if typeof(item) != TYPE_DICTIONARY:
			return _invalid_dependencies(
				"package %d has a malformed dependency entry" % package_id
			)
		var entry: Dictionary = item
		var dependency_id := int(entry.get("packageId", 0))
		var dependency_revision := int(entry.get("revision", 0))
		var artifact_key := str(entry.get("artifactKey", ""))
		if dependency_id <= 0 or dependency_revision <= 0:
			return _invalid_dependencies(
				"package %d has a malformed dependency entry" % package_id
			)
		if not is_valid_artifact_key(artifact_key):
			return _invalid_dependencies(
				"package %d has a malformed dependency artifact key" % package_id
			)
		dependencies.append(
			{
				"package_id": dependency_id,
				"revision": dependency_revision,
				"artifact_key": artifact_key,
			}
		)
	return {"ok": true, "error": "", "dependencies": dependencies}


## `sceneDependencies` of a manifest: `{scene filepath: ["<package id>:<filepath>",
## ...]}`. A malformed map degrades to an empty one: it only drives hot-reload
## diagnostics, never a load decision.
static func scene_map(manifest: Dictionary) -> Dictionary:
	var scenes: Variant = manifest.get("sceneDependencies", {})
	if typeof(scenes) != TYPE_DICTIONARY:
		return {}
	return scenes


## `{token, expiresAt}` of the runtime manifest, or an empty dictionary.
static func download(manifest: Dictionary) -> Dictionary:
	var value: Variant = manifest.get("download", {})
	if typeof(value) != TYPE_DICTIONARY:
		return {}
	return value


static func download_token(manifest: Dictionary) -> String:
	return str(download(manifest).get("token", ""))


## Whether a manifest pins an exact revision: `sync_package(0)` resolves the
## latest revision through the raw manifest, and a mismatch means the backend
## answered for a different publish.
static func matches_revision(
	manifest: Dictionary, package_id: int, revision: int
) -> bool:
	return (
		int(manifest.get("packageId", 0)) == package_id
		and int(manifest.get("revision", 0)) == revision
	)


static func is_valid_artifact_key(value: String) -> bool:
	if value.length() != ARTIFACT_KEY_LENGTH:
		return false
	for index in value.length():
		var ch := value[index]
		if not ((ch >= "0" and ch <= "9") or (ch >= "a" and ch <= "f")):
			return false
	return true


## Whether `slug` is a safe package folder name: lowercase latin letters, digits
## and underscores. Requiring the match to consume the whole input rejects
## `"hero\n"`, which PCRE2's `$` would otherwise accept.
static func is_valid_slug(value: String) -> bool:
	var found := _slug_regex.search(value)
	return found != null and found.get_string() == value


## A manifest path must stay inside the package artifact: relative, forward
## slashes only, no `.`/`..` segment and no drive letter.
static func validate_relative_path(filepath: String) -> String:
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


## Percent-encodes every path segment, keeping `/` as the separator.
static func encode_path(filepath: String) -> String:
	var encoded := PackedStringArray()
	for part: String in filepath.split("/"):
		encoded.append(part.uri_encode())
	return "/".join(encoded)


static func _invalid(message: String) -> Dictionary:
	return {
		"ok": false,
		"error": message,
		"artifact_key": "",
		"token": "",
		"files": [],
	}


static func _invalid_dependencies(message: String) -> Dictionary:
	return {"ok": false, "error": message, "dependencies": []}
