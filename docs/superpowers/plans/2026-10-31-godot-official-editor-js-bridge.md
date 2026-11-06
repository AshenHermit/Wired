# Переход на официальный Godot 4.7.2 через JS-мост — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** убрать кастомную сборку Godot с экспортом Emscripten `FS` и делать все файловые операции пакетов через `JavaScriptBridge`-плагин, а редактор скачивать скриптом с закреплённой версией 4.7.2-stable.

**Architecture:** GDScript-модуль `package_fs.gd` владеет деревом `res://packages` (snapshot/collect/staging/atomic swap/delete), `plugin.gd` — тонкий диспетчер запросов; фронтенд общается с ним через `editor-bridge.ts` (id + промисы), а байты на запись кладёт официальным `Engine.copyToFS` в staging-каталог.

**Tech Stack:** Godot 4.7.2 GDScript (`FileAccess`, `DirAccess`, `JavaScriptBridge`), TypeScript/React 19, Vitest, Node 20+ builtins, NestJS/Docker.

**Spec:** `docs/superpowers/specs/2026-10-31-godot-official-editor-js-bridge-design.md`

## Global Constraints

- Версия редактора закреплена: `4.7.2-stable`, zip `Godot_v4.7.2-stable_web_editor.zip`, sha512 `03ad6b4b4d96f0f7d85bf4fdcf29535891b79d52ee94a11e96895463a2745347b8f601b455e7a58135bf641df43fc25296bc257bbfce593d477dfa64a2272268`.
- Мост — список операций, а не `eval`-канал. Никаких произвольных строк кода из фронтенда.
- Все `packageId` — целые > 0; пути внутри пакета относительные, без `\`, без `..`, без пустых сегментов. Валидация повторяется в GDScript.
- Служебные файлы редактора (любой сегмент с `.`, `*.uid`, `*.import`) не входят в snapshot/collect/written/deleted.
- Запись байтов — только `Engine.copyToFS`; чтение — только base64 внутри `collect`.
- `PackageFileSystem`: все методы асинхронные. `GodotFsError` сохраняется как класс ошибок домена.
- Строки ошибок для пользователя — по-русски.
- Ответы моста: `{id:int, ok:true, value}` / `{id:int, ok:false, error}`.
- Серверные команды запускаются из `packages/server` (пути конфигурации считаются от cwd).
- Коммиты — Conventional Commits.

## Review Focus

- Пакет с нулём файлов или ревизия, удаляющая все файлы: `replace` должен подменить каталог на пустой, а не оставить старый.
- Первое скачивание в редактор, где каталога пакета ещё нет: `replace` без `.previous`, `deleted` пуст.
- Жёсткое падение между двумя `rename`: корня нет, `.previous` есть — следующая операция обязана вернуть `.previous`.
- Имя файла пакета, похожее на служебное (`.config/x.tres`, `foo.uid`, `bar.import`): не должно ни теряться при swap, ни попадать в манифест.
- Мост исчез/не появился/таймаут: панель не показывает ложных данных и не оставляет оптимистичное «изменено».

---

### Task 1: GDScript-модуль файловых операций

**Files:**
- Create: `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd`
- Create: `packages/server/godot_project/_wired/tests/package_fs_smoke.gd`
- Create (uid): `.../addons/wired_bridge/package_fs.gd.uid`, `.../tests/package_fs_smoke.gd.uid` — генерируются Godot при первом импорте, коммитятся вместе с файлами.

**Interfaces:**
- Consumes: ничего.
- Produces (все `static`, класс `WiredPackageFs extends RefCounted`):
  - `static var root_override: String` — пустая строка означает `res://packages`; тест подставляет `user://...`.
  - `static func packages_root() -> String`
  - `static func package_dir(package_id: int) -> String`
  - `static func staging_dir(package_id: int) -> String`
  - `static func previous_dir(package_id: int) -> String`
  - `static func is_valid_id(package_id: int) -> bool`
  - `static func is_valid_relative_path(path: String) -> bool`
  - `static func is_editor_metadata(rel_path: String) -> bool`
  - `static func restore_previous_if_needed(package_id: int) -> void`
  - `static func op_exists(package_id: int) -> Dictionary` → `{exists: bool}`
  - `static func op_create_dir(package_id: int) -> Dictionary` → `{}`
  - `static func op_snapshot(package_id: int) -> Dictionary` → `{files: {path: sha256}}`
  - `static func op_collect(package_id: int) -> Dictionary` → `{files: [{filepath, size, sha256, contents_base64}]}`
  - `static func op_prepare_replace(package_id: int) -> Dictionary` → `{staging_path: String}` (абсолютный путь)
  - `static func op_replace(package_id: int) -> Dictionary` → `{written: String[], deleted: String[]}`
  - `static func op_delete(package_id: int) -> Dictionary` → `{}`
  - На ошибке любая `op_*` возвращает `{error: String}`.

