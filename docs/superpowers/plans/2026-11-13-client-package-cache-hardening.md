# Укрепление клиентского кеша пакетов

Дата: 2026-11-13
Статус: часть исправлений внедрена в ветке `quality/package-cache-caching`
(отпочкована от `client-package-caching`, `77210a4`).

Документ дополняет [дизайн](../specs/2026-11-13-client-package-cache-design.md)
и [план](../plans/2026-11-13-client-package-cache.md) клиентского кеша: там
описано, как кеш появился, здесь — что в нём оказалось хрупким, что уже
исправлено и что стоит сделать дальше.

## 1. Что вообще изменилось относительно `v0.2.x`

`git merge-base v0.2.x client-package-caching` = `6d6df05`, то есть вершина
`v0.2.x`. Ветка не потеряла ни одного коммита основной линии: это чистый
fast-forward из шести коммитов, только клиентский GDScript плюс строка в shell.
Сервер, API и фронтенд не тронуты.

| Коммит | Смысл | Файлы |
| --- | --- | --- |
| `1dacd88` | game-only точка монтирования `/wired-cache` для пакетов | `shell.html` |
| `b39c737` | маркер завершённой записи и проверка артефакта по размерам | `artifact_store.gd` |
| `f031b1e` | переиспользование артефакта между перезагрузками | `packages_manager.gd` |
| `ff50105` | починка производных файлов переиспользованного артефакта | `asset_deriver.gd`, `packages_manager.gd` |
| `af267ab` | один `force_fs_sync` на пачку применений | `packages_manager.gd`, `main_scene.gd` |
| `77210a4` | fallback, если web-корень кеша непригоден | `packages_manager.gd` |

Итого `v0.2.x...client-package-caching`: 6 файлов, `+866 / -21`. Ключевые
инварианты, на которых держится вся конструкция:

- `artifactKey` — content-addressed идентификатор замыкания, приходит до
  скачивания файлов;
- каталог артефакта `<storage root>/<room>/packages/<slug>/<revision>-<key>/`
  атомарно собирается через `.staging` → `.previous` → rename;
- маркер `.wired-artifact.json` пишется последним и означает «каталог целый»;
- на web кеш живёт в отдельной IDBFS-базе `/wired-cache`, чтобы flush
  редактора не стирал пакеты;
- `prune` держит применённый каталог и самую новую другую ревизию.

## 2. Найденные дефекты и что уже исправлено

Все пункты ниже проверены smoke-тестами Godot (см. раздел 5).

### 2.1. Удаление пакета на web не сохранялось (P0, исправлено)

`main_scene._apply_package_removal()` вызывает
`_packages.forget_package(package_id, purge)`. Purge удаляет каталог и ставит
`_storage_dirty`, но `flush_storage()` в этом пути не вызывался вообще:
единственные вызовы были в применении пакета и в reconcile. Если purge —
последняя операция пачки (пакет отключили/удалили), `force_fs_sync` не
происходил, и после перезагрузки страницы удалённые байты возвращались из
IndexedDB.

Исправление: `main_scene._pump_package_ops()` теперь вызывает
`_packages.flush_storage()` один раз в конце пачки, когда очередь пуста
(`main_scene.gd:943`). Это покрывает и apply, и unload, и не добавляет лишних
sync на каждый пакет.

### 2.2. Кеш-хит зря синхронизировал всю файловую систему (P1, исправлено)

`_reuse_artifact()` безусловно ставил `_storage_dirty = true`, а
`_save_slug_index()` переписывал `package_slugs.json` при каждом применении.
Значит, каждый cache hit всё равно вызывал полный `FS.syncfs` — ровно та
стоимость, ради устранения которой кеш и делался.

Исправление:

- `_save_slug_index()` пишет только при `_slug_index_dirty` (флаг поднимает
  `_remember_slug`, когда slug действительно изменился) и сам помечает storage
  грязным только после реальной записи;
