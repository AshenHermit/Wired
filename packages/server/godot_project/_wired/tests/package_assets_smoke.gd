extends SceneTree

## Headless smoke test for the runtime texture/audio derivation of packages.
##
## A package revision only carries the raw artifact: nothing imported its images
## or sounds before they were published. `PackagesManager._derive_assets` writes
## an `.image.res` / `.audio.res` next to each raw file plus an `.import` sidecar
## that remaps the raw path to it, so `ResourceLoader.load()` works at runtime.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/package_assets_smoke.gd --quit-after 600

const ROOT := "user://asset-test"
const STAGING := ROOT + "/staging"
const FINAL := ROOT + "/final"
const PNG_FILE := "tex.png"
const UPPER_FILE := "Upper.PNG"
const WAV_FILE := "beep.wav"
const SCRIPT_FILE := "scripts/hero.gd"
const BAD_FILE := "bad.png"
const GOOD_FILE := "good.png"
const BLOCKED_FILE := "blocked.png"

var _failures: PackedStringArray = []


func _initialize() -> void:
	# Deferred so the tree is running before the first await.
	_run.call_deferred()


func _run() -> void:
	_remove_tree(ROOT)
	var manager := PackagesManager.new()
	_check(manager.has_method("_derive_assets"), "PackagesManager._derive_assets() is missing")
	if manager.has_method("_derive_assets"):
		_test_derives_texture_and_audio(manager)
		_test_rejects_corrupt_asset(manager)
		_test_sidecar_failure_rolls_back(manager)
		_test_skips_declared_derived_names(manager)
	manager.free()
	_remove_tree(ROOT)
	_finish()


# --- tests ----------------------------------------------------------------


func _test_derives_texture_and_audio(manager: PackagesManager) -> void:
	_remove_tree(ROOT)
	DirAccess.make_dir_recursive_absolute(STAGING)
	_write_texture(STAGING.path_join(PNG_FILE))
	_write_texture(STAGING.path_join(UPPER_FILE))
	_write_wav(STAGING.path_join(WAV_FILE))
	_write_text(STAGING.path_join(SCRIPT_FILE), "extends Node\n")

	var result: Dictionary = manager._derive_assets(
		STAGING, FINAL, [PNG_FILE, UPPER_FILE, WAV_FILE, SCRIPT_FILE]
	)
	_check(
		bool(result.get("ok", false)),
		"deriving a png, an uppercase png and a wav must succeed: %s"
		% result.get("error", "")
	)
	if not bool(result.get("ok", false)):
		return
	_check(
		DirAccess.rename_absolute(STAGING, FINAL) == OK,
		"staging must be publishable as the final revision directory"
	)

	var texture := ResourceLoader.load(FINAL.path_join(PNG_FILE)) as Texture2D
	_check(texture != null, "a derived png must load as a Texture2D")
	if texture != null:
		_check(
			texture.get_width() == 1 and texture.get_height() == 1,
			"the derived texture must stay 1x1, got %dx%d"
			% [texture.get_width(), texture.get_height()]
		)
		var image := texture.get_image()
		_check(image != null, "a derived texture must keep its image")
		if image != null:
			_check(
				image.get_pixel(0, 0).is_equal_approx(Color(1.0, 0.0, 0.0, 1.0)),
				"the derived texture must keep its pixel, got %s" % image.get_pixel(0, 0)
			)
	_check(
		ResourceLoader.load(FINAL.path_join(UPPER_FILE)) is Texture2D,
		"extension matching must be case-insensitive"
	)
	var wav := ResourceLoader.load(FINAL.path_join(WAV_FILE)) as AudioStreamWAV
	_check(wav != null, "a derived wav must load as an AudioStreamWAV")
	if wav != null:
		_check(wav.data.size() > 0, "a derived wav must keep its sample data")
		_check(
			absf(wav.get_length() - 0.1) < 0.005,
			"a derived wav must stay 0.1 s long, got %f" % wav.get_length()
		)
		_check(
			wav.mix_rate == 44100,
			"a derived wav must keep its mix rate, got %d" % wav.mix_rate
		)

	_check_sidecar(
		FINAL.path_join(PNG_FILE + ".import"),
		"ImageTexture",
		FINAL.path_join(PNG_FILE + ".image.res"),
	)
	_check_sidecar(
		FINAL.path_join(UPPER_FILE + ".import"),
		"ImageTexture",
		FINAL.path_join(UPPER_FILE + ".image.res"),
	)
	_check_sidecar(
		FINAL.path_join(WAV_FILE + ".import"),
		"AudioStreamWAV",
		FINAL.path_join(WAV_FILE + ".audio.res"),
	)
	_check(
		FileAccess.file_exists(FINAL.path_join(SCRIPT_FILE)),
		"a non-asset file must be copied to the final revision untouched"
	)
	_check(
		_derived_files(FINAL).size() == 6,
		"only image and audio files may get derived files, got %s"
		% [_derived_files(FINAL)]
	)


