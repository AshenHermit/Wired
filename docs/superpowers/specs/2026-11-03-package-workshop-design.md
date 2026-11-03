# Workshop пакетов: витрина, публикация, fork и добавление в комнату

Дата: 2026-11-03
Статус: proposal

## 1. Задача

Появляется workshop — публичная витрина пакетов, опубликованных пользователями. Она видна в двух местах:

- на главной странице во вкладке «Пакеты»: список опубликованных пакетов и поиск по названию, slug и тегам;
- в панели пакетов комнаты: кнопка «Workshop» открывает модальное окно с тем же компонентом списка и поиска, но с возможностью выбрать пакет и добавить его в комнату.

Публикация в workshop идёт из панели комнаты и подчиняется правилам provenance и авторства:

- новый пакет создаётся только внутри комнаты; `parentPackage` у него изначально нет;
- публикуется пакет, у которого есть опубликованная ревизия (`Emit`);
- если slug пакета ещё не занят в workshop, создаётся глобальная копия: `room = null`, `parentPackage = null`, автор — тот, кто опубликовал, содержимое — снимок последней опубликованной ревизии;
- если slug уже занят в workshop и его автор — текущий пользователь, публикация обновляет существующую запись (новая опубликованная ревизия + метаданные);
- если slug занят другим автором, пользователю предлагается создать fork с новым slug: появляется новый пакет в комнате, `parentPackage` сохраняется, внутренние ссылки `res://packages/<старый>/…` переписываются на новый slug;
- добавление пакета из workshop в комнату создаёт копию: та же slug, `parentPackage` = запись workshop, `room` = целевая комната, автор — тот, кто добавляет.

Дополнительно снимается глобальная уникальность `slug`: у комнатной копии он совпадает с оригиналом из workshop, а идентичность пакета остаётся числовой (`id`).

## 2. Goals

- Публичная витрина workshop: глобальные пакеты, у которых есть опубликованная ревизия.
- Поиск по названию, slug и тегам; один компонент для главной страницы и модалки в панели.
- Публикация пакета комнаты в workshop с тремя исходами: создание, обновление, конфликт с предложением fork.
- Fork с новым slug и переписыванием внутренних ссылок в скопированных файлах.
- Добавление записи workshop в комнату как независимой копии с `parentPackage` и `room`.
- Убрать глобальную уникальность `slug` и заменить её областями видимости: комната и workshop.
- Разрешить `Emit` всем участникам комнаты (автор и контрибьюторы), оставив точку расширения для будущих прав.
- Ввести теги пакета и их поиск.

## 3. Non-goals

- Не переносим историю ревизий при копировании: копия получает одну опубликованную ревизию — снимок последней опубликованной ревизии источника.
- Не делаем живую связь с оригиналом: изменения копии не попадают в источник и наоборот.
- Не добавляем семантическое версионирование, дистрибуцию версий и зависимости между версиями.
- Не делаем модерацию, приватность, скрытые пакеты, лицензии и передачу авторства.
- Не меняем схему URL: маршруты остаются `/scripting-packages/:id`, идентичность — числовой `id`.
- Не меняем формат runtime-артефактов, `PackageRuntimeManifest` и пути `user://wired/rooms/<room>/packages/<slug>/…`.
- Не добавляем миграционный фреймворк: проект живёт с `DB_SYNC=1`.
- Не переносим права `Emit` в настройки пакета в этой задаче.
- Не реализуем удаление/скрытие записи workshop с главной страницы.

## 4. Anti-goals

- Два пакета с одним slug в одной комнате: они схлопнутся в один каталог `packages/<slug>` в редакторе и в runtime.
- Копия, которая меняется вместе с оригиналом или ломается при удалении оригинала.
- Публикация в workshop, которая молча перезаписывает чужую запись.
- Fork, который оставляет внутри файлов ссылки на старый slug и поэтому ломает сцены и скрипты.
- Пакет-пустышка в workshop: запись без опубликованной ревизии.
- Ссылка `res://packages/<slug>` в комнате, которая резолвится в глобальный пакет при наличии пакета с тем же slug в этой комнате.
- Разные правила slug в четырёх местах (создание, панель, fork, копирование).

## 5. Constraints

- `DB_SYNC=1` на общей Postgres: изменения entity меняют схему при старте сервера, миграций и отката нет.
- Снятие `unique: true` с `slug` убирает единственную гарантию на уровне БД; конкурентность придётся держать на advisory-lock, как это уже сделано в `create()`/`remove()`.
- `slug` вшит в пути редактора, runtime и в ссылки GDScript, поэтому он не переименовывается после создания пакета.
- Копирование выполняется на сервере: у сервера уже есть байты опубликованных ревизий, а у браузера — нет.
- В панели нет общего компонента поиска и debounce-хука; единственный образец debounce — проверка slug в модалке создания.
- Файлы ревизии хранятся в `<packagesFilesDir>/<packageId>/revisions/<revision>/`, поэтому копия неизбежно дублирует байты в свой каталог.
- Публикация ревизии идемпотентна и защищена advisory-lock `wired.package-publish:<packageId>`; копирование должно переиспользовать этот путь, а не писать в published-каталог напрямую.
- Runtime доставляет пакеты комнаты и транзитивные зависимости; `RoomMembershipGuard` требует `pkg.room.id === roomId`, поэтому глобальные пакеты не могут быть корнем runtime-выдачи.
- Существующие данные: строки без slug уже бэкфиллятся при старте; глобальные пакеты, если они есть, становятся видимыми в workshop только при наличии опубликованной ревизии.

