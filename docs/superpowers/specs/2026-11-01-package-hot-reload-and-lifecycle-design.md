# Дизайн: hot reload пакетов, отключение и удаление пакета комнаты

Дата: 2026-11-01
Статус: draft
Область: `packages/server/godot_project/_wired` (рантайм), `packages/server/src/{godot-game,scripting-packages}` (backend), `frontend/src/app/room/[room_code]/(godot)/*` и `frontend/src/api/services`, `packages/shared/src/api/types.ts`

## 1. Задача

Сейчас пакет комнаты применяется на сервере и клиентах, но не умеет корректно исчезать, а динамические сущности не перезагружаются при смене ревизии. Нужно:

1. **Hot reload при изменении пакета** — статические сцены, компоненты игрока и динамические сущности переезжают на новую ревизию без перезапуска рантайма и без потери состояния мира.
2. **Отключить пакет** — пакет остаётся в комнате, но исключается из игры и из сервера игры. Динамические сущности сохраняют state в сейв и удаляются из дерева; при включении возвращаются.
3. **Удалить из комнаты** — безвозвратное удаление пакета (строка БД, ревизии, артефакты, контент в живом мире) с подтверждением в модальном окне.
4. **Аудит всех кейсов жизненного цикла**: добавление/удаление из регистрации статической сцены, компонента игрока, динамического типа; публикация (Emit) при запущенной игре; отключение; удаление; рестарт рантайма; переподключение клиента.

Главный принцип: **рантайм и клиенты сходятся к одному авторитетному набору пакетов**, который задаёт бэкенд. Все переходы (publish / disable / delete) — это переходы этого набора, а не отдельные ad-hoc пути.

## 2. Цели

1. Динамические сущности переживают смену ревизии: тот же `entity_id`, сохранённый `state`, новый скрипт/сцена.
2. Сущности пакета, который отключили, уходят из дерева на сервере и у всех клиентов, но их записи остаются в `state.json`.
3. Включение отключённого пакета возвращает его контент и сущности на прежние места.
4. Удаление пакета вычищает его из живого мира, из сейва, с клиентов и с диска.
5. Новая ревизия, опубликованная через Emit при запущенной игре, доезжает до сервера и всех клиентов (этот путь уже есть — его нужно не сломать и покрыть тестами).
6. В UI появляются «Отключить/Включить» и «Удалить из комнаты» (модалка подтверждения).
7. Все состояния согласованы после любого порядка событий: late join, потеря события, рестарт рантайма, ошибка применения.

## 3. Не-цели

- Клиентский prediction/rollback и сглаживание.
- Частичная пересборка статики или компонентов: `StaticWorldContainer.rebuild()` и `PlayersManager.rebuild_live_components()` остаются полными, как сегодня.
- Сохранение рантайм-состояния статических сцен между пересборками (сейчас оно сбрасывается на каждое применение пакета; поведение не меняется).
- Отвязка пакета от комнаты с сохранением в библиотеке: удаление всегда безвозвратное.
- Отключение глобального (библиотечного) пакета: флаг `enabled` имеет смысл только для пакета, привязанного к комнате. UI таких пакетов не показывает.
- Пересборка артефактов зависимых пакетов при удалении библиотеки (существующее ограничение доставки).
- Изменение формата манифеста и URL доставки файлов.

## 4. Ограничения и факты