func _test_rejects_corrupt_asset(manager: PackagesManager) -> void:
	# Godot's decoders print an error for the deliberately corrupt file; the
	# checks below are what decides the result.
	_remove_tree(ROOT)
	DirAccess.make_dir_recursive_absolute(STAGING)
	_write_texture(STAGING.path_join(GOOD_FILE))
	_write_text(STAGING.path_join(BAD_FILE), "this is not a png")

	var result: Dictionary = manager._derive_assets(
		STAGING, FINAL, [GOOD_FILE, BAD_FILE]
	)
	_check(not bool(result.get("ok", false)), "a corrupt image must fail the derivation")
	_check(
		str(result.get("error", "")) == "asset_derive_failed:" + BAD_FILE,
		"the failure must name the corrupt file, got %s" % result.get("error", "")
	)
	# The caller drops staging on failure, so derivation itself has to leave
	# nothing behind: no resource and no sidecar of an earlier or later file.
	_check(
		_derived_files(STAGING).is_empty(),
		"a failed derivation must leave no derived files in staging, got %s"
		% [_derived_files(STAGING)]
	)
	_check(
		FileAccess.file_exists(STAGING.path_join(BAD_FILE)),
		"a failed derivation must keep the raw staged files for the caller to drop"
	)
	_check(
		not DirAccess.dir_exists_absolute(FINAL),
		"a failed derivation must not create the final revision directory"
	)


## A sidecar that cannot be written must not leave its derived resource behind.
func _test_sidecar_failure_rolls_back(manager: PackagesManager) -> void:
	_remove_tree(ROOT)
	DirAccess.make_dir_recursive_absolute(STAGING)
	_write_texture(STAGING.path_join(BLOCKED_FILE))
	# A directory in the sidecar's place makes the write itself fail.
	DirAccess.make_dir_recursive_absolute(STAGING.path_join(BLOCKED_FILE + ".import"))

	var result: Dictionary = manager._derive_assets(STAGING, FINAL, [BLOCKED_FILE])
	_check(
		not bool(result.get("ok", false)),
		"an unwritable sidecar must fail the derivation"
	)
	_check(
		str(result.get("error", "")) == "asset_derive_failed:" + BLOCKED_FILE,
		"the failure must name the file with the unwritable sidecar, got %s"
		% result.get("error", "")
	)
	_check(
		_derived_files(STAGING).is_empty(),
		"a failed sidecar write must remove the derived resource, got %s"
		% [_derived_files(STAGING)]
	)


