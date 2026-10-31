# Дизайн: официальный Godot 4.7.2 вместо кастомной сборки

Дата: 2026-10-31.
Статус: утверждено, реализация — `docs/superpowers/plans/2026-10-31-godot-official-editor-js-bridge.md`.
Связанные документы: `2026-10-29-godot-package-storage-stage4.md`,
`2026-10-30-godot-packages-stage6.md`.

## Задача

Сейчас редактор в браузере — собственная сборка Godot с патчем, который
экспортирует Emscripten `FS` в `Module` (`Module["FS"] = FS`). Через
`window.editor.editor.rtenv.FS` фронтенд читает, сравнивает, заменяет и удаляет
файлы пакетов (`packages/<packageId>/`). Без патча вкладка Packages не работает.

Нужно перейти на официальную сборку Godot **4.7.2-stable**, а все файловые
операции пакетов делать через `JavaScriptBridge`-плагин `wired_bridge`, который
уже используется для пересканирования проекта.

## Что уже проверено

- Запись файлов в проект **не требует** кастомной сборки: официальный
  `Engine.prototype.copyToFS(path, buffer)` и `preloadFile()` — публичный API,
  он уже используется в `GodotEditorInstance.downloadProject()` для первичной
  загрузки проекта.
- Официальная сборка **не экспортирует** Emscripten `FS`
  (`platform/web/detect.py`: `EXPORTED_RUNTIME_METHODS = []`), а в
  минифицированном `godot.editor.js` 4.7.2 свойства `rtenv` нет вовсе.
- `JavaScriptBridge` в 4.7.2 умеет: `create_callback`, `get_interface`,
  `eval` (возвращает `PackedByteArray` для `Uint8Array`),
  `is_js_buffer` / `js_buffer_to_packed_byte_array`, `force_fs_sync`.
- `JavaScriptBridge.create_callback` вызывает GDScript-Callable с **одним**
  аргументом — `Array` переданных из JS значений (так уже написан
  `_on_rescan_requested(_args: Array)`).
- Колбэк ничего не возвращает в JS, поэтому ответы идут отдельным вызовом
  JS-функции из GDScript через `JavaScriptBridge.eval`.
- Официальные файлы редактора доступны по пиновому URL
  `https://editor.godotengine.org/releases/4.7.2.stable/godot.editor.js`
  (200 OK), а релизный zip — в `godot-builds`:
  `Godot_v4.7.2-stable_web_editor.zip`, 54 031 095 байт, sha512
  `03ad6b4b4d96f0f7d85bf4fdcf29535891b79d52ee94a11e96895463a2745347b8f601b455e7a58135bf641df43fc25296bc257bbfce593d477dfa64a2272268`
  (128 hex, `SHA512-SUMS.txt` релиза).

## Подходы

1. **Крупные операции в GDScript (выбран).** Мост принимает не файловые
   примитивы, а операции уровня пакета: `snapshot`, `collect`,
   `prepareReplace`/`replace`, `delete`, `createDir`, `sync`, `exists`.
   Байты на запись идут официальным `Engine.copyToFS`, на чтение — base64
   внутри `collect`. Вся работа с деревом и атомарная замена — в GDScript.
2. **Зеркало FS с async-примитивами.** `readFile/writeFile/stat/readdir/rename`
   через мост, весь `PackageFileSystem` переписывается на Promise. Гибче, но
   десятки round-trip на пакет и логика staging/rollback остаётся в JS.
3. **Плагин сам скачивает ревизии** через `HTTPRequest`. Убирает JS из пути
   данных, но переносит авторизацию и API-контракт в GDScript.

Выбран вариант 1: он сохраняет существующее разделение (сеть и проверки —
фронтенд, файловая система — редактор) и не размазывает staging/rollback по
двум языкам.

## Архитектура

### Транспорт: `editor-bridge.ts`

`window.__wiredEditorBridge` расширяется до:

```ts
type WiredEditorBridge = {
  rescan?: () => void;
  request?: (requestId: number, op: string, paramsJson: string) => void;
};
```

`editor-bridge.ts` получает:

- `waitForEditorBridge(timeoutMs)` — опрос `window.__wiredEditorBridge?.request`
  каждые 250 мс; reject по таймауту с понятным текстом.
