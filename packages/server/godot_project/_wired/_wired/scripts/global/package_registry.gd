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
## is identical on every peer.
func _compare_descriptors(left: Dictionary, right: Dictionary) -> bool:
	var left_package := str(left.get("package_id", ""))
	var right_package := str(right.get("package_id", ""))
	if left_package != right_package:
		return left_package < right_package
	var left_order := int(left.get("order", 0))
	var right_order := int(right.get("order", 0))
	if left_order != right_order:
		return left_order < right_order
	return int(left.get("registration_index", 0)) < int(
		right.get("registration_index", 0)
	)