## 6. Рассмотренные подходы

### A. Серверное копирование (выбран)

Копия создаётся сервером: строка пакета + новая ревизия, байты копируются из опубликованного каталога источника в draft-каталог нового пакета, затем публикуются штатным `PackageStorageService.publishRevision` (проверка sha256/размеров, rename, commit). Для fork текст переписывается до расчёта sha256.

Плюсы: одна транзакция и штатная верификация байтов, не нужен открытый редактор, файлы не гоняются через браузер, переписывание ссылок и pins в одном месте. Минусы: новый код копирования ревизий и компенсация при сбое после создания строки пакета.

### B. Копирование на клиенте через существующий Emit

Фронт скачивает файлы `/revisions/:rev/files/*`, создаёт пакет и публикует через `publishPackageFiles`.

Плюсы: почти нет нового серверного кода. Минусы: пакет должен быть загружен в редактор; много round-trip'ов; неатомарно (обрыв оставляет пустой пакет или черновик); переписывание ссылок и sha на клиенте; правила публикации в workshop всё равно проверяются на сервере. Отклонён.

### C. Ссылка на ревизию источника вместо копирования

Плюсы: нет дублирования байтов. Минусы: копия перестаёт быть независимой, а удаление или новая ревизия источника меняет содержимое комнаты; ломается ретеншен артефактов. Отклонён.

### Уникальность slug

- **A. Проверки в сервисе под advisory-lock (выбран).** `unique` снимается; уникальность в комнате и среди глобальных проверяется в `create()`/`remove()` под lock по ключу `package_slug:<scope>:<slug>`, `slug-availability` читает те же области.
- **B. Частичные уникальные индексы Postgres** (`WHERE "roomId" IS NULL` и `(roomId, slug)`). Надёжнее на уровне БД, но требует явной колонки `roomId`/именованного join-column, усложняет `DB_SYNC`-схему и всё равно требует понятного 409. Оставляем как возможное отдельное улучшение.

## 7. Ключевые решения

1. **Workshop = глобальные пакеты.** Запись workshop — это `ScriptingPackage` с `roomId = null`, у которой есть хотя бы одна ревизия `status = 'published'`.
2. **Запись workshop всегда без родителя.** `parentPackage = null` у глобальных пакетов; при публикации из комнаты родитель не переносится, автор — тот, кто опубликовал.
3. **Provenance живёт на комнатной копии.** Добавление из workshop ставит `parentPackage` на запись workshop. Fork сохраняет `parentPackage` исходного пакета и не обнуляет его.
4. **Копия — снимок.** Копируется только последняя опубликованная ревизия источника; она становится ревизией 1 копии и сразу публикуется. История, черновики и discarded-ревизии не переносятся.
5. **Id — идентичность, slug — имя каталога.** API, ревизии, pins, артефакты и `parentPackage` остаются числовыми; slug определяет путь в проекте.
6. **Области уникальности slug:** уникален в пределах комнаты и уникален среди глобальных пакетов. Копия в другой комнате может иметь тот же slug, что и оригинал.
7. **Резолв ссылок room-first.** `res://packages/<slug>/…` в контексте комнаты сначала ищется среди пакетов этой комнаты, затем среди глобальных. Числовые legacy-ссылки разрешаются по id как раньше.
8. **Slug неизменяем.** Поля slug нет в update-DTO и в UI редактирования; смена slug возможна только через fork (новый пакет).
9. **Tombstone только для workshop-имён.** `retired_package_slug` пополняется при удалении глобального пакета; удаление комнатного пакета slug не хоронит. Существующие tombstones остаются в силе.
10. **Новый пакет создаётся только в комнате.** Публичный `POST /scripting-packages` требует `roomId`; глобальные записи создаются только внутренним путём публикации в workshop.
11. **Emit — всем участникам комнаты, но только Emit.** Вводится отдельная проверка `assertPackagePublishing` для создания ревизий, загрузки файлов и публикации: автор пакета, контрибьютор пакета, автор комнаты, контрибьютор комнаты. `PATCH` и `DELETE` остаются на прежней `assertPackageEditing` (автор пакета, контрибьютор пакета, автор комнаты): расширение прав Emit не даёт права переименовать, отключить или удалить чужой пакет.
12. **Публикация в workshop доступна участнику комнаты** (автор или контрибьютор) и только для пакета с опубликованной ревизией.
13. **Публикация не меняет пакет комнаты.** Метаданные и теги из диалога записываются только в запись workshop; `name`/`version`/`description`/`tags` комнатного пакета не перезаписываются. Теги комнатного пакета — только источник предзаполнения диалога: они приходят из записи workshop при добавлении или из исходного пакета при fork.
14. **Запись workshop не редактируется через ревизионные маршруты.** `POST /:id/revisions`, загрузка файлов и publish для пакета с `roomId = null` отвечают `409 package_not_in_room`: содержимое записи меняется только публикацией из комнаты.
15. **Обновление записи — только её автору.** Автор записи совпадает с тем, кто её опубликовал; другой пользователь получает `409 workshop_slug_taken` и предложение fork.
16. **Fork создаёт пакет в той же комнате** с новым slug, тем же `parentPackage`, что у исходного пакета, и переписанными self-ссылками; после fork пользователь публикует его отдельным действием.
17. **Добавление в комнату не переписывает файлы.** Slug сохраняется, поэтому ссылки и каталог совпадают с оригиналом.
18. **Теги — свободные строки на пакете:** `tags: string[]`, `jsonb`, по умолчанию `[]`; нормализуются в нижний регистр, `^[a-z0-9_-]{1,32}$`, не больше 10, без дублей; редактируются в диалоге публикации и копируются при копировании/fork.
19. **Поиск серверный:** `q` ищет подстроку без учёта регистра в `name`, `slug` и элементах `tags`; пустой `q` возвращает всё; сортировка — по дате публикации ревизии, затем по id.
20. **Один общий компонент** витрины используется на главной и в модалке панели; в модалке ему передаётся действие выбора.
21. **Удаление пакета с детьми по `parentPackage`** сначала обнуляет `parentPackageId` у детей (FK не имеет `ON DELETE SET NULL`), затем удаляет строку; комнатные копии продолжают работать со своими байтами.
22. **Ошибки — машинные коды** (`workshop_slug_taken`, `package_not_published`, `package_not_in_room`, `package_not_in_workshop`, `package_room_required`, `package_dependency_not_global`, `package_slug_shadowed`, `slug_taken`, `slug_retired`, `invalid_slug`, `invalid_tags`), UI показывает русский текст по коду.
23. **Запись workshop зависит только от глобальных пакетов.** При копировании в глобальную запись каждая ссылка `res://packages/<slug>` обязана разрешаться в глобальной области; ссылка на пакет комнаты даёт `400 package_dependency_not_global:<slug>` с подсказкой сначала опубликовать зависимость. Это гарантирует, что pins глобальной ревизии валидны в любой комнате.
24. **Область проверки и pins зависит от типа цели.** Глобальная цель (запись workshop) валидируется и пинуется в глобальной области; комнатная цель (добавление, fork) — в области целевой комнаты и проходит ту же проверку отключённых зависимостей, что и обычный publish.

