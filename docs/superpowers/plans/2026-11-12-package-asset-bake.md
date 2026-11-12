# Запекание импортируемых ассетов при сборке runtime-артефакта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сырой `.glb` в опубликованном пакете автоматически превращается в самодостаточный `.scn` при сборке runtime-артефакта, ссылки в текстовых файлах переписываются на него, поэтому игра работает без ручного запекания автором.

**Architecture:** При сборке артефакта `AssetBakeService` планирует задания по `.glb` из замыкания, запускает один headless-процесс Godot на артефакт (кэш по содержимому + пресет), получает байты `.scn`, а `writeArtifact` добавляет их в манифест и переписывает ссылки после `rewritePackageReferences`.

**Tech Stack:** NestJS 11 + TypeScript, Jest, GDScript (Godot 4.8-beta2, `GLTFDocument` / `PackedScene` / `ResourceSaver`), существующие `PackageClosureResolver` и `PackageDeliveryService`.

**Spec:** `docs/superpowers/specs/2026-11-12-package-asset-bake-design.md`

## Global Constraints

- Поддерживается только самодостаточный `.glb`; `.gltf`, `.fbx`, `.dae`, `.obj`, `.blend` → `package_asset_bake_failed`, причина `unsupported_asset_format`, в сообщении — список файлов.
- Ассеты пакетов-зависимостей не запекаются: ссылка из текста на `<dep-slug>/…\.glb` → причина `dependency_asset_unsupported`.
- Таймаут процесса `GODOT_BAKE_TIMEOUT_MS` = `30_000`, параллелизм `GODOT_BAKE_MAX_CONCURRENCY` = `1`, кэш `GODOT_BAKE_CACHE_MAX_BYTES` = `536_870_912`.
- Запечённый файл больше `67_108_864` байт (64 МиБ, `MAX_FILE_SIZE` рантайма) → причина `baked_file_too_large`.
- Пресет — нормализованный `.import`, который уже лежит в `resolved.bytes` как `<asset>.import`; в артефакт `.import` по-прежнему не попадает.
- Внешние ресурсы (материалы пресета и их текстуры) встраиваются в `.scn`: `resource_path` очищается рекурсивно перед упаковкой.
- Порядок переписывания: сначала `rewritePackageReferences`, затем замена пути ассета на путь `.scn`.
- Новых npm-зависимостей нет. Сервер: TypeScript strict, Prettier single quotes, Conventional Commits. GDScript: табы, UTF-8, комментарии по-русски там, где так уже принято.
- `ASSET_BAKE_VERSION` и `BAKE_TOOL_VERSION` — константы в `asset-bake.constants.ts`; при изменении `wired_bake.gd` или логики запекания обе увеличиваются.

## Review Focus

1. `.glb` в пакете-зависимости: сборка падает с `dependency_asset_unsupported`, а не отдаёт в комнату сцену со ссылкой на несуществующий файл.
2. Пакет без `.import` (автор не открывал настройки импорта): запекание идёт без пресета, без ошибки и без предупреждения.
3. Повторная сборка того же артефакта: байты берутся из кэша, процесс Godot не запускается.
4. Битый `.glb` и таймаут: `package_asset_bake_failed` с путём и причиной, staging не переименовывается в готовый артефакт.
5. Материал из пресета отсутствует в пакете: `material_missing`, без тихого отката на встроенный материал.

---

### Task 1: Инструмент запекания (GDScript) и смоук-тест

**Files:**
- Create: `packages/server/godot_bake/project.godot`
- Create: `packages/server/godot_bake/bake_tool.gd`
- Create: `packages/server/godot_bake/wired_bake.gd`
- Create: `packages/server/godot_bake/tests/asset_bake_smoke.gd`

