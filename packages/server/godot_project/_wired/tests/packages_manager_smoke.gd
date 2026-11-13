extends SceneTree

## Headless smoke test for PackagesManager runtime synchronization.
##
## It never touches the network: `request_override` replaces the HTTP transport
## with an in-memory fixture table, so the real `sync_package` / `_sync_package`
## recursion, verification, staging and swap code runs unchanged. The stand-in
## transport yields one frame per request so concurrent syncs really interleave.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/packages_manager_smoke.gd --quit-after 600

const ROOM := "424242"
const LIB_ID := 5
const DEP_ID := 10
const ROOT_ID := 20
const CYCLE_A_ID := 30
const CYCLE_B_ID := 31
const SHARED_LIB_ID := 40
const ROOT_A_ID := 41
const ROOT_B_ID := 42
const RACE_ID := 50
const DIAMOND_LIB_ID := 60
const DIAMOND_A_ID := 61
const DIAMOND_B_ID := 62
const DIAMOND_ROOT_ID := 63
const KEY_LIB_ID := 70
const KEY_DEP_ID := 71
const KEY_ROOT_ID := 72
const SLUG_ID := 80
const SLUG_OTHER_ID := 81
const SLUG_MISSING_ID := 82
const SLUG_SKIPPED_ID := 83
const PROGRESS_ID := 90
const CACHE_ID := 100
const CACHE_LIB_ID := 101
const DERIVE_ID := 110
const FLUSH_ID := 120
## 1×1 PNG, so a cached revision really has a raw asset with derived files.
const TINY_PNG := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

var _manager: PackagesManager
# "package:revision" -> runtime manifest dictionary
var _manifests: Dictionary = {}
# "package:revision:filepath" -> PackedByteArray
var _files: Dictionary = {}
# package id -> latest published revision, served by the raw manifest endpoint
var _latest: Dictionary = {}
# "package:revision:filepath" -> "size" | "hash", corrupts test responses
var _faults: Dictionary = {}
var _requests: PackedStringArray = []
var _applied: Array = []
var _failed: Array = []
var _progress: Array = []
var _failures: PackedStringArray = []


func _initialize() -> void:
	# Deferred so the tree is running before the first await.
	_run.call_deferred()


func _run() -> void:
	_test_interface()
	if not _failures.is_empty():
		_finish()
		return
	_test_runtime_path_and_changed_files()
	_test_room_normalization()
	_test_forget_package_clears_applied_state()
	_manager = PackagesManager.new()
	# Drop the room before the manager loads its slug index: a previous run must
	# not leak folder mappings into this one.
	_manager._remove_tree("user://wired/rooms/%s" % ROOM)
	_manager.configure("http://127.0.0.1:1", ROOM)
	# Apply-order diagnostics are off in a runtime build; this suite asserts the
	# order, so it opts in explicitly.
	_manager.trace_sync_order = true
	_manager.request_override = _transport
	_manager.package_applied.connect(_on_package_applied)
	_manager.package_failed.connect(_on_package_failed)
	_manager.package_progress.connect(_on_package_progress)
	_test_storage_root()
	_test_artifact_marker_verification()
	await _test_recursive_sync()
	await _test_progress_events()
	await _test_same_revision_refresh()
	await _test_artifact_key_refresh()
	await _test_diamond_dependency()
	await _test_revision_rotation()
	await _test_failure_atomicity()
	await _test_missing_manifest()
	await _test_stale_lock_is_reclaimed()
	await _test_restart_pruning()
	_test_relocate_references()
	await _test_cache_reuse_after_restart()
	await _test_cache_rejects_corrupt_artifact()
	await _test_cache_key_change_downloads()
	await _test_cache_repairs_derived_files()
	await _test_unknown_slug_never_touches_the_packages_root()
	await _test_slug_index_survives_restart()
	await _test_skipped_apply_persists_slug_index()
	await _test_independent_slug_revisions()
	await _test_missing_slug_fails_the_apply()
	await _test_concurrent_shared_dependency()
	await _test_concurrent_revisions()
	await _test_cycle()
	await _test_asset_derivation_failure()
	await _test_flush_storage_clears_dirty_state()
	_finish()


# --- tests ----------------------------------------------------------------


func _test_interface() -> void:
	var manager := PackagesManager.new()
	for method: String in [
		"fetch_runtime_manifest",
		"sync_package",
		"flush_storage",
		"runtime_path",
		"current_revision",
		"current_artifact_key",
		"scene_dependencies",
		"instantiate_scene",
		"_changed_files",
		"storage_root",
	]:
		_check(manager.has_method(method), "PackagesManager.%s() is missing" % method)
	_check(
		manager.has_signal("package_applied"),
		"PackagesManager.package_applied signal is missing"
	)
	_check(
		manager.has_signal("package_progress"),
		"PackagesManager.package_progress signal is missing"
	)
	var store := ArtifactStore.new(Callable(manager, "packages_root"))
	for method: String in ["write_marker", "reusable_artifact"]:
		_check(store.has_method(method), "ArtifactStore.%s() is missing" % method)
	manager.free()


func _test_forget_package_clears_applied_state() -> void:
	var manager := PackagesManager.new()
	manager.set_room("77")
	manager._current_revisions[42] = 3
	manager._current_artifact_keys[42] = "abc"
	manager.forget_package(42, false)
	_check(manager.current_revision(42) == 0, "forget clears the revision")
	_check(
		manager.current_artifact_key(42).is_empty(),
		"forget clears the artifact key",
	)
	manager.free()


func _test_runtime_path_and_changed_files() -> void:
	var manager := PackagesManager.new()
	manager.configure("http://127.0.0.1:1", "7")
	# A previous run may have left its slug index in this room.
	manager._slugs.clear()
	_check(
		manager.packages_dir(5).is_empty(),
		"a package whose manifest has not named a slug must not resolve a folder",
	)
	_check(
		manager.runtime_path(5, 3, "scripts/hero.gd", "abc").is_empty(),
		"an unknown slug must not resolve a file path",
	)
	# The runtime manifest is what assigns a folder; the id never becomes one.
	manager._slugs[5] = "hero"
	_check(
		manager.packages_dir(5) == "user://wired/rooms/7/packages/hero",
		"the package directory must use the slug",
	)
	_check(
		manager.runtime_path(5, 3, "scripts/hero.gd", "abc")
		== "user://wired/rooms/7/packages/hero/3-abc/scripts/hero.gd",
		"an explicit artifact key must select the keyed directory"
	)
	assert(manager.runtime_path(5, 3, "scripts/hero.gd") ==
		"user://wired/rooms/7/packages/hero/3/scripts/hero.gd")
	assert(manager._changed_files(
		{"a.gd": "1", "b.gd": "2"},
		{"a.gd": "1", "b.gd": "3", "c.gd": "4"},
	) == PackedStringArray(["b.gd", "c.gd"]))
	# Removed files are not "changed": only the new revision's files matter.
	_check(
		manager._changed_files({"gone.gd": "1"}, {}) == PackedStringArray(),
		"files removed from the new revision must not be reported as changed"
	)
	_check(
		manager._changed_files({}, {"a.gd": "1"}) == PackedStringArray(["a.gd"]),
		"a file without an old hash is changed"
	)
	manager.free()


func _test_room_normalization() -> void:
	var manager := PackagesManager.new()
	manager.set_room("7.0")
	_check(manager.room == "7", "a bridge room of 7.0 must normalize to 7")
	_check(manager._room_id() == 7, "a normalized room must keep its integer id")
	manager.free()


func _test_storage_root() -> void:
	_check(
		_manager.storage_root() == PackagesManager.PACKAGES_ROOT,
		"a desktop build must keep the user:// packages root",
	)
	_check(
		_manager.packages_root()
		== _manager.storage_root().path_join(ROOM).path_join("packages"),
		"the packages root must be derived from storage_root()",
	)
	_check(
		_manager._slug_index_path()
		== _manager.storage_root().path_join(ROOM).path_join(
			PackagesManager.SLUG_INDEX_FILE
		),
		"the slug index must live next to the packages directory",
	)