- `ArtifactStore.prune()` возвращает число удалённых каталогов;
- `_reuse_artifact()` ставит `_storage_dirty` только если был ремонт
  производных файлов, переписан маркер или prune что-то удалил.

Чистый cache hit больше не трогает IDBFS.

### 2.3. Проверка кеша доверяла размеру файла (P1, исправлено)

Маркер хранил `totalSize`/`fileCount`, но никто их не проверял, а
`reusable_artifact()` сверял только размеры. Файл, испорченный с сохранением
длины, принимался как валидный и кешировался навсегда.

Исправление: формат маркера поднят до `2`, в нём теперь `storedHashes`
(sha256 фактических байтов на диске), `fileCount` проверяется против манифеста,
`reusable_artifact()` сверяет размер, затем sha256. Маркер формата 1 просто
промахивается и перекачивается один раз.

Осознанный компромисс: проверка читает все байты пакета локально. Это дешевле
сети и на IDBFS идёт из памяти, но для очень больших пакетов (сотни МБ) стоит
замерить время старта. Если окажется заметно — заменить полный sha256 на
дешёвую выборку (размер + первые/последние 64 КБ) или вынести проверку в
`WIRED_PACKAGE_CACHE_VERIFY=fast`.

### 2.4. Дублирование публикации состояния (P2, исправлено)

Ветка `f031b1e` скопировала блок из ~15 строк из `_sync_package()` в
`_reuse_artifact()`: revision, artifact key, scene map, hashes, запись индекса,
`changed_files`. Две копии неизбежно разъезжаются.

Исправление: `_publish_applied(package_id, revision, artifact_key, manifest,
hashes) -> PackedStringArray` — единственная точка публикации. Обе ветки
(скачивание и кеш) вызывают её.

### 2.5. Смешение слоёв `ArtifactStore` и `AssetDeriver` (P2, исправлено)

`ArtifactStore.reusable_artifact()` сам вызывал
`AssetDeriver.derived_files()`, хотя по документации store отвечает только за
байты на диске. Теперь store не знает про производные файлы: он возвращает
`derive_current` и записанные карты, а `_reuse_artifact()` сам решает, каких
`*.import`/`*.image.res` не хватает.

### 2.6. Мелочи, исправленные попутно

- `ArtifactIdentity` (внутренний класс) вместо восьми позиционных аргументов
  `write_marker`: больше нельзя перепутать `package_id` и `revision`.
- `marker_missing` больше не означает «битый JSON» — для него есть
  `marker_invalid`.
- `stage()` читает `get_error()` до `close()`, а не после.
- `_revision_of_dir_name` убран из `PackagesManager`; тест обращается к
  `ArtifactStore.revision_of_dir_name()` напрямую.
- Если после relocate в текстовом файле остался `user://wired/rooms/`,
  печатается `WIRED_PACKAGES_RELOCATE_MISS package=… files=… root=…` — раньше
  такой артефакт молча кешировался с неразрешимыми путями.
- `_pump_package_ops()` проверяет `_packages != null`: смоуки собирают
  `main_scene` без менеджера пакетов, и безусловный `flush_storage()` падал в
  лог `Nonexistent function 'flush_storage' in base 'Nil'`.

## 3. Что стоит сделать дальше

### P1. Разделить `packages_manager.gd` (≈1370 строк)

Сейчас в одном классе: транспорт, валидация применения, блокировки, кеш,
индекс slug, web-корень, прогресс. Предлагаемое разбиение без изменения
публичного API:

| Новый файл | Содержимое | Оценка |
| --- | --- | --- |
| `package_transport.gd` | `fetch_manifest`, `fetch_runtime_manifest`, `_download_files`, `_request`, `_sha256`, `_latest_revision` | ~250 строк |
| `package_slugs.gd` | `_load_slug_index`, `_remember_slug`, `_save_slug_index`, `_slug_index_path` | ~90 строк |
| `package_storage_root.gd` | `storage_root`, `_probe_*`, `relocate_artifact_text`, `flush_storage` | ~120 строк |
| `packages_manager.gd` | оркестрация `_sync_package_chain`/`_sync_package`/`_reuse_artifact`, состояние, сигналы | ~700 строк |

