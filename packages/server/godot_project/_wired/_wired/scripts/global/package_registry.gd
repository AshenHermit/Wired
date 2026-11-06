extends Node
class_name WiredPackageRegistry

## Deterministic registry of everything packages declare for a room.
##
## The registry is pure data: package entries fill it, and the static world,
## player manager and dynamic world read sorted descriptors from it. Ordering
## is always `package_id` ascending, then `order`, then the registration index,
## so every peer builds the same world from the same packages.
##
## Action and dynamic type names are qualified as `<package_id>/<local_name>`;
## a local name never leaves its package namespace.

const KIND_STATIC := "static"
const KIND_PLAYER := "player"
const KIND_DYNAMIC := "dynamic"
const KIND_MAIN := "main"

# Full descriptors including the internal `kind` discriminator. Public getters
# strip it so callers only see the documented descriptor shape.
var _entries: Array[Dictionary] = []
# package id -> resolved context of the applied revision
var _contexts: Dictionary = {}


## Stores the context of an applied package revision. Re-registering the same
## package replaces the previous context.
func register_context(package_id: String, context: WiredPackageContext) -> void:
	if package_id.is_empty():
		push_warning("WIRED_PACKAGE_REGISTRY_INVALID_CONTEXT package=<empty>")
		return
	_contexts[package_id] = context


func get_context(package_id: String) -> WiredPackageContext:
	var context: Variant = _contexts.get(package_id)
	return context as WiredPackageContext


## Copies every entry of a registration into the registry, stamping the
## registration's package id and qualifying dynamic types.
func add_registration(registration: WiredPackageRegistration) -> void:
	if registration == null:
		push_warning("WIRED_PACKAGE_REGISTRY_INVALID_REGISTRATION reason=null")
		return
	if registration.package_id.is_empty():
		push_warning("WIRED_PACKAGE_REGISTRY_INVALID_REGISTRATION reason=empty_package_id")
		return
	for entry: Dictionary in registration._entries:
		var descriptor := entry.duplicate(true)
		descriptor["package_id"] = registration.package_id
		if str(descriptor.get("kind", "")) == KIND_DYNAMIC:
			descriptor["qualified_type"] = resolve_action(
				registration.package_id, str(descriptor.get("local_type", ""))
			)
		_entries.append(descriptor)


## Drops every entry and the context of one package. Other packages are kept,
## so a revision reload never disturbs unrelated content.
func clear_package(package_id: String) -> void:
	_contexts.erase(package_id)
	var remaining: Array[Dictionary] = []
	for entry: Dictionary in _entries:
		if str(entry.get("package_id", "")) != package_id:
			remaining.append(entry)
	_entries = remaining


func get_static_scenes() -> Array[Dictionary]:
	return _sorted_descriptors(KIND_STATIC)


func get_player_components() -> Array[Dictionary]:
	return _sorted_descriptors(KIND_PLAYER)


func get_dynamic_entities() -> Array[Dictionary]:
	return _sorted_descriptors(KIND_DYNAMIC)


func get_main_scenes() -> Array[Dictionary]:
	return _sorted_descriptors(KIND_MAIN)


func get_main_scene() -> Dictionary:
	var scenes := get_main_scenes()
	return scenes[0] if not scenes.is_empty() else {}


## Dynamic descriptor of a qualified type, or an empty dictionary.
func find_dynamic_entity(qualified_type: String) -> Dictionary:
	for descriptor: Dictionary in get_dynamic_entities():
		if str(descriptor.get("qualified_type", "")) == qualified_type:
			return descriptor
	return {}


## Qualifies a package-local name. Action names and dynamic types share this
## namespace rule.
func resolve_action(package_id: String, local_name: String) -> String:
	return "%s/%s" % [package_id, local_name]


func _sorted_descriptors(kind: String) -> Array[Dictionary]:
	var descriptors: Array[Dictionary] = []
	for entry: Dictionary in _entries:
		if str(entry.get("kind", "")) != kind:
			continue
		var descriptor := entry.duplicate(true)
		descriptor.erase("kind")
		descriptors.append(descriptor)
	descriptors.sort_custom(_compare_descriptors)
	return descriptors


## Explicit comparator rather than relying on sort stability, so package order
## is identical on every peer. Package ids are numeric on the wire (`"12"`), so
## they compare as numbers: a string compare put `"10"` before `"9"`. A
## non-numeric id (a test fixture) still sorts deterministically, after the
## numeric ones, so the order never depends on registration timing.
func _compare_descriptors(left: Dictionary, right: Dictionary) -> bool:
	var package_order := _compare_package_ids(
		str(left.get(WiredProtocol.KEY_PACKAGE_ID, "")),
		str(right.get(WiredProtocol.KEY_PACKAGE_ID, "")),
	)
	if package_order != 0:
		return package_order < 0
	var left_order := int(left.get(WiredProtocol.KEY_ORDER, 0))
	var right_order := int(right.get(WiredProtocol.KEY_ORDER, 0))
	if left_order != right_order:
		return left_order < right_order
	return int(left.get("registration_index", 0)) < int(
		right.get("registration_index", 0)
	)


## Negative when `left` sorts first, positive when `right` does, 0 when equal.
static func _compare_package_ids(left: String, right: String) -> int:
	if left == right:
		return 0
	var left_numeric := left.is_valid_int()
	var right_numeric := right.is_valid_int()
	if left_numeric and right_numeric:
		var left_value := left.to_int()
		var right_value := right.to_int()
		return -1 if left_value < right_value else 1
	if left_numeric != right_numeric:
		# Numeric package ids first, so the order of real packages never depends
		# on which non-numeric ids a fixture happens to register.
		return -1 if left_numeric else 1
	return -1 if left < right else 1