func _test_recursive_sync() -> void:
	_publish(LIB_ID, 1, {"scripts/lib.gd": "lib-v1"})
	_publish(
		DEP_ID,
		2,
		{"scripts/dep.gd": "dep-v2"},
		[_dependency(LIB_ID, 1)],
		{"scenes/dep.tscn": ["%d:scripts/lib.gd" % LIB_ID]},
	)
	_publish(
		ROOT_ID,
		3,
		{"scripts/root.gd": "root-v3", "scenes/root.tscn": "scene-v3"},
		[_dependency(DEP_ID, 2)],
		{"scenes/root.tscn": ["%d:scenes/dep.tscn" % DEP_ID, "%d:scripts/root.gd" % ROOT_ID]},
	)

	_requests.clear()
	_applied.clear()
	_manager._sync_order.clear()
	var result: Dictionary = await _manager.sync_package(ROOT_ID)
	_check(
		bool(result.get("ok", false)),
		"initial sync failed: %s" % result.get("error", "")
	)
	_check(
		_manager._sync_order == [LIB_ID, DEP_ID, ROOT_ID],
		"dependencies must be applied before their dependents, got %s" % [_manager._sync_order]
	)
	_check(
		_requests.has("/scripting-packages/%d/manifest" % ROOT_ID),
		"a revision hint of 0 must resolve the latest revision through the raw manifest"
	)
	_check(
		_requests.has(
			"/scripting-packages/%d/revisions/3/runtime-manifest?room=%s" % [ROOT_ID, ROOM]
		),
		"the exact runtime manifest of the resolved revision must be requested"
	)
	_check(
		_requests.has(
			"/scripting-packages/%d/revisions/3/runtime-files/scripts/root.gd?room=%s&key=%s&token=%d-3"
			% [ROOT_ID, ROOM, _manifest_key(ROOT_ID, 3), ROOT_ID]
		),
		"runtime files must be downloaded with the manifest's room, artifact key and token"
	)
	_check(
		_manager.current_revision(LIB_ID) == 1
		and _manager.current_revision(DEP_ID) == 2
		and _manager.current_revision(ROOT_ID) == 3,
		"every package of the closure must store its applied revision"
	)
	var applied_snapshot := _manager.applied_packages()
	_check(
		applied_snapshot.has(str(ROOT_ID)),
		"applied_packages must key packages by numeric id, got %s" % [applied_snapshot],
	)
	_check(
		not applied_snapshot.has(_slug_for(ROOT_ID)),
		"applied_packages must not key packages by slug, got %s" % [applied_snapshot],
	)
	_check(
		_manager.scene_dependencies(ROOT_ID, "scenes/root.tscn")
		== PackedStringArray(["10:scenes/dep.tscn", "20:scripts/root.gd"]),
		"scene dependencies of the applied manifest must be readable"
	)
	_check(
		_manager.scene_dependencies(ROOT_ID, "scenes/unknown.tscn") == PackedStringArray(),
		"an unknown scene must report no dependencies"
	)
	var root_file := _manager.runtime_path(ROOT_ID, 3, "scripts/root.gd")
	_check(FileAccess.file_exists(root_file), "the root file must be materialized")
	_check(
		FileAccess.get_file_as_string(root_file) == "root-v3",
		"the root file bytes must match the published artifact"
	)
	_check(
		_manager.instantiate_scene(ROOT_ID, "scenes/missing.tscn") == null,
		"a scene that is not on disk must instantiate as null"
	)
	_check(
		_manager.instantiate_scene(9999, "scenes/root.tscn") == null,
		"an unknown package must instantiate as null"
	)
	_check(
		_applied_for(ROOT_ID).get("changed_files", PackedStringArray())
		== PackedStringArray(["scenes/root.tscn", "scripts/root.gd"]),
		"the first apply must report every file as changed"
	)


func _test_progress_events() -> void:
	_publish(PROGRESS_ID, 1, {"scripts/a.gd": "alpha", "scripts/b.gd": "beta"})
	var total := (
		"alpha".to_utf8_buffer().size() + "beta".to_utf8_buffer().size()
	)
	_progress.clear()
	var result: Dictionary = await _manager.sync_package(PROGRESS_ID, 1)
	_check(bool(result.get("ok", false)), "the progress fixture must apply")
	_check(not _progress.is_empty(), "a package sync must report progress")
	var first: Dictionary = _progress[0]
	_check(
		first.get("status") == "loading" and int(first.get("loaded_bytes", -1)) == 0,
		"the first progress event must be a zero-byte loading state",
	)
	_check(
		int(first.get("total_bytes", 0)) == total,
		"the loading event must carry the manifest's total size",
	)
	var last: Dictionary = _progress.back()
	_check(
		last.get("status") == "complete"
		and int(last.get("loaded_bytes", 0)) == total
		and int(last.get("total_bytes", 0)) == total,
		"the last progress event must be a complete transfer",
	)
	_check(
		last.get("name") == "package-%d" % PROGRESS_ID,
		"the progress event must carry the package display name",
	)


func _test_same_revision_refresh() -> void:
	# An unchanged re-apply still runs (the backend may ask again) and reports
	# no changed files; a hint > 0 must not re-read the raw manifest.
	_applied.clear()
	_manager._sync_order.clear()
	_requests.clear()
	var repeat: Dictionary = await _manager.sync_package(ROOT_ID, 3)
	_check(bool(repeat.get("ok", false)), "re-applying the same revision must succeed")
	_check(
		_manager._sync_order == [LIB_ID, DEP_ID, ROOT_ID],
		"dependencies must be refreshed before the package itself"
	)
	_check(
		not _requests.has("/scripting-packages/%d/manifest" % ROOT_ID),
		"an explicit revision hint must not re-read the raw manifest"
	)
	_check(
		_applied_for(ROOT_ID).get("changed_files", PackedStringArray()) == PackedStringArray(),
		"an unchanged re-apply must report no changed files"
	)

	# A library publish rebuilds the dependent artifact: the root revision and
	# bytes stay the same, but its dependency pins and scene map change.
	_publish(LIB_ID, 2, {"scripts/lib.gd": "lib-v2"})
	_publish(
		DEP_ID,
		3,
		{"scripts/dep.gd": "dep-v3"},
		[_dependency(LIB_ID, 2)],
		{"scenes/dep.tscn": ["%d:scripts/lib.gd" % LIB_ID]},
	)
	_publish(
		ROOT_ID,
		3,
		{"scripts/root.gd": "root-v3", "scenes/root.tscn": "scene-v3"},
		[_dependency(DEP_ID, 3)],
		{
			"scenes/root.tscn": [
				"%d:scripts/lib.gd" % LIB_ID,
				"%d:scenes/dep.tscn" % DEP_ID,
				"%d:scripts/root.gd" % ROOT_ID,
			]
		},
	)
	_applied.clear()
	_manager._sync_order.clear()
	var refreshed: Dictionary = await _manager.sync_package(ROOT_ID, 3)
	_check(bool(refreshed.get("ok", false)), "a same-revision dependency refresh must succeed")
	_check(
		_manager.current_revision(LIB_ID) == 2 and _manager.current_revision(DEP_ID) == 3,
		"dependencies must move to the revisions pinned by the new manifest"
	)
	_check(
		_manager.current_revision(ROOT_ID) == 3,
		"the package's own revision must stay unchanged"
	)
	_check(
		_applied_for(ROOT_ID).get("changed_files", PackedStringArray()) == PackedStringArray(),
		"an unchanged artifact reports no changed files"
	)
	_check(
		_manager.scene_dependencies(ROOT_ID, "scenes/root.tscn")
		== PackedStringArray(
			["5:scripts/lib.gd", "10:scenes/dep.tscn", "20:scripts/root.gd"]
		),
		"scene dependencies must refresh even when the revision did not change"
	)

	# The artifact bytes can change without a revision bump (the dependency
	# bytes are embedded), so changed files must be reported again.
	_publish(
		ROOT_ID,
		3,
		{"scripts/root.gd": "root-v3b", "scenes/root.tscn": "scene-v3"},
		[_dependency(DEP_ID, 3)],
		{"scenes/root.tscn": ["%d:scripts/root.gd" % ROOT_ID]},
	)
	_applied.clear()
	var touched: Dictionary = await _manager.sync_package(ROOT_ID, 3)
	_check(bool(touched.get("ok", false)), "rewriting an artifact at the same revision must succeed")
	_check(
		_applied_for(ROOT_ID).get("changed_files", PackedStringArray())
		== PackedStringArray(["scripts/root.gd"]),
		"a same-revision byte change must be reported as a changed file"
	)
	_check(
		FileAccess.get_file_as_string(_manager.runtime_path(ROOT_ID, 3, "scripts/root.gd"))
		== "root-v3b",
		"the new bytes of a same-revision apply must be on disk"
	)