- класс/фабрику `EditorBridgeClient`:
  - `call<T>(op, params): Promise<T>` — присваивает `requestId`, кладёт
    resolver в `Map`, вызывает `bridge.request(id, op, JSON.stringify(params))`;
    таймаут на запрос 60 с; при исчезновении моста — ошибка
    «Мост редактора недоступен: перезагрузите страницу».
  - глобальная функция `window.__wiredEditorBridgeResult(message)` —
    принимает **один** объект `{id, ok, value}` / `{id, ok:false, error}`,
    находит resolver по `id`, резолвит/реджектит. `id` в GDScript — `float`
    (JS-числа приходят как float), поэтому при разборе он приводится к `int`,
    а сравнение в JS идёт по числу: `1.0 === 1` — истинно.
- `requestEditorRescan()` остаётся как есть.

Ответ из GDScript отправляется так (экранирование делает `JSON.stringify`,
`id` приводится к `int`, чтобы не сериализоваться как `1.0`):

```gdscript
var payload := JSON.stringify({
    "id": int(request_id),
    "ok": true,
    "value": result,
})
JavaScriptBridge.eval("window.__wiredEditorBridgeResult(%s)" % payload, true)
```

`payload` — валидный JS-объектный литерал, поэтому `JSON.parse` на стороне JS
не нужен: функция получает готовый объект.

`eval` выбран вместо `JavaScriptObject.call`, потому что он уже используется в
плагине и не зависит от семантики вызова методов `JavaScriptObject`.

## Жизненный цикл движка

`GodotEditorInstance.Execute`/`onExit` пересоздают движок
(`this.editor = new window.Engine(...)`), поэтому ссылка на `copyToFS` не может
быть захвачена один раз:

- `PackageFileSystem` получает **геттер** `getEngine: () => GodotEngine` и
  берёт `editor.editor` в момент вызова, а не в `afterEditorStart`.
- `useRoomPackages` после `start()` запускает постоянный watcher
  (`setInterval` 2 с): пока моста нет — `fsReady = false`; когда появился —
  создаёт клиента и FS, `fsReady = true`, `refresh()`. Через 120 с без моста
  выставляется ошибка, но watcher продолжает работать (редактор мог ещё
  грузиться).
- Любая ошибка транспорта («мост исчез», таймаут) переводит `fsReady` в
  `false` и оставляет watcher активным; действия пакетов блокируются до
  переподключения. Перезапуск редактора пользователем лечится сам.

### Операции моста

Все `packageId` — целые > 0, все пути внутри пакета относительны. GDScript
повторно валидирует id и пути: `/`, без `\`, без `..`, без пустых сегментов.

| op | params | result |
| --- | --- | --- |
| `exists` | `{packageId}` | `{exists: boolean}` |
| `createDir` | `{packageId}` | `{}` |
| `snapshot` | `{packageId}` | `{files: Record<path, sha256hex>}` |
| `collect` | `{packageId}` | `{files: [{filepath, size, sha256, contentsBase64}]}` |
| `prepareReplace` | `{packageId}` | `{stagingPath: string}` |
| `replace` | `{packageId}` | `{written: string[], deleted: string[]}` |
| `delete` | `{packageId}` | `{}` |
| `sync` | `{}` | `{}` |

Семантика:

- `snapshot`/`collect` обходят `res://packages/<id>/` рекурсивно и **пропускают**
  служебные файлы редактора: любой сегмент с `.`, файлы `*.uid`, `*.import`.
  Это зеркало `isEditorMetadataPath()`.
- `collect` считает `sha256` через `HashingContext` и отдаёт содержимое в
  base64 (`Marshalls.raw_to_base64`). Размер и хеш считаются в GDScript, JS
  только декодирует.
- **Восстановление после сбоя.** Перед любой операцией над пакетом
  (`exists`, `snapshot`, `collect`, `prepareReplace`, `replace`) вызывается
  `_restore_previous_if_needed(id)`: если `res://packages/<id>/` отсутствует,
  а `res://packages/.<id>.previous/` есть, `previous` возвращается на место
  через `rename_absolute`. Это закрывает единственное окно между двумя
  `rename` в `replace`, если вкладку закрыли ровно в этот момент. Если корня
  нет и `previous` нет — пакета действительно нет.
