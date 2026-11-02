extends SceneTree

## Headless smoke test for ArtifactStore's slug-based on-disk layout.
##
## Packages live under `<packages root>/<slug>/<revision>-<artifact key>/`, so
## the store must resolve a folder only from a valid slug and must never fall
## back to the numeric package id. The numeric id stays the identity everywhere
## else (state dictionaries, snapshots, registry); this suite only owns paths.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/artifact_store_smoke.gd --quit-after 600

const ROOT := "user://artifact_store_smoke"

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	# Deferred so the tree is running before any filesystem work.
	_run.call_deferred()


func _run() -> void:
	_cleanup()
	_test_paths_are_slug_based()
	_test_invalid_slug_is_rejected()
	_test_stage_swap_and_prune()
	_test_highest_revision_is_scoped_to_the_slug()
	_cleanup()
	_finish()


func _test_paths_are_slug_based() -> void:
	var store := ArtifactStore.new(func() -> String: return ROOT)
	_expect(store.package_dir("hero") == ROOT + "/hero", "package dir uses slug")
	_expect(
		store.revision_dir("hero", 2, "abc") == ROOT + "/hero/2-abc",
		"revision dir uses slug",
	)
	_expect(
		store.revision_dir("hero", 2, "") == ROOT + "/hero/2",
		"an empty artifact key selects the plain revision directory",
	)
	_expect(
		store.staging_dir("hero") == ROOT + "/hero/.staging",
		"the staging directory lives inside the slug directory",
	)


func _test_invalid_slug_is_rejected() -> void:
	var store := ArtifactStore.new(func() -> String: return ROOT)
	# A sibling of the packages root must exist for the no-touch assertions.
	DirAccess.make_dir_recursive_absolute(ROOT + "/hero/1-abc")
	for slug: String in ["", "../escape", "Hero", "hero-one"]:
		_expect(store.package_dir(slug) == "", "%s must not resolve to a directory" % slug)
		_expect(store.highest_revision(slug) == 0, "%s must not enumerate the root" % slug)
		_expect(
			store.revision_dir(slug, 1, "abc") == "",
			"%s must not resolve a revision directory" % slug,
		)
		_expect(
			store.staging_dir(slug) == "",
			"%s must not resolve a staging directory" % slug,
		)
		_expect(
			not store.stage(slug, []).is_empty(),
			"%s must fail staging instead of writing outside the root" % slug,
		)
		_expect(
			not store.swap(slug, 1, "abc").is_empty(),
			"%s must fail the swap instead of renaming outside the root" % slug,
		)
		store.prune(slug, 1, "1-abc")
		store.remove_tree(store.package_dir(slug))
	_expect(
		DirAccess.dir_exists_absolute(ROOT + "/hero/1-abc"),
		"an invalid slug must not delete the packages root",
	)


func _test_stage_swap_and_prune() -> void:
	_cleanup()
	var store := ArtifactStore.new(func() -> String: return ROOT)
	var files: Array = [_file("scripts/hero.gd", "hero-v1")]
	_expect(store.stage("hero", files) == "", "a valid slug must stage the artifact")
	_expect(
		DirAccess.dir_exists_absolute(ROOT + "/hero/.staging"),
		"staging must stay inside the slug directory",
	)
	_expect(store.swap("hero", 1, "aaa") == "", "the staged artifact must swap in")
	_expect(
		FileAccess.get_file_as_string(ROOT + "/hero/1-aaa/scripts/hero.gd")
		== "hero-v1",
		"the swapped artifact must serve the staged bytes",
	)

	store.stage("hero", [_file("scripts/hero.gd", "hero-v2")])
	store.swap("hero", 2, "bbb")
	store.stage("hero", [_file("scripts/hero.gd", "hero-v3")])
	store.swap("hero", 3, "ccc")
	_expect(
		store.highest_revision("hero") == 3,
		"the store must report the highest revision of the slug",
	)
	_expect(
		store.highest_revision("hero", 3) == 2,
		"highest_revision must ignore the excluded revision",
	)
	_expect(
		_artifact_dirs(ROOT + "/hero") == PackedStringArray(["2-bbb", "3-ccc"]),
		"pruning must keep the applied and the previous revision, got %s"
		% [_artifact_dirs(ROOT + "/hero")],
	)


func _test_highest_revision_is_scoped_to_the_slug() -> void:
	_cleanup()
	var store := ArtifactStore.new(func() -> String: return ROOT)
	store.stage("hero", [_file("scripts/hero.gd", "hero-v1")])
	store.swap("hero", 2, "aaa")
	store.stage("weapon", [_file("scripts/weapon.gd", "weapon-v1")])
	store.swap("weapon", 7, "bbb")
	# A stale directory of another slug must not leak into these results.
	DirAccess.make_dir_recursive_absolute(ROOT + "/stale/9-ccc")
	_expect(store.highest_revision("hero") == 2, "hero must keep its own highest revision")
	_expect(
		store.highest_revision("weapon") == 7,
		"weapon must keep its own highest revision",
	)
	_expect(
		store.highest_revision("stale") == 9,
		"a stale directory belongs to its own slug only",
	)
	_expect(
		store.highest_revision("") == 0,
		"an empty slug must not enumerate the packages root",
	)
	_expect(
		ArtifactStore.is_valid_slug("7"),
		"a numeric legacy slug is a valid folder name",
	)
	_expect(
		store.package_dir("7") == ROOT + "/7",
		"a numeric legacy slug must resolve to its own folder",
	)


# --- helpers --------------------------------------------------------------


func _file(filepath: String, text: String) -> Dictionary:
	return {"filepath": filepath, "body": text.to_utf8_buffer()}


## Full artifact directory names (`<revision>-<artifact_key>`), sorted.
func _artifact_dirs(path: String) -> PackedStringArray:
	var names := PackedStringArray()
	var dir := DirAccess.open(path)
	if dir == null:
		return names
	for name: String in dir.get_directories():
		if ArtifactStore.revision_of_dir_name(name) > 0:
			names.append(name)
	names.sort()
	return names


func _cleanup() -> void:
	var store := ArtifactStore.new(func() -> String: return ROOT)
	store.remove_tree(ROOT)


func _expect(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("ARTIFACT_STORE_SMOKE_OK checks=%d" % _checks)
		quit(0)
		return
	for message: String in _failures:
		printerr("ARTIFACT_STORE_SMOKE_FAILED %s" % message)
	quit(1)