- [ ] **Step 1: Написать smoke-тест `tests/package_fs_smoke.gd`**

`extends SceneTree`, `_initialize()`:
```gdscript
WiredPackageFs.root_override = "user://package_fs_smoke"
_cleanup_root()
_check("empty snapshot", WiredPackageFs.op_snapshot(1).has("files"))
# ... сценарии
quit(0 if _failures.is_empty() else 1)
```
Обязательные проверки (имя каждой — в `_check`):
1. `snapshot` на отсутствующем пакете → `{files: {}}`.
2. `op_create_dir(7)` создаёт каталог, `op_exists(7) == {exists:true}`.
3. `prepare_replace(7)` создаёт `.<id>.staging` и возвращает абсолютный путь, оканчивающийся на `/packages/.7.staging`.
4. Файл `.config/x.tres` и `a.uid`, `b.import` не попадают в `snapshot`/`collect`.
5. `replace(7)` при пустом staging переносит пустое дерево, `deleted` содержит все прежние файлы.
6. `replace(8)` при отсутствии корня: `prepare_replace` → файл в staging → `replace` → `exists(8) == true`, `deleted == []`.
7. Служебные файлы старого корня (`.uid`, `.import`, `.import/…`) после `replace` присутствуют в новом.
8. `op_delete(8)` удаляет корень, staging и previous.
9. Восстановление: создать корень, переименовать его в `.<id>.previous` вручную, вызвать `op_exists` → корень вернулся, `exists == true`.
10. `is_valid_relative_path`: `"a/b.gd"` true; `""`, `"/a"`, `"a\\b"`, `"a/../b"`, `"a//b"` false.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/package_fs_smoke.gd --quit-after 600`
Expected: ошибка парсинга/`Identifier "WiredPackageFs" not declared`.

- [ ] **Step 3: Реализовать `package_fs.gd`**

Требования к телу:
- Обход дерева — `DirAccess.open(dir)` + `list_dir_begin()`/`get_next()`, рекурсия; сравнение `path.begins_with(...)` не использовать, только относительные сегменты.
- `sha256` — `FileAccess.get_sha256(abs_path)`; размер — `FileAccess.get_file_as_bytes(abs_path).size()`.
- `create_dir` — `DirAccess.make_dir_recursive_absolute`.
- `prepare_replace` — `restore_previous_if_needed`, затем рекурсивное удаление `previous_dir` и `staging_dir`, затем `make_dir_recursive_absolute(staging_dir)`; вернуть `ProjectSettings.globalize_path(staging_dir)`.
- `replace` — `restore_previous_if_needed`; если staging отсутствует → `{error: "staging не найден"}`; собрать список staging-файлов (все, включая служебные) и старых; скопировать из корня в staging файлы, для которых `is_editor_metadata(rel)` истинно и которых там ещё нет (`FileAccess` copy через `get_file_as_bytes`/`store_buffer`); если корень существует: `DirAccess.rename_absolute(root, previous)`, затем `DirAccess.rename_absolute(staging, root)`; при провале второго шага вернуть previous на место и удалить staging, вернуть `{error: ...}`; иначе `remove_dir_recursive(previous)`.
- `written` — файлы staging без служебных; `deleted` — файлы старого корня без служебных, отсутствующие в новом.
- `op_delete` — `restore_previous_if_needed`, затем удалить корень, staging, previous рекурсивно, ошибки складывать в `{error}`.
- `op_snapshot`/`op_collect` при отсутствующем корне — пустой результат, не ошибка.

- [ ] **Step 4: Прогнать тест**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/package_fs_smoke.gd --quit-after 600`
Expected: `OK 10 checks`, exit code 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd.uid packages/server/godot_project/_wired/tests/package_fs_smoke.gd packages/server/godot_project/_wired/tests/package_fs_smoke.gd.uid
git commit -m "feat(godot): add package file system module for the editor bridge"
```

---

### Task 2: Диспетчер запросов в `plugin.gd`

**Files:**
- Modify: `packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd` (62 строки)

**Interfaces:**
- Consumes: `WiredPackageFs` из Task 1.
- Produces для фронтенда: `window.__wiredEditorBridge.request(requestId: number, op: string, paramsJson: string)`; ответ — `window.__wiredEditorBridgeResult({id, ok, value|error})`.

- [ ] **Step 1: Расширить `_enter_tree`**

Создать второй колбэк `_on_bridge_request(_args: Array)`, сохранить оба в полях (`_rescan_callback`, `_request_callback`, иначе Godot соберёт их сборщиком мусора), затем одним `eval` зарегистрировать:
```gdscript
bridge.eval("window.__wiredEditorBridge = { rescan: window.__wiredEditorRescan, request: window.__wiredEditorRequest }; delete window.__wiredEditorRescan; delete window.__wiredEditorRequest;", true)
```
`_exit_tree` удаляет `window.__wiredEditorBridge`.

- [ ] **Step 2: Реализовать `_on_bridge_request(args)` и `_handle_request`**

- Аргументы: `args[0]` — число (приходит как `float` → `int`), `args[1]` — String op, `args[2]` — String paramsJson.
- Валидация: id > 0, op из списка `["exists","createDir","snapshot","collect","prepareReplace","replace","delete"]`, `JSON.parse_string(paramsJson)` даёт Dictionary, `packageId` приводится к `int`.
- `call_deferred("_handle_request", request_id, op, params)` — не выполнять внутри JS-стека.
- `_handle_request` вызывает соответствующую `WiredPackageFs.op_*`, ловит `{error}` и отправляет ответ:
```gdscript
var message := {"id": int(request_id), "ok": true, "value": result}
# или {"id": ..., "ok": false, "error": ...}
_bridge.eval("window.__wiredEditorBridgeResult(%s)" % JSON.stringify(message), true)
```
- Имя операции маппится явно: `exists`→`op_exists`, `createDir`→`op_create_dir`, `snapshot`→`op_snapshot`, `collect`→`op_collect`, `prepareReplace`→`op_prepare_replace`, `replace`→`op_replace`, `delete`→`op_delete`; `sync` → `JavaScriptBridge.force_fs_sync()` и `{}`.
- Неизвестная операция → `{ok:false, error:"Неизвестная операция: <op>"}`.

- [ ] **Step 3: Проверить вручную**

Запустить дев-сервер, открыть комнату, в консоли браузера:
```js
await new Promise((r) => { window.__wiredEditorBridge.request(1, "exists", JSON.stringify({packageId: 1})); window.__wiredEditorBridgeResult = (m) => { console.log(m); r(); }; });
```
Expected: объект `{id: 1, ok: true, value: {exists: false}}`.

- [ ] **Step 4: Коммит**

```bash
git add packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd
git commit -m "feat(godot): dispatch package fs operations through the editor bridge"
```

---

### Task 3: Транспорт `editor-bridge.ts`

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/editor-bridge.ts`
- Test: `frontend/src/app/room/[room_code]/(godot)/editor-bridge.test.ts`