`class_name PackagesManager` остаётся, остальное — внутренние `RefCounted`,
создаются в `_init`. Тесты, которые сейчас дергают `_manager._storage_dirty` и
`_manager._artifacts`, можно перевести на новые классы напрямую.

### P1. Вынести очередь операций из `main_scene.gd` (≈1434 строки)

`_pump_package_ops`, `_enqueue_package_op`, `_apply_package_removal`,
`_apply_package_revision`, `_apply_client_package`, `_apply_room_packages`,
`_restore_dynamic_if_ready` — это отдельный автомат на ~200 строк, связанный с
`dynamic_world`, `players_manager`, `net` и `registry`. Кандидат —
`package_ops.gd` с явными зависимостями в `_init` и сигналом «пачка
закончилась» (сейчас именно в этой точке делается `flush_storage`, и это
правильное место для будущего контроллера).

### P1. Разбить `tests/packages_manager_smoke.gd` (1911 строк)

Файл вырос на 400 строк в этой ветке и держит сразу транспорт, кеш, prune,
блокировки и flush. Предлагается три смоука по темам:

- `package_cache_smoke.gd` — маркер, хеши, ремонт производных, cache hit;
- `package_sync_smoke.gd` — цепочки, зависимости, блокировки, ретраи;
- `package_storage_smoke.gd` — prune, slug index, flush, web-root fallback.

Плюс два пробела в покрытии:

- регрессия на 2.1 на уровне `main_scene`: очередь `unload(purge=true)` должна
  закончиться `flush_storage` (сейчас проверен только `forget_package`);
- `artifact_store_smoke.gd` не трогает маркер вообще (42 проверки только
  stage/swap/prune) — проверку `write_marker`/`reusable_artifact` стоит держать
  там, а не только через менеджер.

### P2. Решить судьбу `CACHE_REUSE`

Константа всегда `true`, то есть вторая ветка `_sync_package` мертва в
проде. Либо оставить как документированный рубильник (тогда упомянуть в
дизайне, как её выключать при инциденте), либо удалить и полагаться на
`git revert`. Сейчас это единственный «выключенный код» в горячем пути.

### P2. Диагностика relocate

Warning из 2.6 полезен, но не лечит. Если после relocate префикс остался,
правильнее не кешировать такой артефакт: пометить применение как ошибку с
`WIRED_PACKAGES_RELOCATE_MISS` и уйти в обычную загрузку (она тоже не
исправит пути, но хотя бы не закрепит поломку в кеше). Решение зависит от
того, бывает ли `user://`-путь легитимным для непакетного файла.

### P3. Убрать тестовые швы из продакшн-класса

`trace_sync_order` и `_sync_order` живут в `PackagesManager`. Варианты: держать
их под `if OS.is_debug_build()` или перенести трассировку в отдельный
`PackageSyncTrace` (RefCounted), который тест подключает сам. `_remove_tree`
оставить: им пользуется `forget_package`.

### P3. Константы кодов ошибок

`"no_key"`, `"marker_format"`, `"file_hash"`, `"asset_derive_failed:%s"` —
строки, которые тесты и логи сравнивают вручную. Небольшой `const`-набор в
`ArtifactStore`/`PackageManifest` убирает опечатки, но менять публичный формат
ошибок без нужды не стоит.

## 4. Риски и как их проверять

- **Совместимость с нативным runtime.** `storage_root()` возвращает
  `user://wired/rooms` вне web, relocate — no-op, поведение не меняется. Но
  формат маркера общий: нативный runtime после обновления один раз
  перекачает пакеты (маркер v1 → промах). Это ожидаемо и безвредно.
- **Старые каталоги.** `runtime/v1`/`v2` артефактов не мигрируются, а просто
  остаются orphaned до `prune`/ручной чистки — так и было задумано в дизайне.