- `ScriptingPackage` уже привязан к комнате одним `ManyToOne room`; отдельной таблицы настроек комнаты нет. `DB_SYNC=1`, схема мутируется автоматически — новая колонка с default безопасна.
- `PackageSyncService` — единственный, кто пишет команды в stdin рантайма (`package <id> <rev>`); команды обратной выгрузки нет.
- Протокол (`WiredProtocol`) не знает события «пакет убран». `WiredNetwork._package_revisions` отдаёт late joiners только добавленные ревизии.
- Клиент получает стартовый список пакетов один раз в bridge-конфиге; новые пакеты приходят событием `package_revision`, и клиент умеет их скачивать.
- `WorldSnapshotRules.packages_match` требует **точного** равенства карт применённых пакетов: лишний локальный пакет навсегда блокирует snapshot, пока клиент его не выгрузит.
- `DynamicWorldContainer` не умеет ни заменять живые сущности, ни удалять; `apply_snapshot` умеет только добавлять/обновлять.
- `PlayersManager.rebuild_live_components()` уже сохраняет/восстанавливает state компонентов по ключу `<package_id>:<relative_path>`; удалённые из регистрации компоненты просто исчезают.
- Публикация (Emit) уже вызывает `revisionPublished` → dispatch в рантайм → `EVENT_PACKAGE_REVISION` клиентам. Ломается только состав пакетов (disabled) и удаление.
- Авторизация: `assertPackageEditing` (автор, контрибьютор, редактор комнаты). Переиспользуем её для `enabled` и `DELETE`.
- Тесты: Jest в `packages/server/src`, Vitest в `frontend/src`, headless GDScript smoke-тесты в `packages/server/godot_project/_wired/tests`.

## 5. Рассмотренные подходы

### Вариант A — единый lifecycle-набор пакетов (выбран)

Бэкенд хранит `enabled` и является источником истины о том, какие пакеты активны. Любое изменение набора (publish/enable/disable/delete) превращается в команду рантайму и событие клиентам. Рантайм умеет `unload <id> [purge]`; клиенты — `package_removed`. Динамика перезагружается через park→despawn→restore с сохранением id и state.

Плюсы: один путь для disable и delete, состояние мира не теряется, late join и потеря события лечатся snapshot-ом. Минусы: больше точек изменения (БД, API, протокол, рантайм, UI).

### Вариант B — перезапуск рантайма на изменение состава

Гасим рантайм комнаты, клиенты переподключаются. Кода меньше, но рвутся сессии, теряется состояние мира, и это не hot reload. Отклонён.

### Вариант C — только фильтрация на бэкенде

Не отправлять disabled-пакет новым клиентам, живой мир не трогать. Не соответствует требованию «уберётся из игры и сервера игры». Отклонён.

## 6. Модель данных и API

### 6.1 Сущность

`packages/server/src/database/entities/scripting-package.entity.ts`:

```ts
@ApiProperty({ description: 'package is active in its room' })
@Column({ default: true })
enabled: boolean;
```

`packages/shared/src/api/types.ts`: `ScriptingPackage.enabled: boolean`; в `UpdateScriptingPackagePayload` добавить `enabled?: boolean` (в `CreateScriptingPackagePayload` не добавляем: создавать сразу выключенным не нужно).

### 6.2 DTO и сервис

- `UpdateScriptingPackageDto` расширяем полем `enabled?: boolean` (`@IsOptional() @IsBoolean()`), не через `PartialType(Create...)`.
- `ScriptingPackagesService.update`: `if (dto.enabled !== undefined) pkg.enabled = dto.enabled;` и после сохранения, если флаг изменился, уведомить синк-сервис.
- `ScriptingPackagesService.remove`: до удаления загрузить пакет с `room` (уже делает `findOne`), запомнить `roomId`; после удаления строки и файлов вызвать `packageRemoved(id, roomId)`.

### 6.3 Уведомление синк-сервиса

`PACKAGE_REVISION_DISPATCHER` (`packages/server/src/godot-game/package-sync.types.ts`) расширяем:

```ts
revisionPublished(packageId, revision): Promise<void>;
packageEnabledChanged(packageId: number): Promise<void>;   // читает enabled из БД
packageRemoved(packageId: number, roomId: number): void;   // без БД
```

`ScriptingPackagesService` инжектит существующий токен (`@Optional()`, как `storage`) — циклов нет: `ScriptingPackagesModule` уже импортирует `GodotGameModule`.

`PackageSyncService`:

- `packageEnabledChanged(packageId)`: читает пакет с `room`. Если `enabled === false` → `deactivate(packageId, roomId)`; если `true` → `reconcileRoom(roomId)` (dispatch последней опубликованной ревизии).
- `packageRemoved(packageId, roomId)`: `store.remove(roomId, packageId)` → `runtime.sendPackageUnload(packageId, true)` (одна команда, без промежуточного `deactivate`).
- `deactivate(packageId, roomId)`: удалить запись из store, `runtime.sendPackageUnload(packageId, false)`. Если рантайм не running — просто удалить запись. Файлы на диске **не трогаем** (см. §6.5).
- `roomPackages(roomId)` фильтрует `enabled: true` — только для dispatch/reconcile.
- `getStatuses(roomId)` возвращает **все** пакеты комнаты, включая отключённые и без опубликованной ревизии. Фильтрацию «в игре» делают потребители: bridge-конфиг и `packagesAreApplied` в `GameTab` берут только `enabled && revision > 0`. Панель пакетов получает полный список и по нему же обнаруживает удаление (пакет исчез из ответа).
- `revisionPublished` для `enabled === false` ничего не делает: свой пакет не диспатчится, зависимые не обновляются. Это безопасно только вместе с инвариантом §6.5.
- `SyncRecordStore.remove(roomId, packageId)`.

`PackageSyncStatus` в `packages/shared/src/api/types.ts` расширяем: `enabled: boolean`, `revision: number` (`0` — нет опубликованной), `publishedAt: string | null`. `StatusReporter`/`game-room.service` соответственно перестают пропускать пакеты без публикации.

`RoomRuntimeService` / `RoomRuntimeSession`:

```ts
sendPackageUnload(packageId: number, purge: boolean): boolean; // "unload <id>" / "unload <id> purge"
sendRoomPackages(packageIds: number[]): boolean;               // "room-packages <id,id,...>"
```

### 6.4 Frontend API

`frontend/src/api/services/scripting-packages.ts`:

```ts
updateScriptingPackage(id, { enabled }): Promise<ScriptingPackage>  // PATCH scripting-packages/:id
deleteScriptingPackage(id): Promise<void>                          // DELETE scripting-packages/:id
```

### 6.5 Инвариант зависимостей

Артефакт пакета B, который ссылается на `res://packages/A/...`, после сборки указывает на каталог A (`user://wired/rooms/<room>/packages/A/<rev>-<key>/`), а не копирует его файлы. Поэтому:

- **Отключение A файлы не удаляет.** Рантайм только снимает регистрацию и выгружает контент; каталог A остаётся на диске. Если B остался включённым, его ссылки продолжают работать.
- **Удаление A запрещено, если от A (транзитивно, в т.ч. через глобальные библиотеки) зависит включённый пакет комнаты.** `DELETE /scripting-packages/:id` возвращает `409 Conflict` с `{ dependents: [{ packageId, name }] }`; UI показывает их в модалке и предлагает сначала отключить/удалить зависимые. Проверка — `PackageClosureResolver.findDependentRoomPackages(id)`, отфильтрованная по `enabled`. Это моё решение (защита от порчи живых сцен); при желании его можно смягчить позже.
- **Отключение A разрешено всегда.** Включённые зависимые не ломаются (файлы на месте), а отключённые нам не важны. Повторное включение ничего не пересобирает.
- **Публикация B, у которой прямая или транзитивная зависимость в той же комнате отключена, отклоняется** (`409`, `{ dependencyId, name }`). Иначе артефакт B прибил бы ревизию A, чей каталог рантайму не разрешено скачивать. Проверка — в `PackageRevisionsService.publish` после резолва closure.
- **Удаление библиотечного пакета, от которого зависят пакеты комнат**, блокируется тем же `findDependentRoomPackages` (он возвращает зависимых из всех комнат, если корень — библиотека).
- **Emit отключённого пакета** в UI недоступен; бэкенд его игнорирует (ревизия сохраняется, доставки нет).

Инвариант, который держит всё: **включённый пакет комнаты не может зависеть от отключённого или удалённого пакета**. Он проверяется в трёх точках: disable (есть ли включённые зависимые), publish (есть ли отключённые зависимости), delete (есть ли включённые зависимые).

## 7. Рантайм Godot

### 7.1 Протокол и сеть

`WiredProtocol`:

```gdscript
const EVENT_PACKAGE_REMOVED := "package_removed"
# payload переиспользует существующий KEY_PACKAGE_ID = "package_id"
```