## 8. Детальный дизайн

### 8.1. Модель данных и миграция

`packages/server/src/database/entities/scripting-package.entity.ts`:

```ts
@Column({ type: 'varchar', length: 64, nullable: true })
slug: string;

@ApiProperty({ description: 'Workshop tags', isArray: true })
@Column({ type: 'jsonb', default: [] })
tags: string[];
```

- `unique: true` снимается. При старте `DB_SYNC` удалит уникальный индекс; новая схема не содержит уникальных ограничений на slug.
- `tags` добавляется как `jsonb NOT NULL DEFAULT '[]'`, поэтому существующие строки получают пустой массив без backfill.
- Остальные поля не меняются: `author`, `room`, `parentPackage`, `childrenPackages`, `enabled`, `scripts`, `physicalFiles`.

Проверка после первого старта: `\d scripting_package` не должен показывать уникальный индекс по `slug`, а `tags` должен быть `jsonb not null default '[]'`.

Удаление пакета (`ScriptingPackagesService.remove`) перед `delete` выполняет:

```sql
UPDATE scripting_package SET "parentPackageId" = NULL WHERE "parentPackageId" = $1;
```

Это нужно, чтобы удаление записи workshop или любого родителя не падало на FK. `childrenPackages` после этого пуст, а копии остаются самостоятельными пакетами.

### 8.2. Slug: области, проверки и резолв

**Области.** Две области видимости:

- `room:<roomId>` — пакеты комнаты;
- `global` — глобальные пакеты workshop.

`slug` уникален внутри области. Ключ advisory-lock: `package_slug:<room:<id>|global>:<slug>`.

**`ScriptingPackagesService.create`:**

- публичный путь требует `roomId`; без него — `400 package_room_required`;
- проверка занятости: `findOne({ where: { slug, room: { id: roomId } } })` для комнаты и `findOne({ where: { slug, room: IsNull() } })` для глобальной области;
- tombstone проверяется только для глобальной области (`409 slug_retired`);
- `23505` оставляем в маппинге как страховку, но после снятия индекса он больше не срабатывает;
- внутренний путь (`createGlobalRecord`) используется только сервисом workshop и пропускает проверку «только в комнате», но выполняет те же проверки области и tombstone.

**`checkSlugAvailability(slug, roomId?)`:**

- без `roomId` проверяет глобальную область и tombstone;
- с `roomId` проверяет область комнаты (tombstone не применяется);
- ответ расширяется глобальной областью:

```ts
type PackageSlugAvailability = {
  slug: string;
  available: boolean;           // в запрошенной области
  reason?: 'taken' | 'retired'; // в запрошенной области
  global: { available: boolean; reason?: 'taken' | 'retired' };
};
```

`GET /scripting-packages/slug-availability?slug=&roomId=` — `roomId` опционален. Модалка создания передаёт текущую комнату; диалог fork проверяет и комнату, и `global`.

**Индекс slug → id** (`package-slug-index.ts`) становится областным:

```ts
export interface PackageSlugIndex {
  byId: Map<number, { slug: string; roomId: number | null }>;
  byRoomSlug: Map<string, number>;   // `${roomId}:${slug}`
  byGlobalSlug: Map<string, number>;
}
```

`loadPackageSlugIndex` загружает `id`, `slug` и id комнаты (`leftJoin('pkg.room', 'room')` + `addSelect(['pkg.id', 'pkg.slug', 'room.id'])` или `@RelationId`); колонки `roomId` как свойства сущности нет, поэтому `select: { roomId: true }` не сработает. `resolvePackageTarget(target, index, roomId)`:

- `/^\d+$/` → `Number(target)` (legacy);
- иначе → `byRoomSlug.get(`${roomId}:${target}`) ?? byGlobalSlug.get(target) ?? null`.

Все места, читающие текст пакета, передают область пакета, чьи файлы читаются:

- `PackageClosureResolver.resolve()` — комната запроса;
- `PackageRevisionsService.assertNoDisabledRoomDependency` и `recordPinnedDependencies` — комната публикуемого пакета (или `null` для глобального);
- `buildSceneDependencies`/`rewritePackageReferences` — комната выдачи;
- reverse-scan (`findDependentRoomPackages`) — комната сканируемого пакета.

**Защита от теней.** Если в комнате есть пакет со slug `X`, глобальный пакет с тем же slug не должен попасть в замыкание выдачи: ссылки уже резолвятся в комнатный пакет. Legacy-числовая ссылка на глобальный пакет, чей slug занят комнатным, даёт `400 package_slug_shadowed:<slug>` при сборке артефакта, чтобы два пакета не писали в один каталог `packages/<slug>`.

**Tombstone.** `remove()` пишет `RetiredPackageSlug` только если `pkg.room === null`. Комнатные пакеты удаляются без tombstone. Это осознанно: имя — локальное для комнаты, а глобальное имя workshop защищается.

### 8.3. API и shared-типы

`packages/shared/src/api/types.ts`:

```ts
export type ScriptingPackage = {
  // ...существующие поля
  tags: string[];
};

export type CreateScriptingPackagePayload = {
  // ...существующие поля
  tags?: string[];
};

export type WorkshopPackageSummary = {
  id: number;
  slug: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  author?: User;
  revision: number;
  publishedAt: string;
  updatedAt: string;
};

export type WorkshopListing = {
  items: WorkshopPackageSummary[];
  total: number;
};

export type WorkshopPackageMetadata = {
  name?: string;
  version?: string;
  description?: string;
  tags?: string[];
};

export type WorkshopPublishResult = {
  mode: 'created' | 'updated';
  package: WorkshopPackageSummary;
};

export type WorkshopForkPayload = { slug: string };
export type RoomCopyPayload = { roomId: number };
```

`UpdateScriptingPackagePayload` получает `tags?`; `UpdateScriptingPackageDto` — необязательные `tags`.

Новые маршруты (все объявляются **до** `@Get(':id')`, где это статические сегменты):

| Метод | Путь | Гвард | Назначение |
|---|---|---|---|
| `GET` | `/scripting-packages/workshop?q=&limit=&offset=` | нет | витрина и поиск |
| `GET` | `/scripting-packages/workshop/lookup?slug=` | нет | существующая запись по slug (для диалога публикации) |
| `POST` | `/scripting-packages/:id/workshop` | auth | публикация/обновление записи |
| `POST` | `/scripting-packages/:id/workshop-fork` | auth | fork с новым slug |
| `POST` | `/scripting-packages/:id/room-copy` | auth | копия записи workshop в комнату |
| `GET` | `/scripting-packages/slug-availability?slug=&roomId=` | auth | доступность в областях |

Ответы и ошибки:

- `POST /:id/workshop` → `{ mode, package }`.
  - пакет не в комнате → `409 { code: 'package_not_in_room' }`;
  - нет опубликованной ревизии → `409 { code: 'package_not_published' }`;
  - не участник комнаты → `403`;
  - slug занят другим автором → `409 { code: 'workshop_slug_taken', slug, workshopPackage: WorkshopPackageSummary }`;
  - slug в tombstone → `409 { code: 'slug_retired', slug }`.
- `POST /:id/workshop-fork` body `{ slug }` → `{ package }`.
  - slug занят в комнате или глобально → `409 { code: 'slug_taken', slug }`;
  - `invalid_slug` — по общему правилу;
  - не участник комнаты или пакет не в комнате → `403`/`409 package_not_in_room`.
- `POST /:id/room-copy` body `{ roomId }` → `{ package }`.
  - источник не глобальный → `400 package_not_in_workshop`;
  - нет опубликованной ревизии → `409 package_not_published`;
  - нет прав на комнату → `403`;
  - slug занят в комнате → `409 { code: 'slug_taken', slug }`.
- `GET /workshop` — `q` обрезается, приводится к нижнему регистру, максимум 64 символа; `limit` 1–100 (по умолчанию 50), `offset` ≥ 0.
- `GET /workshop/lookup?slug=` → `200 { package: WorkshopPackageSummary | null }`. Отсутствие записи — это `null`, а не `404`: клиент различает три состояния диалога, и обычный retry-экран ошибки для этого случая не показывается.
- `WorkshopPackageSummary.author` — полный `User`, как в публичном `GET /rooms` (id, name, email, picture, service). Отдельный «публичный автор» не вводим; вопрос приватности email в публичных ответах существует и до этой задачи.

### 8.4. Серверное копирование ревизий

Новый сервис `packages/server/src/scripting-packages/package-copy.service.ts` (или публичные методы `PackageRevisionsService` — на усмотрение реализации, но правила ниже обязательны).

`PackageRevisionsService` получает публичный метод:

```ts
async publishCopiedRevision(args: {
  sourcePackageId: number;
  sourceRevision: number;      // последняя published
  targetPackageId: number;
  /** Область валидации ссылок и записи pins: комната цели или null для workshop. */
  scopeRoomId: number | null;
  transformFile?: (filepath: string, data: Buffer) => Buffer;
}): Promise<PackageRevision>;
```

Алгоритм:

1. Прочитать строку источника (`status = 'published'`, `files`, `publishedAt`). Ошибка `409 package_not_published`, если её нет.
2. Прочитать каждый файл из `publishedRevisionDir(sourcePackageId, sourceRevision)`.
3. Применить `transformFile` (fork: переписать self-ссылки), пересчитать `size` и `sha256` по новым байтам.
4. Проверить ссылки в области `scopeRoomId`:
   - глобальная цель (`null`): каждая ссылка обязана разрешаться в глобальной области, иначе `400 package_dependency_not_global:<slug>`;
   - комнатная цель: та же проверка, что в `publish()` — резолв room-first и запрет ссылаться на отключённый пакет той же комнаты (`409 dependency_disabled`), неизвестный slug — `400 package_dependency_unknown_slug:<slug>`.
5. Вычислить `revision = maximum('revision', { package }) + 1` (для новой копии это 1).
6. Создать строку ревизии `status = 'draft'` с новыми `files`.
7. Записать файлы в `draftRevisionDir(targetPackageId, revision)` через `saveDraftFile`.
8. Вызвать `storage.publishRevision(targetPackageId, revision, files, commit)`: он проверит точный набор файлов, размеры и sha256, перенесёт каталог в `revisions/<revision>` и в `commit` сохранит строку как `published` с `publishedAt = now`.
9. `recordPinnedDependencies(targetPackageId, revision, files, scopeRoomId)` — pins считаются по новому пакету в его области, иначе artifact key копии будет зависеть от чужих публикаций.
10. `dispatchPublished(targetPackageId, revision)` — только если у цели есть комната; глобальная запись никуда не диспатчится.
11. При ошибке на шагах 6–8 удалить строку ревизии и каталог; вызывающая сторона удаляет созданный пакет.

**Почему область разная.** Глобальная запись workshop может быть скопирована в любую комнату, поэтому её pins обязаны указывать только на глобальные пакеты: id глобального пакета одинаков в любой комнате. Ссылка на пакет комнаты в записи workshop сделала бы копию неработоспособной в другой комнате, поэтому публикация такой ссылки запрещена. Комнатная копия, наоборот, живёт только в своей комнате, и её pins могут указывать на room-пакеты — это нормальный случай.

Компенсация на уровне сервиса workshop: если после создания строки пакета копирование упало, вызвать `remove()` для нового пакета (он ещё не опубликован, зависимостей нет) и пробросить ошибку.

**Переписывание ссылок для fork.** Текст расширений `.gd`, `.tscn`, `.tres`, `.import` заменяется по границе сегмента: `res://packages/<old>/` → `res://packages/<new>/`. Это безопасно: внутри пакета все ссылки на собственный slug — self-ссылки, потому что slug уникален в комнате. После замены байты и sha256 пересчитываются. Бинарные файлы не переписываются; если в них встречается старый путь (редкий случай), это ограничение документируется.

**Метаданные копии.** `name`, `version`, `description`, `tags` копируются из источника (для добавления в комнату — из записи workshop, для fork — из исходного пакета). При публикации в workshop значения из диалога записываются в глобальную запись и не меняют пакет комнаты. `enabled = true`, `scripts`/`physicalFiles`/`dependencies` копируются как есть.

### 8.5. Правила публикации, fork и добавления

Сервис `PackageWorkshopService` (новый, зависимости: `ScriptingPackagesService`, `PackageRevisionsService`, репозитории `ScriptingPackage`/`ScriptingPackageRevision`, `PackageStorageService`, dispatcher).

**`publishToWorkshop(packageId, user, metadata)`:**

1. Загрузить пакет с `room.author`, `room.contributors`, `author`. Требовать `room != null` и участие пользователя в комнате (автор или контрибьютор).
2. Найти последнюю `published`-ревизию; нет — `409 package_not_published`.
3. Найти глобальный пакет по slug:
   - нет → создать глобальную запись (`createGlobalRecord`: `room = null`, `parentPackage = null`, `author = user`) и скопировать ревизию с `scopeRoomId = null`; `mode = 'created'`;
   - есть, `author.id === user.id` → дописать новую опубликованную ревизию и обновить метаданные записи; `mode = 'updated'`;
   - есть, автор другой → `409 workshop_slug_taken` с `workshopPackage`.
4. Метаданные из `metadata` пишутся только в глобальную запись; пакет комнаты не меняется (`name`, `version`, `description`, `tags` остаются прежними).
5. После успеха вернуть summary записи.

При создании записи её slug проверяется в глобальной области под advisory-lock; гонка двух публикаций даёт одному `409 workshop_slug_taken`, второй создаёт запись.

**`forkToWorkshop(packageId, user, newSlug)`:**

1. Пакет комнаты + участие пользователя (как выше), есть опубликованная ревизия.
2. Нормализовать `newSlug`; проверить, что он свободен и в комнате, и глобально (иначе `409 slug_taken`).
3. Создать пакет комнаты: тот же `room`, `parentPackage` = `parentPackage` исходного пакета (не обнулять), `author = user`, метаданные копируются.
4. Скопировать ревизию с `transformFile`, переписывающим `<oldSlug>` → `<newSlug>`, и `scopeRoomId = room.id` (проверка и pins — в области комнаты).
5. Вернуть новый пакет. Автоматической публикации в workshop нет: пользователь нажимает «Опубликовать» ещё раз, и slug уже свободен.
6. Исходный пакет остаётся в комнате без изменений.

