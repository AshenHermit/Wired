class_name WiredBakeTool
extends RefCounted

## Headless glTF baking.
##
## Turns a raw `.glb` into a self-contained `.scn` (meshes, skins, animations and
## textures live inside the file) and applies the import preset from its
## `.import` sidecar: animation loop modes and external materials. The result is
## loadable by an exported game, which has no glTF loader.

const LOOP_MODE_OPTION := "settings/loop_mode"
const MATERIAL_ENABLED_OPTION := "use_external/enabled"
const MATERIAL_PATH_OPTION := "use_external/path"


static func run(project_root: String, jobs_path: String) -> Dictionary:
	var results: Array = []
	var errors: Array = []
	var jobs := _read_jobs(project_root, jobs_path)
	for job: Dictionary in jobs:
		var outcome := _bake_job(project_root, job)
		if outcome.has("error"):
			errors.append(outcome["error"])
		else:
			results.append(outcome)
	return {"ok": errors.is_empty(), "results": results, "errors": errors}


static func _read_jobs(project_root: String, jobs_path: String) -> Array:
	var text := FileAccess.get_file_as_string(_resolve(project_root, jobs_path))
	if text.is_empty():
		return []
	var parsed: Variant = JSON.parse_string(text)
	if not parsed is Dictionary:
		return []
	var jobs: Variant = (parsed as Dictionary).get("jobs", [])
	return jobs if jobs is Array else []


static func _bake_job(project_root: String, job: Dictionary) -> Dictionary:
	var source_rel := str(job.get("source", ""))
	var output_rel := str(job.get("output", ""))
	if source_rel.is_empty() or output_rel.is_empty():
		return _job_error(source_rel, "invalid_job", "у задания нет source или output")
	var source_path := _resolve(project_root, source_rel)
	var output_path := _resolve(project_root, output_rel)

	var document := GLTFDocument.new()
	var state := GLTFState.new()
	var append_error := document.append_from_file(source_path, state)
	if append_error != OK:
		return _job_error(source_rel, "gltf_import_failed", error_string(append_error))
	var scene := document.generate_scene(state)
	if scene == null:
		return _job_error(source_rel, "gltf_import_failed", "generate_scene вернул null")

	var preset := _apply_preset(scene, str(job.get("preset", "")), project_root)
	var preset_error: Dictionary = preset.get("error", {})
	if not preset_error.is_empty():
		scene.free()
		preset_error["file"] = source_rel
		return {"error": preset_error}

	var packed := PackedScene.new()
	var pack_error := packed.pack(scene)
	if pack_error != OK:
		scene.free()
		return _job_error(source_rel, "pack_failed", error_string(pack_error))
	DirAccess.make_dir_recursive_absolute(output_path.get_base_dir())
	var save_error := ResourceSaver.save(packed, output_path)
	scene.free()
	if save_error != OK:
		return _job_error(source_rel, "save_failed", error_string(save_error))
	return {
		"output": output_rel,
		"size": FileAccess.get_file_as_bytes(output_path).size(),
		"animations": preset["animations"],
		"materials": preset["materials"],
		"warnings": preset["warnings"],
	}


static func _job_error(source_rel: String, reason: String, message: String) -> Dictionary:
	return {"error": {"file": source_rel, "reason": reason, "message": message}}


## Applies `_subresources` from the import preset to the generated scene.
static func _apply_preset(scene: Node, preset_text: String, project_root: String) -> Dictionary:
	var animations := PackedStringArray()
	var materials := PackedStringArray()
	var warnings := PackedStringArray()
	var result := {"animations": animations, "materials": materials, "warnings": warnings, "error": {}}
	if preset_text.is_empty():
		return result
	var subresources := _block_after(preset_text, "_subresources")
	if subresources.is_empty():
		return result

	var animation_entries := _entries(_block_after(subresources, "animations"))
	if not animation_entries.is_empty():
		var players := _find_nodes(scene, "AnimationPlayer")
		for name: String in animation_entries.keys():
			var loop_mode := _int_value(animation_entries[name], LOOP_MODE_OPTION, -1)
			if loop_mode < 0:
				continue
			var animation: Animation = null
			for player: AnimationPlayer in players:
				animation = player.get_animation(name)
				if animation != null:
					break
			if animation == null:
				warnings.append("анимация не найдена в сцене: %s" % name)
				continue
			animation.loop_mode = loop_mode as Animation.LoopMode
			animations.append(name)

	var material_entries := _entries(_block_after(subresources, "materials"))
	if not material_entries.is_empty():
		for key: String in material_entries.keys():
			var body: String = material_entries[key]
			if not _bool_value(body, MATERIAL_ENABLED_OPTION, false):
				continue
			# Godot writes `uid://` into `use_external/path` and keeps a `res://`
			# fallback next to it; a throwaway project has no uid cache.
			var path := _string_value(body, "use_external/fallback_path")
			if path.is_empty():
				path = _string_value(body, MATERIAL_PATH_OPTION)
			if path.is_empty():
				continue
			var material_path := _resolve(project_root, path)
			if not ResourceLoader.exists(material_path):
				result["error"] = {"reason": "material_missing", "message": "материал не найден: %s" % path}
				return result
			var loaded := load(material_path) as Material
			if loaded == null:
				result["error"] = {
					"reason": "material_missing",
					"message": "файл пресета не материал: %s" % path,
				}
				return result
			# Внешний ресурс попал бы в .scn как путь res://, который в рантайме
			# недоступен: материал и его текстуры встраиваются в файл.
			var embedded := _embed(loaded, {}) as Material
			if not _apply_material(scene, key, embedded):
				warnings.append("материал не найден в сцене: %s" % key)
				continue
			materials.append(key)
	return result


