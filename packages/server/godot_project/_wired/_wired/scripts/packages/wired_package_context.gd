extends RefCounted
class_name WiredPackageContext

## Resolved location of one package revision.
##
## The runtime builds a context after a package revision has been applied:
## `packages` is the live PackagesManager, while fixture and editor contexts may
## instead point at a plain `root_path`. Both forms expose the same relative
## path API, so registrations never need to know where the files live.

## String form of the backend package id. PackagesManager works with integers,
## so the context converts it at the boundary.
var package_id: String = ""
## Fallback root used when no PackagesManager is attached.
var root_path: String = ""
var revision: int = 0
var artifact_key: String = ""
var packages: PackagesManager = null


## Absolute (res:// or user://) location of a package file.
func scene_path(relative_path: String) -> String:
	if packages != null:
		return packages.runtime_path(
			_package_number(), revision, relative_path, artifact_key
		)
	return root_path.path_join(relative_path)


## Loads and instantiates a package scene. Returns null when the file is
## missing or does not contain a PackedScene, and reports the reason.
func instantiate(relative_path: String) -> Node:
	if packages != null:
		var number := _package_number()
		var managed := packages.instantiate_scene(number, relative_path, revision)
		if managed == null:
			push_error(
				"WIRED_PACKAGE_INSTANTIATE_FAILED package=%s path=%s"
				% [
					package_id,
					packages.runtime_path(number, revision, relative_path, artifact_key),
				]
			)
		return managed
	var path := scene_path(relative_path)
	if not ResourceLoader.exists(path):
		push_error(
			"WIRED_PACKAGE_INSTANTIATE_FAILED package=%s path=%s reason=missing"
			% [package_id, path]
		)
		return null
	var packed := ResourceLoader.load(path) as PackedScene
	if packed == null:
		push_error(
			"WIRED_PACKAGE_INSTANTIATE_FAILED package=%s path=%s reason=not_packed_scene"
			% [package_id, path]
		)
		return null
	return packed.instantiate()


## Numeric package id expected by PackagesManager.
func _package_number() -> int:
	if not package_id.is_valid_int():
		push_error(
			"WIRED_PACKAGE_CONTEXT_INVALID_ID package=%s reason=not_numeric"
			% package_id
		)
		return 0
	return package_id.to_int()