**`addToRoom(workshopPackageId, roomId, user)`:**

1. Источник должен быть глобальным (`room == null`) и иметь опубликованную ревизию.
2. Права на комнату: автор или контрибьютор (как в `create`).
3. Создать пакет комнаты: `room = target`, `parentPackage = источник`, `author = user`, тот же slug.
4. Скопировать ревизию без переписывания, `scopeRoomId = roomId`.
5. Вернуть новый пакет.

**Теги.** `normalizeTags(input: string[])`: trim, lower-case, `^[a-z0-9_-]{1,32}$`, дедупликация, максимум 10; иначе `400 invalid_tags` с указанием проблемного значения.

### 8.6. Поиск workshop

`ScriptingPackagesService.findWorkshop({ q, limit, offset })` через QueryBuilder/raw SQL:

```sql
SELECT p.id, p.slug, p.name, p.version, p.description, p.tags,
       a.id AS "authorId", a.name AS "authorName", a.email AS "authorEmail",
       a.picture AS "authorPicture", a.service AS "authorService",
       r.revision, r."publishedAt", p."updatedAt",
       COUNT(*) OVER() AS total
FROM scripting_package p
LEFT JOIN "user" a ON a.id = p."authorId"
JOIN LATERAL (
  SELECT revision, "publishedAt"
  FROM scripting_package_revision
  WHERE "packageId" = p.id AND status = 'published'
  ORDER BY revision DESC
  LIMIT 1
) r ON TRUE
WHERE p."roomId" IS NULL
  AND ($1 = '' OR p.name ILIKE $1 OR p.slug ILIKE $1
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(p.tags) AS t(tag)
         WHERE t.tag ILIKE $1
       ))
ORDER BY r."publishedAt" DESC, p.id DESC
LIMIT $2 OFFSET $3;
```

`$1` — `%<q>%` или `''`. Точные имена таблиц/колонок сверить со схемой (`scripting_package`, `scripting_package_revision`, `"user"`, camelCase-колонки `"packageId"`, `"roomId"`, `"authorId"`, `"publishedAt"`, `"updatedAt"`). Ответ маппится в `WorkshopListing`; `author` собирается из пяти колонок (id, name, email, picture, service), пароль и служебные поля пользователя не выбираются.

Индексы не добавляются: при текущем объёме ILIKE и jsonb-скан достаточны. Если витрина вырастет, отдельной задачей добавляется `pg_trgm`/GIN.

### 8.7. Frontend: общий компонент витрины и главная страница

Новые файлы:

- `frontend/src/api/services/scripting-packages.ts` — `listWorkshopPackages`, `lookupWorkshopPackage`, `publishPackageToWorkshop`, `forkPackageToWorkshop`, `copyWorkshopPackageToRoom`; `checkPackageSlugAvailability(slug, roomId?)` получает второй аргумент.
- `frontend/src/components/packages/workshop-browser.tsx` — презентационный компонент:
  - props: `{ onSelect?: (pkg: WorkshopPackageSummary) => void; selectLabel?: string; busyId?: number | null; className?: string }`;
  - поиск: `Input` с иконкой `SearchIcon`, placeholder «Поиск по названию, slug или тегу», кнопка очистки, `aria-label="Поиск пакетов"`;
  - debounce 300 мс тем же способом, что в модалке создания (таймер + флаг отмены в `useEffect`);
  - карточки: имя, `slug` моноширинным, версия, автор (имя и аватар), дата публикации, описание с обрезкой, чипы тегов; при `onSelect` — кнопка с `selectLabel` (по умолчанию «Добавить»);
  - состояния: загрузка (спиннер), пусто («В workshop пока нет пакетов» / «Ничего не найдено»), ошибка с кнопкой «Повторить»;
  - кнопка «Показать ещё», если `items.length < total`.
- `frontend/src/components/packages/use-workshop-packages.ts` — загрузка (`limit = 50`, `offset`), ошибки, `reload()`, `loadMore()`.

Главная (`frontend/src/app/(browser)/(homepage)/homepage-client.tsx`): содержимое вкладки `packages` заменяется на `<PackageWorkshop />` без `onSelect`; заголовок карточки — «Workshop», описание — «Пакеты сообщества. Ищите по названию, slug или тегу». Витрина публичная и работает без авторизации.

### 8.8. Frontend: панель Packages

`frontend/src/app/room/[room_code]/(godot)/PackagesTab.tsx`:

- в шапке рядом с «Создать пакет» — кнопка «Workshop» (иконка `Store`/`PackageSearch`) → `Dialog` (`animate-ui` radix) шириной `sm:max-w-2xl`, внутри `<PackageWorkshop onSelect={...} selectLabel="Добавить" busyId={...} />`; список скроллится внутри диалога;
- выбор пакета вызывает `packages.addFromWorkshop(id)`; строка выбранного пакета показывает спиннер, остальные кнопки disabled;
- в меню карточки пакета — пункт «Опубликовать в workshop» (иконка `Upload`/`Store`); недоступен без `authorId`, при `busy`, при отсутствии опубликованной ревизии (подсказка «Сначала Emit»);
- диалог публикации: поля «Название», «Версия», «Описание», «Теги» (через запятую); при открытии — `lookupWorkshopPackage(slug)`; значения берутся из найденной записи workshop, а если её нет — из пакета комнаты:
  - записи нет → «Будет создана новая запись в workshop»;
  - автор — текущий пользователь → «Публикация обновится»;
  - автор другой → «Slug занят: <имя автора>» и primary-кнопка «Создать fork»;