## A same-revision rebuild (a dependency published) must produce a new artifact
## key and a new directory; the old bytes must not be served again.
func _test_artifact_key_refresh() -> void:
	_publish(KEY_LIB_ID, 1, {"scripts/key_lib.gd": "key-lib-v1"})
	_publish(
		KEY_DEP_ID,
		1,
		{"scripts/key_dep.gd": "key-dep-v1"},
		[_dependency(KEY_LIB_ID, 1)],
	)
	_publish(
		KEY_ROOT_ID,
		1,
		{"scripts/key_root.gd": "key-root-v1"},
		[_dependency(KEY_DEP_ID, 1)],
	)
	var first: Dictionary = await _manager.sync_package(KEY_ROOT_ID, 1)
	_check(bool(first.get("ok", false)), "the keyed artifact must apply")
	if not bool(first.get("ok", false)):
		return
	var first_key := _manager.current_artifact_key(KEY_ROOT_ID)
	var first_dir := _manager.revision_dir(KEY_ROOT_ID, 1, first_key)
	var first_path := _manager.runtime_path(KEY_ROOT_ID, 1, "scripts/key_root.gd")
	_check(
		not first_key.is_empty() and FileAccess.file_exists(first_path),
		"the first artifact must be keyed and materialized"
	)
	_check(
		_manager.current_artifact_key(KEY_DEP_ID) == _manifest_key(KEY_DEP_ID, 1),
		"the dependency directory must use the dependency's own key"
	)

	# A library publish rebuilds both dependents at the same revision.
	_publish(KEY_LIB_ID, 2, {"scripts/key_lib.gd": "key-lib-v2"})
	_publish(
		KEY_DEP_ID,
		1,
		{"scripts/key_dep.gd": "key-dep-v1"},
		[_dependency(KEY_LIB_ID, 2)],
	)
	_publish(
		KEY_ROOT_ID,
		1,
		{"scripts/key_root.gd": "key-root-v1"},
		[_dependency(KEY_DEP_ID, 1)],
	)
	var second: Dictionary = await _manager.sync_package(KEY_ROOT_ID, 1)
	_check(bool(second.get("ok", false)), "the rebuilt artifact must apply")
	if not bool(second.get("ok", false)):
		return
	var second_key := _manager.current_artifact_key(KEY_ROOT_ID)
	_check(
		second_key != first_key,
		"a dependency publish must change the artifact key of the dependent"
	)
	_check(
		_manager.revision_dir(KEY_ROOT_ID, 1, second_key) != first_dir,
		"a dependency publish must change the client directory"
	)
	_check(
		not DirAccess.dir_exists_absolute(first_dir),
		"the stale artifact of the same revision must be pruned"
	)
	_check(
		_artifact_dirs(KEY_ROOT_ID) == PackedStringArray(["1-" + second_key]),
		"exactly the current keyed artifact must stay on disk"
	)
	_check(
		FileAccess.get_file_as_string(
			_manager.runtime_path(KEY_ROOT_ID, 1, "scripts/key_root.gd")
		) == "key-root-v1",
		"the rebuilt artifact must serve the pinned bytes"
	)
	_check(
		FileAccess.get_file_as_string(
			_manager.runtime_path(KEY_LIB_ID, 2, "scripts/key_lib.gd")
		) == "key-lib-v2",
		"the dependency must serve the newly published bytes"
	)


## A diamond graph applies its shared library exactly once per sync.
func _test_diamond_dependency() -> void:
	_publish(
		DIAMOND_LIB_ID, 1, {"scripts/diamond_lib.gd": "diamond-lib-v1"}
	)
	_publish(
		DIAMOND_A_ID,
		1,
		{"scripts/diamond_a.gd": "diamond-a"},
		[_dependency(DIAMOND_LIB_ID, 1)],
	)
	_publish(
		DIAMOND_B_ID,
		1,
		{"scripts/diamond_b.gd": "diamond-b"},
		[_dependency(DIAMOND_LIB_ID, 1)],
	)
	_publish(
		DIAMOND_ROOT_ID,
		1,
		{"scripts/diamond_root.gd": "diamond-root"},
		[_dependency(DIAMOND_A_ID, 1), _dependency(DIAMOND_B_ID, 1)],
	)
	_requests.clear()
	_applied.clear()
	_manager._sync_order.clear()

	var result: Dictionary = await _manager.sync_package(DIAMOND_ROOT_ID, 1)
	_check(
		bool(result.get("ok", false)),
		"the diamond closure must apply: %s" % result.get("error", "")
	)
	_check(
		_manager._sync_order
		== [DIAMOND_LIB_ID, DIAMOND_A_ID, DIAMOND_B_ID, DIAMOND_ROOT_ID],
		"a shared dependency must be applied once, before both branches: %s"
		% [_manager._sync_order]
	)
	_check(
		_count_requests(
			"/scripting-packages/%d/revisions/1/runtime-files/scripts/diamond_lib.gd"
			% DIAMOND_LIB_ID
		) == 1,
		"the diamond library must be downloaded once"
	)
	_check(
		_count_requests(
			"/scripting-packages/%d/revisions/1/runtime-manifest" % DIAMOND_LIB_ID
		) == 1,
		"the diamond library manifest must be requested once"
	)
	_check(
		_count_applied(DIAMOND_LIB_ID) == 1,
		"the diamond library must emit package_applied once"
	)


func _test_revision_rotation() -> void:
	_publish(ROOT_ID, 4, {"scripts/root.gd": "root-v4"}, [_dependency(DEP_ID, 3)])
	var fourth: Dictionary = await _manager.sync_package(ROOT_ID, 4)
	_check(bool(fourth.get("ok", false)), "revision 4 must apply")
	_check(
		_revision_dirs(ROOT_ID) == PackedStringArray(["3", "4"]),
		"the previous revision must stay next to the current one"
	)
	_publish(ROOT_ID, 5, {"scripts/root.gd": "root-v5"}, [_dependency(DEP_ID, 3)])
	var fifth: Dictionary = await _manager.sync_package(ROOT_ID, 5)
	_check(bool(fifth.get("ok", false)), "revision 5 must apply")
	_check(
		_revision_dirs(ROOT_ID) == PackedStringArray(["4", "5"]),
		"only the current and previous revisions may stay on disk"
	)
	_check(_manager.current_revision(ROOT_ID) == 5, "the current revision must follow the apply")


func _test_failure_atomicity() -> void:
	# Revision 5 is applied; a failed revision must leave it completely intact.
	var old_file := _manager.runtime_path(ROOT_ID, 5, "scripts/root.gd")
	var old_bytes := FileAccess.get_file_as_string(old_file)
	_publish(ROOT_ID, 6, {"scripts/root.gd": "root-v6"}, [_dependency(DEP_ID, 3)])
	for mode: String in ["size", "hash"]:
		_faults["%d:6:scripts/root.gd" % ROOT_ID] = mode
		_applied.clear()
		_failed.clear()
		var result: Dictionary = await _manager.sync_package(ROOT_ID, 6)
		_check(
			not bool(result.get("ok", false)),
			"a %s-corrupted file must fail the apply" % mode
		)
		_check(
			_manager.current_revision(ROOT_ID) == 5,
			"a failed apply must not publish its revision"
		)
		_check(
			FileAccess.get_file_as_string(old_file) == old_bytes,
			"a failed apply must leave the previous files unchanged"
		)
		_check(
			not DirAccess.dir_exists_absolute(
				_manager.packages_dir(ROOT_ID).path_join(".staging")
			),
			"a failed apply must remove the staging directory"
		)
		_check(
			not DirAccess.dir_exists_absolute(_manager.revision_dir(ROOT_ID, 6)),
			"a failed apply must not create the revision directory"
		)
		_check(
			not _failed.is_empty(),
			"a failed apply must emit package_failed"
		)
		_check(
			_applied_for(ROOT_ID).is_empty(),
			"a failed apply must not emit package_applied"
		)
	_faults.clear()

	# A corrupt dependency must stop the closure before the root is published.
	_publish(DEP_ID, 4, {"scripts/dep.gd": "dep-v4"})
	_publish(ROOT_ID, 7, {"scripts/root.gd": "root-v7"}, [_dependency(DEP_ID, 4)])
	var dep_file := _manager.runtime_path(DEP_ID, 3, "scripts/dep.gd")
	var dep_bytes := FileAccess.get_file_as_string(dep_file)
	_faults["%d:4:scripts/dep.gd" % DEP_ID] = "hash"
	_applied.clear()
	_failed.clear()
	var dependency_failure: Dictionary = await _manager.sync_package(ROOT_ID, 7)
	_check(
		not bool(dependency_failure.get("ok", false)),
		"a corrupt dependency must fail the dependent"
	)
	_check(
		_manager.current_revision(DEP_ID) == 3,
		"the dependency's working revision must not change"
	)
	_check(
		FileAccess.get_file_as_string(dep_file) == dep_bytes,
		"the dependency's files must stay intact"
	)
	_check(
		_manager.current_revision(ROOT_ID) == 5,
		"the root must not be published when a dependency fails"
	)
	_check(
		not DirAccess.dir_exists_absolute(_manager.revision_dir(ROOT_ID, 7)),
		"the root revision directory must not be created"
	)
	_check(
		not DirAccess.dir_exists_absolute(
			_manager.packages_dir(DEP_ID).path_join(".staging")
		),
		"the dependency must clean its staging directory"
	)
	_check(
		_applied_for(ROOT_ID).is_empty(),
		"the root must not emit package_applied when a dependency fails"
	)
	_faults.clear()

	# Recovery: the same revision now applies normally.
	var recovered: Dictionary = await _manager.sync_package(ROOT_ID, 6)
	_check(bool(recovered.get("ok", false)), "a retry after a failure must succeed")
	_check(_manager.current_revision(ROOT_ID) == 6, "the retried revision must be published")
	_check(
		_revision_dirs(ROOT_ID) == PackedStringArray(["5", "6"]),
		"the failed revision must not disturb the revision window"
	)