`WiredNetwork`:

- `remove_package_revision(package_id)`: убрать из `_package_revisions`, broadcast `{type: EVENT_PACKAGE_REMOVED, package_id}`.
- `_send_package_revisions` для late joiners: `_package_revisions` уже не содержит выгруженный пакет — ничего не меняем.
- Клиентский `_on_server_event`: `EVENT_PACKAGE_REMOVED` → сигнал/колбэк в `main_scene._apply_package_removal(package_id)`.
- `sendRoomPackages`/`set_room_package_ids(ids)`: серверная команда `room-packages <id,id,...>` (список **всех** пакетов комнаты, включая отключённые) — источник истины для очистки сейва (см. §7.2, шаг 8).

### 7.2 Команда управления

`main_scene._control_loop`:

```
unload <id>          -> _apply_package_removal(id, false)
unload <id> purge    -> _apply_package_removal(id, true)
```

`_apply_package_removal` и `_apply_package_revision` сериализуются: `main_scene` держит простую очередь (`_package_ops_busy` + `_package_ops_queue`), чтобы `unload` не выполнился посреди `await sync_package` того же пакета.

Порядок `_apply_package_removal(package_id, purge)` на сервере:

1. `_dynamic_world.park_package(package_id)` — снять записи живых сущностей пакета в pending-список и удалить узлы (despawn).
2. `_registry.clear_package(package_id)`.
3. `_packages.forget_package(package_id, purge)` — сбросить `_current_revisions/_current_artifact_keys/_file_hashes/_scene_dependencies`; каталог `user://wired/rooms/<room>/packages/<id>` удалять **только при `purge`** (отключение обязано сохранить файлы, §6.5). Клиент всегда оставляет файлы: стоимость — место на диске до конца жизни комнаты.
4. `_static_world.rebuild()`.
5. `_players.rebuild_live_components()` (с park-логикой компонентов, §7.4); при `purge` — ещё `_players.purge_package(package_id)` (вычистить запомненные state компонентов).
6. Если `purge`: `_dynamic_world.purge_package(package_id)` — удалить pending-записи пакета из сейва.
7. `_net.remove_package_revision(package_id)` — broadcast клиентам.

**Удаление пакета, пока рантайм не запущен.** Сейв пишет только Godot, бэкенд его формат не трогает. Поэтому после `runtime ready` (и после `reconcileRoom`) `PackageSyncService` отправляет команду `room-packages <все id пакетов комнаты>`; `main_scene._apply_room_packages(ids)` вычищает `_dynamic_world._parked` и запомненные state компонентов игроков для пакетов, которых в списке нет. Отключённые пакеты в списке есть и сохраняются. Так удаление, сделанное при выключенной комнате, применяется при следующем старте. Тот же список — хороший источник для late join, но bridge-конфиг уже несёт карту пакетов, дублировать не нужно.

### 7.3 Динамический мир

`DynamicWorldContainer` получает:

- `_parked: Array[Dictionary]` — записи, ожидающие тип/пакет. Заменяет `_saved_dynamic_records` в `main_scene` как единственный владелец pending-списка: `seed_pending(records)` при загрузке `state.json`, `pending_records()` для сохранения.
- `park_package(package_id) -> int`: для каждой живой сущности, у которой `type_id` начинается с `"<package_id>/"`, собрать persisted record (`{entity_id, type_id, owner_player_id, state, persistent}`), добавить в `_parked`, затем despawn. Узел снять с родителя (`get_parent().remove_child`) и `queue_free()`, чтобы `MultiplayerSpawner` разослал despawn сразу, а имя `Dynamic<id>` освободилось в этом же кадре.
- `restore_pending() -> int`: пройти `_parked`, попробовать `_restore_records`; успешно восстановленные записи удалить из `_parked`. Тип, которого нет в registry, остаётся в pending — это и есть «сущность убрали из регистрации».
- `purge_package(package_id)`: удалить из `_parked` все записи пакета.
- `save_state()`: живые записи + `_parked` (только `persistent != false`). Дедупликация по `entity_id`: живая запись выигрывает.
- `snapshot_state()`: только живые.
- `apply_snapshot(records, packages)` — снапшот авторитетен для состава, но не для «свежести»: он собран в момент T и приходит асинхронно, а spawn-пакеты новых сущностей идут отдельно. Поэтому prune не безусловный:
  - существующая сущность с тем же id и актуальной ревизией пакета → `_wired_load_state`;
  - существующая сущность, чей пакет присутствует в карте снапшота с **другой** ревизией/artifact_key, и её id отсутствует в records → локально удалить и пересоздать из записи с новым контекстом (id и state сохраняются);
  - отсутствующая в `_entities` → создать (текущий repair-путь);
  - **лишняя** (id есть в `_entities`, но нет в records), и при этом её пакет отсутствует в карте снапшота **или** его ревизия в карте отличается от штампа сущности → удалить узел и запись индекса. Сущность, чей штамп совпадает с картой снапшота, не удаляется: она могла появиться после T. Это лечит потерянное событие `package_removed`, выгруженный тип и рестарт сервера без гонки со spawn-пакетами.
- При `_instantiate_entity` ставить на узел штамп пакета: `META_PACKAGE_ID`, `META_PACKAGE_REVISION` и новый `META_PACKAGE_ARTIFACT_KEY` из контекста. Сравнение идёт по паре revision+artifact_key (один и тот же номер ревизии может быть пересобран с другим ключом).
- `apply_snapshot` получает вторым аргументом карту пакетов снапшота (`{ "<id>": {revision, artifact_key} }`), которую `_apply_world_snapshot` уже имеет.

`main_scene._apply_registered_package(package_id, revision)` (сервер и клиент):

1. `_dynamic_world.park_package(package_id)` (сервер) / `_dynamic_world.drop_package(package_id)` (клиент: удалить узлы пакета, ничего не парковать).
2. `_registry.clear_package(package_id)`; `PackageEntryLoader.load_entry(...)`.
3. `_static_world.rebuild()`; `_players.rebuild_live_components()`.
4. Сервер: `_dynamic_world.restore_pending()` — сущности возвращаются с теми же id и state, но уже с новым контекстом.
5. Клиент: `_request_world_snapshot()` после применения пакета — снапшот заменит устаревшие экземпляры и восстановит пропущенные.

Почему не «сервер шлёт respawn, клиент ждёт»: клиент может применить пакет позже, чем придёт spawn-пакет, и создать сущность старым контекстом. Авторитетный снапшот с проверкой ревизии закрывает оба порядка.

### 7.4 Компоненты игрока

- `PlayersManager.rebuild_live_components()` уже сохраняет/восстанавливает state. Добавляем: перед `_rebuild_components` игрок паркует state компонентов, чьи ключи исчезли из нового набора (`<package_id>:<path>`), в `WiredPlayer._parked_component_states`; `save_state()` включает их, `load_state()` мержит. Тогда disable→enable возвращает состояние компонента, как и у динамики.
- `PlayersManager.purge_package(package_id)` очищает `_parked_component_states` всех живых игроков и `_saved_states` для этого пакета (удаление навсегда).
- `_components_match` остаётся критерием для snapshot-repair, но теперь ещё и вызывает `rebuild_live_components`, если набор разошёлся (уже делает).
- Локальные (`local_only`) компоненты: park/restore выполняется на владельце; на остальных пирах их нет, и это не меняется.

### 7.5 Статические сцены

`StaticWorldContainer.rebuild()` уже удаляет только корни с `META_REGISTERED` и создаёт заново из registry. Этого достаточно: удалённый из регистрации корень исчезает, добавленный появляется, сцена удалённого пакета исчезает после `registry.clear_package`. Менять контейнер не нужно; покрываем тестами.

## 8. Клиент: состав пакетов и snapshot