**Interfaces:**
- Consumes: `WiredEditorBridge.request` из Task 2.
- Produces:
  - `type WiredEditorBridge = { rescan?: () => void; request?: (requestId: number, op: string, paramsJson: string) => void }`
  - `class EditorBridgeError extends Error`
  - `type EditorBridgeClient = { call<T>(op: string, params?: Record<string, unknown>): Promise<T> }`
  - `function createEditorBridgeClient(options?: { timeoutMs?: number }): EditorBridgeClient`
  - `function waitForEditorBridge(timeoutMs: number): Promise<void>`
  - `function requestEditorRescan(): boolean` (без изменений)

- [ ] **Step 1: Написать падающие тесты**

`editor-bridge.test.ts`, добавить `describe("EditorBridgeClient")`:
1. `resolves the response matched by id` — фейковый `request` вызывает `window.__wiredEditorBridgeResult({id, ok:true, value:{files:{}}})` через `queueMicrotask`; `await expect(client.call("snapshot", {packageId: 1})).resolves.toEqual({files:{}})`.
2. `ignores a response with an unknown id` — отправить `{id: 999, ok:true}` и убедиться, что промис не завершился (`vi.advanceTimersByTime`), затем завершить нужным id.
3. `rejects with the GDScript error` — `{id, ok:false, error:"staging не найден"}` → `rejects.toThrow("staging не найден")`.
4. `times out` — `createEditorBridgeClient({timeoutMs: 50})`, фейк молчит → `rejects.toThrow("не ответил за 50 мс")`.
5. `rejects when the bridge is gone` — без `window.__wiredEditorBridge` → `rejects.toThrow("Мост редактора недоступен")`.
6. `waits for a late bridge` — `waitForEditorBridge` стартует при пустом окне, через 250 мс появляется `request` → промис резолвится.
7. `waitForEditorBridge rejects after the timeout`.
8. `requestEditorRescan` — существующие три теста остаются зелёными.