- fork-диалог: поле «Новый slug» с тем же `SLUG_PATTERN` и debounce-проверкой (`roomId` + `global`), пояснение «Создастся копия пакета с новым slug в этой комнате; исходный пакет останется»; после успеха — уведомление «Форк создан: <slug>. Опубликуйте его в workshop отдельно»;
- ошибки сервера показываются по коду: `workshop_slug_taken` → переход в fork, `package_not_published` → «Сначала опубликуйте пакет (Emit)», `slug_taken` → «Slug уже занят в комнате»;
- после добавления из workshop: уведомление «Пакет добавлен в комнату», `refresh()` и `downloadPackage(newId)`, чтобы файлы появились в редакторе;
- после fork: то же самое (файлы новой копии скачиваются в редактор).

`frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`:

- новые действия контроллера: `addFromWorkshop(workshopPackageId)`, `publishToWorkshop(packageId, metadata)`, `forkWorkshopPackage(packageId, slug)`;
- новое исключение `WorkshopSlugTakenError` с `slug` и `workshopPackage` — выбрасывается при `409 workshop_slug_taken`, чтобы UI открыл fork-диалог;
- `addFromWorkshop`/`forkWorkshopPackage` после создания пакета делают `dispatch({ type: 'created', package })`, `refresh()` и `downloadPackage(newId)`; при ошибке скачивания пакет остаётся созданным, а ошибка попадает в `action.error`;
- `publishToWorkshop` не меняет пакет комнаты и не пишет в редактор — только API-вызов и `notice`.

`SLUG_PATTERN`, `SLUG_MAX_LENGTH` и debounce-константу вынести в общий модуль (например, `frontend/src/components/packages/slug.ts`), чтобы модалка создания и fork-диалог не расходились.

### 8.9. Права: Emit и управление пакетом

Проверка делится на две, потому что расширение Emit не должно давать права переименовывать и удалять чужие пакеты.

**`assertPackagePublishing(user, packageId)`** — для `POST /:id/revisions`, загрузки файлов в черновик и `POST /:id/revisions/:rev/publish`:

- загружает `author`, `contributors`, `room.author`, `room.contributors`;
- пропускает автора пакета, контрибьютора пакета, автора комнаты, контрибьютора комнаты;
- требует `pkg.room != null`; для глобального пакета — `409 package_not_in_room` (содержимое workshop меняется только публикацией из комнаты);
- сюда же добавляются будущие настройки прав пакета.

**`assertPackageEditing(user, packageId)`** — для `PATCH /:id` и `DELETE /:id`, без изменений:

- пропускает автора пакета, контрибьютора пакета, автора комнаты;
- контрибьютор комнаты **не** может переименовать, отключить или удалить пакет, который сам не создавал.

Публикация в workshop (`POST /:id/workshop`) и fork используют проверку участия в комнате (автор или контрибьютор) отдельно от этих двух: это не редактирование пакета, а создание новой записи.

## 9. Тестирование

Сервер (Jest):

- `ScriptingPackagesService`: создание в комнате при существующем глобальном пакете с тем же slug; `409 slug_taken` внутри комнаты; одинаковый slug в двух комнатах разрешён; `400 package_room_required` для публичного создания без комнаты; tombstone проверяется только для глобальной области; `checkSlugAvailability` с `roomId` и без (включая `global`-часть ответа).
- `PackageWorkshopService`: `created`/`updated`/`workshop_slug_taken`; публикация пакета без опубликованной ревизии; публикация глобального пакета (`409 package_not_in_room`); гонка двух публикаций одного slug; права участника комнаты; публикация не меняет `name`/`version`/`description`/`tags` комнатного пакета; `lookup` возвращает `null` для свободного slug.
- `publishCopiedRevision`: копия создаёт ревизию 1 с байтами источника; sha256 пересчитан; pins записаны в области цели; dispatcher вызван только для комнатной цели; сбой публикации удаляет строку и каталог; глобальная цель с ссылкой на пакет комнаты даёт `400 package_dependency_not_global`; комнатная цель проверяет отключённые зависимости (`409 dependency_disabled`).
- fork: новый пакет с новым slug, `parentPackage` сохранён, self-ссылки переписаны во всех текстовых расширениях, бинарные файлы не тронуты, старый пакет на месте; `409 slug_taken` для комнаты и для глобальной области.
- `addToRoom`: `parentPackage` указывает на запись workshop, `roomId` корректен, копия независима (изменение источника не меняет копию), `409 slug_taken` при конфликте в комнате.
- Резолв: room-first тень, `package_slug_shadowed`, глобальные ссылки при отсутствии комнатного пакета, legacy-числовые ссылки.
- Поиск: по name/slug/тегу, регистронезависимость, пустой `q`, исключение комнатных и неопубликованных пакетов, `limit`/`offset`/`total`.
- `remove`: обнуление `parentPackageId` у детей; tombstone только для глобальных.
- `assertPackagePublishing`: контрибьютор комнаты может создавать ревизии и публиковать; глобальный пакет отклоняет ревизионные маршруты (`409 package_not_in_room`).
- `assertPackageEditing`: контрибьютор комнаты по-прежнему не может `PATCH`/`DELETE` чужой пакет.