- Bridge-конфиг (`GameTab.tsx`) собирает `packages` из `GET /rooms/:id/game/packages`, фильтруя `enabled && revision > 0`; `packagesAreApplied` проверяет тот же отфильтрованный список. Disabled не скачивается при старте.
- `EVENT_PACKAGE_REMOVED` → `_apply_package_removal(id, false)` на клиенте: `_packages.forget_package(id, false)`, `_registry.clear_package`, rebuild static/players, `drop_package`, затем `request_world_snapshot()`.
- Потеря события: первый же снапшот содержит карту пакетов без выгруженного; клиент обнаруживает расхождение, применяет **серверную** карту как истину: выгружает локальные пакеты, которых нет на сервере (`forget_package` + rebuild), докачивает недостающие (`sync_package`), после чего применяет снапшот. Это заменяет текущее «defer и ждать, пока локальная подпись изменится».
- **Ошибка докачки.** Если `sync_package` для пакета из карты сервера не удался (404/сеть/хеш), клиент логирует `WIRED_PACKAGE_SYNC_FAILED`, не применяет players/dynamic (инвариант `packages_match` сохраняется) и планирует повтор с backoff (2с, 5с, 10с, далее каждые 10с, без лимита попыток — комната живёт долго). На каждой попытке запрашивается свежий снапшот: если пакет к этому моменту удалён, новая карта его уже не содержит, и клиент сходится штатным путём. Ошибки hash/format (пакет есть, но битый) ретраятся так же и логируются как `cli_package_failed`.
- `packages_match` остаётся финальным гейтом применения players/dynamic; расхождение теперь лечится, а не блокирует навсегда.

## 9. Frontend UI

### 9.1 `use-room-packages.ts`

- `setPackageEnabled(id, enabled)`: PATCH, затем `refresh()`. Ошибки — через существующий `guarded`/`actionFor`.
- `deletePackage(id)`: DELETE, удалить каталог пакета из FS редактора (`files.removePackage`), удалить baseline/snapshot, dispatch `removed`, `refresh()`. `409` с зависимыми → ошибка действия с их списком (не удаляем).
- Reducer: новое действие `removed` с `removedIds: Set<number>` (tombstones). `merged`/`created` фильтруют tombstone-ids, чтобы устаревший `roomPackages` prop не воскресил удалённый пакет.
- `load()` теперь удаляет из состояния пакеты, которых нет в ответе `getRoomPackages` (ответ полный, включая отключённые и неопубликованные) — так удаление из другой вкладки/пользователем доезжает до панели. Tombstones очищаются при смене комнаты.
- `entry` для disabled-пакета: `status: "disabled"`, `enabled: false`; download/adopt остаются доступными, «Emit» скрыт.

### 9.2 `PackagesTab.tsx`

- Бейдж «Отключён» и кнопка «Включить» вместо «Отключить» по `entry.package.enabled`.
- Кнопка «Удалить из комнаты» (danger) открывает `Dialog` (shadcn `components/ui/dialog`) с названием и id пакета, кнопки «Отмена» / «Удалить навсегда». Подтверждение — только через модалку, не `window.confirm`.
- Существующая «Убрать из редактора» остаётся и по-прежнему означает только локальную FS; в тексте явно развести два действия.
- Для disabled-пакета скрываем блок runtime-статуса и показываем причину: «Пакет отключён в комнате».

## 10. Матрица кейсов (аудит)

