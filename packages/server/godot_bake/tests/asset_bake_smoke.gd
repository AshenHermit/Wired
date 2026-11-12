extends SceneTree

## Smoke test for the headless bake tool.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_bake \
##     --script res://tests/asset_bake_smoke.gd --quit-after 600

## Preloaded instead of relying on `class_name`: a headless `--script` run does
## not populate the global script class cache.
const WiredBakeToolScript := preload("res://bake_tool.gd")

const ROOT := "user://asset_bake_smoke"

const PRESET_TEXT := """[remap]

importer="scene"

[params]

_subresources={
"animations": {
"Idle": {
"settings/loop_mode": 1
}
},
"materials": {
"surface_a": {
"use_external/enabled": true,
"use_external/path": "res://packages/hero/preset_mat.tres"
}
}
}
"""

var _failures: PackedStringArray = []
var _passed := 0


func _initialize() -> void:
	_remove_tree(ROOT)
	DirAccess.make_dir_recursive_absolute(ROOT + "/packages/hero")

	_test_bakes_with_preset()
	_test_reports_missing_material()
	_test_continues_after_broken_job()

	_remove_tree(ROOT)
	if _failures.is_empty():
		print("OK %d checks" % _passed)
		quit(0)
	else:
		print("FAILED %s" % ", ".join(_failures))
		quit(1)


func _test_bakes_with_preset() -> void:
	var problems: Array = []
	_make_glb(ROOT + "/packages/hero/model.glb")
	_write_material(ROOT + "/packages/hero/preset_mat.tres")
	_write(
		ROOT + "/jobs.json",
		JSON.stringify(
			{
				"jobs": [
					{
						"source": "packages/hero/model.glb",
						"output": "packages/hero/model.glb.scn",
						"preset": PRESET_TEXT,
					}
				]
			}
		)
	)

	var result: Dictionary = WiredBakeToolScript.run(ROOT, "jobs.json")
	_expect(problems, result.get("ok", false), "запекание завершилось ошибкой: %s" % [result.get("errors", [])])
	_expect(problems, result.get("results", []).size() == 1, "ожидался один результат")

	var baked_path := ROOT.path_join(str(result["results"][0]["output"]))
	var packed := ResourceLoader.load(baked_path) as PackedScene
	_expect(problems, packed != null, "запечённый файл не загружается как PackedScene")
	if packed == null:
		_report("bakes a glb with the import preset", problems)
		return

	var scene := packed.instantiate()
	var player := scene.get_node_or_null("AnimationPlayer") as AnimationPlayer
	var idle: Animation = player.get_animation("Idle") if player != null else null
	_expect(problems, idle != null and idle.loop_mode == Animation.LOOP_LINEAR, "loop_mode не применён")

	var body := scene.get_node_or_null("Body") as MeshInstance3D
	var applied := body.get_active_material(0) as StandardMaterial3D if body != null else null
	_expect(
		problems,
		applied != null and applied.albedo_color == Color(1, 0, 0),
		"внешний материал не применён"
	)
	# Загруженный сабресурс получает путь вида `<scn>::<name>`; внешний файл
	# пресета выглядел бы как путь к `.tres`.
	_expect(
		problems,
		applied != null and applied.resource_path.contains("model.glb.scn::"),
		"материал не встроен в .scn: %s" % [applied.resource_path if applied != null else "<null>"]
	)

	var bytes := FileAccess.get_file_as_bytes(baked_path)
	_expect(
		problems,
		not _contains_bytes(bytes, "preset_mat.tres"),
		"в .scn осталась ссылка на .tres"
	)
	_expect(problems, not _contains_bytes(bytes, "hero/model.glb"), "в .scn осталась ссылка на .glb")
	scene.free()
	_report("bakes a glb with the import preset", problems)


