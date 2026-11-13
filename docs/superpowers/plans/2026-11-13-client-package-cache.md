# Клиентский кеш ревизий пакетов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Game tab переиспользует уже материализованный артефакт пакета с тем же `artifactKey` после полной перезагрузки страницы, не скачивая файлы повторно.

**Architecture:** Клиентский GDScript проверяет каталог `<slug>/<revision>-<artifactKey>/` по runtime-manifest, маркеру завершённой записи и размерам файлов. Кеш живёт на отдельном IDBFS-моунте `/wired-cache` (его не трогает WASM-редактор), сервер и фронтенд не меняются.

**Tech Stack:** Godot 4.8-beta2, GDScript, headless smoke-тест на `SceneTree`, кастомный HTML-шелл web-экспорта.

**Spec:** `docs/superpowers/specs/2026-11-13-client-package-cache-design.md`

## Global Constraints

- Меняются только: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd`, `.../global/artifact_store.gd`, `.../global/asset_deriver.gd`, `.../scripts/main_scene.gd`, `.../_wired/web/shell.html`, `.../tests/packages_manager_smoke.gd`. Сервер, `packages/shared`, фронтенд и API не меняются.
- Web-корень кеша: `/wired-cache/wired/rooms/<room>/packages`; нативная сборка остаётся на `user://wired/rooms/...`.
- Маркер: файл `.wired-artifact.json`, `formatVersion == 1`.
- Выключатель функции: `const CACHE_REUSE := true` в `packages_manager.gd`.
- GDScript: табы для отступов, `snake_case`, типизированные сигнатуры; комментарии — по-английски, как в файлах.
- Тесты (PowerShell, из корня репозитория):

  ```powershell
  & "packages/server/godot_runtime/4.8-beta2-win32-x64/Godot_v4.8-beta2_win64_console.exe" --headless --path packages/server/godot_project/_wired --script res://tests/packages_manager_smoke.gd --quit-after 600
  ```

  Признак успеха: последняя строка `PACKAGES_MANAGER_SMOKE_OK` и `$LASTEXITCODE == 0`. Строки `ERROR:` от теста намеренной ошибки вывода ассетов ожидаемы.
- Коммиты — Conventional Commits, один коммит на задачу.
- Никаких новых зависимостей и генераторов кода.

## Review Focus

1. Каталог записан частично (IDBFS потерял свежие записи) — должен быть промах, а не загрузка битых файлов. Тест: Task 3, `_test_cache_rejects_corrupt_artifact`.
2. Маркер от другой ревизии/ключа (переопубликовали зависимость) — переиспользования быть не должно. Тесты: Task 2 (`reusable_artifact`), Task 3 (`_test_cache_key_change_downloads`).
3. Валидный маркер, но пропал производный `.image.res` — ремонт без скачивания. Тест: Task 4.
4. `/wired-cache` не смонтирован (старый экспорт/шелл) — игра обязана стартовать на `user://`, а не писать в непостоянный MEMFS. Тест: Task 1 (`storage_root`), проверка в браузере: Task 6.
5. Одинаковая ревизия, новые байты (новый `artifactKey`) — старый кеш не должен отдаваться. Тест: Task 3, обновлённый `_test_same_revision_refresh`.

---

### Task 1: Web-корень кеша и второй IDBFS-моунт

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd:4-11,58-63,166-167,199-202`
- Modify: `packages/server/godot_project/_wired/_wired/web/shell.html:319-332`
- Test: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd` (`_run`, новая `_test_storage_root`)

**Interfaces:**
- Consumes: ничего.
- Produces: `PackagesManager.WEB_CACHE_MOUNT: String`, `PackagesManager.WEB_PACKAGES_ROOT: String`, `PackagesManager.storage_root() -> String`; `packages_root()` и `_slug_index_path()` строятся от `storage_root()`.

- [ ] **Step 1: Написать падающий тест**

В `_run` после `_manager.package_progress.connect(_on_package_progress)` (строка ~77) добавить `_test_storage_root()`. Саму функцию — после `_test_room_normalization`:

```gdscript
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: команда из Global Constraints.
Expected: `Invalid call. Nonexistent function 'storage_root'` (тест не доходит до `PACKAGES_MANAGER_SMOKE_OK`).

- [ ] **Step 3: Реализовать `storage_root()` и моунт в шелле**

В `packages_manager.gd` рядом с `PACKAGES_ROOT`:

```gdscript
## The Web build mounts this extra persistent path (see `_wired/web/shell.html`),
## so the package cache is not part of the `/userfs` database the WASM editor
## mounts and flushes.
const WEB_CACHE_MOUNT := "/wired-cache"
const WEB_PACKAGES_ROOT := "/wired-cache/wired/rooms"
```

`packages_root()` и `_slug_index_path()`:

```gdscript
## Root every package path is built from. The Web build keeps the cache on its
## own IDBFS mount; when the mount is absent (older export, host page without the
## override) `initFS` still creates the directory in MEMFS, so the mount is
## probed instead of trusting the platform.
func storage_root() -> String:
	if OS.has_feature("web") and DirAccess.dir_exists_absolute(WEB_CACHE_MOUNT):
		return WEB_PACKAGES_ROOT
	return PACKAGES_ROOT
```

- `packages_root()` → `return storage_root().path_join(room).path_join("packages")`
- `_slug_index_path()` → `return storage_root().path_join(room).path_join(SLUG_INDEX_FILE)`
- Обновить шапку файла (строки 4–11): упомянуть, что на web корень — `/wired-cache/wired/rooms`.

В `shell.html` внутрь `startGame({...})`, перед `onProgress`:

```js
					persistentPaths: ['/userfs', '/wired-cache'],
```

и комментарий над ним: кеш пакетов живёт вне `/userfs`, потому что редактор комнаты монтирует ту же базу и своими сбросами удаляет чужие записи.

- [ ] **Step 4: Убедиться, что тест проходит**

Run: команда из Global Constraints.
Expected: `PACKAGES_MANAGER_SMOKE_OK`, exit code 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd packages/server/godot_project/_wired/_wired/web/shell.html packages/server/godot_project/_wired/tests/packages_manager_smoke.gd
git commit -m "feat(wired): mount a game-only cache path for package files"
```

---

