# Пресеты импорта в пакетах — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Настройки импорта Godot (`*.import`) становятся содержимым пакета в нормализованном виде и автоматически восстанавливаются, когда Godot перегенерировал сайдкар с нуля.

**Architecture:** Нормализация живёт в ядре редактора (`WiredPackageFs`, GDScript): из `.import` вырезаются машинно-зависимые `[remap] path*/metadata/valid` и весь `[deps]`, остаются `importer`, `importer_version`, `type`, `uid` и `[params]` (включая `_subresources`). Такой файл публикуется как обычное содержимое пакета. Копия пресета кэшируется в `<package>/.wired/import-presets/`, и аддон `wired_bridge` при `filesystem_changed` возвращает пресет в живой `.import`, если Godot его обнулил при замене исходника, после чего просит реимпорт. Нативный рантайм `.import` не получает — `writeArtifact` их пропускает.

**Tech Stack:** GDScript 4.8 (`_wired` addon), TypeScript/NestJS (`packages/server`), TypeScript/React/Vitest (`frontend`).

**Spec:** `docs/superpowers/specs/2026-11-12-package-import-presets-design.md`

## Global Constraints

- GDScript: отступы табами, `snake_case`, статические методы `WiredPackageFs` (класс `RefCounted`, `class_name WiredPackageFs`).
- Нормализация обязана быть идемпотентной: повторный прогон по уже нормализованному тексту даёт байт-в-байт тот же результат.
- `.import` никогда не попадает в runtime-артефакт (`writeArtifact`) и не добавляется в `TEXT_FILE_EXTENSIONS`.
- `.uid` и точечные каталоги (`.wired/`, `.godot/`) остаются editor metadata; `.import` — больше нет.
- UI-строки только через `frontend/messages/{en,ru}.json`; новых строк этот план не добавляет.
- Server: Prettier single quotes, trailing commas. Conventional Commits (`feat(core):`, `feat(server):`, `test(frontend):`).
- Новых зависимостей нет.
- Smoke-тесты `_wired` запускаются нативным Godot 4.8-beta2 (`GODOT_RUNTIME_PATH`), не web-сборкой.

**Команда прогона smoke-тестов** (PowerShell, из корня репозитория):

```powershell
$godot = ((Select-String -Path packages/server/.env -Pattern '^GODOT_RUNTIME_PATH=').Line -replace '^GODOT_RUNTIME_PATH=','').Trim('"')
& $godot --headless --path packages/server/godot_project/_wired --script res://tests/package_fs_smoke.gd --quit-after 600
```

Ожидаемый результат: `OK <n> checks` и код возврата 0; при провале печатается `FAILED` со списком.

## Review Focus

1. `.import` без исходника (сирота) — не должен публиковаться и не должен ломать `snapshot`/`collect`.
2. `_subresources` отсутствует / `{}` / `{  }` / однострочный / многострочный — определение «пустой пресет» структурное (`str_to_var`), а не поиск подстроки.
3. Повторная нормализация уже нормализованного текста — тот же sha (иначе пакет выглядит вечно грязным).
4. Пользователь осознанно сбросил настройки, исходник не менялся — восстановление не срабатывает повторно.
5. Каталог `.wired/import-presets` переживает подмену ревизии (`op_replace`), не публикуется и не мешает удалению файлов.

---

### Task 1: Нормализация `.import` и публикация в snapshot/collect