func _test_missing_manifest() -> void:
	_failed.clear()
	var missing: Dictionary = await _manager.sync_package(999, 1)
	_check(not bool(missing.get("ok", false)), "a missing runtime manifest must fail")
	_check(
		_manager._applying.is_empty(),
		"a failed apply must release the per-package lock, got %s"
		% [_manager._applying],
	)
	_check(
		str(missing.get("error", "")).contains("runtime_manifest_missing"),
		"a 404 runtime manifest must be reported as runtime_manifest_missing"
	)
	_check(
		_failed.size() == 1 and int(_failed[0].get("package_id", 0)) == 999,
		"a failed sync must emit package_failed"
	)


## A coroutine that aborted inside `await` (an engine error never resumes) cannot
## run its cleanup line, so the lock carries an acquisition time and a waiter
## takes over an abandoned one instead of blocking the package for the full
## `APPLY_LOCK_TIMEOUT_MS`.
func _test_stale_lock_is_reclaimed() -> void:
	var manager := PackagesManager.new()
	# A lock entry without a usable timestamp is what an interrupted acquisition
	# leaves behind; it can never be released by its owner.
	manager._applying[77] = 0
	var reclaimed: int = await manager._acquire_apply_lock(77)
	_check(
		reclaimed == PackagesManager.ApplyLock.ACQUIRED,
		"an abandoned apply lock must be reclaimed",
	)
	_check(
		manager._applying.has(77),
		"the reclaimed lock must belong to the new owner",
	)
	manager._release_apply_lock(77)

	var free_lock: int = await manager._acquire_apply_lock(78)
	_check(
		free_lock == PackagesManager.ApplyLock.ACQUIRED,
		"a free lock must be acquired without waiting",
	)
	_check(
		not manager._apply_lock_is_stale(78),
		"a lock taken now must not be considered abandoned",
	)
	manager._release_apply_lock(78)

	manager.free()


func _test_restart_pruning() -> void:
	# A new manager has no in-memory revisions, like a fresh process. A
	# same-revision refresh must still keep the real previous revision on disk.
	var restarted := PackagesManager.new()
	restarted.configure("http://127.0.0.1:1", ROOM)
	restarted.request_override = _transport
	_check(restarted.current_revision(ROOT_ID) == 0, "a new manager starts without revisions")
	var same: Dictionary = await restarted.sync_package(ROOT_ID, 6)
	_check(bool(same.get("ok", false)), "a same-revision refresh after restart must succeed")
	_check(
		_revision_dirs(ROOT_ID) == PackedStringArray(["5", "6"]),
		"a same-revision refresh must keep the real previous revision after restart"
	)
	var newer: Dictionary = await restarted.sync_package(ROOT_ID, 7)
	_check(bool(newer.get("ok", false)), "a newer revision after restart must apply")
	_check(restarted.current_revision(ROOT_ID) == 7, "the newer revision must be current")
	_check(
		_revision_dirs(ROOT_ID) == PackedStringArray(["6", "7"]),
		"the pruning window must follow the highest revision on disk"
	)
	var stale: Dictionary = await restarted.sync_package(ROOT_ID, 6)
	_check(bool(stale.get("ok", false)), "a stale revision must be a no-op success")
	_check(bool(stale.get("skipped", false)), "a stale revision must be reported as skipped")
	_check(
		restarted.current_revision(ROOT_ID) == 7,
		"a stale revision must not move the state backwards"
	)
	_check(
		_revision_dirs(ROOT_ID) == PackedStringArray(["6", "7"]),
		"a stale revision must not change the revision window"
	)
	restarted.free()


## The backend rewrites package references in text files to `user://` paths of
## its own cache, which is not where the Web build mounts the packages root.
func _test_relocate_references() -> void:
	var text := 'path="user://wired/rooms/%s/packages/lib/1-abc/art/pic.png"' % ROOM
	var relocated := PackagesManager.relocate_artifact_text(
		text, ROOM, "/wired-cache/wired/rooms"
	)
	_check(
		relocated
		== 'path="/wired-cache/wired/rooms/%s/packages/lib/1-abc/art/pic.png"' % ROOM,
		"a web root must relocate the backend package prefix",
	)
	_check(
		PackagesManager.relocate_artifact_text(
			"no package paths here", ROOM, "/wired-cache/wired/rooms"
		) == "no package paths here",
		"text without the prefix must be untouched",
	)


## A complete artifact on disk must be applied without downloading again.
func _test_cache_reuse_after_restart() -> void:
	_publish(CACHE_ID, 1, {"scripts/cache.gd": "cache-v1", "scenes/cache.tscn": "scene-v1"})
	var first: Dictionary = await _manager.sync_package(CACHE_ID, 1)
	_check(bool(first.get("ok", false)), "the first apply must download the artifact")
	_check(not bool(first.get("cached", false)), "the first apply must not be a cache hit")
	var restarted := _restarted_manager()
	_requests.clear()
	var second: Dictionary = await restarted.sync_package(CACHE_ID, 1)
	_check(bool(second.get("ok", false)), "a cached artifact must apply after restart")
	_check(bool(second.get("cached", false)), "a complete artifact must be reported as cached")
	_check(not _has_request_containing("runtime-files"), "a cache hit must not download files")
	_check(
		second.get("changed_files", PackedStringArray()).size() == 2,
		"a cache hit in a fresh process must report every file as changed",
	)
	_check(restarted.current_revision(CACHE_ID) == 1, "a cache hit must publish the revision")
	_check(
		not restarted.current_artifact_key(CACHE_ID).is_empty(),
		"a cache hit must publish the artifact key",
	)
	_check(
		FileAccess.get_file_as_string(
			restarted.runtime_path(CACHE_ID, 1, "scripts/cache.gd")
		) == "cache-v1",
		"a cache hit must expose the applied files",
	)
	restarted.free()


func _test_cache_rejects_corrupt_artifact() -> void:
	var path := _manager.runtime_path(CACHE_ID, 1, "scripts/cache.gd")
	var handle := FileAccess.open(path, FileAccess.WRITE)
	handle.store_string("bad")
	handle.close()
	var restarted := _restarted_manager()
	_requests.clear()
	var result: Dictionary = await restarted.sync_package(CACHE_ID, 1)
	_check(bool(result.get("ok", false)), "a corrupt cache must fall back to a download")
	_check(not bool(result.get("cached", false)), "a corrupt cache must not be reused")
	_check(_has_request_containing("runtime-files"), "a corrupt cache must download the files")
	_check(
		FileAccess.get_file_as_string(path) == "cache-v1",
		"the download must restore the corrupted file",
	)
	restarted.free()


func _test_cache_key_change_downloads() -> void:
	var previous := _manager.current_artifact_key(CACHE_ID)
	_publish(CACHE_LIB_ID, 1, {"scripts/cache_lib.gd": "lib-v1"})
	_publish(
		CACHE_ID,
		1,
		{"scripts/cache.gd": "cache-v1", "scenes/cache.tscn": "scene-v1"},
		[_dependency(CACHE_LIB_ID, 1)],
	)
	var restarted := _restarted_manager()
	_requests.clear()
	var result: Dictionary = await restarted.sync_package(CACHE_ID, 1)
	_check(bool(result.get("ok", false)), "a new artifact key must apply")
	_check(not bool(result.get("cached", false)), "a new artifact key must not reuse the old bytes")
	_check(_has_request_containing("runtime-files"), "a new artifact key must download")
	_check(
		restarted.current_artifact_key(CACHE_ID) != previous,
		"the key must change when a dependency is published",
	)
	_check(
		_artifact_dirs(CACHE_ID).size() == 1,
		"the old keyed directory must be pruned",
	)
	restarted.free()