**Interfaces:**
- Produces:
  - `class_name WiredBakeTool` (в `bake_tool.gd`), `static func run(project_root: String, jobs_path: String) -> Dictionary`, возвращает `{"ok": bool, "results": Array, "errors": Array}`; `results[i] = {"output": String, "size": int, "animations": PackedStringArray, "materials": PackedStringArray, "warnings": PackedStringArray}`, `errors[i] = {"file": String, "reason": String, "message": String}`.
  - Формат `jobs.json`: `{"jobs": [{"source": "packages/<slug>/player/dude.glb", "output": "packages/<slug>/player/dude.glb.scn", "preset": "<text or null>"}]}`; пути — относительно корня временного проекта, без `res://`.
  - `wired_bake.gd` — `extends SceneTree`, читает `OS.get_cmdline_user_args()[0]`, печатает `WIRED_BAKE_OK <json>` (с `{"results": ..., "warnings": ...}`) или `WIRED_BAKE_ERROR <json>` и `quit(1)`.

- [ ] **Step 1: Написать падающий смоук-тест**

`packages/server/godot_bake/tests/asset_bake_smoke.gd` — `extends SceneTree`, константы `const ROOT := "user://asset_bake_smoke"`. Тест сам создаёт проектную песочницу `ROOT` (каталог `packages/hero/`), генерирует синтетический `.glb` через `GLTFDocument`:

```gdscript
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
	var packed := PackedScene.new()
	packed.pack(root)
	var state := GLTFState.new()
	var document := GLTFDocument.new()
	document.append_from_scene(root, state)
	document.write_to_filesystem(state, ProjectSettings.globalize_path(path))
```

Далее тест пишет внешний материал `packages/hero/preset_mat.tres` (`StandardMaterial3D` с `albedo_color = Color(1, 0, 0)` и `resource_name = "surface_a"`), собирает `jobs.json` с пресетом

```
[remap]

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
```

вызывает `WiredBakeTool.run(...)` и проверяет утверждения:

```gdscript
var baked_path: String = result["results"][0]["output"]
var packed := ResourceLoader.load("res://" + baked_path) as PackedScene
_expect(problems, packed != null, "запечённый файл не загружается как PackedScene")
var scene := packed.instantiate()
var player := scene.get_node("AnimationPlayer") as AnimationPlayer
var idle := player.get_animation("Idle")
_expect(problems, idle.loop_mode == Animation.LOOP_LINEAR, "loop_mode не применён")
var body := scene.get_node("Body") as MeshInstance3D
var applied := body.get_surface_override_material(0) as StandardMaterial3D
_expect(problems, applied != null and applied.albedo_color == Color(1, 0, 0), "внешний материал не применён")
_expect(problems, applied != null and applied.resource_path == "", "материал остался внешним")
var bytes := FileAccess.get_file_as_bytes("res://" + baked_path)
_expect(problems, bytes.find("preset_mat.tres".to_utf8_buffer()) == -1, "в .scn осталась ссылка на .tres")
_expect(problems, bytes.find("hero/model.glb".to_utf8_buffer()) == -1, "в .scn осталась ссылка на .glb")
```

Второй прогон с пресетом, где `use_external/path` указывает на `res://packages/hero/missing.tres`, проверяет `result["errors"][0]["reason"] == "material_missing"`. Третий прогон передаёт два задания сразу — битый glb (`res://packages/hero/broken.glb`, файл содержит `not a glb`) и исправный: проверяется `result["results"].size() == 1 and result["errors"].size() == 1`, то есть одна ошибка не прерывает остальные задания. Итог теста — строка `OK <n> checks` или `FAILED ...`, `quit(0)` / `quit(1)`.

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `& $godot --headless --path packages/server/godot_bake --script res://tests/asset_bake_smoke.gd --quit-after 600`

где `$godot = "packages/server/godot_runtime/4.8-beta2-win32-x64/Godot.exe"`.

Expected: FAIL — `Parse Error: Could not find type "WiredBakeTool"` (файла `bake_tool.gd` ещё нет).