static func _apply_material(scene: Node, key: String, material: Material) -> bool:
	var found := false
	for node: Node in _find_nodes(scene, "MeshInstance3D"):
		var mesh := node as MeshInstance3D
		var surface_count := mesh.mesh.get_surface_count() if mesh.mesh != null else 0
		for surface in surface_count:
			var current := mesh.get_active_material(surface)
			if current == null or current.resource_name != key:
				continue
			mesh.set_surface_override_material(surface, material)
			found = true
	return found


## Duplicates a resource tree and clears every resource path so saving the scene
## embeds the data instead of referencing files that do not exist at runtime.
static func _embed(resource: Resource, seen: Dictionary) -> Resource:
	if resource == null:
		return null
	if seen.has(resource):
		return seen[resource]
	var copy := resource.duplicate(true)
	seen[resource] = copy
	copy.resource_path = ""
	for property: Dictionary in copy.get_property_list():
		if not (int(property["usage"]) & PROPERTY_USAGE_STORAGE):
			continue
		var value: Variant = copy.get(property["name"])
		if value is Resource:
			copy.set(property["name"], _embed(value, seen))
		elif value is Array:
			var items: Array = value
			for index in items.size():
				if items[index] is Resource:
					items[index] = _embed(items[index], seen)
	return copy


static func _find_nodes(root: Node, node_class: String) -> Array:
	var found: Array = []
	if root.is_class(node_class):
		found.append(root)
	for child: Node in root.get_children():
		found.append_array(_find_nodes(child, node_class))
	return found


## Resolves a project-relative or `res://` path against [param project_root].
## Absolute filesystem paths (the tool's own `jobs.json`) are used as-is, while
## `res://` paths are re-rooted so a `user://` sandbox can load them.
static func _resolve(project_root: String, path: String) -> String:
	if (
		path.is_absolute_path()
		and not path.begins_with("res://")
		and not path.begins_with("user://")
	):
		return path
	if path.begins_with("res://"):
		path = path.substr("res://".length())
	return project_root.path_join(path)


## Body of the dictionary that follows a key, in either a config-file section
## (`_subresources={`) or a Variant dictionary (`"animations": {`).
static func _block_after(text: String, key: String) -> String:
	for marker: String in ["\"" + key + "\":", key + "="]:
		var index := text.find(marker)
		if index < 0:
			continue
		var open := text.find("{", index + marker.length())
		if open >= 0:
			return _block_body(text, open)
	return ""


## Text between the braces opened at [param open_index] (quotes are respected).
static func _block_body(text: String, open_index: int) -> String:
	var depth := 0
	var in_string := false
	var escaped := false
	for index in range(open_index, text.length()):
		var character := text[index]
		if in_string:
			if escaped:
				escaped = false
			elif character == "\\":
				escaped = true
			elif character == "\"":
				in_string = false
			continue
		if character == "\"":
			in_string = true
		elif character == "{":
			depth += 1
		elif character == "}":
			depth -= 1
			if depth == 0:
				return text.substr(open_index + 1, index - open_index - 1)
	return ""


## Top-level `"<name>": {...}` entries of a block.
static func _entries(block: String) -> Dictionary:
	var entries := {}
	var index := 0
	while index < block.length():
		var quote := block.find("\"", index)
		if quote < 0:
			break
		var closing := block.find("\"", quote + 1)
		if closing < 0:
			break
		var key := block.substr(quote + 1, closing - quote - 1)
		var open := block.find("{", closing)
		if open < 0:
			break
		var body := _block_body(block, open)
		entries[key] = body
		index = open + body.length() + 2
	return entries


static func _option_text(body: String, key: String) -> String:
	var marker := "\"" + key + "\":"
	var index := body.find(marker)
	if index < 0:
		return ""
	var rest := body.substr(index + marker.length()).strip_edges()
	var stop := rest.find("\n")
	if stop < 0:
		stop = rest.length()
	return rest.substr(0, stop).strip_edges().trim_suffix(",").strip_edges()


static func _int_value(body: String, key: String, fallback: int) -> int:
	var text := _option_text(body, key)
	if text.is_empty() or not text.is_valid_int():
		return fallback
	return text.to_int()


static func _bool_value(body: String, key: String, fallback: bool) -> bool:
	var text := _option_text(body, key)
	if text == "true":
		return true
	if text == "false":
		return false
	return fallback


static func _string_value(body: String, key: String) -> String:
	var text := _option_text(body, key)
	if not text.begins_with("\""):
		return ""
	var end := text.find("\"", 1)
	if end < 0:
		return ""
	return text.substr(1, end - 1)