## A cached artifact whose derived files are missing or were produced by an older
## derive version is repaired in place: the raw files are still on disk, so the
## repair must not download the artifact again.
func _test_cache_repairs_derived_files() -> void:
	_publish(
		DERIVE_ID,
		1,
		{"art/tiny.png": Marshalls.base64_to_raw(TINY_PNG), "scripts/derive.gd": "v1"},
	)
	var first: Dictionary = await _manager.sync_package(DERIVE_ID, 1)
	_check(bool(first.get("ok", false)), "a package with a texture must apply")
	var dir := _manager.revision_dir(DERIVE_ID, 1)
	var derived_path := dir.path_join("art/tiny.png.image.res")
	_check(FileAccess.file_exists(derived_path), "the texture must be derived")
	DirAccess.remove_absolute(derived_path)
	var restarted := _restarted_manager()
	_requests.clear()
	var repaired: Dictionary = await restarted.sync_package(DERIVE_ID, 1)
	_check(bool(repaired.get("ok", false)), "a missing derived file must be repaired")
	_check(bool(repaired.get("cached", false)), "a repair must not download the artifact")
	_check(not _has_request_containing("runtime-files"), "a repair must not download files")
	_check(
		FileAccess.file_exists(derived_path),
		"the repair must recreate the derived resource",
	)
	var marker_path := dir.path_join(ArtifactStore.MARKER_FILE)
	var marker: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(marker_path))
	# A marker rewritten after a relocation carries the sizes on disk; the repair
	# rewrites the marker, so those recorded sizes have to survive unchanged.
	var handle := FileAccess.open(dir.path_join("scripts/derive.gd"), FileAccess.READ)
	var stored_size := handle.get_length()
	handle.close()
	marker["storedSizes"] = {"scripts/derive.gd": stored_size}
	marker["deriveVersion"] = 0
	handle = FileAccess.open(marker_path, FileAccess.WRITE)
	handle.store_string(JSON.stringify(marker))
	handle.close()
	var stale := _restarted_manager()
	_requests.clear()
	var upgraded: Dictionary = await stale.sync_package(DERIVE_ID, 1)
	_check(bool(upgraded.get("ok", false)), "an old derive version must still apply")
	_check(bool(upgraded.get("cached", false)), "an old derive version must be repaired locally")
	_check(not _has_request_containing("runtime-files"), "an old derive version must not download")
	var updated: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(marker_path))
	_check(
		int(updated.get("deriveVersion", 0)) == AssetDeriver.VERSION,
		"the repair must record the current derive version",
	)
	var kept: Dictionary = updated.get("storedSizes", {})
	_check(
		int(kept.get("scripts/derive.gd", 0)) == stored_size,
		"the repair must keep the stored sizes of the marker",
	)
	restarted.free()
	stale.free()


## The browser file system is mirrored into IndexedDB, so a batch of applies must
## sync it once at the end instead of after every package.
func _test_flush_storage_clears_dirty_state() -> void:
	_manager.flush_storage()
	_check(not _manager._storage_dirty, "a flushed manager must not be dirty")
	_publish(FLUSH_ID, 1, {"scripts/flush.gd": "v1"})
	var result: Dictionary = await _manager.sync_package(FLUSH_ID, 1)
	_check(bool(result.get("ok", false)), "the flush fixture must apply")
	_check(_manager._storage_dirty, "a successful apply must mark the storage dirty")
	_manager.flush_storage()
	_check(not _manager._storage_dirty, "flush_storage must clear the dirty flag")


## A package with no slug yet must not resolve, enumerate or delete a path: an
## empty slug used to be the packages root itself.
func _test_unknown_slug_never_touches_the_packages_root() -> void:
	var root := _manager.packages_root()
	_check(
		DirAccess.dir_exists_absolute(root),
		"the packages root must exist after the applies above",
	)
	var unknown := PackagesManager.new()
	unknown.configure("http://127.0.0.1:1", ROOM)
	_check(
		unknown.packages_dir(987654).is_empty(),
		"an unknown package must not resolve a folder",
	)
	_check(
		unknown.revision_dir(987654, 1, "abc").is_empty(),
		"an unknown package must not resolve a revision folder",
	)
	_check(
		unknown.runtime_path(987654, 1, "scripts/x.gd").is_empty(),
		"an unknown package must not resolve a file path",
	)
	unknown.forget_package(987654, true)
	_check(
		DirAccess.dir_exists_absolute(root),
		"purging an unknown package must not delete the packages root",
	)
	_check(
		DirAccess.dir_exists_absolute(_manager.packages_dir(ROOT_ID)),
		"purging an unknown package must not delete another package's folder",
	)
	unknown.free()


## The folder of an applied package outlives the process: a restart resolves it
## from `package_slugs.json`, and a purge removes exactly that folder.
func _test_slug_index_survives_restart() -> void:
	_publish(SLUG_ID, 1, {"scripts/slug.gd": "slug-v1"})
	var result: Dictionary = await _manager.sync_package(SLUG_ID, 1)
	_check(
		bool(result.get("ok", false)),
		"the slug fixture must apply: %s" % result.get("error", ""),
	)
	if not bool(result.get("ok", false)):
		return
	var folder := _manager.packages_dir(SLUG_ID)
	_check(
		folder
		== "user://wired/rooms/%s/packages/%s" % [ROOM, _slug_for(SLUG_ID)],
		"the artifact must live in the slug folder, got %s" % folder,
	)
	var index_path := "user://wired/rooms/%s/package_slugs.json" % ROOM
	_check(
		FileAccess.file_exists(index_path),
		"a successful apply must write the slug index",
	)
	_check(
		not FileAccess.file_exists(index_path + ".tmp"),
		"the temporary slug index must be renamed into place",
	)
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(index_path))
	_check(
		typeof(parsed) == TYPE_DICTIONARY
		and str((parsed as Dictionary).get(str(SLUG_ID), "")) == _slug_for(SLUG_ID),
		"the index must map the numeric id to its slug, got %s" % [parsed],
	)

	var restarted := PackagesManager.new()
	restarted.configure("http://127.0.0.1:1", ROOM)
	restarted.request_override = _transport
	_check(
		str(restarted._slugs.get(SLUG_ID, "")) == _slug_for(SLUG_ID),
		"a restart must restore the id -> slug mapping, got %s" % [restarted._slugs],
	)
	_check(
		restarted.packages_dir(SLUG_ID) == folder,
		"a restart must resolve the same folder before any manifest is read",
	)
	restarted.forget_package(SLUG_ID, true)
	_check(
		not DirAccess.dir_exists_absolute(folder),
		"a purge must remove the slug folder the restart restored",
	)
	_check(
		DirAccess.dir_exists_absolute(_manager.packages_dir(ROOT_ID)),
		"a purge must not touch another package's slug folder",
	)
	restarted.free()


## A skipped apply still has to persist the slug it learns. A folder can exist
## from an older runtime that never wrote the index, and the next restart must
## still resolve and purge exactly that folder.
func _test_skipped_apply_persists_slug_index() -> void:
	_publish(SLUG_SKIPPED_ID, 1, {"scripts/skipped.gd": "skipped-v1"})
	_publish(SLUG_SKIPPED_ID, 2, {"scripts/skipped.gd": "skipped-v2"})
	# A newer revision is on disk, so a request for revision 1 is a skipped
	# apply rather than a same-revision refresh.
	var applied: Dictionary = await _manager.sync_package(SLUG_SKIPPED_ID, 2)
	_check(
		bool(applied.get("ok", false)),
		"the skipped-apply fixture must apply first: %s" % applied.get("error", ""),
	)
	if not bool(applied.get("ok", false)):
		return
	var folder := _manager.packages_dir(SLUG_SKIPPED_ID)
	var slug := _slug_for(SLUG_SKIPPED_ID)
	var index_path := "user://wired/rooms/%s/package_slugs.json" % ROOM
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(index_path))
	var index: Dictionary = parsed if typeof(parsed) == TYPE_DICTIONARY else {}
	# Simulate a missing entry: the folder is there, the index is not.
	index.erase(str(SLUG_SKIPPED_ID))
	var handle := FileAccess.open(index_path, FileAccess.WRITE)
	handle.store_string(JSON.stringify(index))
	handle.close()

	var restarted := PackagesManager.new()
	restarted.configure("http://127.0.0.1:1", ROOM)
	restarted.request_override = _transport
	_check(
		not restarted._slugs.has(SLUG_SKIPPED_ID),
		"the fixture must start without an index entry for the skipped package",
	)
	_check(
		DirAccess.dir_exists_absolute(folder),
		"the skipped fixture folder must still be on disk at %s" % folder,
	)
	_check(
		restarted._artifacts.highest_revision(slug) == 2,
		"the restart must see revision 2 on disk, got %d"
		% restarted._artifacts.highest_revision(slug),
	)
	var skipped: Dictionary = await restarted.sync_package(SLUG_SKIPPED_ID, 1)
	_check(
		bool(skipped.get("ok", false)) and bool(skipped.get("skipped", false)),
		"the older revision already on disk must be skipped, got %s" % [skipped],
	)
	_check(
		int(skipped.get("revision", 0)) == 2,
		"the skip must report the on-disk revision, got %s"
		% skipped.get("revision", 0),
	)
	restarted.free()

	var after_skip: Variant = JSON.parse_string(FileAccess.get_file_as_string(index_path))
	_check(
		typeof(after_skip) == TYPE_DICTIONARY
		and str((after_skip as Dictionary).get(str(SLUG_SKIPPED_ID), "")) == slug,
		"a skipped apply must persist the slug it learned, got %s" % [after_skip],
	)

	var after_restart := PackagesManager.new()
	after_restart.configure("http://127.0.0.1:1", ROOM)
	after_restart.request_override = _transport
	_check(
		after_restart.packages_dir(SLUG_SKIPPED_ID) == folder,
		"a restart must resolve the slug persisted by a skipped apply",
	)
	after_restart.forget_package(SLUG_SKIPPED_ID, true)
	_check(
		not DirAccess.dir_exists_absolute(folder),
		"a purge must remove the folder of a slug learned by a skipped apply",
	)
	_check(
		DirAccess.dir_exists_absolute(_manager.packages_dir(ROOT_ID)),
		"the skipped-apply purge must not touch another package's folder",
	)
	after_restart.free()