- `prepareReplace` сначала выполняет восстановление, затем удаляет
  `.previous`, пересоздаёт пустой `res://packages/.<id>.staging/` и возвращает
  его абсолютный путь (`ProjectSettings.globalize_path`). Префикс `.`
  обязателен: скрытые каталоги Godot не импортирует.
- `replace`: выполняет восстановление, проверяет, что staging существует; копирует в него служебные
  файлы текущего пакета (`.uid`, `.import`, dotfiles), чтобы не потерять кэш
  импорта. Если каталога пакета ещё нет (первое скачивание в пустой редактор),
  шаг с `.previous` пропускается: staging просто переименовывается в root, а
  `deleted` пуст. Иначе `DirAccess.rename_absolute(root, previous)`, затем
  `rename_absolute(staging, root)`; при ошибке второго шага `previous`
  возвращается на место, staging удаляется; после успеха `previous`
  удаляется. `written` — файлы staging без служебных, `deleted` — файлы
  старого каталога, которых нет в новом.
- `delete` рекурсивно удаляет каталог `res://packages/<id>/` и
  `.<id>.staging`/`.<id>.previous`, если остались.
- `sync` вызывает `JavaScriptBridge.force_fs_sync()`. У этой функции нет
  колбэка завершения, поэтому `sync()` во фронтенде означает «запрос отправлен»,
  а не гарантию записи в IndexedDB. Это **осознанное ухудшение** относительно
  текущего `FS.syncfs(false, callback)`: ошибка персистенции больше не
  всплывает, а `replace`/`delete` сообщают об успехе до записи в IndexedDB.
  Начальная загрузка проекта по-прежнему идёт через `copyToFS` и `start()`.

### Таймауты

Таймаут транспорта **не отменяет** уже поставленную в очередь операцию:
`call_deferred` выполнится, когда движок освободится. Поэтому после любой
транспортной ошибки панель переводится в `fsReady = false`, а вернувшись,
обязана перечитать состояние (`refresh()`) и не считать пакет изменённым по
своим оптимистичным данным. Все операции идемпотентны или атомарны, поэтому
повтор после переподключения безопасен.

GDScript выполняет операцию не внутри JS-стека, а через
`call_deferred("_handle_request", ...)`, как уже сделано для `rescan`: нельзя
пере-входить в файловую систему движка, пока активен JS. Поэтому все методы
`PackageFileSystem` асинхронные.

### Запись байтов: `copyToFS`, не base64

`replaceContents()` во фронтенде:

1. `prepareReplace` → `stagingPath`;
2. для каждого файла `engine.copyToFS(`${stagingPath}/${filepath}`,
   bytes)` — официальный API сам создаёт промежуточные каталоги;
3. `replace` → `{written, deleted}`;
4. `sync`.

Если шаг 2 или 3 падает, корневой каталог пакета не тронут, staging
перезаписывается следующим `prepareReplace`. Base64 используется только на
чтение (`collect`), то есть при Emit — редком явном действии с небольшими
скриптами.

### `godot-packages-fs.ts`

Удаляются `EmscriptenFs`, `createPackageFileSystem(instance)` c `rtenv.FS`,
`readFile/writeFile/listFiles/prune/` приватный обход дерева. Остаётся
доменный слой:

```ts
createPackageFileSystem({
  bridge: EditorBridgeClient,
  getEngine: () => Pick<GodotEngine, "copyToFS">,
  projectRoot: string,
}): PackageFileSystem
```

`PackageFileSystem` (все методы async, кроме чистых хелперов):

- `exists(packageId): Promise<boolean>`
- `createPackageDir(packageId): Promise<void>` (`createDir` + `sync`)
- `snapshot(packageId): Promise<Record<string, string>>`
- `collectFiles(packageId): Promise<CollectedPackageFile[]>` (декодирование
  base64)
- `replaceContents(packageId, Map<string, Uint8Array>): Promise<{written, deleted}>`
- `deletePackage(packageId): Promise<void>` (+ `sync`)
- `sync(): Promise<void>`