- [ ] **Step 3: Реализовать инструмент**

`project.godot` — минимальный: `config_version=5`, `[application] config/name="wired_bake"`.

`bake_tool.gd`: `class_name WiredBakeTool extends RefCounted`. `static func run(project_root, jobs_path)` читает JSON, для каждого задания вызывает `_bake_job(project_root, job)` и собирает результаты/ошибки, не прерываясь на первой ошибке. `_bake_job` выполняет: `GLTFDocument.append_from_file(source_absolutes, state)` (ошибка → `{"file": source, "reason": "gltf_import_failed", "message": error_string(err)}`), `generate_scene(state)`, `_apply_preset(scene, preset_text)`, `PackedScene.pack(scene)`, `ResourceSaver.save(packed, output)`. `_apply_preset` парсит только два блока: значения `loop_mode` — регулярным выражением по строкам `_subresources` (анимация → int), материалы — тройкой `key`, `use_external/enabled`, `use_external/path`; для анимаций ищет `AnimationPlayer` обходом дерева и берёт `get_animation(name)`; для материалов обходит `MeshInstance3D`, сравнивает `get_active_material(i).resource_name` с ключом и при совпадении вызывает `mesh.set_surface_override_material(i, load(path))` (файла нет → ошибка `material_missing`); загруженный материал и всё, что на него ссылается, дублирует и рекурсивно очищает `resource_path` (`_embed(resource, seen)` по `get_property_list()`, значениям типа `Resource`/`Array[Resource]`). Признак «пресет применён» — имя анимации/материала в `results[i].animations`/`materials`; неизвестные имена — в `warnings`.

`wired_bake.gd`: `extends SceneTree`, `_initialize()` → `var result := WiredBakeTool.run("res://", OS.get_cmdline_user_args()[0])`, печать `WIRED_BAKE_OK ` / `WIRED_BAKE_ERROR ` + `JSON.stringify(...)`, `quit(0/1)`.

- [ ] **Step 4: Прогнать смоук-тест**

Run: та же команда.

Expected: `OK 8 checks`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_bake
git commit -m "feat(bake): add headless Godot tool that bakes glb scenes with import presets"
```

---

### Task 2: Выбор ассетов и планирование заданий

**Files:**
- Create: `packages/server/src/scripting-packages/delivery/asset-bake.constants.ts`
- Create: `packages/server/src/scripting-packages/delivery/asset-bake.types.ts`
- Create: `packages/server/src/scripting-packages/delivery/asset-bake.service.ts`
- Test: `packages/server/src/scripting-packages/delivery/asset-bake.service.spec.ts`

**Interfaces:**
- Consumes: `ResolvedClosure` из `publish/package-closure-resolver.ts` (`rootFiles`, `rootTextFiles`, `dependencyTextFiles`, `bytes`, `slugByPackage`).
- Produces:
  - `asset-bake.constants.ts`: `export const BAKE_TOOL_VERSION = 1;` `export const ASSET_BAKE_VERSION = 1;` `export const BAKED_SUFFIX = '.scn';` `export const UNSUPPORTED_ASSET_EXTENSIONS = ['.gltf', '.fbx', '.dae', '.obj', '.blend'] as const;`
  - `asset-bake.types.ts`: `export type BakeJob = { source: string; output: string; preset: string | null };` `export class AssetBakeError extends Error { readonly code = 'package_asset_bake_failed'; constructor(readonly reason: string, message: string) }`
  - `AssetBakeService.planJobs(resolved: ResolvedClosure, slug: string): BakeJob[]` — кидает `AssetBakeError`; не мутирует `resolved`.

- [ ] **Step 1: Написать падающие тесты**

`asset-bake.service.spec.ts` — пять кейсов на `planJobs` с самодельным `ResolvedClosure` (хелпер `makeClosure({ files, bytes, dependencyTextFiles, slugByPackage })`):

```ts
it('планирует .glb с пресетом из соседнего .import', () => {
  const jobs = service.planJobs(closure, 'hero');
  expect(jobs).toEqual([
    { source: 'player/dude.glb', output: 'player/dude.glb.scn', preset: '[remap]\n\nimporter="scene"\n' },
  ]);
});