## Each package owns one folder, so a stale revision directory of one package
## must never make another package look newer on disk.
func _test_independent_slug_revisions() -> void:
	_publish(SLUG_ID, 2, {"scripts/slug.gd": "slug-v2"})
	_publish(SLUG_OTHER_ID, 3, {"scripts/other.gd": "other-v3"})
	var first: Dictionary = await _manager.sync_package(SLUG_ID, 2)
	_check(bool(first.get("ok", false)), "the first slug fixture must apply")
	var second: Dictionary = await _manager.sync_package(SLUG_OTHER_ID, 3)
	_check(bool(second.get("ok", false)), "the second slug fixture must apply")
	if not (bool(first.get("ok", false)) and bool(second.get("ok", false))):
		return
	# A stale artifact of the other package: nothing may consult it for SLUG_ID.
	DirAccess.make_dir_recursive_absolute(
		_manager.packages_dir(SLUG_OTHER_ID).path_join("9-stale")
	)
	_publish(SLUG_ID, 3, {"scripts/slug.gd": "slug-v3"})
	_publish(SLUG_OTHER_ID, 4, {"scripts/other.gd": "other-v4"})

	var restarted := PackagesManager.new()
	restarted.configure("http://127.0.0.1:1", ROOM)
	restarted.request_override = _transport
	var advanced: Dictionary = await restarted.sync_package(SLUG_ID, 3)
	_check(
		bool(advanced.get("ok", false)) and not bool(advanced.get("skipped", false)),
		"another slug's stale revision must not skip this package, got %s"
		% [advanced],
	)
	_check(
		restarted.current_revision(SLUG_ID) == 3,
		"the newer revision of its own slug must apply",
	)
	_check(
		_revision_dirs_for(restarted, SLUG_ID) == PackedStringArray(["2", "3"]),
		"only its own slug's revision window may rotate, got %s"
		% [_revision_dirs_for(restarted, SLUG_ID)],
	)
	var blocked: Dictionary = await restarted.sync_package(SLUG_OTHER_ID, 4)
	_check(
		bool(blocked.get("ok", false)) and bool(blocked.get("skipped", false)),
		"its own stale revision must still block an older apply, got %s"
		% [blocked],
	)
	_check(
		int(blocked.get("revision", 0)) == 9,
		"the skip must report the on-disk revision, got %s"
		% blocked.get("revision", 0),
	)
	restarted.free()


## A runtime manifest without a slug is malformed: no file may land in a
## `<numeric id>` folder as a fallback.
func _test_missing_slug_fails_the_apply() -> void:
	_publish(SLUG_MISSING_ID, 1, {"scripts/missing.gd": "missing-v1"})
	(_manifests["%d:1" % SLUG_MISSING_ID] as Dictionary).erase("slug")
	_applied.clear()
	_failed.clear()
	var result: Dictionary = await _manager.sync_package(SLUG_MISSING_ID, 1)
	_check(
		not bool(result.get("ok", false)),
		"a runtime manifest without a slug must fail",
	)
	_check(
		str(result.get("error", "")).contains("slug"),
		"the failure must name the missing slug, got %s" % result.get("error", ""),
	)
	_check(
		_manager.packages_dir(SLUG_MISSING_ID).is_empty(),
		"a slugless manifest must not resolve a folder",
	)
	_check(
		not DirAccess.dir_exists_absolute(
			"user://wired/rooms/%s/packages/%d" % [ROOM, SLUG_MISSING_ID]
		),
		"the numeric id must never become a fallback folder",
	)
	_check(
		_failed.size() == 1
		and int(_failed[0].get("package_id", 0)) == SLUG_MISSING_ID,
		"a slugless manifest must emit package_failed, got %s" % [_failed],
	)
	_check(
		_applied_for(SLUG_MISSING_ID).is_empty(),
		"a slugless manifest must not emit package_applied",
	)


func _test_concurrent_shared_dependency() -> void:
	_publish(SHARED_LIB_ID, 1, {"scripts/shared.gd": "shared-v1"})
	_publish(
		ROOT_A_ID, 1, {"scripts/a.gd": "a-v1"}, [_dependency(SHARED_LIB_ID, 1)]
	)
	_publish(
		ROOT_B_ID, 1, {"scripts/b.gd": "b-v1"}, [_dependency(SHARED_LIB_ID, 1)]
	)

	_requests.clear()
	_applied.clear()
	var results: Array = [null, null]
	# Both calls start without waiting for the first: they interleave on HTTP.
	_sync_into(results, 0, ROOT_A_ID)
	_sync_into(results, 1, ROOT_B_ID)
	await _await_results(results)
	_check(
		_result_ok(results[0]) and _result_ok(results[1]),
		"two concurrent roots sharing a library must both succeed"
	)
	_check(
		_manager.current_revision(ROOT_A_ID) == 1
		and _manager.current_revision(ROOT_B_ID) == 1,
		"both roots must be published"
	)
	_check(
		_manager.current_revision(SHARED_LIB_ID) == 1,
		"the shared library must be published"
	)
	_check(
		_count_requests(
			"/scripting-packages/%d/revisions/1/runtime-files/scripts/shared.gd"
			% SHARED_LIB_ID
		) == 1,
		"the shared library file must be downloaded once"
	)
	_check(
		_count_requests(
			"/scripting-packages/%d/revisions/1/runtime-manifest" % SHARED_LIB_ID
		) == 1,
		"the shared library manifest must be requested once"
	)
	_check(
		_count_applied(SHARED_LIB_ID) == 1,
		"the shared library must be applied once"
	)


func _test_concurrent_revisions() -> void:
	_publish(RACE_ID, 1, {"scripts/race.gd": "race-v1"})
	_publish(RACE_ID, 2, {"scripts/race.gd": "race-v2"})

	# Older revision first: the newer one must win once the lock is free.
	var results: Array = [null, null]
	_sync_explicit_into(results, 0, RACE_ID, 1)
	_sync_explicit_into(results, 1, RACE_ID, 2)
	await _await_results(results)
	_check(
		_result_ok(results[0]) and _result_ok(results[1]),
		"two back-to-back revisions must both finish successfully"
	)
	_check(
		_manager.current_revision(RACE_ID) == 2,
		"the newer revision must win the race"
	)
	_check(
		FileAccess.get_file_as_string(_manager.runtime_path(RACE_ID, 2, "scripts/race.gd"))
		== "race-v2",
		"the newer bytes must be on disk"
	)
	_check(
		_revision_dirs(RACE_ID) == PackedStringArray(["1", "2"]),
		"the applied revisions must stay in the window"
	)

	# Newer revision first: the older caller must not move the state backwards.
	results = [null, null]
	_sync_explicit_into(results, 0, RACE_ID, 2)
	_sync_explicit_into(results, 1, RACE_ID, 1)
	await _await_results(results)
	_check(
		_result_ok(results[0]) and _result_ok(results[1]),
		"an older concurrent caller must not fail"
	)
	_check(
		bool(results[1].get("skipped", false)),
		"the older concurrent caller must be skipped"
	)
	_check(
		_manager.current_revision(RACE_ID) == 2,
		"an older revision must never replace a newer one"
	)
	_check(
		FileAccess.get_file_as_string(_manager.runtime_path(RACE_ID, 2, "scripts/race.gd"))
		== "race-v2",
		"the newer bytes must remain on disk"
	)


func _test_cycle() -> void:
	_publish(
		CYCLE_A_ID, 1, {"scripts/a.gd": "cycle-a"}, [_dependency(CYCLE_B_ID, 1)]
	)
	_publish(
		CYCLE_B_ID, 1, {"scripts/b.gd": "cycle-b"}, [_dependency(CYCLE_A_ID, 1)]
	)
	_requests.clear()
	_applied.clear()
	_manager._sync_order.clear()
	var result: Dictionary = await _manager.sync_package(CYCLE_A_ID, 1)
	_check(not bool(result.get("ok", false)), "a dependency cycle must fail")
	_check(
		str(result.get("error", "")).contains("package_dependency_cycle"),
		"the error must name the cycle: %s" % result.get("error", "")
	)
	_check(
		str(result.get("error", "")).contains("%d:1" % CYCLE_A_ID),
		"the error must name the package that closes the cycle"
	)
	_check(
		_manager.current_revision(CYCLE_A_ID) == 0
		and _manager.current_revision(CYCLE_B_ID) == 0,
		"no package of a cycle may be published"
	)
	_check(
		not DirAccess.dir_exists_absolute(_manager.revision_dir(CYCLE_A_ID, 1))
		and not DirAccess.dir_exists_absolute(_manager.revision_dir(CYCLE_B_ID, 1)),
		"a cycle must not create revision directories"
	)
	_check(
		not DirAccess.dir_exists_absolute(_manager.packages_dir(CYCLE_A_ID))
		and not DirAccess.dir_exists_absolute(_manager.packages_dir(CYCLE_B_ID)),
		"a cycle must not create package folders"
	)
	_check(_manager._sync_order.is_empty(), "a cycle must not apply any package")
	_check(
		not _has_request_containing("/runtime-files/"),
		"a cycle must be rejected before files are downloaded"
	)