**Files:**
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd`
- Modify: `packages/server/godot_project/_wired/tests/package_fs_smoke.gd`

**Interfaces:**
- Produces:
  - `static func normalize_import_text(text: String) -> String`
  - `static func import_preset_is_empty(text: String) -> bool` — `true`, если `_subresources` отсутствует, пустой, или не разбирается как Dictionary; `false`, если в нём есть хотя бы одна запись.
  - `static func import_source_rel_path(import_rel_path: String) -> String` — `player/dude.glb.import` → `player/dude.glb`.
  - `static func import_source_exists(package_slug: String, import_rel_path: String) -> bool`
- Consumes: существующие `packages_root()`, `package_dir()`, `_list_files()`.

- [ ] **Step 1: Написать падающие тесты нормализации**

В `package_fs_smoke.gd` добавить три теста и вызовы в `_initialize()` (сразу после `_test_create_dir`).

```gdscript
func _test_import_normalized() -> void:
	var problems: Array = []
	var raw := """; machine note
[remap]

importer="scene"
importer_version=1
type="PackedScene"
uid="uid://abc"
path="res://.godot/imported/dude.glb-deadbeef.scn"
metadata={
"imported_formats": ["s3tc_bptc"]
}
valid=true

[deps]

source_file="res://packages/hero/dude.glb"
dest_files=["res://.godot/imported/dude.glb-deadbeef.scn"]

[params]

materials/extract=0
_subresources={
"animations": {
"Action": {
"settings/loop_mode": 1
}
}
}
"""
	var expected := """[remap]

importer="scene"
importer_version=1
type="PackedScene"
uid="uid://abc"

[params]

materials/extract=0
_subresources={
"animations": {
"Action": {
"settings/loop_mode": 1
}
}
}
"""
	var normalized: String = WiredPackageFs.normalize_import_text(raw)
	_expect(problems, normalized == expected, "нормализованный текст не совпал:\n%s" % normalized)
	_expect(problems, WiredPackageFs.normalize_import_text(normalized) == normalized, "нормализация не идемпотентна")
	_expect(problems, not WiredPackageFs.import_preset_is_empty(normalized), "непустой _subresources распознан как пустой")
	_expect(problems, WiredPackageFs.import_preset_is_empty("[remap]\n\nimporter=\"scene\"\n\n[params]\n\n_subresources={  }\n"), "пустой _subresources распознан как непустой")
	_expect(problems, WiredPackageFs.import_preset_is_empty("[remap]\n\nimporter=\"scene\"\n\n[params]\n"), "отсутствующий _subresources распознан как непустой")
	_report("import sidecar is normalized into a portable preset", problems)


func _test_import_paths() -> void:
	var problems: Array = []
	_expect(problems, WiredPackageFs.import_source_rel_path("a/b.png.import") == "a/b.png", "путь исходника вычислен неверно")
	_expect(problems, WiredPackageFs.import_source_rel_path("root.import") == "root", "путь исходника в корне вычислен неверно")
	_report("import sidecar source path is derived from the sidecar path", problems)


func _test_import_in_snapshot_and_collect() -> void:
	var problems: Array = []
	var slug := "hero_import"
	_write(WiredPackageFs.package_dir(slug).path_join("dude.glb"), "glb")
	_write(WiredPackageFs.package_dir(slug).path_join("dude.glb.import"), "[remap]\n\nimporter=\"scene\"\ntype=\"PackedScene\"\npath=\"res://.godot/imported/x.scn\"\n\n[deps]\n\nsource_file=\"res://packages/hero_import/dude.glb\"\n\n[params]\n\n_subresources={  }\n")
	# сирота: исходника нет
	_write(WiredPackageFs.package_dir(slug).path_join("ghost.import"), "[remap]\n\nimporter=\"scene\"\n")

	var snapshot: Dictionary = WiredPackageFs.op_snapshot(slug)
	var names: Array = snapshot.get("files", {}).keys()
	names.sort()
	_expect(problems, names == ["dude.glb", "dude.glb.import"], "snapshot содержит %s" % [names])

	var collected: Dictionary = WiredPackageFs.op_collect(slug)
	var entries: Array = collected.get("files", [])
	var by_path := {}
	for entry: Dictionary in entries:
		by_path[str(entry["filepath"])] = entry
	_expect(problems, not by_path.has("ghost.import"), "сирота попала в collect")
	var import_entry: Dictionary = by_path.get("dude.glb.import", {})
	var normalized: String = WiredPackageFs.normalize_import_text(FileAccess.get_file_as_string(WiredPackageFs.package_dir(slug).path_join("dude.glb.import")))
	var bytes := normalized.to_utf8_buffer()
	_expect(problems, int(import_entry.get("size", -1)) == bytes.size(), "размер считается не по нормализованному тексту")
	_expect(problems, str(import_entry.get("sha256", "")) == normalized.sha256_text(), "sha collect не совпадает с нормализованным текстом")
	_expect(problems, str(snapshot["files"].get("dude.glb.import", "")) == normalized.sha256_text(), "sha snapshot и collect расходятся")
	_expect(problems, Marshalls.base64_to_raw(str(import_entry.get("contents_base64", ""))) == bytes, "collect отдаёт не нормализованный текст")
	_report("import sidecars are shipped normalized and orphans are dropped", problems)
