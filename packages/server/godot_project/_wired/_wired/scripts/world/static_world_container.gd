extends Node
class_name StaticWorldContainer

## Local-only owner of the static scenes that packages register for a room.
##
## Static content is built from `WiredPackageRegistry` descriptors and never
## replicated: every peer instantiates the same scenes from the same registry.
## Each package root is tagged with `_wired_package_id` (its owning package) and
## `_wired_registered = true`: the tags tell registry-owned roots from nodes
## authored in `main.tscn`, so `clear()` replaces exactly the children this
## container created and nothing generic replaces a live root behind its back.
##
## Spawn markers are `Marker2D`/`Marker3D` nodes in the `wired_player_spawn`
## group or with `wired_player_spawn = true` metadata. They are collected
## recursively in tree order and indexed across both dimensions: index `i` is
## the same marker for both getters, a `Marker3D` projects to `Vector2(x, y)`
## and a `Marker2D` lifts to `Vector3(x, y, 0)`. An out-of-range index or a
## world without markers returns the zero vector.

## Kept as local names for readability; the values live in `WiredProtocol`, so a
## producer and a consumer of the metadata cannot drift apart.
const META_PACKAGE_ID := WiredProtocol.META_PACKAGE_ID
const META_REGISTERED := WiredProtocol.META_REGISTERED
const META_SPAWN := "wired_player_spawn"
const SPAWN_GROUP := &"wired_player_spawn"

var _registry: WiredPackageRegistry = null


## Attaches the registry this container builds from. Replacing the registry
## takes effect on the next `rebuild()`.
func setup(registry: WiredPackageRegistry) -> void:
	_registry = registry


## Replaces every registry-owned child with the current static registrations,
## in the registry's deterministic order. A registration without a context or a
## scene that fails to load is skipped: one broken package must not empty the
## rest of the world.
func rebuild() -> void:
	var prepared := prepare_rebuild()
	if bool(prepared.get("ok", false)):
		commit_prepared(prepared)


## Instantiates the current registry into an unattached replacement set. The
## active children remain in the tree and continue participating in physics
## until `commit_prepared()` is called.
func prepare_rebuild() -> Dictionary:
	var replacements: Array[Node] = []
	if _registry == null:
		return {"ok": true, "replacements": replacements}
	for descriptor: Dictionary in _registry.get_static_scenes():
		var package_id := str(descriptor.get("package_id", ""))
		var path := str(descriptor.get("path", ""))
		var context := _registry.get_context(package_id)
		if context == null:
			push_warning(
				"WIRED_STATIC_WORLD_SKIPPED package=%s path=%s reason=no_context"
				% [package_id, path]
			)
			continue
		var instance := context.instantiate(path)
		if instance == null:
			# WiredPackageContext already reported why it failed.
			continue
		instance.set_meta(META_PACKAGE_ID, package_id)
		instance.set_meta(META_REGISTERED, true)
		replacements.append(instance)
	return {"ok": true, "replacements": replacements}


## Adds the prepared roots before removing the active roots, so there is no
## empty physics window during a package reload.
func commit_prepared(prepared: Dictionary) -> bool:
	if not bool(prepared.get("ok", false)):
		return false
	var replacements: Variant = prepared.get("replacements", [])
	if typeof(replacements) != TYPE_ARRAY:
		return false
	for instance: Node in replacements:
		if not is_instance_valid(instance) or instance.get_parent() != null:
			return false
	var previous: Array[Node] = []
	for child: Node in get_children():
		if bool(child.get_meta(META_REGISTERED, false)):
			previous.append(child)
	for instance: Node in replacements:
		add_child(instance)
	for child: Node in previous:
		if is_instance_valid(child):
			remove_child(child)
			child.free()
	return true


## Releases a prepared set when the new revision cannot be committed.
func discard_prepared(prepared: Dictionary) -> void:
	var replacements: Variant = prepared.get("replacements", [])
	if typeof(replacements) != TYPE_ARRAY:
		return
	for instance: Node in replacements:
		if is_instance_valid(instance) and instance.get_parent() == null:
			instance.free()


## Removes only the children created by `rebuild()`. Nodes authored directly in
## the static world scene (a camera or an environment, for example) are kept.
func clear() -> void:
	for child: Node in get_children():
		if bool(child.get_meta(META_REGISTERED, false)):
			# Detach first so a rebuild in the same frame does not see the old
			# nodes while `queue_free()` waits for the end of the frame.
			remove_child(child)
			child.queue_free()


## Spawn position of the `index`-th marker in the 2D plane.
func get_spawn_position_2d(index: int = 0) -> Vector2:
	var marker := _spawn_marker(index)
	var marker_2d := marker as Marker2D
	if marker_2d != null:
		return marker_2d.global_position
	var marker_3d := marker as Marker3D
	if marker_3d != null:
		return Vector2(marker_3d.global_position.x, marker_3d.global_position.y)
	return Vector2.ZERO


## Spawn position of the `index`-th marker in 3D space.
func get_spawn_position_3d(index: int = 0) -> Vector3:
	var marker := _spawn_marker(index)
	var marker_3d := marker as Marker3D
	if marker_3d != null:
		return marker_3d.global_position
	var marker_2d := marker as Marker2D
	if marker_2d != null:
		return Vector3(marker_2d.global_position.x, marker_2d.global_position.y, 0.0)
	return Vector3.ZERO


## The `index`-th spawn marker in tree order, or `null` when there is none.
func _spawn_marker(index: int) -> Node:
	if index < 0:
		return null
	var found := 0
	for node: Node in find_children("*", "", true, false):
		if not _is_spawn_marker(node):
			continue
		if found == index:
			return node
		found += 1
	return null


## A marker counts when it is a 2D/3D marker and opts in through either the
## group or the metadata; the group survives scene instancing, the metadata is
## easier to spot in the inspector.
func _is_spawn_marker(node: Node) -> bool:
	if not (node is Marker2D or node is Marker3D):
		return false
	return node.is_in_group(SPAWN_GROUP) or bool(node.get_meta(META_SPAWN, false))