func _test_reports_missing_material() -> void:
	var problems: Array = []
	_write(
		ROOT + "/missing.json",
		JSON.stringify(
			{
				"jobs": [
					{
						"source": "packages/hero/model.glb",
						"output": "packages/hero/missing.glb.scn",
						"preset": PRESET_TEXT.replace("preset_mat.tres", "missing.tres"),
					}
				]
			}
		)
	)
	var result: Dictionary = WiredBakeToolScript.run(ROOT, "missing.json")
	var errors: Array = result.get("errors", [])
	_expect(
		problems,
		errors.size() == 1 and str(errors[0].get("reason", "")) == "material_missing",
		"ожидалась ошибка material_missing, получено %s" % [errors]
	)
	_report("reports a missing preset material", problems)


func _test_continues_after_broken_job() -> void:
	var problems: Array = []
	_write(ROOT + "/packages/hero/broken.glb", "not a glb")
	_write(
		ROOT + "/broken.json",
		JSON.stringify(
			{
				"jobs": [
					{
						"source": "packages/hero/broken.glb",
						"output": "packages/hero/broken.glb.scn",
						"preset": "",
					},
					{
						"source": "packages/hero/model.glb",
						"output": "packages/hero/second.glb.scn",
						"preset": "",
					},
				]
			}
		)
	)
	var result: Dictionary = WiredBakeToolScript.run(ROOT, "broken.json")
	_expect(
		problems,
		result.get("results", []).size() == 1 and result.get("errors", []).size() == 1,
		"одна ошибка прервала остальные задания: %s" % [result]
	)
	_expect(
		problems,
		FileAccess.file_exists(ROOT + "/packages/hero/second.glb.scn"),
		"второе задание не запечено"
	)
	_report("one broken job does not stop the others", problems)


func _make_glb(path: String) -> void:
	var root := Node3D.new()
	root.name = "Model"
	var mesh := MeshInstance3D.new()
	mesh.name = "Body"
	var box := BoxMesh.new()
	mesh.mesh = box
	var material := StandardMaterial3D.new()
	material.resource_name = "surface_a"
	material.albedo_color = Color(0.1, 0.2, 0.3)
	mesh.set_surface_override_material(0, material)
	root.add_child(mesh)
	mesh.owner = root
	var player := AnimationPlayer.new()
	player.name = "AnimationPlayer"
	var animation := Animation.new()
	animation.length = 1.0
	animation.loop_mode = Animation.LOOP_NONE
	var track := animation.add_track(Animation.TYPE_VALUE)
	animation.track_set_path(track, NodePath("Body:position"))
	animation.track_insert_key(track, 0.0, Vector3.ZERO)
	var library := AnimationLibrary.new()
	library.add_animation("Idle", animation)
	player.add_animation_library("", library)
	root.add_child(player)
	player.owner = root
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	document.append_from_scene(root, state)
	document.write_to_filesystem(state, ProjectSettings.globalize_path(path))
	root.free()


func _write_material(path: String) -> void:
	var material := StandardMaterial3D.new()
	material.resource_name = "surface_a"
	material.albedo_color = Color(1, 0, 0)
	ResourceSaver.save(material, path)


func _expect(problems: Array, condition: bool, message: String) -> void:
	if condition:
		_passed += 1
	else:
		problems.append(message)


func _report(name: String, problems: Array) -> void:
	if not problems.is_empty():
		_failures.append("%s: %s" % [name, ", ".join(problems)])


func _contains_bytes(bytes: PackedByteArray, needle: String) -> bool:
	return bytes.get_string_from_utf8().find(needle) >= 0


func _write(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(text)
	file.close()


func _remove_tree(path: String) -> void:
	if not DirAccess.dir_exists_absolute(path):
		return
	var dir := DirAccess.open(path)
	if dir == null:
		return
	dir.include_hidden = true
	var names := PackedStringArray()
	dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		if name != "." and name != "..":
			names.append(name)
		name = dir.get_next()
	dir.list_dir_end()
	for child in names:
		_remove_tree(path.path_join(child))
	DirAccess.remove_absolute(path)