`assertRelativePackagePath`, `isEditorMetadataPath`, `GodotFsError`,
`applyPackageRevision` сохраняются; `applyPackageRevision` меняется только
вызовом нового `replaceContents`. `package-sync.ts` не меняется по смыслу:
`planPackageSync`, `changedPackageFiles`, `reconcilePackageRevision`,
`publishPackageFiles` остаются, но `snapshot`/`collectFiles` теперь async —
они и так вызывались через `await`.

### Жизненный цикл в `use-room-packages.ts`

Сейчас `beforeEditorStart` создаёт FS до `start()`, потому что модуль уже
инициализирован. Моста в этот момент ещё нет: плагин регистрируется при
загрузке проекта внутри `start()`.

- `GodotEditor` получает проп `afterStart?: (editor) => void`, вызываемый
  **после** `await editor.start()` (не блокирует статус `ready`).
- `useRoomPackages` вместо `beforeEditorStart` отдаёт
  `afterEditorStart(editor)`: сохраняет `editor` и запускает
  `waitForEditorBridge(120_000)`; по успеху создаёт `PackageFileSystem`,
  ставит `fsReady = true` и вызывает `refresh()`; по таймауту — `error`
  («Мост редактора не появился: пакеты недоступны»), редактор при этом
  работает.
- `buildEntries()` больше не может звать `files.exists()` синхронно: `load()`
  заранее собирает `Set<number>` присутствующих пакетов (`await exists` по
  каждому) и передаёт его в `buildEntries`.
- Асинхронными становятся все места вызова `exists`: `load` (для
  `buildEntries`), `removePackage`, `adoptPackage`. `createPackage` `exists`
  не вызывает — только `createPackageDir`.
- `requestEditorRescan()` остаётся после create/download/delete.

### Скачивание официального редактора

`packages/server/scripts/fetch-godot-editor.mjs` (Node ≥ 20, только builtins):

- Константы: `GODOT_EDITOR_VERSION = "4.7.2-stable"`,
  `ZIP_NAME = "Godot_v4.7.2-stable_web_editor.zip"`, `ZIP_SHA512` из
  `SHA512-SUMS.txt`. Обновление версии — правка этих трёх констант.
- URL: `https://github.com/godotengine/godot-builds/releases/download/<version>/<zip>`.
- Каталог: `process.env.GODOT_EDITOR_PATH ?? packages/server/godot_editor`.
- Если `VERSION` совпадает и `godot.editor.wasm` на месте — выход без сети;
  `--force` перекачивает.
- Скачивание в `os.tmpdir()`, проверка sha512 (`node:crypto`), распаковка
  (`scripts/lib/unzip.mjs`, ~90 строк: EOCD → central directory →
  `inflateRawSync`, защита от `..` и абсолютных путей), запись `VERSION`.
- Проверка, что после распаковки есть `godot.editor.js`, `godot.editor.wasm`,
  `godot.editor.html`; иначе — ошибка и ненулевой код выхода.

Скрипты: `packages/server/package.json` → `"fetch:editor"`, корневой
`package.json` → `"fetch:editor": "pnpm --filter server fetch:editor"`.

Репозиторий: `git rm -r --cached packages/server/godot_editor`, строка
`packages/server/godot_editor/` в корневой `.gitignore`. Файлы остаются на
диске локально; историю git не переписываем.

Docker: в `backend.Dockerfile` стадия `build` получает
`RUN pnpm --filter server fetch:editor`, финальная стадия —
`COPY --from=build /app/packages/server/godot_editor
/app/packages/server/godot_editor`. Образ теперь требует сеть при сборке;
альтернатива для офлайна — монтировать каталог, как сейчас монтируется storage.

### Версия проекта `_wired`

- `project.godot`: `config/features=PackedStringArray("4.7", "GL Compatibility")`.
- Каталог `.godot/` не закоммичен, пересоздаётся сам.
- Локальный `GODOT_RUNTIME_PATH` для `pnpm export:game` должен быть 4.7.2 —
  это фиксируется в AGENTS.md как требование, а не проверяется кодом.
- `docs/superpowers/specs/` и AGENTS.md: убрать формулировки про кастомную
  сборку и «committed WASM editor», добавить `pnpm fetch:editor` в команды.

## Тесты

- `editor-bridge.test.ts`: транспорт (совпадение id, ошибка из GDScript,
  таймаут, отсутствие моста), `rescan` без изменений.