```

- [ ] **Step 2: Прогнать тесты и убедиться, что падают**

Run: команда из Global Constraints.
Expected: `FAILED` с упоминанием `normalize_import_text` / отсутствующих методов.

- [ ] **Step 3: Реализовать нормализацию**

В `package_fs.gd`:

1. В `is_editor_metadata()` убрать ветку `or rel_path.ends_with(".import")`, оставив `.uid` и точечные сегменты. Обновить doc-комментарий класса (L13-15): `.import` — содержимое пакета, метаданными остаются `.uid` и точечные каталоги.
2. Добавить:

```gdscript
## Turns a Godot importer sidecar into a portable preset: keeps the [remap]
## importer identity and the [params] block, drops [deps] and the
## machine-local [remap] keys `path`, `path.*`, `metadata`, `valid`.
## Line-based, idempotent, collapses blank runs, ends with one newline.
static func normalize_import_text(text: String) -> String

## True when `[params] _subresources` is absent, an empty dictionary, or
## unparseable; false when it holds at least one entry.
static func import_preset_is_empty(text: String) -> bool

static func import_source_rel_path(import_rel_path: String) -> String
static func import_source_exists(package_slug: String, import_rel_path: String) -> bool
```

Реализация `normalize_import_text`: идти по строкам, хранить текущую секцию (`[remap]`/`[deps]`/`[params]`/прочее), отбрасывать строки, начинающиеся с `;`; в `[deps]` отбрасывать заголовок и всё содержимое; в `[remap]` отбрасывать строки, чей ключ (до первого `=`, `strip_edges`) равен `path`, начинается с `path.`, либо равен `metadata`/`valid`; при отбрасывании строки считать баланс `{`/`[` минус `}`/`]` вне двойных кавычек и пропускать следующие строки, пока баланс не станет 0 (многострочный `metadata={...}`); остальные строки сохранять. В конце — свернуть подряд идущие пустые строки в одну, убрать хвостовые пустые, соединить `\n` и добавить один завершающий `\n`.

`import_preset_is_empty`: найти в `[params]` ключ `_subresources`, собрать его значение тем же балансом скобок, `str_to_var()`; вернуть `true`, если ключа нет, `str_to_var` вернул не Dictionary или пустой Dictionary; `false` в остальных случаях (в т.ч. при ошибке разбора — консервативно считаем пресетом).

`import_source_rel_path` — `import_rel_path.get_basename()`; `import_source_exists` — `FileAccess.file_exists(package_dir(slug).path_join(import_source_rel_path(import_rel_path)))`.

- [ ] **Step 4: Прогнать тесты нормализации**

Run: команда из Global Constraints.
Expected: `_test_import_normalized` и `_test_import_paths` проходят, `_test_import_in_snapshot_and_collect` падает (`.import` всё ещё отфильтрован как метаданные).

- [ ] **Step 5: Подключить к snapshot/collect**

В `package_fs.gd`:

1. `op_snapshot`: для `rel_path.ends_with(".import")` — пропускать, если `not import_source_exists(package_slug, rel_path)`, иначе класть `normalize_import_text(_read_text(abs)).sha256_text()`; для остальных — прежний `FileAccess.get_sha256`.
2. `op_collect`: для `.import` (с той же проверкой сироты) брать `var text := normalize_import_text(_read_text(abs))`, `var contents := text.to_utf8_buffer()`, `size = contents.size()`, `sha256 = text.sha256_text()`, `contents_base64 = Marshalls.raw_to_base64(contents)`; для остальных — как было.
3. Добавить приватный `_read_text(abs_path: String) -> String` = `FileAccess.get_file_as_string(abs_path)`.
4. Обновить doc-комментарий `op_rename`: он больше не «теряет `*.import`», формулировка про `*.uid` только.

- [ ] **Step 6: Обновить `_test_metadata_excluded`**

Тест оставить с тем же ожиданием `["main.gd","sub/helper.gd"]`, но зафиксировать смысл: в фикстуре есть `b.import` **без** источника `b.png`, поэтому он отфильтрован как сирота, а не как метаданные. Переименовывать тест не нужно; в `_report` заменить описание на `"editor metadata and orphan import sidecars stay out of the tree"`. Каталог `.config/x.tres` и `a.uid` остаются вне дерева.

- [ ] **Step 7: Прогнать тесты**

Run: команда из Global Constraints.
Expected: `OK <n> checks`, код 0.

- [ ] **Step 8: Commit**

```bash
git add packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd packages/server/godot_project/_wired/tests/package_fs_smoke.gd
git commit -m "feat(core): ship normalized Godot import sidecars with the package"
```

---

### Task 2: `op_replace` и удаление файлов с учётом `.import`

**Files:**
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd`
- Modify: `packages/server/godot_project/_wired/tests/package_fs_smoke.gd`