Frontend (Vitest):

- `workshop-browser`: debounce поиска, состояния загрузки/пусто/ошибка, кнопка выбора, «Показать ещё».
- `use-room-packages`: `addFromWorkshop` (копия + download + refresh), `publishToWorkshop` (created/updated), `WorkshopSlugTakenError` и переход в fork.
- `PackagesTab`: кнопка «Workshop» открывает модалку, меню публикации, диалог публикации с тремя состояниями, fork-диалог, ошибки по кодам.
- Главная: вкладка «Пакеты» рендерит витрину без `onSelect`.

Интеграция (ручная):

- опубликовать пакет комнаты, увидеть его на главной, найти по имени, slug и тегу;
- добавить запись в другую комнату, проверить `parentPackage`, каталог `packages/<slug>` и загрузку файлов в редактор;
- изменить комнатную копию и убедиться, что запись workshop не изменилась; опубликовать обновление автором и увидеть новую ревизию;
- вторым пользователем попытаться опубликовать тот же slug, получить fork, проверить переписанные ссылки и работу сцены;
- удалить запись workshop и убедиться, что комнатные копии продолжают работать.

## 10. Риски

1. **Снятие уникального индекса.** Единственная защита от дублей — advisory-lock в сервисе; любой новый путь создания пакета обязан проходить через него. Индекс можно вернуть частичным (вариант B) отдельной задачей.
2. **Гонка publish/create.** Создание глобальной записи и публикация выполняются в разных транзакциях; при сбое после создания строки пакета остаётся пустая запись. Компенсация: удалить созданный пакет при ошибке копирования.
3. **Тень slug.** Legacy-числовые ссылки могут вытащить глобальный пакет в комнату, где уже есть пакет с тем же slug. Закрывается проверкой `package_slug_shadowed` при сборке артефакта.
4. **Дублирование байтов.** Каждая копия занимает своё место в storage; ретеншен считается отдельно для пакета и не дедуплицирует файлы. При активном копировании storage растёт быстрее.
5. **Зависимости не копируются.** Пакет-копия ссылается на зависимости по slug; если их нет в комнате и нет глобальной версии, сборка артефакта упадёт. Пользователю нужно добавить зависимости отдельно. UI может подсказывать это в описании добавления.
6. **Fork переписывает только текст.** Бинарные файлы с зашитым `res://packages/<slug>` останутся со старым путём; это документированное ограничение, а не молчаливая порча.
7. **Существующие tombstones.** Tombstone, созданный старой версией при удалении комнатного пакета, продолжит блокировать это имя для workshop. Очистка — вручную, вне рамок задачи.
8. **Обновление записи доступно только автору.** При потере автора запись нельзя обновить; передача авторства не входит в задачу.
9. **Поиск без индексов.** ILIKE и jsonb-скан по всей таблице; на текущем объёме приемлемо.
10. **`DB_SYNC` на общей базе.** Первый старт удаляет уникальный индекс и добавляет `tags`; перед запуском нужно убедиться, что в таблице нет дублей slug (после снятия ограничения они станут легальными, но старые данные их не содержат).
11. **Права Emit расширены.** Любой контрибьютор комнаты сможет публиковать ревизии любого пакета комнаты. `PATCH` и `DELETE` при этом остаются на `assertPackageEditing` (автор пакета, контрибьютор пакета, автор комнаты), поэтому переименовать или удалить чужой пакет контрибьютор комнаты не может. Точка расширения будущих прав — `assertPackagePublishing`.
12. **Публикация в workshop требует глобальных зависимостей.** Пакет, который ссылается на пакет своей комнаты, не публикуется: `400 package_dependency_not_global`. Это защита от нерабочей записи в других комнатах, но пользователю придётся сначала опубликовать зависимость и объяснить это в UI.
13. **Клиент и сервер обновляются вместе.** Новые поля (`tags`, `WorkshopPackageSummary`) и маршруты не имеют fallback; старый frontend с новым сервером не падает, но не показывает витрину.

## 11. Что оставляем исполнителю

- Точную раскладку `PackageWorkshopService` и `PackageCopyService` по файлам, а также публичность методов `publishCopiedRevision`/`recordPinnedDependencies`.
- Формат карточек витрины, показ даты публикации и пагинацию («Показать ещё» / бесконечный скролл) — при обязательном debounce и состоянии ошибки.
- Конкретные иконки и тексты кнопок в рамках русской локализации панели.
- Показывать ли теги на карточках пакетов комнаты (в дизайне — только витрина и диалог публикации) и как выглядит индикатор «есть запись в workshop» на карточке комнаты.
- Добавлять ли частичные уникальные индексы Postgres сразу (вариант B) или отдельной задачей (в дизайне — отдельной).

## 12. Открытые вопросы

Нет. Зафиксированы: workshop = глобальные пакеты с опубликованной ревизией; копия — снимок последней опубликованной ревизии; `parentPackage` — только provenance и не обнуляется при fork; room-first резолв slug; уникальность slug в комнате и среди глобальных; tags как jsonb-массив; серверное копирование; публикация доступна участникам комнаты, обновление — только автору записи; fork создаёт новый пакет в комнате без автопубликации.