Использовать `vi.useFakeTimers()` там, где проверяются таймеры; очищать `window.__wiredEditorBridge` и `window.__wiredEditorBridgeResult` в `afterEach`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter frontend exec vitest run editor-bridge`
Expected: FAIL — `createEditorBridgeClient is not a function`.

- [ ] **Step 3: Реализовать транспорт**

- `requestId` — модульный счётчик с 1.
- `resolvers: Map<number, {resolve, reject, timer}>`.
- `ensureResultHandler()` — один раз на модуль вешает `window.__wiredEditorBridgeResult = (message) => { const resolver = resolvers.get(Number(message?.id)); ... }`, идемпотентно.
- `call` синхронно проверяет `window.__wiredEditorBridge?.request`, иначе `EditorBridgeError("Мост редактора недоступен: перезагрузите страницу")`; ставит `setTimeout`, при срабатывании удаляет resolver и реджектит `EditorBridgeError(\`Мост редактора не ответил за ${timeoutMs} мс\`)`; после ответа таймер очищается.
- `waitForEditorBridge` — опрос 250 мс через `setTimeout`, по истечении реджект `EditorBridgeError("Мост редактора не появился за N мс")`.
- `requestEditorRescan` — как сейчас.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter frontend exec vitest run editor-bridge`
Expected: PASS, 11 тестов.

- [ ] **Step 5: Коммит**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/editor-bridge.ts" "frontend/src/app/room/[room_code]/(godot)/editor-bridge.test.ts"
git commit -m "feat(frontend): add request/response transport for the editor bridge"
```

---

### Task 4: `godot-packages-fs.ts` поверх транспорта

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.ts` (476 строк)
- Test: `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.test.ts`
- Test: `frontend/src/app/room/[room_code]/(godot)/package-sync.test.ts` (замена фейка)

**Interfaces:**
- Consumes: `EditorBridgeClient`, `EditorBridgeError` (Task 3).
- Produces:
  - `type PackageEngine = { copyToFS(path: string, data: Uint8Array): void }`
  - `createPackageFileSystem({ bridge, getEngine, projectRoot }: { bridge: EditorBridgeClient; getEngine: () => PackageEngine; projectRoot: string }): PackageFileSystem`
  - `PackageFileSystem`: `exists(id): Promise<boolean>`, `createPackageDir(id): Promise<void>`, `snapshot(id): Promise<Record<string,string>>`, `collectFiles(id): Promise<CollectedPackageFile[]>`, `replaceContents(id, Map<string, Uint8Array>): Promise<{written: string[]; deleted: string[]}>`, `deletePackage(id): Promise<void>`, `sync(): Promise<void>`, `packageDir(id): string`
  - Сохраняются: `GodotFsError`, `isEditorMetadataPath`, `assertRelativePackagePath`, `CollectedPackageFile`, `applyPackageRevision`, `PACKAGES_DIR`.

- [ ] **Step 1: Переписать тесты на фейковый транспорт**

Фейк:
```ts
const tree = new Map<string, Uint8Array>(); // путь относительно корня проекта
const bridge = { call: vi.fn(async (op, params) => handlers[op](params)) };
const copyToFS = vi.fn((path: string, data: Uint8Array) => { tree.set(path.replace(`${projectRoot}/`, ""), data); });
```
Тесты (имена — как в спеке):
1. `rejects unsafe package paths` — `assertRelativePackagePath("../x")`, `"/x"`, `"a\\b"` кидают `GodotFsError`.
2. `decodes base64 from collect` — `collect` возвращает `{files:[{filepath:"main.gd", size:4, sha256:"…", contentsBase64: btoa("test")}]}` → `collectFiles` даёт `Uint8Array` `[116,101,115,116]`.
3. `writes staging then swaps` — `replaceContents(7, map)` вызывает `prepareReplace`, затем `copyToFS` для каждого файла в `staging_path`, затем `replace` и `sync`; возвращает `{written, deleted}` из ответа.
4. `does not write when applyPackageRevision fails verification` — манифест с неверным sha256 → `rejects.toThrow`, `copyToFS` не вызван.
5. `surfaces a missing staging directory` — `replace` вернул `{error:"staging не найден"}` → `rejects.toThrow("staging не найден")`.
6. `keeps editor metadata out of collect` — уже покрыто на стороне GDScript, здесь только проверка, что `collectFiles` не фильтрует повторно (фильтрация — ответственность GDScript).
7. `uses the live engine` — после замены объекта движка (`getEngine` возвращает новый) `replaceContents` пишет через новый `copyToFS`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs`
Expected: FAIL — нет `createPackageFileSystem` с новой сигнатурой / нет `bridge`.

- [ ] **Step 3: Реализовать доменный слой**

- Удалить `EmscriptenFs`, `createPackageFileSystem(instance)`, `readFile`, `writeFile`, `listFiles`, `prune`, `walk`, `removeTree`, `removeEmptyDirectories`, `isDirectory`.
- `exists` → `bridge.call<{exists:boolean}>("exists", {packageId})`.
- `createPackageDir` → `createDir`, затем `sync`.
- `snapshot` → `bridge.call<{files: Record<string,string>}>("snapshot", {packageId})` → `.files`.
- `collectFiles` → `collect`, декодировать `contentsBase64` через `atob` в `Uint8Array`; `entry` собирать из `{filepath, size, sha256}`.
- `replaceContents` → `prepareReplace` (ответ `{staging_path: string}`, локальная переменная называется `stagingPath`) → для каждого `[path, bytes]` вызвать `getEngine().copyToFS(\`${stagingPath}/${path}\`, bytes)` → `replace` → `sync`; при ошибке `copyToFS`/`replace` вернуть ошибку без `sync`.
- `deletePackage` → `delete` + `sync`.
- `sync` → `bridge.call("sync", {})`.
- `applyPackageRevision` не меняет порядок проверок: сначала размер и sha256 всех файлов, потом `replaceContents`.

- [ ] **Step 4: Обновить `package-sync.test.ts`**

Заменить старый FS-фейк (`rtenv.FS`) на объект `PackageFileSystem` с `snapshot`/`collectFiles`/`replaceContents`/`exists`/`sync` — по одной `vi.fn()` на метод. Логика тестов не меняется; проверить, что `reconcilePackageRevision` вызывает `snapshot`, затем `applyPackageRevision`.

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter frontend exec vitest run godot-packages-fs package-sync`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.ts" "frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.test.ts" "frontend/src/app/room/[room_code]/(godot)/package-sync.test.ts"
git commit -m "refactor(frontend): move package fs operations onto the editor bridge"
```

---

### Task 5: Жизненный цикл в хуке и загрузчике редактора

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts` (689 строк)
- Modify: `frontend/src/app/room/[room_code]/(godot)/GodotEditor.tsx` (115 строк)
- Modify: `frontend/src/app/room/[room_code]/(godot)/RoomPageClient.tsx` (82 строки)
- Test: `frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx`

**Interfaces:**
- Consumes: `createPackageFileSystem` (Task 4), `waitForEditorBridge` (Task 3), `GodotEditorInstance.editor`.
- Produces:
  - `GodotEditor` проп `afterStart?: (editor: GodotEditorInstance) => void` (вызывается после `await editor.start()`, не блокирует `ready`); `beforeStart` удаляется.
  - Хук возвращает `afterEditorStart(editor: GodotEditorInstance): void` вместо `beforeEditorStart`.

- [ ] **Step 1: Обновить тесты хука**

1. `does not mark the fs ready before the bridge appears` — `afterEditorStart` при пустом `window.__wiredEditorBridge` → `fsReady === false`.
2. `connects when the bridge appears later` — `afterEditorStart` при пустом окне, затем подставить `window.__wiredEditorBridge = { request }` и продвинуть таймеры на 250 мс (опрос `waitForEditorBridge`) → `fsReady === true`, `refresh` вызван.
3. `reports an error when the bridge never appears` — продвинуть таймеры на 120 000 мс → `error` содержит «Мост редактора не появился», `fsReady === false`.
4. `drops readiness when a bridge call fails` — после успешного подключения `request` реджектит/кидает → `fsReady === false`, действия недоступны.
5. `awaits async exists` — `removePackage`/`adoptPackage` дожидаются `exists`, `buildEntries` получает `Set` из `load`.

Фейк FS: `createPackageFileSystem` мокается; `exists: vi.fn(async () => true)`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter frontend exec vitest run use-room-packages`
Expected: FAIL — `afterEditorStart is not a function`.

- [ ] **Step 3: Переписать подключение в хуке**

- `const engineRef = useRef<GodotEditorInstance | null>(null)`.
- `afterEditorStart(editor)` — сохранить `engineRef`, затем:
  ```ts
  void (async () => {
    try {
      await waitForEditorBridge(BRIDGE_WAIT_MS); // 120_000
      connect();
    } catch (e) {
      setError("Мост редактора не появился: пакеты недоступны");
      startReconnectLoop();
    }
  })();
  ```
- `connect()` идемпотентен: если `filesRef.current` уже есть — выход; иначе `createEditorBridgeClient()`, `createPackageFileSystem({ bridge, getEngine: () => engineRef.current!.editor, projectRoot: editor.rootPath })`, `setFsReady(true)`, `void refresh()`.
- `startReconnectLoop()` — `setInterval(2000)`, на тике вызывает `connect()`, если `window.__wiredEditorBridge?.request` есть; интервал хранится в ref и не создаётся дважды.
- Cleanup: интервал и подписку на unmount снимать в `useEffect(() => () => stopReconnectLoop(), [])`.
- Обернуть действия: при `EditorBridgeError` — `setFsReady(false)`, `filesRef.current = null`, `setError(...)`, `startReconnectLoop()`.
- `exists` → `await` во всех местах: `load()` собирает `const present = new Set<number>()` до `buildEntries`, `removePackage`, `adoptPackage`.
- `createPackage` не меняется по логике.

- [ ] **Step 4: Обновить `GodotEditor` и `RoomPageClient`**

- `GodotEditor.tsx`: `afterStart?: (editor: GodotEditorInstance) => void`; в `loadEditor` после `await start()` — `afterStart?.(editor)`. `beforeStart` удалить.
- `RoomPageClient.tsx`: `<GodotEditor roomId={room.id} afterStart={packages.afterEditorStart} />`.

- [ ] **Step 5: Прогнать тесты и типы**

Run: `pnpm --filter frontend exec vitest run use-room-packages && pnpm check-types:frontend`
Expected: PASS, 0 ошибок типов.

- [ ] **Step 6: Коммит**

```bash
git add "frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts" "frontend/src/app/room/[room_code]/(godot)/use-room-packages.test.tsx" "frontend/src/app/room/[room_code]/(godot)/GodotEditor.tsx" "frontend/src/app/room/[room_code]/(godot)/RoomPageClient.tsx"
git commit -m "feat(frontend): connect package fs after the editor bridge appears"
```

---

### Task 6: Скрипт скачивания официального редактора

**Files:**
- Create: `packages/server/scripts/fetch-godot-editor.mjs`
- Create: `packages/server/scripts/lib/unzip.mjs`
- Create: `packages/server/scripts/lib/unzip.test.mjs`
- Modify: `packages/server/package.json` (scripts)
- Modify: `package.json` (корень)

**Interfaces:**
- Produces:
  - `unzip.mjs`: `export function extractZip(buffer: Buffer, destDir: string): string[]` — список записанных файлов; кидает `Error` на path traversal.
  - `fetch-godot-editor.mjs`: CLI, коды выхода 0/1; пишет `VERSION` в каталог редактора.
  - `pnpm fetch:editor` (корень и `packages/server`).

- [ ] **Step 1: Написать тесты `unzip.test.mjs`**

`node:test` + `node:assert/strict`, временный каталог через `mkdtempSync(join(tmpdir(), "wired-unzip-"))`; хелпер `makeZip(entries)` строит zip с method 0 (stored) — local file header + central directory + EOCD.

Тесты:
1. `extracts stored entries and creates nested directories`.
2. `extracts deflated entries` — один файл с method 8, данные через `deflateRawSync`.
3. `rejects parent traversal` — имя `../evil.txt`.
4. `rejects absolute paths` — `/etc/passwd`.
5. `ignores directory entries` — имя `dir/` не создаёт файл, но каталог существует.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test packages/server/scripts/lib/unzip.test.mjs`
Expected: FAIL — `Cannot find module .../unzip.mjs`.

- [ ] **Step 3: Реализовать `unzip.mjs`**

EOCD (`0x06054b50`) с конца буфера, центральный каталог (`0x02014b50`) → локальные заголовки (`0x04034b50`) → данные по `localHeaderOffset` + `nameLength` + `extraLength`; method 0 — копия, 8 — `inflateRawSync`; нормализовать через `path.posix.normalize`, отклонять `path.isAbsolute` и сегменты `..`; писать через `mkdirSync(dirname, {recursive:true})` + `writeFileSync`.

- [ ] **Step 4: Реализовать `fetch-godot-editor.mjs`**

- Константы `VERSION`, `ZIP_NAME`, `ZIP_SHA512` (Global Constraints).
- `destDir = resolve(process.env.GODOT_EDITOR_PATH ?? join(import.meta.dirname, "..", "godot_editor"))`.
- Если `readFileSync(join(destDir,"VERSION"),"utf8").trim() === VERSION` и есть `godot.editor.wasm` — печать `Редактор уже на <version>` и выход 0; `--force` игнорирует.
- Скачивание `fetch(url)` → `Buffer.from(await res.arrayBuffer())`; проверить `res.ok`, размер, `createHash("sha512")`.
- Распаковать zip во временный каталог, скопировать весь набор файлов (`godot.editor.*`, worklets, шрифты, `manifest.json`, `offline.html`, `service.worker.js`, `favicon.png`, `logo.svg`) в `destDir` (старые `.wasm`/`.js` удалить перед копированием), записать `VERSION`.
- Проверить наличие `godot.editor.js`, `godot.editor.wasm`, `godot.editor.html`; иначе — `console.error` и `process.exit(1)`.
- Не логировать содержимое env.

- [ ] **Step 5: Добавить скрипты и прогнать**

`packages/server/package.json`: `"fetch:editor": "node scripts/fetch-godot-editor.mjs"`, `"test:scripts": "node --test scripts/lib/*.test.mjs"`.
Корень: `"fetch:editor": "pnpm --filter server fetch:editor"`.

Run: `pnpm --filter server test:scripts && pnpm fetch:editor`
Expected: тесты PASS; скрипт скачивает zip, печатает размер и `Готово: 4.7.2-stable`.

- [ ] **Step 6: Коммит**

```bash
git add packages/server/scripts/fetch-godot-editor.mjs packages/server/scripts/lib/unzip.mjs packages/server/scripts/lib/unzip.test.mjs packages/server/package.json package.json
git commit -m "feat(server): fetch the pinned official Godot web editor"
```

---

### Task 7: Миграция репозитория, Docker и документации

**Files:**
- Modify: `.gitignore`
- Modify: `backend.Dockerfile`
- Modify: `AGENTS.md`
- Modify: `packages/server/godot_project/_wired/project.godot`
- Modify: `docs/superpowers/specs/2026-10-31-godot-official-editor-js-bridge-design.md` (статус)
- Create: `docs/superpowers/specs/2026-10-31-godot-official-editor-results.md`
- Index: `git rm -r --cached packages/server/godot_editor`

**Interfaces:**
- Consumes: `pnpm fetch:editor` (Task 6).
- Produces: чистая установка = `pnpm install && pnpm fetch:editor`.

- [ ] **Step 1: Убрать редактор из git**

```bash
git rm -r --cached packages/server/godot_editor
```
Добавить в `.gitignore`:
```
packages/server/godot_editor/
```
Файлы на диске остаются.

- [ ] **Step 2: Проверить, что скрипт восстанавливает каталог**

```bash
rm -rf packages/server/godot_editor
pnpm fetch:editor
node -e "const s=require('fs').statSync('packages/server/godot_editor/godot.editor.wasm'); if (s.size < 40e6) process.exit(1)"
```
Expected: каталог скачан, wasm > 40 МБ.

- [ ] **Step 3: Обновить Dockerfile**

В стадии `build` после `COPY . .` и установки зависимостей:
```dockerfile
RUN pnpm --filter server fetch:editor
```
В финальной стадии:
```dockerfile
COPY --from=build /app/packages/server/godot_editor /app/packages/server/godot_editor
```
Проверить: `docker build -f backend.Dockerfile .` (нужна сеть); в комментарии к `RUN` указать, что офлайн-сборка требует заранее подготовленного каталога.

- [ ] **Step 4: Обновить `_wired` и документацию**

- `project.godot`: `config/features=PackedStringArray("4.7", "GL Compatibility")`.
- `AGENTS.md`: заменить «committed WASM editor / ~80 MB» на «скачивается `pnpm fetch:editor`, версия 4.7.2 закреплена в `scripts/fetch-godot-editor.mjs`»; в команды добавить `pnpm fetch:editor`; в факты — «файловые операции пакетов идут через `wired_bridge` (`package_fs.gd`), а не через `rtenv.FS`»; отметить, что `GODOT_RUNTIME_PATH` для `export:game` должен быть 4.7.2.
- Дизайн-док: `Статус: реализовано` после прохождения чеклиста.

- [ ] **Step 5: Написать `2026-10-31-godot-official-editor-results.md`**

По образцу `2026-10-30-godot-packages-stage6.md`: `## Итог`, таблица «что изменилось», чеклист e2e (создать пакет → скачать ревизию → Emit → удалить → перезагрузить страницу → проверить IndexedDB), результат прогона тестов.

- [ ] **Step 6: Финальная проверка**

```bash
pnpm --filter server test && pnpm --filter server build && pnpm --filter frontend test && pnpm check-types:frontend && pnpm --filter frontend lint
```
Expected: всё зелёное; e2e-чеклист пройден вручную на 4.7.2.

- [ ] **Step 7: Коммит**

```bash
git add .gitignore backend.Dockerfile AGENTS.md packages/server/godot_project/_wired/project.godot docs/superpowers/specs/2026-10-31-godot-official-editor-js-bridge-design.md docs/superpowers/specs/2026-10-31-godot-official-editor-results.md
git commit -m "chore: drop the custom Godot editor build and pin 4.7.2"
```
