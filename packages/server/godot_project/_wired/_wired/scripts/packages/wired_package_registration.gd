extends RefCounted
class_name WiredPackageRegistration

## One package's declarative content registration.
##
## A package entry (`wired_package.gd`) extends this class and calls the
## `add_*` helpers from `register()`. The registration only collects entries;
## `WiredPackageRegistry` turns them into sorted descriptors after the entry
## has been fully registered.

const DEFAULT_AUTHORITY := "server"
const KIND_STATIC := "static"
const KIND_PLAYER := "player"
const KIND_DYNAMIC := "dynamic"

## Set by PackageEntryLoader before `register()` is called.
var package_id: String = ""
## Resolved revision context of the package, set by the loader.
var context: WiredPackageContext = null

# Registration-local entries. `registration_index` preserves the author's call
# order for entries that share the same order value.
var _entries: Array[Dictionary] = []


## Overridden by a package entry. The default keeps a content-less package valid.
func register(_registry: WiredPackageRegistry) -> void:
	pass


func add_static_scene(relative_path: String, options: Dictionary = {}) -> void:
	_entries.append(_entry(KIND_STATIC, relative_path, options))


func add_player_component(relative_path: String, options: Dictionary = {}) -> void:
	_entries.append(_entry(KIND_PLAYER, relative_path, options))


func add_dynamic_entity(
	local_type: String, relative_path: String, options: Dictionary = {}
) -> void:
	var entry := _entry(KIND_DYNAMIC, relative_path, options)
	entry["local_type"] = local_type
	_entries.append(entry)


## Builds the descriptor shared by every content kind. The package id and the
## qualified dynamic type are added by the registry, because the entry may be
## registered before `package_id` is known.
func _entry(kind: String, relative_path: String, options: Dictionary) -> Dictionary:
	var authority := str(options.get("authority", DEFAULT_AUTHORITY))
	if authority.is_empty():
		authority = DEFAULT_AUTHORITY
	return {
		"kind": kind,
		"path": relative_path,
		"order": int(options.get("order", 0)),
		"authority": authority,
		"local_only": bool(options.get("local_only", false)),
		"options": options.duplicate(true),
		"registration_index": _entries.size(),
	}