- `godot-packages-fs.test.ts`: переписать на фейковый транспорт
  (`call(op, params)` поверх in-memory дерева) + фейковый `copyToFS`;
  покрыть: валидацию путей, `collectFiles` с base64, `replaceContents`
  (staging → swap, служебные файлы переносятся), `applyPackageRevision`
  (проверка размера/sha256 до записи, ничего не пишется при ошибке).
- `package-sync.test.ts`: та же замена FS-фейка; логика планирования не
  меняется.
- `use-room-packages.test.tsx`: `createPackageFileSystem` мокается, `exists`
  асинхронный, добавить сценарии «мост появился позже», «мост не появился»,
  «мост исчез во время действия».
- GDScript: файловые операции выносятся из `plugin.gd` в `RefCounted`
  `res://addons/wired_bridge/package_fs.gd` (статические функции), плагин
  остаётся тонким диспетчером. Тогда их можно покрыть headless-тестом по
  образцу `_wired/tests/packages_manager_smoke.gd`
  (`godot --headless --path ... --script res://tests/package_fs_smoke.gd`):
  snapshot/collect/replace/delete на временном каталоге, перенос служебных
  файлов, откат при сбое. Тест не входит в `pnpm test`, запускается вручную.
- e2e-чеклист (создать пакет, скачать ревизию, Emit, удалить, перезагрузить
  страницу, проверить IndexedDB) описывается в спеке-результате этапа.

## Инвентарь изменений

- `packages/server/godot_project/_wired/addons/wired_bridge/plugin.gd` —
  диспетчер операций.
- `packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd` —
  новый модуль файловых операций.
- `packages/server/godot_project/_wired/tests/package_fs_smoke.gd` — новый.
- `frontend/src/app/room/[room_code]/(godot)/editor-bridge.ts` — транспорт.
- `frontend/src/app/room/[room_code]/(godot)/godot-packages-fs.ts` — доменный
  слой поверх транспорта.
- `frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts` — watcher,
  async `exists`, `afterEditorStart`.
- `frontend/src/app/room/[room_code]/(godot)/GodotEditor.tsx` — проп
  `afterStart` вместо `beforeStart`.
- `frontend/src/app/room/[room_code]/(godot)/RoomPageClient.tsx` — проброс.
- Тесты: `editor-bridge`, `godot-packages-fs`, `package-sync`,
  `use-room-packages`.
- `packages/server/scripts/fetch-godot-editor.mjs`,
  `packages/server/scripts/lib/unzip.mjs` — новые.
- `package.json` (корень и `packages/server`), `.gitignore`,
  `backend.Dockerfile`, `AGENTS.md`, `_wired/project.godot`.
- Удаление: `packages/server/godot_editor/*` из индекса git (файлы остаются на
  диске до первого `pnpm fetch:editor`).

## Вне рамок

- Общий `eval`-канал из фронтенда в движок: мост остаётся списком операций.
- Скачивание пакетов самим плагином через `HTTPRequest`.
- Изменения multiplayer/runtime и формата пакетов на сервере.
- Переписывание git-истории, чтобы убрать 80 МБ из прошлых коммитов.

## Риски

1. `JavaScriptBridge.eval` с большим base64- payload: строка собирается через
   `JSON.stringify`, поэтому экранирование корректно; объём ограничен размером
   пакета (скрипты), но при росте пакетов это первое место для оптимизации.
2. `force_fs_sync()` без колбэка: возможна потеря последних записей при
   аварийном закрытии вкладки сразу после действия, и ошибка записи в IndexedDB
   больше не всплывает. Это принятый регресс относительно `FS.syncfs`.
3. Перезапуск редактора (`Execute`/`onExit` → `init()`): пересоздаются и мост,
   и движок. Геттер `getEngine()` берёт живой движок на каждый вызов, watcher
   переподключает мост; клиент проверяет мост на каждом вызове и отдаёт
   понятную ошибку.
4. 4.7.2 может генерировать больше служебных файлов (`.uid` для новых
   скриптов) — фильтр служебных путей обязателен в GDScript и JS.
5. Сборка Docker-образа начинает зависеть от сети и доступности GitHub.
6. Переход 4.6.2 → 4.7.2 может изменить поведение плагина редактора; проверка
   — e2e-чеклист на реальном редакторе.