**Interfaces:**
- Consumes: `normalize_import_text()`, `import_source_rel_path()`, `import_source_exists()` из Task 1.
- Produces: приватные `_copy_missing_import_sidecars(root: String, staging: String, old_files: Array, staged: Dictionary) -> void` и `_sidecar_rel_path(source_rel: String) -> String` (`source_rel + ".import"`).

- [ ] **Step 1: Написать падающие тесты**

```gdscript
func _test_replace_prefers_staged_import() -> void:
	var problems: Array = []
	var slug := "hero_imp_replace"
	_write(WiredPackageFs.package_dir(slug).path_join("dude.glb"), "old")
	_write(WiredPackageFs.package_dir(slug).path_join("dude.glb.import"), "[remap]\n\nimporter=\"scene\"\n\n[params]\n\n_subresources={  }\n")
	WiredPackageFs.op_prepare_replace(slug)
	var staging := WiredPackageFs.staging_dir(slug)
	_write(staging.path_join("dude.glb"), "new")
	_write(staging.path_join("dude.glb.import"), "[remap]\n\nimporter=\"scene\"\n\n[params]\n\n_subresources={\n\"animations\": {\n\"Action\": {\n\"settings/loop_mode\": 1\n}\n}\n}\n")
	var result: Dictionary = WiredPackageFs.op_replace(slug)
	var live: String = FileAccess.get_file_as_string(WiredPackageFs.package_dir(slug).path_join("dude.glb.import"))
	_expect(problems, live.contains("loop_mode"), "сайдкар из ревизии перетёрт локальным")
	_expect(problems, result["written"].has("dude.glb.import"), "сайдкар не попал в written")
	_report("replace keeps the staged import sidecar", problems)


func _test_replace_copies_local_import_for_legacy_revision() -> void:
	var problems: Array = []
	var slug := "hero_imp_legacy"
	_write(WiredPackageFs.package_dir(slug).path_join("dude.glb"), "old")
	_write(WiredPackageFs.package_dir(slug).path_join("dude.glb.import"), "[remap]\n\nimporter=\"scene\"\n\n[params]\n\n_subresources={\n\"animations\": {\n\"Action\": {\n\"settings/loop_mode\": 1\n}\n}\n}\n")
	WiredPackageFs.op_prepare_replace(slug)
	_write(WiredPackageFs.staging_dir(slug).path_join("dude.glb"), "new")
	WiredPackageFs.op_replace(slug)
	var live_path := WiredPackageFs.package_dir(slug).path_join("dude.glb.import")
	_expect(problems, FileAccess.file_exists(live_path), "локальный пресет потерян при ревизии без .import")
	_expect(problems, FileAccess.get_file_as_string(live_path).contains("loop_mode"), "локальный пресет скопирован без настроек")
	_report("replace keeps the local import sidecar when the revision has none", problems)
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

Expected: второй тест падает (`op_replace` больше не копирует `.import`, т.к. он не metadata).

- [ ] **Step 3: Реализовать**

В `op_replace`, после `_copy_editor_metadata(...)`, до переименования каталогов вызвать `_copy_missing_import_sidecars(root, staging, old_files, staged)`: для каждого `source_rel` из `staged`, который не заканчивается на `.import` и не является metadata, при отсутствии `staged.has(source_rel + ".import")` и наличии старого файла `root.path_join(source_rel + ".import")` — скопировать его в staging и пометить `staged[sidecar] = true`. При этом `.wired/` по-прежнему копируется `_copy_editor_metadata` (точечный каталог).

`written`/`deleted` не меняются: `.import` теперь не metadata и попадает в оба списка автоматически.

В `op_delete_files`: после `_remove_tree(abs_path)` для выбранного файла (не каталога) удалить `abs_path + ".import"`, если он есть, и добавить его в `deleted`; doc-комментарий переписать: метаданные рядом с выбранным файлом — это `.uid`; `.import` удаляется вместе с исходником.

- [ ] **Step 4: Обновить два существующих теста**

- `_test_metadata_preserved`: `b.import` больше **не** выживает (в staging его нет) — заменить проверку выживания на `_expect(problems, not FileAccess.file_exists(root.path_join("b.import")), ...)`; `.uid` и `.import/legacy.res` (это каталог `.import`, а не сайдкар) остаются. `written` остаётся `["new.gd"]`, в `deleted` добавляется сирота: `["b.import", "main.gd", "old.gd"]` (после сортировки).
- `_test_delete_files_keeps_metadata_of_selected_file` → переименовать в `_test_delete_files_removes_sidecar_of_selected_file` (и в `_initialize()`): после удаления `main.gd` ожидать `main.gd.import` отсутствующим, `main.gd.uid` и `.config/settings.tres` на месте; `deleted` содержит и `main.gd`, и `main.gd.import`.

- [ ] **Step 5: Прогнать тесты**

Run: команда из Global Constraints. Expected: `OK <n> checks`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd packages/server/godot_project/_wired/tests/package_fs_smoke.gd
git commit -m "feat(core): keep import sidecars across package revision swaps"
```