## A revision whose raw image cannot be derived must fail exactly like a corrupt
## download: staging is dropped before the swap, so the current revision and its
## files stay intact and no signals report an apply.
func _test_asset_derivation_failure() -> void:
	var applied_before := _manager.current_revision(ROOT_ID)
	var old_file := _manager.runtime_path(ROOT_ID, applied_before, "scripts/root.gd")
	var old_bytes := FileAccess.get_file_as_string(old_file)
	_publish(
		ROOT_ID,
		8,
		{"scripts/root.gd": "root-v8", "bad.png": "this is not a png"},
		[_dependency(DEP_ID, 3)],
	)
	_applied.clear()
	_failed.clear()
	# Godot's decoders print an error for the deliberately corrupt file; the
	# checks below are what decides the result.
	var result: Dictionary = await _manager.sync_package(ROOT_ID, 8)
	_check(not bool(result.get("ok", false)), "an undecodable image must fail the apply")
	_check(
		str(result.get("error", "")) == "asset_derive_failed:bad.png",
		"the failure must name the derived asset, got %s" % result.get("error", "")
	)
	_check(
		_manager.current_revision(ROOT_ID) == applied_before,
		"a failed derivation must not publish its revision"
	)
	_check(
		FileAccess.get_file_as_string(old_file) == old_bytes,
		"a failed derivation must leave the previous files unchanged"
	)
	_check(
		not DirAccess.dir_exists_absolute(
			_manager.packages_dir(ROOT_ID).path_join(".staging")
		),
		"a failed derivation must remove the staging directory"
	)
	_check(
		not DirAccess.dir_exists_absolute(_manager.revision_dir(ROOT_ID, 8)),
		"a failed derivation must not create the revision directory"
	)
	_check(not _failed.is_empty(), "a failed derivation must emit package_failed")
	_check(
		_applied_for(ROOT_ID).is_empty(),
		"a failed derivation must not emit package_applied"
	)


## A cached artifact is only reused when its marker names this exact revision and
## key and every manifest file still has the size it was written with. The marker
## may also record the on-disk size of a file whose bytes were rewritten after
## publishing (a relocated `user://` prefix), and that recorded size is verified
## against the disk instead of trusted.
func _test_artifact_marker_verification() -> void:
	_check(
		AssetDeriver.derived_files(["art/pic.png"]) == PackedStringArray(
			["art/pic.png.image.res", "art/pic.png.import"]
		),
		"a raw texture must require its derived resource and sidecar",
	)
	_check(
		AssetDeriver.derived_files(
			["art/pic.png", "art/pic.png.image.res"]
		).is_empty(),
		"a declared derived file must not be required twice",
	)
	var store := ArtifactStore.new(Callable(_manager, "packages_root"))
	var slug := "probe"
	var key := "b".repeat(64)
	var dir := store.revision_dir(slug, 1, key)
	_check(not dir.is_empty(), "the probe directory must have a path")
	DirAccess.make_dir_recursive_absolute(dir)
	# `FileAccess.open` never creates parent directories.
	DirAccess.make_dir_recursive_absolute(dir.path_join("scripts"))
	var body := "probe"
	var handle := FileAccess.open(dir.path_join("scripts/probe.gd"), FileAccess.WRITE)
	handle.store_string(body)
	handle.close()
	var files: Array = [
		{"filepath": "scripts/probe.gd", "size": body.length(), "sha256": ""},
	]
	_check(
		not bool(
			store.reusable_artifact(1, slug, 1, key, files).get("reusable", true)
		),
		"an artifact without a marker must not be reusable",
	)
	_check(
		store.write_marker(dir, 1, slug, 1, key, body.length(), files.size()).is_empty(),
		"the marker must be written",
	)
	var hit := store.reusable_artifact(1, slug, 1, key, files)
	_check(bool(hit.get("reusable", false)), "a complete artifact must be reusable")
	_check(
		bool(hit.get("derive_current", false)),
		"the marker must carry the current derive version",
	)
	_check(
		(hit.get("missing_derived", PackedStringArray()) as PackedStringArray).is_empty(),
		"an artifact without raw assets derives nothing",
	)
	# The manifest says 999 bytes because the file is expected to be relocated;
	# the marker's stored size is what a later run has to verify.
	var relocated: Array = [
		{"filepath": "scripts/probe.gd", "size": 999, "sha256": ""},
	]
	_check(
		store.write_marker(
			dir,
			1,
			slug,
			1,
			key,
			body.length(),
			files.size(),
			{"scripts/probe.gd": body.length()},
		).is_empty(),
		"the marker with stored sizes must be written",
	)
	var relocated_hit := store.reusable_artifact(1, slug, 1, key, relocated)
	_check(
		bool(relocated_hit.get("reusable", false)),
		"a recorded stored size must win over the manifest size",
	)
	var stored: Dictionary = relocated_hit.get("stored_sizes", {})
	_check(
		int(stored.get("scripts/probe.gd", 0)) == body.length(),
		"a hit must report the stored sizes, so a rewrite keeps them",
	)
	_check(
		store.write_marker(
			dir,
			1,
			slug,
			1,
			key,
			body.length(),
			files.size(),
			{"scripts/probe.gd": body.length() + 1},
		).is_empty(),
		"the marker with a wrong stored size must be written",
	)
	_check(
		not bool(
			store.reusable_artifact(1, slug, 1, key, relocated).get("reusable", true)
		),
		"a recorded stored size must still be checked against the disk",
	)
	_check(
		store.write_marker(dir, 1, slug, 1, key, body.length(), files.size()).is_empty(),
		"the plain marker must be restored",
	)
	var marker: Variant = JSON.parse_string(
		FileAccess.get_file_as_string(dir.path_join(ArtifactStore.MARKER_FILE))
	)
	_check(
		typeof(marker) == TYPE_DICTIONARY
		and not (marker as Dictionary).has("storedSizes"),
		"a marker without stored sizes must not carry the key",
	)
	_check(
		not bool(
			store.reusable_artifact(1, slug, 2, key, files).get("reusable", true)
		),
		"a marker of another revision must not match",
	)
	_check(
		not bool(
			store.reusable_artifact(
				1, slug, 1, "c".repeat(64), files
			).get("reusable", true)
		),
		"a marker of another artifact key must not match",
	)
	handle = FileAccess.open(dir.path_join("scripts/probe.gd"), FileAccess.WRITE)
	handle.store_string("probe-too-long")
	handle.close()
	_check(
		not bool(
			store.reusable_artifact(1, slug, 1, key, files).get("reusable", true)
		),
		"a file of the wrong size must not be reused",
	)
	store.remove_tree(dir)


# --- fixture transport ----------------------------------------------------


## Minimal HTTP stand-in: receives the same relative path `_request` would use,
## waits one frame (so concurrent syncs interleave) and returns the same
## response shape.
func _transport(path: String) -> Dictionary:
	_requests.append(path)
	await _next_frame()
	var query := ""
	var query_index := path.find("?")
	if query_index >= 0:
		query = path.substr(query_index + 1)
		path = path.substr(0, query_index)
	var parts := path.trim_prefix("/").split("/")

	if parts.size() == 3 and parts[2] == "manifest":
		var package_id := int(parts[1])
		if not _latest.has(package_id):
			return _not_found()
		return _json({
			"packageId": package_id,
			"slug": _slug_for(package_id),
			"name": "package-%d" % package_id,
			"revision": int(_latest[package_id]),
		})

	if parts.size() == 5 and parts[4] == "runtime-manifest":
		var key := "%s:%s" % [parts[1], parts[3]]
		if not _manifests.has(key):
			return _not_found()
		return _json(_manifests[key])

	if parts.size() >= 6 and parts[4] == "runtime-files":
		var filepath := "/".join(parts.slice(5))
		var key := "%s:%s:%s" % [parts[1], parts[3], filepath]
		if not _files.has(key):
			return _not_found()
		var manifest_key := _manifest_key(int(parts[1]), int(parts[3]))
		if query != "room=%s&key=%s&token=%s-%s" % [
			ROOM, manifest_key, parts[1], parts[3]
		]:
			return _not_found()
		return {
			"ok": true,
			"status": 200,
			"error": "",
			"body": _corrupt(key, _files[key]),
			"text": "",
		}

	return _not_found()


func _json(body: Dictionary) -> Dictionary:
	return {
		"ok": true,
		"status": 200,
		"error": "",
		"body": PackedByteArray(),
		"text": JSON.stringify(body),
	}


func _not_found() -> Dictionary:
	return {"ok": false, "status": 404, "error": "HTTP 404", "body": PackedByteArray()}