- **Большие пакеты.** Замерить холодный старт Game tab с пакетом >100 МБ после
  перезагрузки: время должно уйти в чтение+sha256, а не в сеть. Если разница
  с сетью меньше ожидаемой — вернуться к компромиссу из 2.3.
- **Одновременные вкладки.** Две вкладки одной комнаты пишут в одну IndexedDB;
  блокировка применения (`_applying`) живёт в памяти процесса и между
  вкладками не работает. Это не регрессия ветки, но кеш делает окно
  рассинхронизации шире: стоит проверить сценарий «две вкладки, публикация
  пакета» и, если воспроизводится, вынести решение в отдельную задачу (Web
  Locks или BroadcastChannel).

## 5. Проверка

Выполнено на этой ветке (Godot 4.6.2 с PATH, не пинированный 4.8-beta2 —
поэтому проверялся только GDScript-уровень):

```bash
godot --headless --path packages/server/godot_project/_wired --import
godot --headless --path packages/server/godot_project/_wired \
  --script res://tests/packages_manager_smoke.gd --quit-after 1200
godot --headless --path packages/server/godot_project/_wired \
  --script res://tests/artifact_store_smoke.gd --quit-after 600
godot --headless --path packages/server/godot_project/_wired \
  --script res://tests/package_assets_smoke.gd --quit-after 600
godot --headless --path packages/server/godot_project/_wired \
  --script res://tests/main_scene_swap_smoke.gd --quit-after 900
godot --headless --path packages/server/godot_project/_wired \
  --script res://tests/package_entry_smoke.gd --quit-after 600
```

Ожидаемый признак успеха — строка `*_SMOKE_OK` в выводе (Godot возвращает
код 1 из-за stderr-предупреждений, это нормально для этих смоуков).

Фактические результаты прогона:

| Смоук | Результат |
| --- | --- |
| `packages_manager_smoke` | `PACKAGES_MANAGER_SMOKE_OK` |
| `artifact_store_smoke` | `ARTIFACT_STORE_SMOKE_OK checks=42` |
| `package_assets_smoke` | `PACKAGE_ASSETS_SMOKE_OK` |
| `main_scene_swap_smoke` | `MAIN_SCENE_SWAP_SMOKE_OK checks=41` |
| `package_entry_smoke` | `PACKAGE_ENTRY_SMOKE_OK checks=9` |
| `package_registry_smoke` | `PACKAGE_REGISTRY_SMOKE_OK checks=53` |
| `state_persistence_smoke` | `STATE_PERSISTENCE_SMOKE_OK checks=104` |
| `package_fs_smoke` | `OK 32 checks` |

Ручной сценарий для web-части (нужен `pnpm export:game` и пинированный
4.8-beta2):

1. Открыть Game tab, дождаться `WIRED_PACKAGES_APPLIED`.
2. Перезагрузить страницу, открыть Game tab снова: в консоли
   `WIRED_PACKAGES_CACHED`, в Network нет запросов `runtime-files`.
3. Отключить пакет (purge), перезагрузить страницу: каталог пакета не
   возвращается, в консоли нет `WIRED_PACKAGES_CACHED` для него.
4. Опубликовать зависимость: ключ меняется, снова `WIRED_PACKAGES_APPLIED`
   и полная загрузка.

## 6. Чек-лист

- [x] purge сохраняется на web (flush в конце пачки);
- [x] cache hit не синхронизирует IDBFS без реальных изменений;
- [x] целостность кеша проверяется по sha256, а не только по размеру;
- [x] публикация состояния и маркер не дублируются;
- [x] `ArtifactStore` не зависит от `AssetDeriver`;
- [x] relocate-miss диагностируется;
- [ ] разбить `packages_manager.gd` (P1);
- [ ] вынести очередь операций из `main_scene.gd` (P1);
- [ ] разбить `packages_manager_smoke.gd`, добавить main_scene-регрессию (P1);
- [ ] решить судьбу `CACHE_REUSE` (P2);
- [ ] замерить холодный старт на большом пакете (P3);
- [ ] проверить две вкладки одной комнаты (P3).
