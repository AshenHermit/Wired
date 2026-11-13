extends RefCounted
class_name AssetDeriver

## Runtime form of the raw assets published inside a package artifact.
##
## The runtime only ever sees files exactly as they were published, so nothing
## imported them beforehand: a raw `png`/`ogg` has no imported resource, and
## `ResourceLoader.load()` would fail. This script saves the texture or stream
## next to the raw file and writes an `.import` sidecar that remaps the raw path
## to it. Derived files are runtime-only: they never enter the manifest, the
## hashes or the publish flow, and other file types are left untouched.
##
## Everything here is static: derivation depends on the staging directory and
## the artifact's file list only.

## Raw image extensions that get a runtime texture next to the file.
const TEXTURE_EXTENSIONS := ["png", "jpg", "jpeg", "webp", "bmp"]
## Raw audio extensions and the stream class each one loads into.
const AUDIO_STREAM_TYPES := {
	"wav": "AudioStreamWAV",
	"ogg": "AudioStreamOggVorbis",
	"mp3": "AudioStreamMP3",
}
## Bumped on any change of the derivation rules (extensions, suffixes, sidecar
## contents). The marker of a cached artifact stores it, so an older cache is
## re-derived instead of serving files the new rules no longer describe.
const VERSION := 1

## Extension -> `{kind, suffix, type}`. `kind` selects the derivation helper,
## `suffix` names the derived file next to the raw one and `type` is the
## resource class the sidecar declares. Built once from the tables above, so a
## raw format is declared exactly once.
static var _derivations: Dictionary = {}


## Builds the runtime form of every raw image and audio file of a staged
## revision and writes the `.import` sidecars.
##
## `staging` is the staged artifact directory, `final_dir` the keyed directory
## staging is renamed to afterwards: the sidecar's `path` must point there,
## because it is read after the rename. A file whose derived name is already
## declared by the artifact is skipped, so derivation never overwrites a
## published file.
##
## Returns `{ok: bool, error: String}`. A failure removes everything derived by
## this call unless `cleanup_failed` is false, so a caller that stages into a
## scratch directory can drop it as a whole. An in-place repair of a cached
## artifact passes false: its target is the live directory, where deleting the
## derived files would discard assets that already worked. The repair leaves the
## marker unrewritten after a failure, so the next sync repairs again, and a
## failed follow-up download must not leave the package worse than before.
static func derive(
	staging: String, final_dir: String, filepaths: Array, cleanup_failed: bool = true
) -> Dictionary:
	var table := derivations()
	# Derived names must never replace a file the artifact already declares.
	var declared := {}
	for filepath: Variant in filepaths:
		declared[str(filepath)] = true
	var derived := PackedStringArray()
	for filepath: Variant in filepaths:
		var path := str(filepath)
		var derivation: Dictionary = table.get(path.get_extension().to_lower(), {})
		if derivation.is_empty():
			continue
		var suffix := str(derivation.get("suffix", ""))
		var sidecar_name := path + ".import"
		if declared.has(path + suffix) or declared.has(sidecar_name):
			continue
		var target := staging.path_join(path + suffix)
		var type := str(derivation.get("type", ""))
		var ok := false
		# The dispatch table names the helper; an unknown kind stays a failure
		# instead of falling back to audio.
		match str(derivation.get("kind", "")):
			"texture":
				ok = _derive_texture(staging.path_join(path), target)
			"audio":
				ok = _derive_audio(staging.path_join(path), target, type)
		if not ok:
			if cleanup_failed:
				_remove_files(derived)
			return {"ok": false, "error": "asset_derive_failed:%s" % path}
		# Both names are recorded before the sidecar write, so neither the derived
		# resource nor a half-written sidecar can survive a failure.
		var sidecar := staging.path_join(sidecar_name)
		derived.append(target)
		derived.append(sidecar)
		if not _write_import(sidecar, type, final_dir.path_join(path + suffix)):
			if cleanup_failed:
				_remove_files(derived)
			return {"ok": false, "error": "asset_derive_failed:%s" % path}
	return {"ok": true, "error": ""}


## Extension dispatch table: every raw asset extension mapped to the kind of
## derivation, the suffix of the derived file and the sidecar's resource class.
static func derivations() -> Dictionary:
	if not _derivations.is_empty():
		return _derivations
	var table := {}
	for extension: String in TEXTURE_EXTENSIONS:
		table[extension] = {
			"kind": "texture", "suffix": ".image.res", "type": "ImageTexture"
		}
	for extension: String in AUDIO_STREAM_TYPES:
		table[extension] = {
			"kind": "audio",
			"suffix": ".audio.res",
			"type": AUDIO_STREAM_TYPES[extension],
		}
	_derivations = table
	return _derivations


## Names derived next to the raw files of `filepaths`: `<file><suffix>` and
## `<file>.import`, skipping any name the artifact already declares (the skip
## rule of `derive()`). The `.import` remap is per raw file, so a declared
## derived resource skips the pair.
static func derived_files(filepaths: Array) -> PackedStringArray:
	var table := derivations()
	var declared := {}
	for filepath: Variant in filepaths:
		declared[str(filepath)] = true
	var names := PackedStringArray()
	for filepath: Variant in filepaths:
		var path := str(filepath)
		var derivation: Dictionary = table.get(path.get_extension().to_lower(), {})
		if derivation.is_empty():
			continue
		var suffix := str(derivation.get("suffix", ""))
		if declared.has(path + suffix) or declared.has(path + ".import"):
			continue
		names.append(path + suffix)
		names.append(path + ".import")
	return names


## Saves the texture of a raw image file. Returns false when the bytes are not
## a readable image or the derived resource cannot be written.
static func _derive_texture(source: String, target: String) -> bool:
	var image := Image.load_from_file(source)
	if image == null:
		return false
	return ResourceSaver.save(ImageTexture.create_from_image(image), target) == OK


## Saves the stream of a raw audio file as `type` (`AudioStreamWAV`, ...).
## Returns false when the bytes are not a readable stream of that class.
static func _derive_audio(source: String, target: String, type: String) -> bool:
	var stream: AudioStream = null
	match type:
		"AudioStreamWAV":
			stream = AudioStreamWAV.load_from_file(source)
		"AudioStreamOggVorbis":
			stream = AudioStreamOggVorbis.load_from_file(source)
		"AudioStreamMP3":
			stream = AudioStreamMP3.load_from_file(source)
	if stream == null:
		return false
	return ResourceSaver.save(stream, target) == OK


## Writes the sidecar that makes `ResourceLoader.load()` read the raw path as the
## derived resource. `resource_path` is the final location, because staging is
## renamed after derivation. Every asset keeps the `importer="texture"` marker
## the plan pins for the runtime remap, audio included; `path` selects the
## derived resource at runtime.
static func _write_import(path: String, type: String, resource_path: String) -> bool:
	var handle := FileAccess.open(path, FileAccess.WRITE)
	if handle == null:
		return false
	handle.store_string(
		'[remap]\n\nimporter="texture"\ntype="%s"\npath="%s"\n' % [type, resource_path]
	)
	var write_error := handle.get_error()
	handle.close()
	return write_error == OK


static func _remove_files(paths: PackedStringArray) -> void:
	for path: String in paths:
		DirAccess.remove_absolute(path)