it('планирует .glb без пресета', () => {
  expect(service.planJobs(closureWithoutImport, 'hero')[0].preset).toBeNull();
});

it('отказывает на .gltf с внешними буферами', () => {
  expect(() => service.planJobs(closureWithGltf, 'hero')).toThrow(AssetBakeError);
  expect(() => service.planJobs(closureWithGltf, 'hero')).toThrow(/unsupported_asset_format.*model\.gltf/);
});

it('отказывает на ссылке из зависимости на её же .glb', () => {
  const closure = makeClosure({ dependencyTextFiles: new Map([[9, [{ filepath: 'scene.tscn', text: 'path="res://packages/lib/model.glb"' }]]]), slugByPackage: new Map([[5, 'hero'], [9, 'lib']]) });
  expect(() => service.planJobs(closure, 'hero')).toThrow(/dependency_asset_unsupported/);
});

it('не считает упоминание в комментарии ссылкой', () => {
  const closure = makeClosure({ rootTextFiles: [{ filepath: 'notes.gd', text: '# res://packages/lib/model.glb' }], slugByPackage: new Map([[5, 'hero'], [9, 'lib']]) });
  expect(service.planJobs(closure, 'hero')).toEqual([]);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

Run: `pnpm --filter server exec jest asset-bake.service.spec`

Expected: FAIL — `Cannot find module './asset-bake.service'`.

- [ ] **Step 3: Реализовать**

`planJobs` фильтрует `resolved.rootFiles` по `filepath.toLowerCase().endsWith('.glb')`, для каждого берёт `bytes.get(filepath + '.import')` и декодирует UTF-8 (нет файла → `null`). Неподдерживаемые расширения собирает в один список и кидает `AssetBakeError('unsupported_asset_format', ...)` с перечислением. Ссылки на чужие ассеты ищет по `rootTextFiles` и всем `dependencyTextFiles` регуляркой `PACKAGE_ASSET_REFERENCE_RE = /res:\/\/packages\/([^/"\s]+)\/([^"\s]+\.(?:glb|gltf|fbx|dae|obj|blend))/gi`, пропускает строки, начинающиеся с `#` или `;`, и кидает `dependency_asset_unsupported`, если группа 1 совпадает со слагом пакета из `slugByPackage`, отличным от `slug`.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter server exec jest asset-bake.service.spec`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/delivery/asset-bake.*
git commit -m "feat(delivery): plan glb bake jobs from the package closure"
```

---

### Task 3: Кэш, запуск процесса и разбор ответа

**Files:**
- Create: `packages/server/src/scripting-packages/delivery/asset-bake-cache.ts`
- Create: `packages/server/src/scripting-packages/delivery/godot-bake.runner.ts`
- Modify: `packages/server/src/scripting-packages/delivery/asset-bake.service.ts`
- Test: `packages/server/src/scripting-packages/delivery/asset-bake.service.spec.ts`

**Interfaces:**
- Produces:
  - `export interface BakeRunner { run(options: { projectDir: string; jobsPath: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> }` и `export class ChildProcessBakeRunner implements BakeRunner` (`spawn(executablePath, ['--headless','--path',projectDir,'--script','res://wired_bake.gd','--',jobsPath], { cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })`, по таймауту `kill('SIGKILL')`, промис резолвится с кодом выхода; на Windows убивает дерево через `taskkill /pid <pid> /T /F`).
  - `export class AssetBakeCache { constructor(dir: string, maxBytes: number); keyFor(key: string): string; get(fileName: string): Buffer | null; put(fileName: string, bytes: Buffer): Promise<void>; prune(): Promise<void> }` — `keyFor` возвращает `<sha256(source)>-<sha256(preset ?? '' + BAKE_TOOL_VERSION)>.scn` через `createHash('sha256')` и `package-hash.ts`.
  - `AssetBakeService` ctor `(private readonly cache: AssetBakeCache, private readonly runner: BakeRunner, private readonly options: { projectPath: string; executablePath: string; timeoutMs: number; maxConcurrency: number })`; `async bake(resolved: ResolvedClosure, slug: string, jobs: BakeJob[]): Promise<Map<string, Buffer>>` — ключ результата `job.output`.
- Consumes: `WiredBakeTool` из Task 1 (формат `jobs.json` и `WIRED_BAKE_OK`).

- [ ] **Step 1: Написать падающие тесты**

Дополнить `asset-bake.service.spec.ts` (фейковый раннер пишет ответ в `stdout`, счётчик вызовов):

```ts
it('на попадании в кэш не запускает процесс', async () => {
  await service.bake(closure, 'hero', jobs);
  const baked = await service.bake(closure, 'hero', jobs);
  expect(runner.calls).toBe(1);
  expect(baked.get('player/dude.glb.scn')?.equals(scnBytes)).toBe(true);
});

it('падает с package_asset_bake_failed на WIRED_BAKE_ERROR', async () => {
  runner.stdout = 'WIRED_BAKE_ERROR {"errors":[{"file":"packages/hero/player/dude.glb","reason":"gltf_import_failed","message":"boom"}]}';
  await expect(service.bake(closure, 'hero', jobs)).rejects.toThrow(/dude\.glb.*gltf_import_failed.*boom/);
});

it('убивает процесс по таймауту', async () => {
  runner.run = () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 137, stdout: '', stderr: '' }), 50));
  await expect(serviceWithTimeout(10).bake(closure, 'hero', jobs)).rejects.toThrow(/timeout/);
});

it('отказывает, если запечённый файл больше 64 МиБ', async () => {
  const huge = Buffer.alloc(67_108_865);
  await expect(service.bake(closure, 'hero', [{ ...jobs[0], output: 'big.scn' }])).rejects.toThrow(/baked_file_too_large/);
});
```

Отдельно в `asset-bake-cache.spec.ts` — вытеснение по бюджету: кэш с `maxBytes = 4` принимает два файла по 3 байта, `await cache.prune()`, после чего `cache.get('a.scn')`, записанный раньше по `mtime`, равен `null`, а `cache.get('b.scn')` — нет.

- [ ] **Step 2: Прогнать и убедиться, что падают**

Run: `pnpm --filter server exec jest asset-bake.service.spec`

Expected: FAIL — `service.bake is not a function`.

- [ ] **Step 3: Реализовать**

`bake` вычисляет ключи, читает кэш, для промахов собирает один временный каталог `os.tmpdir()/wired-bake-<random>/` (`mkdtemp`): пишет `project.godot` и `wired_bake.gd` из `options.projectPath`, раскладывает `resolved.bytes` как `<tmp>/packages/<slug>/<filepath>`, пишет `jobs.json` с абсолютными внутри проекта путями `packages/<slug>/<filepath>`. Запускает раннер один раз для всех промахов, разбирает первую строку `WIRED_BAKE_OK ` / `WIRED_BAKE_ERROR ` (нет строки при `exitCode !== 0` → `AssetBakeError('bake_failed', stderr)`), читает `<tmp>/<output>`, проверяет размер, кладёт в кэш. `finally` — `rm(tmp, { recursive: true, force: true })`. Семафор на `maxConcurrency` (массив ожидающих промисов).

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter server exec jest asset-bake.service.spec`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/delivery
git commit -m "feat(delivery): run and cache headless glb bakes"
```

---

### Task 4: Интеграция в сборку артефакта и версия артефакта

**Files:**
- Modify: `packages/server/src/scripting-packages/delivery/package-delivery.service.ts:435-509` (`writeArtifact`) и конструктор сервиса
- Modify: `packages/server/src/scripting-packages/publish/package-closure-resolver.ts:299-323` (`computeArtifactKeys`)
- Test: `packages/server/src/scripting-packages/delivery/package-delivery.service.spec.ts`, `packages/server/src/scripting-packages/publish/package-closure-resolver.spec.ts`

**Interfaces:**
- Consumes: `AssetBakeService.planJobs`, `AssetBakeService.bake` (Tasks 2–3), `ASSET_BAKE_VERSION`.
- Produces: `writeArtifact` пишет запечённые `.scn` и добавляет их в `files`; `computeArtifactKeys` учитывает `assetBakeVersion` (по умолчанию `ASSET_BAKE_VERSION`).

- [ ] **Step 1: Написать падающие тесты**

В `package-delivery.service.spec.ts` (хелперы `writePublished`, `readArtifactBytes`, `artifactDir`):

```ts
it('запекает .glb и переписывает ссылку на .scn', async () => {
  await writePublished(5, 3, { 'player/model.glb': glbBytes, 'player/model.glb.import': Buffer.from(presetText), 'player/scene.tscn': '[ext_resource type="PackedScene" path="res://packages/heroes/player/model.glb" id="1"]\n' });
  const manifest = await service.getRuntimeManifest(5, 3, 7);
  const paths = manifest.files.map((file) => file.filepath);
  expect(paths).toContain('player/model.glb.scn');
  expect(paths).not.toContain('player/model.glb.import');
  const scene = (await readArtifactBytes(5, 3, 7, 'player/scene.tscn')).toString('utf8');
  expect(scene).toContain('/player/model.glb.scn');
  const entry = manifest.files.find((file) => file.filepath === 'player/model.glb.scn')!;
  expect(entry.size).toBe(bakedBytes.length);
});

it('меняет ключ артефакта при смене ASSET_BAKE_VERSION', async () => {
  const first = await createResolver({ assetBakeVersion: 1 }).resolve(5, 3, 7);
  const second = await createResolver({ assetBakeVersion: 2 }).resolve(5, 3, 7);
  expect(second.artifactKeys.get(5)).not.toBe(first.artifactKeys.get(5));
});
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

Run: `pnpm --filter server exec jest package-delivery.service.spec`

Expected: FAIL — в `files` нет `player/model.glb.scn`.

- [ ] **Step 3: Реализовать**

В `writeArtifact` перед циклом записи: `const jobs = this.assetBake.planJobs(resolved, slug); const baked = await this.assetBake.bake(resolved, slug, jobs);` и `const bakedByAsset = new Map(jobs.map((job) => [job.source, job.output]))`. После успешной записи обычных файлов — записать каждый `baked` в staging (`mkdir` + `writeFile`), добавить в `files` запись `{ filepath: output, size, sha256 }` и в `totalSize`. Переписывание: в `rewriteText` после `rewritePackageReferences` применить `replaceAll(userPath(assetRel), userPath(outputRel))` для каждого `bakedByAsset`. В `computeArtifactKeys` в хешируемый список добавить `['asset-bake', this.assetBakeVersion]`; `PackageClosureResolver` получает последним параметром конструктора `assetBakeVersion: string = ASSET_BAKE_VERSION`, чтобы тест создавал два резолвера с разными версиями, не трогая константу (хелпер `createResolver({ assetBakeVersion })` в `package-closure-resolver.spec.ts`).

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter server exec jest package-delivery.service.spec package-closure-resolver`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages
git commit -m "feat(delivery): ship baked scenes in runtime artifacts"
```

---

### Task 5: Конфигурация и подключение сервиса

**Files:**
- Modify: `packages/server/src/config/config.ts`
- Modify: `packages/server/src/scripting-packages/delivery/package-delivery.module.ts`
- Test: `packages/server/src/scripting-packages/delivery/package-delivery.module.spec.ts`

**Interfaces:**
- Produces: `config.assetBake = { projectPath: resolve(GODOT_BAKE_PROJECT_PATH ?? './godot_bake'), executablePath: config.godotRuntime.executablePath, timeoutMs: 30_000, maxConcurrency: 1, cacheDir: join(packagesFilesDir, 'bake-cache'), cacheMaxBytes: 536_870_912 }`.
- Consumes: `AssetBakeCache`, `ChildProcessBakeRunner`, `AssetBakeService` (Tasks 2–3).

- [ ] **Step 1: Написать падающий тест**

```ts
it('собирает AssetBakeService с путями из конфигурации', () => {
  const moduleRef = createModule();
  const service = moduleRef.get(AssetBakeService);
  expect(service).toBeInstanceOf(AssetBakeService);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `pnpm --filter server exec jest package-delivery.module.spec`

Expected: FAIL — `No provider for AssetBakeService`.

- [ ] **Step 3: Реализовать**

Добавить в `config.ts` блок `assetBake` (значения из Global Constraints), зарегистрировать в `package-delivery.module.ts` провайдеры `AssetBakeCache` и `AssetBakeService` (фабрики на `config.assetBake`), передать сервис в `PackageDeliveryService`.

- [ ] **Step 4: Прогнать тесты и проверку типов**

Run: `pnpm --filter server exec jest package-delivery.module.spec && pnpm --filter server check-types`

Expected: PASS, типы без ошибок.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config/config.ts packages/server/src/scripting-packages/delivery
git commit -m "feat(config): configure the asset bake pipeline"
```

---

### Task 6: Документация и интеграционный тест на реальной модели

**Files:**
- Modify: `docs/superpowers/specs/2026-11-12-package-asset-bake-design.md:3`
- Create: `packages/server/godot_bake/README.md`
- Modify: `AGENTS.md` (список env-переменных рантайма)
- Test: `packages/server/src/scripting-packages/delivery/asset-bake.integration.spec.ts`

**Interfaces:**
- Consumes: `AssetBakeService` (Task 3), реальные файлы `packages/server/godot_project/examples/cura_player/player/dude.glb` и `dude.glb.import`.

- [ ] **Step 1: Написать интеграционный тест**

```ts
const maybe = process.env.WIRED_GODOT_INTEGRATION === '1' ? it : it.skip;
const dudeDir = 'packages/server/godot_project/examples/cura_player/player';
const dudeSource = readFileSync(join(dudeDir, 'dude.glb'));
const dudePreset = readFileSync(join(dudeDir, 'dude.glb.import'), 'utf8');

function closureFromCuraPlayer(): ResolvedClosure {
  const presetBytes = Buffer.from(dudePreset);
  return {
    packageId: 5,
    name: 'Cura Player',
    revision: 36,
    roomId: 2,
    publishedAt: new Date(0),
    revisionByPackage: new Map([[5, 36]]),
    nameByPackage: new Map([[5, 'Cura Player']]),
    slugByPackage: new Map([[5, 'cura_player']]),
    artifactKeys: new Map([[5, 'test']]),
    directDependencyIds: [],
    rootTextFiles: [],
    dependencyTextFiles: new Map(),
    rootFiles: [
      { filepath: 'player/dude.glb', size: dudeSource.length, sha256: sha256Hex(dudeSource) },
      { filepath: 'player/dude.glb.import', size: presetBytes.length, sha256: sha256Hex(presetBytes) },
    ],
    bytes: new Map([
      ['player/dude.glb', dudeSource],
      ['player/dude.glb.import', presetBytes],
    ]),
  };
}

const jobs = [{ source: 'player/dude.glb', output: 'player/dude.glb.scn', preset: dudePreset }];

async function inspectBake(bytes: Buffer): Promise<{ loopModes: number[]; materials: string[] }> {
  const tmpDir = join('packages/server/godot_bake', 'tests', 'tmp');
  const tmpPath = join(tmpDir, `bake-${Date.now()}.scn`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(tmpPath, bytes);
  try {
    const { stdout } = await execFileAsync(
      config.assetBake.executablePath,
      ['--headless', '--path', 'packages/server/godot_bake', '--script', 'res://tests/inspect_bake.gd', '--', `res://tests/tmp/${basename(tmpPath)}`],
      { timeout: 30_000 },
    );
    const line = stdout.split('\n').find((entry) => entry.startsWith('WIRED_INSPECT_OK '));
    if (!line) throw new Error(`no WIRED_INSPECT_OK in ${stdout}`);
    return JSON.parse(line.slice('WIRED_INSPECT_OK '.length));
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

maybe('запекает реальный dude.glb с его пресетом', async () => {
  const result = await service.bake(closureFromCuraPlayer(), 'cura_player', jobs);
  const scene = await inspectBake(result.get('player/dude.glb.scn')!);
  expect(scene.loopModes.filter((mode) => mode === 1)).toHaveLength(9);
  expect(scene.materials).toHaveLength(14);
}, 120_000);
```

Проба внутри теста запускает тот же бинарник с `--script res://tests/inspect_bake.gd` (в `packages/server/godot_bake/tests/inspect_bake.gd`), который печатает `WIRED_INSPECT_OK <json>` с `{ "loop_modes": [...], "materials": [...] }`.
- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `$env:WIRED_GODOT_INTEGRATION="1"; pnpm --filter server exec jest asset-bake.integration`

Expected: FAIL — нет `tests/inspect_bake.gd`.

- [ ] **Step 3: Реализовать пробу и документацию**

`inspect_bake.gd` грузит `.scn`, обходит `AnimationPlayer` (собирает `loop_mode` всех анимаций) и `MeshInstance3D` (собирает `resource_name` материалов). `README.md` в `godot_bake/` описывает формат `jobs.json`, `WIRED_BAKE_OK`, правило «меняешь `bake_tool.gd` — увеличь `BAKE_TOOL_VERSION` и `ASSET_BAKE_VERSION`». В спецификации строка 3 меняется на `Статус: принято, реализуется по docs/superpowers/plans/2026-11-12-package-asset-bake.md.` В `AGENTS.md` в список runtime-настроек добавляются `GODOT_BAKE_PROJECT_PATH`, `GODOT_BAKE_TIMEOUT_MS`, `GODOT_BAKE_MAX_CONCURRENCY`, `GODOT_BAKE_CACHE_MAX_BYTES` с значениями по умолчанию.

- [ ] **Step 4: Прогнать интеграционный тест и весь серверный набор**

Run: `$env:WIRED_GODOT_INTEGRATION="1"; pnpm --filter server exec jest asset-bake.integration --runInBand`

Expected: PASS (`9` анимаций с `loop_mode = 1`, `14` материалов).

Затем: `pnpm --filter server test`, ожидается зелёный набор (кроме штатно пропущенного `room-runtime.integration`).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-package-asset-bake-design.md packages/server/godot_bake AGENTS.md packages/server/src/scripting-packages/delivery/asset-bake.integration.spec.ts
git commit -m "docs(bake): document the asset bake pipeline and cover the real model"
```

---

## Проверка вручную после реализации

1. `pnpm --filter server test` — зелёный; `pnpm --filter server check-types` — чисто.
2. Пересобрать артефакт `cura_player` (новая ревизия или `ASSET_BAKE_VERSION`), открыть комнату: в артефакте есть `player/dude.glb.scn`, в `player_model.tscn` ссылка ведёт на `.scn`, в консоли игры нет `No loader found for resource`.
3. Заменить модель в редакторе и опубликовать: loop mode и материалы сохраняются (пресет), игра грузится без ручного запекания.