## Applies a fault to a response body: a wrong length or a corrupted byte, while
## the manifest still describes the original file.
func _corrupt(key: String, body: PackedByteArray) -> PackedByteArray:
	var mode := str(_faults.get(key, ""))
	if mode == "size":
		var longer := body.duplicate()
		longer.append(0)
		return longer
	if mode == "hash":
		var same := body.duplicate()
		if same.is_empty():
			same.append(0)
		else:
			same[0] = int(same[0]) ^ 0xFF
		return same
	return body


## Registers a published runtime artifact and makes it the package's latest.
func _publish(
	package_id: int,
	revision: int,
	files: Dictionary,
	dependencies: Array = [],
	scenes: Dictionary = {},
) -> void:
	var entries: Array = []
	var paths := files.keys()
	paths.sort()
	var total_size := 0
	for filepath: Variant in paths:
		var raw: Variant = files[filepath]
		var body: PackedByteArray
		if typeof(raw) == TYPE_PACKED_BYTE_ARRAY:
			body = raw
		else:
			body = str(raw).to_utf8_buffer()
		var digest := _manager._sha256(body)
		entries.append({"filepath": str(filepath), "size": body.size(), "sha256": digest})
		_files["%d:%d:%s" % [package_id, revision, filepath]] = body
		total_size += body.size()
	var normalized: Array = []
	for dependency: Variant in dependencies:
		var entry: Dictionary = dependency
		var dependency_id := int(entry.get("packageId", 0))
		var dependency_revision := int(entry.get("revision", 0))
		normalized.append({
			"packageId": dependency_id,
			"revision": dependency_revision,
			"name": "package-%d" % dependency_id,
			"artifactKey": _manifest_key(dependency_id, dependency_revision),
		})
	_manifests["%d:%d" % [package_id, revision]] = {
		"packageId": package_id,
		"slug": _slug_for(package_id),
		"name": "package-%d" % package_id,
		"revision": revision,
		"roomId": int(ROOM),
		"publishedAt": "2026-10-30T00:00:00.000Z",
		"artifactKey": _closure_key(package_id, revision, normalized),
		"files": entries,
		"totalSize": total_size,
		"dependencies": normalized,
		"sceneDependencies": scenes,
		"download": {"token": "%d-%d" % [package_id, revision], "expiresAt": 0},
	}
	_latest[package_id] = revision


func _dependency(package_id: int, revision: int) -> Dictionary:
	return {
		"packageId": package_id,
		"revision": revision,
		"name": "package-%d" % package_id,
		"artifactKey": _manifest_key(package_id, revision),
	}


## On-disk folder of a fixture package. The numeric id stays the identity in
## state and snapshots; only the folder is addressed by a slug.
func _slug_for(package_id: int) -> String:
	return "pkg_%d" % package_id


## Artifact key of a manifest already in the fixture, or a deterministic
## fallback for a dependency that was not published yet.
func _manifest_key(package_id: int, revision: int) -> String:
	var key := "%d:%d" % [package_id, revision]
	if _manifests.has(key):
		return str(_manifests[key].get("artifactKey", ""))
	return key.sha256_text()


## Mirrors the server: the key covers the resolved closure including the bytes
## of every file, so a same-revision rebuild changes it.
func _closure_key(package_id: int, revision: int, dependencies: Array) -> String:
	var seen := {}
	var entries: Array = []
	var queue: Array = [[package_id, revision, dependencies]]
	while not queue.is_empty():
		var item: Array = queue.pop_front()
		var id := int(item[0])
		var rev := int(item[1])
		var pair_key := "%d:%d" % [id, rev]
		if seen.has(pair_key):
			continue
		seen[pair_key] = true
		entries.append({
			"packageId": id,
			"revision": rev,
			"files": _file_digests(id, rev),
		})
		var manifest: Dictionary = _manifests.get(pair_key, {})
		for dependency: Variant in item[2]:
			var entry: Dictionary = dependency
			var dependency_id := int(entry.get("packageId", 0))
			var dependency_revision := int(entry.get("revision", 0))
			var dependency_manifest: Dictionary = _manifests.get(
				"%d:%d" % [dependency_id, dependency_revision], {}
			)
			queue.append([
				dependency_id,
				dependency_revision,
				dependency_manifest.get("dependencies", []),
			])
	entries.sort_custom(
		func(a: Dictionary, b: Dictionary) -> bool:
			return a.packageId < b.packageId or (
				a.packageId == b.packageId and a.revision < b.revision
			)
	)
	return JSON.stringify(entries).sha256_text()


func _file_digests(package_id: int, revision: int) -> Array:
	var prefix := "%d:%d:" % [package_id, revision]
	var paths: Array = []
	for key: Variant in _files:
		var entry := str(key)
		if entry.begins_with(prefix):
			paths.append(entry.substr(prefix.length()))
	paths.sort()
	var digests: Array = []
	for filepath: String in paths:
		digests.append([filepath, _manager._sha256(_files[prefix + filepath])])
	return digests


# --- async helpers --------------------------------------------------------


func _next_frame() -> void:
	var loop := Engine.get_main_loop()
	if loop is SceneTree:
		await (loop as SceneTree).process_frame


## A manager of the same room with no in-memory state, like a page reload.
func _restarted_manager() -> PackagesManager:
	var restarted := PackagesManager.new()
	restarted.configure("http://127.0.0.1:1", ROOM)
	restarted.request_override = _transport
	restarted.trace_sync_order = true
	return restarted


func _sync_into(results: Array, index: int, package_id: int) -> void:
	results[index] = await _manager.sync_package(package_id)


func _sync_explicit_into(
	results: Array, index: int, package_id: int, revision: int
) -> void:
	results[index] = await _manager.sync_package(package_id, revision)


## Waits until both concurrent calls stored a result, with a hard deadline so a
## regression cannot hang the headless run.
func _await_results(results: Array) -> void:
	var deadline := Time.get_ticks_msec() + 20_000
	while _results_pending(results) and Time.get_ticks_msec() < deadline:
		await _next_frame()
	_check(not _results_pending(results), "concurrent syncs did not finish in time")


func _results_pending(results: Array) -> bool:
	for result: Variant in results:
		if typeof(result) != TYPE_DICTIONARY:
			return true
	return false


# --- signal capture and assertions ---------------------------------------


func _on_package_applied(
	package_id: int, revision: int, changed_files: PackedStringArray
) -> void:
	_applied.append(
		{"package_id": package_id, "revision": revision, "changed_files": changed_files}
	)


func _on_package_failed(package_id: int, error: String) -> void:
	_failed.append({"package_id": package_id, "error": error})


func _on_package_progress(
	package_id: int,
	name: String,
	revision: int,
	loaded_bytes: int,
	total_bytes: int,
	status: String,
	error: String,
) -> void:
	_progress.append({
		"package_id": package_id,
		"name": name,
		"revision": revision,
		"loaded_bytes": loaded_bytes,
		"total_bytes": total_bytes,
		"status": status,
		"error": error,
	})


func _applied_for(package_id: int) -> Dictionary:
	for entry: Dictionary in _applied:
		if int(entry.get("package_id", 0)) == package_id:
			return entry
	return {}


func _count_applied(package_id: int) -> int:
	var count := 0
	for entry: Dictionary in _applied:
		if int(entry.get("package_id", 0)) == package_id:
			count += 1
	return count


func _count_requests(prefix: String) -> int:
	var count := 0
	for path: String in _requests:
		if path.begins_with(prefix):
			count += 1
	return count


func _has_request_containing(fragment: String) -> bool:
	for path: String in _requests:
		if path.contains(fragment):
			return true
	return false


func _result_ok(result: Variant) -> bool:
	return typeof(result) == TYPE_DICTIONARY and bool(result.get("ok", false))


func _revision_dirs(package_id: int) -> PackedStringArray:
	return _revision_dirs_for(_manager, package_id)


func _revision_dirs_for(
	manager: PackagesManager, package_id: int
) -> PackedStringArray:
	var names := PackedStringArray()
	var dir := DirAccess.open(manager.packages_dir(package_id))
	if dir == null:
		return names
	for name: String in dir.get_directories():
		var base := name.get_slice("-", 0)
		if base.is_valid_int() and not names.has(base):
			names.append(base)
	names.sort()
	return names


## Full artifact directory names (`<revision>-<artifact_key>`), sorted.
func _artifact_dirs(package_id: int) -> PackedStringArray:
	var names := PackedStringArray()
	var dir := DirAccess.open(_manager.packages_dir(package_id))
	if dir == null:
		return names
	for name: String in dir.get_directories():
		if _manager._revision_of_dir_name(name) > 0:
			names.append(name)
	names.sort()
	return names


func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _manager != null:
		_manager._remove_tree("user://wired/rooms/%s" % ROOM)
		_manager.free()
	if _failures.is_empty():
		print("PACKAGES_MANAGER_SMOKE_OK")
		quit(0)
		return
	for message: String in _failures:
		printerr("PACKAGES_MANAGER_SMOKE_FAILED %s" % message)
	quit(1)