### Task 2: Маркер артефакта и проверка переиспользования

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/artifact_store.gd:31-35,157` (константы и новые методы после `swap`)
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/asset_deriver.gd:23,103` (`VERSION`, `derived_files`)
- Test: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd` (новая `_test_artifact_marker_verification`, вызов в `_run`)

**Interfaces:**
- Consumes: `storage_root()`/`packages_root()` из Task 1.
- Produces:
  - `AssetDeriver.VERSION: int`
  - `AssetDeriver.derived_files(filepaths: Array) -> PackedStringArray`
  - `ArtifactStore.MARKER_FILE: String`, `ArtifactStore.MARKER_FORMAT_VERSION: int`
  - `ArtifactStore.write_marker(dir: String, package_id: int, slug: String, revision: int, artifact_key: String, total_size: int, file_count: int) -> String` (пустая строка — успех)
  - `ArtifactStore.reusable_artifact(package_id: int, slug: String, revision: int, artifact_key: String, files: Array) -> Dictionary` с ключами `reusable: bool`, `dir: String`, `derive_current: bool`, `missing_derived: PackedStringArray`, `error: String`

- [ ] **Step 1: Написать падающий тест**

Новая функция после `_test_asset_derivation_failure`; вызов в `_run` после `_test_storage_root()`:

```gdscript
func _test_artifact_marker_verification() -> void:
	_check(
		AssetDeriver.derived_files(["art/pic.png"]) == PackedStringArray(
			["art/pic.png.image.res", "art/pic.png.import"]
		),
		"a raw texture must require its derived resource and sidecar",
	)
	_check(
		AssetDeriver.derived_files(["art/pic.png", "art/pic.png.image.res"]).is_empty(),
		"a declared derived file must not be required twice",
	)
	var store := ArtifactStore.new(Callable(_manager, "packages_root"))
	var slug := "probe"
	var key := "b".repeat(64)
	var dir := store.revision_dir(slug, 1, key)
	_check(not dir.is_empty(), "the probe directory must have a path")
	DirAccess.make_dir_recursive_absolute(dir)
	var body := "probe"
	var handle := FileAccess.open(dir.path_join("scripts/probe.gd"), FileAccess.WRITE)
	handle.store_string(body)
	handle.close()
	var files: Array = [
		{"filepath": "scripts/probe.gd", "size": body.length(), "sha256": ""},
	]
	_check(
		not bool(store.reusable_artifact(1, slug, 1, key, files).get("reusable", true)),
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
	_check(
		not bool(store.reusable_artifact(1, slug, 2, key, files).get("reusable", true)),
		"a marker of another revision must not match",
	)
	_check(
		not bool(
			store.reusable_artifact(1, slug, 1, "c".repeat(64), files).get("reusable", true)
		),
		"a marker of another artifact key must not match",
	)
	handle = FileAccess.open(dir.path_join("scripts/probe.gd"), FileAccess.WRITE)
	handle.store_string("probe-too-long")
	handle.close()
	_check(
		not bool(store.reusable_artifact(1, slug, 1, key, files).get("reusable", true)),
		"a file of the wrong size must not be reused",
	)
	store.remove_tree(dir)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: команда из Global Constraints.
Expected: `Invalid call. Nonexistent function 'derived_files'`.

- [ ] **Step 3: Реализовать `VERSION`, `derived_files` и методы `ArtifactStore`**

В `asset_deriver.gd`:

```gdscript
## Bumped on any change of the derivation rules (extensions, suffixes, sidecar
## contents). The marker of a cached artifact stores it, so an older cache is
## re-derived instead of serving files the new rules no longer describe.
const VERSION := 1
```

`derived_files` — ровно то же правило пропуска, что в `derive()`:

```gdscript
## Names derived next to the raw files of `filepaths`: `<file><suffix>` and
## `<file>.import`, skipping any name the artifact already declares (the skip
## rule of `derive()`).
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
```

В `artifact_store.gd` — константы рядом с `STAGING_DIR`/`PREVIOUS_DIR`:

```gdscript
## Written into an artifact directory after everything else, so a directory that
## carries it is a completed apply and not a partially written one.
const MARKER_FILE := ".wired-artifact.json"
const MARKER_FORMAT_VERSION := 1
```

`write_marker` (после `swap`): строит словарь `{formatVersion, packageId, slug, revision, artifactKey, totalSize, fileCount, deriveVersion: AssetDeriver.VERSION}`, пишет `dir.path_join(MARKER_FILE)`, возвращает `""` при успехе и текст ошибки при `FileAccess.open == null` или `handle.get_error() != OK`.

`reusable_artifact` (после `write_marker`) возвращает словарь из блока Interfaces. Проверки по порядку:

1. `artifact_key.is_empty()` → `reusable: false, error: "no_key"`.
2. `dir := revision_dir(...)`; пустой путь → `"invalid_slug"`; `not DirAccess.dir_exists_absolute(dir)` → `"missing"`.
3. `FileAccess.get_file_as_string(dir.path_join(MARKER_FILE))`, `JSON.parse_string`; не словарь → `"marker_missing"`; `formatVersion != MARKER_FORMAT_VERSION` → `"marker_format"`; `packageId`/`slug`/`revision`/`artifactKey` не совпали → `"marker_mismatch"`.
4. Для каждого `file` из `files`: `filepath` непустой, размер файла (через `FileAccess.open(path, READ).get_length()`, `-1` если открыть нельзя) равен `int(file.size)`; иначе → `"file_size"`.
5. `expected := AssetDeriver.derived_files(filepaths)`, `missing := expected` без существующих файлов; `derive_current := int(marker.deriveVersion) == AssetDeriver.VERSION`.

При успехе: `{reusable: true, dir: dir, derive_current: ..., missing_derived: missing, error: ""}`. При промахе `dir` всё равно возвращается, чтобы вызывающий мог его заменить обычным `swap`.

- [ ] **Step 4: Убедиться, что тест проходит**

Run: команда из Global Constraints.
Expected: `PACKAGES_MANAGER_SMOKE_OK`, exit code 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/artifact_store.gd packages/server/godot_project/_wired/_wired/scripts/global/asset_deriver.gd packages/server/godot_project/_wired/tests/packages_manager_smoke.gd
git commit -m "feat(wired): verify cached artifacts by marker and file sizes"
```

---

### Task 3: Переиспользование артефакта при старте

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd:58-63` (`CACHE_REUSE`), `:672-690` (вызов перед `_download_files`), новый `_reuse_artifact` после `_sync_package`
- Test: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd` (`_closure_key`, `_file_digests`, `_restarted_manager`, три новых теста)

**Interfaces:**
- Consumes: `ArtifactStore.reusable_artifact(...)`, `AssetDeriver.derived_files(...)`.
- Produces: `PackagesManager.CACHE_REUSE: bool`; `PackagesManager._reuse_artifact(package_id: int, revision: int, artifact_key: String, slug: String, manifest: Dictionary, declared: Array) -> Dictionary` (пустой словарь — промах; успех — результат с `cached: true`); результат `sync_package` получает необязательный ключ `cached`.

- [ ] **Step 1: Написать падающие тесты и сделать фикстуру честной**

В фикстуре `_closure_key` ключ должен зависеть от байтов (как серверный `commitSha`), иначе сценарий «те же байты под тем же ключом» не смоделировать. Заменить тело `_closure_key` и добавить `_file_digests`:

```gdscript
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
```

Добавить хелпер «свежий процесс»:

```gdscript
## A manager of the same room with no in-memory state, like a page reload.
func _restarted_manager() -> PackagesManager:
	var restarted := PackagesManager.new()
	restarted.configure("http://127.0.0.1:1", ROOM)
	restarted.request_override = _transport
	restarted.trace_sync_order = true
	return restarted
```

Константы пакетов для кеша: `const CACHE_ID := 100`, `const CACHE_LIB_ID := 101`. Тесты — после `_test_restart_pruning`, вызовы в `_run` в этом же порядке:

```gdscript
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
```

```gdscript
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
```

```gdscript
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
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: команда из Global Constraints.
Expected: `PACKAGES_MANAGER_SMOKE_FAILED a cache hit must not download files` (первый провал), плюс, возможно, падение `_test_same_revision_refresh` из-за фикстуры — это тоже ожидаемо до реализации.

- [ ] **Step 3: Реализовать ветку переиспользования**

Константа рядом с `PACKAGES_ROOT`:

```gdscript
## Applies a locally complete artifact instead of downloading it again. The
## switch exists so the feature can be rolled back without touching the flow.
const CACHE_REUSE := true
```

В `_sync_package` сразу после `_sync_dependencies`, `trace_sync_order` и до `_download_files`:

```gdscript
	if CACHE_REUSE:
		var cached := _reuse_artifact(
			package_id, revision, artifact_key, slug, manifest, declared
		)
		if not cached.is_empty():
			return cached
```

Новый метод после `_sync_package`:

```gdscript
## Applies a revision from a verified local artifact. Returns an empty dictionary
## when the directory is not a match, so the caller downloads normally; `swap`
## then replaces the directory of that key.
func _reuse_artifact(
	package_id: int,
	revision: int,
	artifact_key: String,
	slug: String,
	manifest: Dictionary,
	declared: Array,
) -> Dictionary:
	var inspection := _artifacts.reusable_artifact(
		package_id, slug, revision, artifact_key, declared
	)
	if not bool(inspection.get("reusable", false)):
		return {}
	var dir := str(inspection.get("dir", ""))
	if dir.is_empty():
		return {}
	var hashes := {}
	var files := PackedStringArray()
	for item: Dictionary in declared:
		var filepath := str(item.get("filepath", ""))
		hashes[filepath] = str(item.get("sha256", ""))
		files.append(filepath)
	var changed := _changed_files(_file_hashes.get(package_id, {}), hashes)
	_current_revisions[package_id] = revision
	_current_artifact_keys[package_id] = artifact_key
	_scene_dependencies[package_id] = PackageManifest.scene_map(manifest)
	_file_hashes[package_id] = hashes
	_save_slug_index()
	_artifacts.prune(slug, revision, dir.get_file())
	print(
		"WIRED_PACKAGES_CACHED package=%d revision=%d artifact=%s files=%d"
		% [package_id, revision, artifact_key.left(12), files.size()]
	)
	return {
		"ok": true,
		"error": "",
		"revision": revision,
		"artifact_key": artifact_key,
		"files": files,
		"changed_files": changed,
		"cached": true,
	}
```

Переформулировать комментарий в `_sync_package_chain` (строки 508–511): «fresh call» обновляет пакет, когда меняется `artifactKey`, а не при каждом вызове.

- [ ] **Step 4: Убедиться, что весь набор проходит**

Run: команда из Global Constraints.
Expected: `PACKAGES_MANAGER_SMOKE_OK`, exit code 0. Существующие тесты `_test_concurrent_shared_dependency`, `_test_concurrent_revisions`, `_test_diamond_dependency`, `_test_restart_pruning` остаются зелёными.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd packages/server/godot_project/_wired/tests/packages_manager_smoke.gd
git commit -m "feat(wired): reuse cached package artifacts across reloads"
```

---

### Task 4: Ремонт производных файлов без скачивания

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd` (`_reuse_artifact`, блок после `reusable_artifact`)
- Test: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd` (`_publish` — поддержка `PackedByteArray`, новый тест)

**Interfaces:**
- Consumes: `inspection.derive_current`, `inspection.missing_derived`, `inspection.dir` из Task 2; `_reuse_artifact` из Task 3.
- Produces: поведение — при `derive_current == false` или непустом `missing_derived` ветка вызывает `AssetDeriver.derive(dir, dir, paths)` и перезаписывает маркер; при ошибке — промах (обычная загрузка).

- [ ] **Step 1: Написать падающий тест**

Константы: `const DERIVE_ID := 110`, `const TINY_PNG := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="` (1×1 PNG для проверки производных; если `Image.load_from_file` его не примет, заменить на любой валидный 1×1 PNG — это только тестовые данные).

В `_publish` заменить получение байтов, чтобы принимать сырые байты:

```gdscript
		var raw: Variant = files[filepath]
		var body: PackedByteArray
		if typeof(raw) == TYPE_PACKED_BYTE_ARRAY:
			body = raw
		else:
			body = str(raw).to_utf8_buffer()
```

Тест после `_test_cache_key_change_downloads`:

```gdscript
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
	marker["deriveVersion"] = 0
	var handle := FileAccess.open(marker_path, FileAccess.WRITE)
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
	restarted.free()
	stale.free()
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: команда из Global Constraints.
Expected: `PACKAGES_MANAGER_SMOKE_FAILED a repair must not download files`.

- [ ] **Step 3: Реализовать ремонт**

В `_reuse_artifact` после проверки `dir.is_empty()`:

```gdscript
	var missing: PackedStringArray = inspection.get(
		"missing_derived", PackedStringArray()
	)
	if not bool(inspection.get("derive_current", false)) or not missing.is_empty():
		var paths: Array = declared.map(
			func(item: Dictionary) -> String: return str(item.get("filepath", ""))
		)
		var derive_result := AssetDeriver.derive(dir, dir, paths)
		if not bool(derive_result.get("ok", false)):
			return {}
		var marker_error := _artifacts.write_marker(
			dir,
			package_id,
			slug,
			revision,
			artifact_key,
			int(_total_bytes.get(package_id, 0)),
			declared.size(),
		)
		if not marker_error.is_empty():
			return {}
```

При ошибке ремонта — пустой словарь: вызывающий скачает пакет, `swap` заменит каталог.

- [ ] **Step 4: Убедиться, что весь набор проходит**

Run: команда из Global Constraints.
Expected: `PACKAGES_MANAGER_SMOKE_OK`, exit code 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd packages/server/godot_project/_wired/tests/packages_manager_smoke.gd
git commit -m "fix(wired): repair derived assets of a reused artifact"
```

---

### Task 5: Сброс FS в IndexedDB после пакетного применения

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd` (флаг `_storage_dirty`, `flush_storage()`, отметки после `swap`/`prune`/ремонта)
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd:1226-1253` (после цикла предзагрузки), `:639-646` (после успешного reconcile)
- Test: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd` (новый `_test_flush_storage_clears_dirty_state`)

**Interfaces:**
- Consumes: успешные записи ветки загрузки и ветки переиспользования.
- Produces: `PackagesManager.flush_storage() -> void` — сбрасывает FS один раз на пачку, если этот процесс что-то записал; на desktop — no-op.

- [ ] **Step 1: Написать падающий тест**

Константа `const FLUSH_ID := 120`; тест после `_test_cache_repairs_derived_files`, вызов в `_run` последним:

```gdscript
func _test_flush_storage_clears_dirty_state() -> void:
	_manager.flush_storage()
	_check(not _manager._storage_dirty, "a flushed manager must not be dirty")
	_publish(FLUSH_ID, 1, {"scripts/flush.gd": "v1"})
	var result: Dictionary = await _manager.sync_package(FLUSH_ID, 1)
	_check(bool(result.get("ok", false)), "the flush fixture must apply")
	_check(_manager._storage_dirty, "a successful apply must mark the storage dirty")
	_manager.flush_storage()
	_check(not _manager._storage_dirty, "flush_storage must clear the dirty flag")
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: команда из Global Constraints.
Expected: `Invalid get index '_storage_dirty'` (или `Nonexistent function 'flush_storage'`).

- [ ] **Step 3: Реализовать флаг и сброс**

Рядом с `_sync_order`:

```gdscript
## Set when this process changed the package files, so `flush_storage()` syncs
## once per batch instead of per package.
var _storage_dirty := false
```

После `set_api_base`:

```gdscript
## Persists the browser file system after a batch of applies. IDBFS mirrors the
## whole in-memory tree into IndexedDB, which is too expensive per package and is
## skipped while another sync is in flight, so callers flush when their batch is
## done. A desktop build has nothing to persist.
func flush_storage() -> void:
	if not _storage_dirty:
		return
	_storage_dirty = false
	if not OS.has_feature("web"):
		return
	JavaScriptBridge.force_fs_sync()
```

Отметки `_storage_dirty = true`: после успешного `swap` в `_sync_package` (перед публикацией состояния), после `prune` в `_reuse_artifact`, после успешной записи маркера в блоке ремонта.

В `main_scene.gd` — после цикла предзагрузки, перед `print("WIRED_CLIENT_STARTING ...")`:

```gdscript
	_packages.flush_storage()
```

и в `_apply_world_snapshot_owned` сразу после блока `if not await _reconcile_client_packages(packages): ... return`:

```gdscript
	_packages.flush_storage()
```

- [ ] **Step 4: Убедиться, что весь набор проходит**

Run: команда из Global Constraints.
Expected: `PACKAGES_MANAGER_SMOKE_OK`, exit code 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd packages/server/godot_project/_wired/_wired/scripts/main_scene.gd packages/server/godot_project/_wired/tests/packages_manager_smoke.gd
git commit -m "feat(wired): flush the browser file system once per package batch"
```

---

### Task 6: Ручная проверка в браузере

**Files:** без изменений кода.

- [ ] **Step 1:** Пересобрать экспорт: `pnpm export:game` (нужны `fetch:runtime` и `fetch:templates`). Ожидается успешное завершение.
- [ ] **Step 2:** Запустить `pnpm dev:server` и `pnpm --filter frontend dev -- -p 3001`, открыть комнату → Game tab.
- [ ] **Step 3:** DevTools → Application → IndexedDB: должны быть две базы — `/userfs` и `/wired-cache`. Если база одна, ключ `persistentPaths` в шелле не применился: проверить написание ключа (`Config.update` молча игнорирует неизвестные).
- [ ] **Step 4:** Network, фильтр `runtime-files`: на первом старте запросы есть, игра работает и сцена инстанцируется. Полная перезагрузка страницы — запросов `runtime-files` нет, в консоли `WIRED_PACKAGES_CACHED`, игра работает.
- [ ] **Step 5:** Открыть редактор комнаты, создать и удалить файл пакета (это вызывает `syncfs` редактора), вернуться в Game tab и перезагрузить страницу: запросов `runtime-files` по-прежнему нет. Это главная проверка изоляции.
- [ ] **Step 6:** Переопубликовать зависимость и перезагрузить страницу: зависимый пакет скачивается целиком (новый `artifactKey`), остальные — из кеша.
- [ ] **Step 7:** Если на шаге 3/4 применение падает (в консоли `cannot create`/`asset_derive_failed`, нет `WIRED_PACKAGES_CACHED`), значит absolute-путь вне `user://` не поддерживается движком: остановиться и вернуться к спецификации (вариант C — Cache API/OPFS), не «чинить» это на месте.

Результат проверки (что прошло, какие логи) записать в сообщение коммита или PR.