| Событие | Сервер | Клиенты | Сейв |
|---|---|---|---|
| Новая ревизия (Emit) | `package` → sync → apply: park→restore dynamic, rebuild static/players, `set_package_revision` | `package_revision` → sync, rebuild, request snapshot | state сущностей сохранён |
| Новая ревизия у disabled-пакета | `revisionPublished` игнорируется | ничего | — |
| Включение пакета | reconcile → dispatch latest → apply | `package_revision` | parked-сущности восстанавливаются |
| Отключение пакета | `unload` → park+despawn, clear registry, rebuild, remove revision broadcast | `package_removed` → forget, rebuild, drop | записи остаются в `state.json` |
| Удаление пакета | `unload <id> purge` + удаление строки/файлов | `package_removed` | parked-записи пакета удаляются |
| Добавили статическую сцену в регистрацию | rebuild добавляет корень | rebuild после sync | — |
| Убрали статическую сцену | rebuild удаляет корень | то же | — |
| Добавили компонент игрока | rebuild добавляет всем живым | то же | новый компонент получает default state |
| Убрали компонент игрока | rebuild удаляет, state паркуется | то же | state сохраняется в сейве |
| Добавили динамический тип | доступен для spawn | доступен после sync | — |
| Убрали динамический тип | живые сущности park+despawn, pending | snapshot убирает | записи остаются pending |
| Пакет не применился (ошибка) | `package_failed`, retry бэкендом | не получает ревизию | состояние не меняется |
| Рестарт рантайма | `reconcileRoom(fresh)`, только enabled | переподключение, bridge-конфиг без disabled | pending-записи восстанавливаются |
| Late join | снапшот с картой enabled-пакетов | snapshot reconcile | — |
| Потеря `package_removed` | — | snapshot prune + adopt карты сервера | — |
| Удаление при выключенной комнате | `room-packages` при старте | bridge-конфиг без пакета | pending-записи вычищаются при старте |
| Удаление пакета, от которого зависит enabled-пакет | `409`, удаления нет | панель показывает зависимых | — |

## 11. Тесты

- Jest `package-sync.service.spec.ts`: disable → `sendPackageUnload(id,false)` + запись удалена, `getStatuses` содержит пакет с `enabled:false`; enable → dispatch; delete → `sendPackageUnload(id,true)`; publish disabled → нет dispatch; `roomPackages` фильтрует enabled; runtime ready → `sendRoomPackages` со всеми id комнаты.
- Jest `scripting-packages.service.spec.ts` / controller: PATCH `enabled` уведомляет dispatcher; DELETE вызывает `packageRemoved(id, roomId)`; DELETE с enabled-зависимым → `409` + список; PUBLIC publish с отключённой зависимостью → `409`; запрет для чужого пользователя.
- Godot smoke: `dynamic_world_smoke.gd` — park сохраняет state и id, restore возвращает сущность, purge удаляет записи, snapshot удаляет лишние и заменяет устаревшую ревизию, но не трогает сущность с актуальным штампом; `static_world_smoke.gd` — rebuild после `clear_package`; `players_manager_smoke.gd` — удалённый компонент паркует state и восстанавливает после возврата.
- Vitest `use-room-packages.test.tsx`: toggle вызывает PATCH; delete вызывает DELETE, убирает entry и не воскрешает из props; пакет, исчезнувший из ответа поллинга, удаляется из состояния; tombstones сбрасываются при смене комнаты. `PackagesTab.test.tsx`: модалка, disabled-бейдж, скрытый Emit для disabled, обработка `409`.

## 12. Что остаётся строителю

- Точные имена полей события `package_removed` и helper-функций — на его выбор, если сохраняется смысл.
- Формат parked-записи: разрешено добавить внутренний ключ `persistent`, если он снимается перед spawn.
- Очередь package-операций в `main_scene`: конкретная реализация (флаг + массив) — на его выбор.
- Порядок удаления строки БД и файлов при DELETE: строка авторитетна, ошибка диска логируется (как сейчас).
- Точный формат `room-packages` (через запятую или JSON) и место вызова `sendRoomPackages` (рядом с dispatch в `reconcileRoom`).
- Хранение parked-state компонентов: в `WiredPlayer` или отдельным словарём `PlayersManager` — на его выбор, важен ключ `<package_id>:<path>`.

## 13. Решения, принятые самому (проверить при чтении)

1. Удаление пакета блокируется, если от него зависит включённый пакет комнаты (`409` + список). Смягчение — отдельная задача.
2. Отключение не удаляет файлы пакета с диска; удаление — удаляет.
3. `GET /rooms/:id/game/packages` отдаёт все пакеты комнаты с `enabled`; фильтрация «в игре» — на клиенте.
4. Prune в снапшоте условный (по карте пакетов и штампу ревизии), чтобы не удалять сущности, созданные после сборки снапшота.
5. Emit отключённого пакета не доставляется и не включает пакет.
6. Новые пакеты без опубликованной ревизии попадают в панель, но не в игру.