---

### Task 3: Кэш пресетов и `restore_import_presets`

**Files:**
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd`
- Modify: `packages/server/godot_project/_wired/tests/package_fs_smoke.gd`

**Interfaces:**
- Consumes: `normalize_import_text()`, `import_preset_is_empty()`, `import_source_rel_path()`, `_read_text()`.
- Produces:
  - `const IMPORT_PRESETS_DIR := ".wired/import-presets"`
  - `static func restore_import_presets(package_slug: String) -> Array[String]` — возвращает абсолютные editor-пути (`res://packages/<slug>/<source rel>`) восстановленных исходников; пишет пресет в живой `.import` и обновляет `applied-sha256` в кэше.

- [ ] **Step 1: Написать падающие тесты**

```gdscript
func _test_import_preset_cache_and_restore() -> void:
	var problems: Array = []
	var slug := "hero_presets"
	var root := WiredPackageFs.package_dir(slug)
	var preset := "[remap]\n\nimporter=\"scene\"\nuid=\"uid://a\"\n\n[params]\n\n_subresources={\n\"animations\": {\n\"Action\": {\n\"settings/loop_mode\": 1\n}\n}\n}\n"
	_write(root.path_join("dude.glb"), "model-v1")
	_write(root.path_join("dude.glb.import"), preset)
	WiredPackageFs.op_prepare_replace(slug)
	_write(WiredPackageFs.staging_dir(slug).path_join("dude.glb"), "model-v1")
	_write(WiredPackageFs.staging_dir(slug).path_join("dude.glb.import"), preset)
	WiredPackageFs.op_replace(slug)

	var cache_path := root.path_join(WiredPackageFs.IMPORT_PRESETS_DIR).path_join("dude.glb.import")
	_expect(problems, FileAccess.file_exists(cache_path), "пресет не закэширован при replace")
	_expect(problems, FileAccess.get_file_as_string(cache_path).begins_with("; applied-sha256="), "нет заголовка applied-sha256")

	# Godot перегенерировал сайдкар при замене модели
	_write(root.path_join("dude.glb"), "model-v2")
	_write(root.path_join("dude.glb.import"), "[remap]\n\nimporter=\"scene\"\nuid=\"uid://a\"\n\n[params]\n\n_subresources={  }\n")
	var restored: Array[String] = WiredPackageFs.restore_import_presets(slug)
	_expect(problems, restored == [root.path_join("dude.glb")], "восстановление вернуло %s" % [restored])
	_expect(problems, FileAccess.get_file_as_string(root.path_join("dude.glb.import")).contains("loop_mode"), "пресет не возвращён в живой .import")
	var second: Array[String] = WiredPackageFs.restore_import_presets(slug)
	_expect(problems, second.is_empty(), "повторное восстановление сработало без смены исходника")

	# исходник снова сменился, но пользователь осознанно сбросил настройки
	_write(root.path_join("dude.glb"), "model-v3")
	_write(root.path_join("dude.glb.import"), "[remap]\n\nimporter=\"scene\"\nuid=\"uid://a\"\n\n[params]\n\n_subresources={  }\n")
	var third: Array[String] = WiredPackageFs.restore_import_presets(slug)
	_expect(problems, third == [root.path_join("dude.glb")], "смена исходника не восстановила пресет")

	# пресет остаётся в кэше после подмены ревизии
	WiredPackageFs.op_prepare_replace(slug)
	_write(WiredPackageFs.staging_dir(slug).path_join("dude.glb"), "model-v3")
	_write(WiredPackageFs.staging_dir(slug).path_join("dude.glb.import"), preset)
	WiredPackageFs.op_replace(slug)
	_expect(problems, FileAccess.file_exists(cache_path), "кэш пресетов не пережил подмену ревизии")
	_expect(problems, not WiredPackageFs.op_snapshot(slug)["files"].has(".wired/import-presets/dude.glb.import"), "кэш пресетов попал в публикуемый snapshot")
	_report("import presets are cached and restored once per source version", problems)


func _test_import_preset_cache_removed_for_default_import() -> void:
	var problems: Array = []
	var slug := "hero_presets_default"
	var root := WiredPackageFs.package_dir(slug)
	_write(root.path_join("dude.glb.import"), "[remap]\n\nimporter=\"scene\"\n\n[params]\n\n_subresources={  }\n")
	WiredPackageFs.op_prepare_replace(slug)
	_write(WiredPackageFs.staging_dir(slug).path_join("dude.glb"), "model")
	WiredPackageFs.op_replace(slug)
	var cache_path := root.path_join(WiredPackageFs.IMPORT_PRESETS_DIR).path_join("dude.glb.import")
	_expect(problems, not FileAccess.file_exists(cache_path), "кэш создан из пустого пресета")
	_report("default import sidecars leave no preset cache", problems)
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

Expected: `FAILED`, метод `restore_import_presets` не найден.

- [ ] **Step 3: Реализовать**

В `package_fs.gd`:

1. `const IMPORT_PRESETS_DIR := ".wired/import-presets"` и `const IMPORT_PRESET_SHA_PREFIX := "; applied-sha256="`.
2. Хелперы: `_import_preset_cache_path(slug, sidecar_rel) -> String` (`package_dir(slug).path_join(IMPORT_PRESETS_DIR).path_join(sidecar_rel)`), `_store_import_preset(slug, sidecar_rel, source_sha, preset_text)` (пишет `IMPORT_PRESET_SHA_PREFIX + sha + "\n" + preset_text`, создавая каталоги), `_read_import_preset(abs_path) -> Dictionary` (`{"sha": String, "text": String}`; первая строка с префиксом, остальное — текст; при отсутствии/поломке — пустые строки).
3. `_maintain_import_presets(root, slug)` — вызывается из `op_replace` после успешной подмены: для каждого `rel` из `_list_files(root)`, заканчивающегося на `.import`, при наличии исходника: если пресет не пуст — `_store_import_preset` с текущим `FileAccess.get_sha256(source)`, иначе удалить файл кэша; затем пройти по `_list_files(root.path_join(IMPORT_PRESETS_DIR))` и удалить записи, у которых нет живого сайдкара или исходника.
4. `restore_import_presets(package_slug)`: для каждого живого `.import` в пакете — пропустить, если исходника нет, кэша нет, живой пресет не пуст, или `applied-sha256` совпадает с текущим `FileAccess.get_sha256(source)`; иначе записать текст пресета в живой `.import`, обновить кэш с новым sha и добавить `root.path_join(source_rel)` в результат. Функция ничего не пишет в каталог `.wired`, кроме обновления sha.
5. Вызвать `_maintain_import_presets(root, slug)` в конце `op_replace` (после `_remove_tree(previous)` и до `return`).

- [ ] **Step 4: Прогнать тесты**

Run: команда из Global Constraints. Expected: `OK <n> checks`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd packages/server/godot_project/_wired/tests/package_fs_smoke.gd
git commit -m "feat(core): cache and restore Godot import presets per package"
```