## A derived name must never overwrite a file the artifact itself declares.
func _test_skips_declared_derived_names(manager: PackagesManager) -> void:
	_remove_tree(ROOT)
	DirAccess.make_dir_recursive_absolute(STAGING)
	_write_texture(STAGING.path_join(PNG_FILE))
	_write_wav(STAGING.path_join(WAV_FILE))
	_write_text(STAGING.path_join(PNG_FILE + ".import"), "declared sidecar\n")
	_write_text(STAGING.path_join(WAV_FILE + ".audio.res"), "declared audio\n")

	var result: Dictionary = manager._derive_assets(
		STAGING,
		FINAL,
		[PNG_FILE, WAV_FILE, PNG_FILE + ".import", WAV_FILE + ".audio.res"],
	)
	_check(
		bool(result.get("ok", false)),
		"declared derived names must be skipped instead of failing: %s"
		% result.get("error", "")
	)
	_check(
		FileAccess.get_file_as_string(STAGING.path_join(PNG_FILE + ".import"))
		== "declared sidecar\n",
		"a declared sidecar must keep its content"
	)
	_check(
		FileAccess.get_file_as_string(STAGING.path_join(WAV_FILE + ".audio.res"))
		== "declared audio\n",
		"a declared derived resource must keep its content"
	)
	_check(
		not FileAccess.file_exists(STAGING.path_join(PNG_FILE + ".image.res")),
		"a png with a declared sidecar must not get a derived resource"
	)
	_check(
		not FileAccess.file_exists(STAGING.path_join(WAV_FILE + ".import")),
		"a wav with a declared derived resource must not get a sidecar"
	)


# --- fixtures -------------------------------------------------------------


func _write_texture(path: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var image := Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
	image.fill(Color(1.0, 0.0, 0.0, 1.0))
	image.save_png(path)


## A valid 0.1 s mono 16-bit 440 Hz PCM wav.
func _write_wav(path: String) -> void:
	var sample_rate := 44100
	var count := int(sample_rate * 0.1)
	var pcm := PackedByteArray()
	for index in count:
		var value := int(sin(TAU * 440.0 * index / sample_rate) * 12000.0)
		_append_u16(pcm, value)
	var header := "RIFF".to_ascii_buffer()
	_append_u32(header, 36 + pcm.size())
	header.append_array("WAVEfmt ".to_ascii_buffer())
	_append_u32(header, 16)
	_append_u16(header, 1)
	_append_u16(header, 1)
	_append_u32(header, sample_rate)
	_append_u32(header, sample_rate * 2)
	_append_u16(header, 2)
	_append_u16(header, 16)
	header.append_array("data".to_ascii_buffer())
	_append_u32(header, pcm.size())
	header.append_array(pcm)
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_buffer(header)
	file.close()


func _write_text(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(text)
	file.close()


func _append_u16(buffer: PackedByteArray, value: int) -> void:
	buffer.append(value & 0xFF)
	buffer.append((value >> 8) & 0xFF)


func _append_u32(buffer: PackedByteArray, value: int) -> void:
	buffer.append(value & 0xFF)
	buffer.append((value >> 8) & 0xFF)
	buffer.append((value >> 16) & 0xFF)
	buffer.append((value >> 24) & 0xFF)


# --- assertions -----------------------------------------------------------


func _check_sidecar(path: String, type: String, resource_path: String) -> void:
	_check(FileAccess.file_exists(path), "%s must exist" % path)
	if not FileAccess.file_exists(path):
		return
	var text := FileAccess.get_file_as_string(path)
	_check(text.contains("[remap]"), "%s must contain [remap]" % path)
	_check(
		text.contains('importer="texture"'),
		"%s must contain the runtime remap marker importer=\"texture\"" % path
	)
	_check(
		text.contains('type="%s"' % type),
		"%s must declare type=\"%s\"" % [path, type]
	)
	_check(
		text.contains('path="%s"' % resource_path),
		"%s must remap to the absolute path %s" % [path, resource_path]
	)


func _derived_files(path: String) -> PackedStringArray:
	var names := PackedStringArray()
	var dir := DirAccess.open(path)
	if dir == null:
		return names
	for name: String in dir.get_files():
		if name.ends_with(".res") or name.ends_with(".import"):
			names.append(name)
	return names


func _remove_tree(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	# Collect names first: deleting while enumerating can skip entries.
	var names := PackedStringArray()
	dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		names.append(name)
		name = dir.get_next()
	dir.list_dir_end()
	for child_name: String in names:
		var child := path.path_join(child_name)
		if DirAccess.dir_exists_absolute(child):
			_remove_tree(child)
		else:
			DirAccess.remove_absolute(child)
	DirAccess.remove_absolute(path)


func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("PACKAGE_ASSETS_SMOKE_OK")
		quit(0)
		return
	for message: String in _failures:
		printerr("PACKAGE_ASSETS_SMOKE_FAILED %s" % message)
	quit(1)
