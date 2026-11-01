extends RefCounted
class_name WiredWorldSnapshot

## Comparison rules for the server-authored late-join snapshot.
##
## The snapshot carries the server's applied package map
## `{package_id: {revision, artifact_key}}`. A client may only apply the player
## and dynamic records when its own applied map is identical: the same revision
## can still resolve to different component sets after a dependency publish,
## because the artifact key embeds the resolved dependency closure.
##
## Applying a snapshot with a mismatched map would build players from a
## different registry than the server used, which is the defect this guard
## exists to prevent. The client defers, requests a fresh snapshot, and retries
## after the next package application.


## True when both maps cover exactly the same package ids with the same
## revision and artifact key. Keys may arrive as ints or strings.
static func packages_match(remote: Dictionary, local: Dictionary) -> bool:
	var normalized_remote := _normalize(remote)
	var normalized_local := _normalize(local)
	if normalized_remote.size() != normalized_local.size():
		return false
	for package_id: String in normalized_remote:
		if not normalized_local.has(package_id):
			return false
		var remote_entry: Dictionary = normalized_remote[package_id]
		var local_entry: Dictionary = normalized_local[package_id]
		if int(remote_entry.get("revision", 0)) != int(local_entry.get("revision", 0)):
			return false
		if (
			str(remote_entry.get("artifact_key", ""))
			!= str(local_entry.get("artifact_key", ""))
		):
			return false
	return true


static func _normalize(packages: Dictionary) -> Dictionary:
	var result := {}
	for key: Variant in packages:
		var value: Variant = packages[key]
		if typeof(value) != TYPE_DICTIONARY:
			continue
		var entry: Dictionary = value
		result[str(key)] = {
			"revision": int(entry.get("revision", 0)),
			"artifact_key": str(entry.get("artifact_key", "")),
		}
	return result