---

### Task 4: Хук аддона на `filesystem_changed`

**Files:**
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd`

**Interfaces:**
- Consumes: `WiredPackageFs.restore_import_presets(slug)`, `WiredPackageFs.packages_root()`, `WiredPackageFs.is_valid_slug()`, `EditorInterface.get_resource_filesystem()`.
- Produces: `func _on_filesystem_changed() -> void`, `func _restore_import_presets() -> void`.

- [ ] **Step 1: Реализовать хук**

1. Поля: `var _restore_queued := false`, `var _restoring := false`.
2. В `_enter_tree()` (до раннего `return` для не-web) подключить сигнал: `var filesystem := EditorInterface.get_resource_filesystem(); if filesystem != null: filesystem.filesystem_changed.connect(_on_filesystem_changed)`; в `_exit_tree()` — отключить, если соединение было.
3. `_on_filesystem_changed()`: `if _restore_queued or _restoring: return`, иначе `_restore_queued = true` и `call_deferred("_restore_import_presets")`.
4. `_restore_import_presets()`: сбросить `_restore_queued`, поднять `_restoring = true`, собрать слаг-каталоги через `DirAccess.get_directories_at(WiredPackageFs.packages_root())`, отфильтровать `is_valid_slug()`, для каждого вызвать `restore_import_presets`, накопить восстановленные пути; если список непуст — `EditorInterface.get_resource_filesystem().reimport_files(PackedStringArray(restored))`; в конце `_restoring = false`. Ошибки не тостовать (по дизайну без уведомлений), только `push_warning`.

- [ ] **Step 2: Проверить синтаксис**

Run:

```powershell
$godot = ((Select-String -Path packages/server/.env -Pattern '^GODOT_RUNTIME_PATH=').Line -replace '^GODOT_RUNTIME_PATH=','').Trim('"')
& $godot --headless --path packages/server/godot_project/_wired --check-only --script res://addons/wired_bridge/plugin.gd
```

Expected: без ошибок парсинга (код 0).

- [ ] **Step 3: Commit**

```bash
git add packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd
git commit -m "feat(core): restore import presets on filesystem changes"
```

---

### Task 5: Frontend — `.import` больше не метаданные

**Files:**
- Modify: `frontend/src/godot/bridge/godot-packages-fs.ts:33-44`
- Test: `frontend/src/godot/bridge/godot-packages-fs.test.ts`

**Interfaces:**
- Produces: `isEditorMetadataPath("player/dude.glb.import") === false`.

- [ ] **Step 1: Написать падающий тест**

Добавить в `describe("createPackageFileSystem", ...)` (рядом с тестом «keeps editor metadata out of collect»), импортировав `isEditorMetadataPath` в существующий импорт из `./godot-packages-fs`:

```ts
it("treats import sidecars as package content", () => {
  expect(isEditorMetadataPath("player/dude.glb.import")).toBe(false);
  expect(isEditorMetadataPath("hero.gd.uid")).toBe(true);
  expect(isEditorMetadataPath(".godot/cache")).toBe(true);
  expect(isEditorMetadataPath(".wired/import-presets/dude.glb.import")).toBe(
    true,
  );
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs`
Expected: FAIL — `expected true to be false` на первой проверке.

- [ ] **Step 3: Реализовать**

В `isEditorMetadataPath` убрать `|| filepath.endsWith(".import")`, оставив `filepath.endsWith(".uid")`; обновить doc-комментарий: `.import` — содержимое пакета (пресет импорта).

- [ ] **Step 4: Прогнать тест**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/godot/bridge/godot-packages-fs.ts frontend/src/godot/bridge/godot-packages-fs.test.ts
git commit -m "feat(frontend): treat Godot import sidecars as package content"
```

---

### Task 6: Backend — `.import` не уходит в runtime-артефакт

**Files:**
- Modify: `packages/server/src/scripting-packages/delivery/package-delivery.service.ts` (`writeArtifact`, L435-509)
- Test: `packages/server/src/scripting-packages/delivery/package-delivery.service.spec.ts`
- Test: `packages/server/src/scripting-packages/publish/package-runtime-references.spec.ts`

**Interfaces:**
- Consumes: `resolved.rootFiles` / `resolved.bytes` / `resolved.rootTextFiles` (без изменений).
- Produces: runtime-манифест и каталог артефакта без файлов `*.import`.

- [ ] **Step 1: Написать падающие тесты**

В `package-delivery.service.spec.ts`, рядом с тестом `'copies binary files byte-for-byte with the original hash'`:

```ts
it('excludes import sidecars from the runtime artifact', async () => {
  await writePublished(5, 3, {
    'hero.gd': 'extends Node',
    'dude.glb': 'glb',
    'dude.glb.import': '[remap]\n\nimporter="scene"\n\n[params]\n',
  });

  const manifest = await service.getRuntimeManifest(5, 3, 7);

  expect(manifest.files.map((file) => file.filepath)).toEqual([
    'dude.glb',
    'hero.gd',
  ]);
  expect(existsSync(resolve(artifactDir(5, 3, 7), 'dude.glb.import'))).toBe(
    false,
  );
  expect(existsSync(resolve(artifactDir(5, 3, 7), 'dude.glb'))).toBe(true);
});
```

В `package-runtime-references.spec.ts` добавить в набор проверок `isTextPackageFile`: `expect(isTextPackageFile('dude.glb.import')).toBe(false);`.

Если в `package-delivery.service.spec.ts` ещё нет импорта `resolve` из `node:path`, добавить его рядом с существующим импортом `fs`; `manifest.files` при необходимости сузить через `manifest.files!`.

- [ ] **Step 2: Прогнать тесты и убедиться, что падают**

Run: `pnpm --filter server exec jest package-delivery.service.spec package-runtime-references.spec`
Expected: новый delivery-тест падает (`.import` в манифесте и на диске); references-тест проходит сразу (он фиксирует текущее поведение — это защита от регрессии).

- [ ] **Step 3: Реализовать**

В цикле `writeArtifact` перед чтением байтов:

```ts
if (entry.filepath.endsWith('.import')) {
  continue;
}
```

Doc-комментарий `writeArtifact`: импортные сайдкары редактора не доставляются рантайму — он не умеет использовать `[remap]` в `.godot/imported`.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter server exec jest package-delivery.service.spec package-runtime-references.spec`
Expected: PASS.

- [ ] **Step 5: Проверить типы**

Run: `pnpm --filter server check-types`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages/delivery/package-delivery.service.ts packages/server/src/scripting-packages/delivery/package-delivery.service.spec.ts packages/server/src/scripting-packages/publish/package-runtime-references.spec.ts
git commit -m "feat(server): exclude import sidecars from runtime artifacts"
```

---

### Task 7: Документация

**Files:**
- Modify: `docs/superpowers/specs/2026-11-12-package-import-presets-design.md`
- Modify: `docs/superpowers/specs/2026-10-31-godot-official-editor-js-bridge-design.md`
- Modify: `docs/superpowers/plans/2026-10-30-godot-package-runtime-delivery.md`

- [ ] **Step 1: Обновить статус спеки**

В шапке `2026-11-12-package-import-presets-design.md` заменить «на согласовании» на «принято, реализуется по `docs/superpowers/plans/2026-11-12-package-import-presets.md`».

- [ ] **Step 2: Исправить устаревшие утверждения**

- `2026-10-31-godot-official-editor-js-bridge-design.md` (L144, L161): `.import` больше не editor metadata; метаданными остаются `.uid` и точечные каталоги, а `.import` публикуется нормализованным (без `[deps]` и `[remap] path/metadata/valid`).
- `2026-10-30-godot-package-runtime-delivery.md` (L17, L1032): уточнить, что `.import` может находиться в ревизии, но в runtime-артефакт не попадает (`writeArtifact` его пропускает), потому что путь `res://.godot/imported/...` в рантайме не существует.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-package-import-presets-design.md docs/superpowers/specs/2026-10-31-godot-official-editor-js-bridge-design.md docs/superpowers/plans/2026-10-30-godot-package-runtime-delivery.md
git commit -m "docs: describe import presets as package content"
```

---

## Ручная проверка после реализации

1. `pnpm dev:server` и `pnpm --filter frontend dev -- -p 3001`, открыть комнату, дождаться редактора.
2. Открыть `res://packages/cura_player/player/dude.glb.import`, убедиться, что после первой загрузки ревизии в нём есть `_subresources` и нет `[deps]`/`path=`.
3. Заменить модель: удалить `dude.glb` в доке FileSystem и перетащить новый файл с тем же именем.
4. Дождаться реимпорта, открыть Import dock: loop mode у `Action`, `Fast Run_fit` и остальных из списка должен остаться `1`, внешние материалы `NiMultiShader*.tres` — назначенными.
5. Опубликовать пакет и открыть комнату в другом браузере: настройки импорта должны приехать вместе с ревизией, `.import` — виден в списке файлов пакета.

После раскатки `cura_player` достаточно опубликовать заново — код пакета менять не нужно.
