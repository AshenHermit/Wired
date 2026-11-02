# Slug пакетов и управление метаданными пакета

Дата: 2026-11-02
Статус: proposal

## 1. Задача

У пакета остаётся числовой `id` — внутренний идентификатор, по которому работают API, состояние runtime, снапшоты и зависимости. Появляется дополнительный уникальный строковый `slug`, который пользователь вводит при создании пакета. Slug становится именем каталога пакета:

- в редакторе Godot: `res://packages/<slug>/`;
- в runtime и вкладке Game: `user://wired/rooms/<room>/packages/<slug>/<revision>-<artifactKey>/`;
- в ссылках между пакетами: `res://packages/<slug>/...`.

Дополнительно меняется панель Packages:

- рядом с именем пакета появляется иконка карандаша для редактирования имени;
- рядом с версией — карандаш для редактирования версии;
- slug показывается рядом с именем примерно там, где сейчас показывается `#id`, и не редактируется;
- создание пакета переносится из встроенной формы в модальное окно, открываемое кнопкой «Создать пакет»;
- в модальном окне пользователь вводит имя, версию и slug; доступность slug проверяется до отправки.

## 2. Goals

- Добавить `slug` в модель пакета, API, shared-типы и runtime-манифесты.
- Сделать slug глобально уникальным и неизменяемым после создания.
- Запретить повторное использование slug после удаления пакета.
- Использовать slug как имя каталога пакета в редакторе и runtime.
- Научить сервер разрешать ссылки и по числовому id, и по slug.
- Сохранить числовой id как идентичность в API, состоянии, протоколе и зависимостях.
- Дать пользователю редактировать имя и версию пакета из карточки.
- Перенести создание пакета в модальное окно с проверкой доступности slug.
- Не сломать существующий пакет: ему назначается `slug = str(id)`, поэтому его каталог и старые ссылки остаются прежними.

## 3. Non-goals

- Не меняем маршруты API с `/scripting-packages/:id` на slug.
- Не переводим состояние runtime, снапшоты мультиплеера, реестр пакетов и ключи зависимостей на slug.
- Не переименовываем серверные каталоги хранения и артефактов (`<packagesFilesDir>/<id>/...`).
- Не делаем slug редактируемым.
- Не добавляем обратную совместимость для манифестов без `slug`: клиенты и сервер обновляются вместе.
- Не добавляем миграционный фреймворк: проект живёт с `DB_SYNC=1`, миграция выполняется идемпотентным backfill-кодом.

## 4. Anti-goals

- Ситуация, когда после переименования пакета меняется путь каталога или ломаются опубликованные ссылки.
- Два пакета с одинаковым slug, включая пакет, удалённый ранее.
- Пустой slug в пути каталога, из-за которого операция над пакетом затрагивает корень `packages`.
- Числовой slug нового пакета, из-за которого `res://packages/9/...` становится неоднозначным.
- Скрытая потеря локальных файлов при переходе на slug-каталоги.
- Разные правила валидации slug в UI, API, bridge и runtime.

## 5. Constraints

- `DB_SYNC=1` на общей удалённой Postgres: изменение entity меняет схему при старте сервера. Колонку нельзя добавить как `NOT NULL` без значения на непустой таблице.
- В репозитории нет миграций и CI.
- Godot 4.8-beta2 web-сборка не экспортирует Emscripten `FS`; файловые операции идут только через `wired_bridge`.
- Серверные пути пакетов и артефактов уже привязаны к числовому id; менять их не нужно.
- Ссылки в опубликованных ревизиях уже содержат числовые id. Их нельзя ломать.
- Пакеты могут быть глобальными (`roomId = null`) и использоваться из нескольких комнат; поэтому уникальность slug — глобальная.
- Имена пакетов английские, но slug вводит пользователь, а не генерируется из имени.
- Старый пакет, скорее всего, один; но код обязан корректно обработать несколько.

## 6. Рассмотренные подходы

### A. Slug как путь, id как идентичность (выбран)

`slug` добавляется в пакет, манифесты и имена каталогов. API, состояние, протокол, зависимости и серверное хранилище остаются числовыми. Сервер разрешает ссылки двух видов: числовой сегмент — id, нечисловой — slug. Старый пакет получает `slug = str(id)`, поэтому его каталог и ссылки не меняются.

Плюсы: минимальный риск для существующих данных, не ломаются API и мультиплеер, миграция сводится к backfill одного поля. Минусы: механическая работа по всем слоям, где путь каталога передаётся отдельно от id.

### B. Slug как новая идентичность

Маршруты API, состояние runtime, снапшоты и реестр переводятся на slug.

Плюсы: публично красивее и последовательнее. Минусы: ломает существующих клиентов и ссылки, требует менять протокол и резко увеличивает объём работ. Для задачи не нужно.

### C. Slug только в интерфейсе

Slug отображается и проверяется, но каталоги остаются числовыми.

Плюсы: самый дешёвый вариант. Минусы: не выполняет главное требование — папки пакетов должны называться slug.

Выбран вариант A.

## 7. Ключевые решения

1. **Slug — alias пути, не идентичность.** API и состояние продолжают использовать `id: number`.
2. **Slug вводит пользователь при создании.** Автогенерации из имени нет.
3. **Формат нового slug:** `^(?=.*[a-z])[a-z0-9_]+$`, длина 1–64. Только строчные латинские буквы, цифры и `_`; хотя бы одна буква. Чисто числовой slug запрещён.
4. **Старые slug могут быть числовыми.** Для существующих пакетов `slug = str(id)`. Валидация пути (не создания) допускает `^[a-z0-9_]+$`.
5. **Уникальность глобальная.** Уникальный индекс на `slug`; проверка доступности и финальная проверка при создании.
6. **Slug неизменяем.** Нет поля в update-DTO и нет UI для редактирования.
7. **Правило разбора ссылки:** сегмент из цифр — числовой id; иначе — slug. Поэтому новый числовой slug запрещён, а старый `"7"` одновременно является id 7 и slug 7 и указывает на тот же пакет.
8. **Серверное хранилище остаётся числовым.** Меняются только пути, которые видит редактор/runtime, и переписывание ссылок.
9. **Манифесты несут slug.** `PackageManifest` и `PackageRuntimeManifest` получают обязательное поле `slug`. Fallback на `str(packageId)` не делаем: сервер и клиенты обновляются вместе.
10. **Состояние и протокол остаются числовыми.** `_current_revisions`, `applied_packages()`, `sceneDependencies`, реестр, `_wired_package_id` и снапшоты не меняют ключи.
11. **Имя и версия редактируются через существующий PATCH.** Права проверяет сервер; UI показывает ошибку 403.
12. **Создание — модальное окно.** Встроенная форма удаляется.
13. **Slug удалённого пакета не переиспользуется.** При удалении slug попадает в таблицу `retired_package_slug`; availability и create проверяют её наравне с живыми пакетами.
14. **Один локальный инстанс сервера.** Сейчас нет деплоя и несколько версий одновременно не работают; backfill при старте считается достаточным. Если появится rolling deploy, понадобится отдельный план.
15. **Формат артефактов поднимается до `v2`.** Старые `runtime/v1`-артефакты не содержат slug и не должны попадать в кэш; они игнорируются и пересобираются в `v2`.
16. **Closure resolver получает репозиторий пакетов.** Индекс slug → id строится глобальным запросом `{ id, slug }`, а не из ещё не разрешённого замыкания.
17. **`ArtifactStore` работает с явным slug.** Пустой slug запрещён на уровне store; вызывающий код обязан знать slug до файловой операции. Для неизвестного slug `highest_revision` возвращает 0, а purge — no-op, а не работает с корнем `packages`.

## 8. Детальный дизайн

### 8.1. Модель данных и миграция

`packages/server/src/database/entities/scripting-package.entity.ts`:

```ts
@ApiProperty({ example: 'hero_controller', description: 'Stable package slug' })
@Column({ type: 'varchar', length: 64, unique: true, nullable: true })
slug: string;
```

Колонка остаётся `nullable: true` в entity, потому что `DB_SYNC=1` добавляет её в уже заполненную таблицу. Сервис всегда заполняет slug и не отдаёт пакет без него. Уникальный индекс создаётся TypeORM вместе с колонкой; NULL-значения не конфликтуют.

Новая сущность `packages/server/src/database/entities/retired-package-slug.entity.ts`:

```ts
@Entity('retired_package_slug')
export class RetiredPackageSlug {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ type: 'int' })
  packageId: number;

  @CreateDateColumn()
  retiredAt: Date;
}
```

Сущность регистрируется в `TypeOrmModule.forFeature` модулей `scripting-packages` и `package-delivery` (и в `entities.metadata.spec.ts`). Уникальность `slug` здесь обеспечивает первичный ключ. Отдельная таблица выбрана вместо soft-delete пакета: она не меняет существующие выборки, relations и логику зависимостей.

Удаление пакета в `ScriptingPackagesService.remove()` сначала пишет `retired_package_slug` (`INSERT ... ON CONFLICT DO NOTHING`), затем удаляет пакет. Если удаление пакета упадёт, tombstone останется — это безопасно: slug всё равно считается занятым. Поэтому `slug_taken` и `slug_retired` — разные коды ошибки для UI, но оба означают «нельзя использовать».

Backfill выполняется один раз при старте приложения в `ScriptingPackagesService implements OnApplicationBootstrap`:

```sql
UPDATE scripting_package
SET slug = id::text
WHERE slug IS NULL;
```

После backfill сервис проверяет, что строк без slug не осталось; при наличии — логирует и падает на старте, чтобы не выпустить в UI пакеты с неопределённым путём. SQL идемпотентен. Точное имя таблицы подтверждается по фактической схеме (`scripting_package` для текущей naming strategy), но backfill лучше делать через `repository.query` с явно проверенным именем.

Порядок запуска (сейчас сервер и frontend запускаются локально, деплоя нет):

1. Перезапустить сервер: TypeORM добавит nullable-колонку, уникальный индекс и таблицу `retired_package_slug`; bootstrap заполнит `slug = str(id)`.
2. Проверить существующий пакет: `slug` равен строке его id.
3. Перезапустить frontend и Godot runtime. Без fallback они требуют `slug` в манифестах, поэтому новые slug-пакеты можно создавать только после обновления клиентов.
4. Старые каталоги редактора и старые runtime-каталоги не переименовываются: для существующего пакета slug совпадает с числовым именем.

Так как одновременно работает только один локальный инстанс сервера, старый код не сможет вставить пакет с `slug = NULL` после backfill. Если в будущем появится rolling deploy или несколько инстансов, понадобится null-guard в чтении и периодический re-backfill; в текущем дизайне этого нет.

Если автоматический `DB_SYNC` не создаст индекс, ручной идемпотентный вариант:

```sql
ALTER TABLE scripting_package ADD COLUMN IF NOT EXISTS slug varchar(64);
UPDATE scripting_package SET slug = id::text WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_scripting_package_slug ON scripting_package (slug);
```

### 8.2. API и shared-типы

`packages/shared/src/api/types.ts`:

- `ScriptingPackage` получает `slug: string`.
- `CreateScriptingPackagePayload` получает обязательный `slug: string`.
- `PackageManifest` получает `slug: string`.
- `PackageRuntimeManifest` получает `slug: string`.
- `PackageSyncStatus` получает `slug: string` (нужен `packageFromStatus` во frontend).
- `PackageRuntimeDependency` **не** получает slug: клиент получает slug каждого dependency из его собственного runtime-манифеста.

`CreateScriptingPackageDto` получает:

```ts
@ApiProperty({ example: 'hero_controller' })
@IsString()
@MaxLength(64)
@Matches(/^(?=.*[a-z])[a-z0-9_]+$/, {
  message:
    'slug must contain lowercase latin letters, digits or _, and at least one letter',
})
slug: string;
```

`UpdateScriptingPackagePayload` нужно переопределить как `Partial<Omit<CreateScriptingPackagePayload, 'slug'>> & { enabled?: boolean }`, иначе slug автоматически попадёт в update-тип через `Partial<Create>`. `UpdateScriptingPackageDto` не получает `slug`. Глобальный `ValidationPipe` с whitelist отбрасывает лишнее поле; сервис не обновляет slug ни при каких условиях.

Новый endpoint в `scripting-packages.controller.ts` объявляется **до** `@Get(':id')`, иначе `ParseIntPipe` попытается разобрать слово как id:

```ts
@UseAuthGuard()
@Get('slug-availability')
async slugAvailability(@Query('slug') slug: string) {
  return this.packagesService.checkSlugAvailability(slug);
}
```

Ответ: `{ slug: string; available: boolean; reason?: 'taken' | 'retired' }`. Пустой/невалидный slug даёт `400` с кодом `invalid_slug`. `checkSlugAvailability()` проверяет оба источника: живой пакет (`reason: 'taken'`) и `retired_package_slug` (`reason: 'retired'`). Эндпоинт только читает, поэтому гонка между проверкой и созданием разрешается уникальными индексами.

`ScriptingPackagesService.create()`:

- валидирует slug тем же правилом (DTO уже валидирует, сервис страхует);
- проверяет живой пакет и tombstone; для живого бросает `409 { code: 'slug_taken', slug }`, для tombstone — `409 { code: 'slug_retired', slug }`;
- сохраняет пакет;
- ловит Postgres unique violation `23505` и преобразует в `409 slug_taken` (гонка двух create);
- возвращает пакет с slug.

Гонка «create против delete» закрывается транзакцией и advisory-lock по slug. И `create`, и `remove` берут `pg_advisory_xact_lock(hashtext('package_slug:' || slug))`; внутри блокировки create повторно проверяет пакет и tombstone, а remove пишет tombstone и удаляет пакет. Обе операции выполняются в одной транзакции, поэтому новый пакет не может появиться между проверкой и tombstone, а tombstone не может появиться между проверкой и вставкой.

`findAll()` и `findOne()` продолжают работать по числовому id и отдают slug вместе с остальными полями.

`packages/server/src/godot-game/package-sync.service.ts`:

- `reporter.toStatus(...)` добавляет `slug: pkg.slug`;
- `getStatuses()` сортировка остаётся по `packageId`.

### 8.3. Разбор ссылок и resolution на сервере

Сейчас ссылки и зависимости везде числовые: `/(["'])res:\/\/packages\/(\d+)\/([^"'\r\n]+)\1/g`. Нужны два уровня.

**Синтаксис.** `package-runtime-references.ts`:

```ts
export interface RawPackageFileReference {
  target: string; // "42" или "hero_controller"
  filepath: string;
}
```

- `PACKAGE_REFERENCE_RE` захватывает `([a-z0-9_]+)` вместо `(\d+)`.
- `PACKAGE_PATH_RE` — то же для абсолютного пути.
- `collectPackageReferences(text): RawPackageFileReference[]` только парсит и нормализует путь; не ходит в БД.
- `resolvePackageReference(target, index): number | null`:
  - `/^\d+$/` → `Number(target)`;
  - иначе → `index.idBySlug.get(target)`.
- `PackageFileReference` остаётся `{ packageId: number; filepath: string }` и получается после resolution.

**Индекс slug → id.** Замыкание нельзя использовать для построения индекса: пока ссылка не разрешена, неизвестно, какие пакеты входят в замыкание. Поэтому индекс строится глобально:

- `PackageClosureResolver` получает в конструктор `Repository<ScriptingPackage>` (прокидывается из `PackageDeliveryService` и обоих spec-файлов);
- в начале `resolve()` и `findDependentRoomPackages()` вызывается `loadSlugIndex(): { bySlug: Map<string, number>; byId: Map<number, string> }` через `packagesRepository.find({ select: { id: true, slug: true } })`;
- индекс передаётся вниз в `collectPackageReferences`-обвязку, `buildReverseReferenceGraph`, `buildSceneDependencies` и `rewritePackageReferences`;
- в publish-time проверках `PackageRevisionsService` получает тот же `packagesRepository` (или helper из `ScriptingPackagesService`) и резолвит ссылки через `find({ select: { id: true, slug: true } })` один раз на публикацию.

Числовые ссылки не требуют записей в индексе: они сразу дают id. Числовой id, которого нет в `byId`, даёт прежнюю ошибку загрузки ревизии; slug, которого нет в `bySlug`, даёт `package_dependency_unknown_slug:<slug>`. Если slug существует, но у пакета нет опубликованной ревизии, `resolve()` выдаёт существующую ошибку `package_dependency_unpublished`, а не «unknown slug».

**Где применяется:**

1. `PackageClosureResolver.resolve()`:
   - `loadRevision()` возвращает `slug`;
   - `ResolvedClosure` получает `slugByPackage: Map<number, string>`;
   - при обходе текстовых файлов `collectPackageReferences()` → resolve → `ref.packageId`;
   - self-reference сравнивается по resolved id, а не по строке;
   - неизвестный slug даёт `BadRequestException('package_dependency_unknown_slug:<slug>')`; неизвестный числовой id приводит к прежнему `NotFoundException`/ошибке загрузки ревизии.
2. `buildReverseReferenceGraph()` и `collectRevisionReferences()`:
   - `LatestPublishedRevision` получает `slug`;
   - строится `idBySlug` по всем пакетам с последней опубликованной ревизией;
   - ссылки резолвятся тем же правилом.
3. `PackageRevisionsService.assertDependenciesEnabled()` и `recordPinnedDependencies()`:
   - оба читают текст и вызывают `collectPackageReferences()`;
   - добавляют resolution slug → id перед проверкой enabled/pins;
   - это критично: иначе публикация пакета со ссылкой `res://packages/<slug>/...` не запишет pin и не проверит отключённую зависимость.
4. `buildSceneDependencies()` и локальный `collectReferences()`:
   - получают `idBySlug` (или общий resolver) и резолвят package-ссылки;
   - ключи результата остаются `"<packageId>:<filepath>"`.

**Переписывание ссылок.** `rewritePackageReferences()` получает `slugByPackage: ReadonlyMap<number, string>` и пишет:

```text
user://wired/rooms/<roomId>/packages/<slug>/<revision>-<artifactKey>/<rest>
```

Slug берётся только из `slugByPackage`; отсутствие — ошибка `package_reference_not_rewritable:<id>`. Никакого fallback на `str(id)`.

**Artifact key.** Не меняется: sha256 по отсортированному списку `(id, revision)` замыкания. Slug неизменяем, поэтому не влияет на идентичность артефакта. Переписывание в slug-путь выполняется при сборке артефакта, как и раньше.

### 8.4. Runtime-манифесты и выдача

`package-delivery.service.ts`:

- `RuntimeArtifact` получает `slug: string`.
- `manifestBody` получает `slug: resolved.slugByPackage.get(resolved.packageId)!`.
- `getRuntimeManifest()` возвращает `slug` в `PackageRuntimeManifest`.
- `directDependencies` остаётся без slug.
- `ARTIFACT_FORMAT_VERSION` поднимается с `'v1'` до `'v2'`; каталог становится `<packagesFilesDir>/<numeric id>/runtime/v2/<roomId>/<revision>/<artifactKey>/`. Старые `runtime/v1`-манифесты не содержат slug и не должны читаться как кэш: все артефакты пересобираются в `v2`.
- `pruneArtifacts()` продолжает сканировать только текущую версию (`v2`); каталоги `v1` остаются сиротами. Их можно удалить одноразово вручную или отдельной cleanup-командой; автоматическое удаление в этом дизайне не делаем, чтобы не рисковать старыми данными.
- `readPinnedDependencies`, `collectRuntimePackageIds`, retention и `resolveRuntimeFile` не меняются, кроме версии в пути.

`PackageManifest` (raw manifest для редактора) получает `slug` из того же источника. `PackageManifest.validate_runtime()` требует непустой slug, соответствующий `^[a-z0-9_]+$` (числовые legacy допустимы).

### 8.5. Редактор: `WiredPackageFs` и bridge

`packages/server/godot_project/_wired/addons/wired_bridge/package_fs.gd`:

- все операции принимают `package_slug: String` вместо `package_id: int`;
- `is_valid_slug(slug)` проверяет `^[a-z0-9_]+$` и длину 1–64 (числовые legacy допустимы);
- `package_dir(slug) = packages_root().path_join(slug)`;
- `staging_dir(slug) = .<slug>.staging`, `previous_dir(slug) = .<slug>.previous`;
- `package_relative_path`, `op_exists`, `op_create_dir`, `op_snapshot`, `op_collect`, `op_prepare_replace`, `op_replace`, `op_delete`, `op_delete_files` переводятся на slug;
- сообщения об ошибках показывают slug.

`plugin.gd`:

- `_handle_request` читает строковый `packageSlug` вместо целого `packageId`;
- `_package_id_of_path()` заменяется на `_package_slug_of_path()`: берёт первый сегмент после `res://packages/`, проверяет `WiredPackageFs.is_valid_slug`, игнорирует `.staging`/`.previous`;
- `_on_delete_selected_pressed()` группирует выбранные пути по slug;
- тост показывает `res://packages/<slug>/`.

Frontend `godot-packages-fs.ts`:

- `PackageFileSystem` методы, работающие с каталогом, принимают `slug: string`: `exists`, `createPackageDir`, `snapshot`, `collectFiles`, `replaceContents`, `deletePackage`, `packageDir`;
- добавить `assertPackageSlug(slug)`: `^[a-z0-9_]+$`, длина 1–64 (числовые legacy допустимы);
- bridge payload: `{ packageSlug: slug }`;
- `assertStagingPath(stagingPath, slug)` ожидает `/<PACKAGES_DIR>/.<slug>.staging`;
- `applyPackageRevision()` использует `manifest.slug`;
- `publishPackageFiles(packageId, slug, files)` и `reconcilePackageRevision(packageId, slug, files, baseline)` передают slug в FS;
- ошибки по-прежнему содержат числовой id для диагностики, но путь — slug.

### 8.6. Godot runtime

`PackagesManager`:

- добавляет `var _slugs: Dictionary = {}` (id → slug);
- при валидации runtime-манифеста вызывает `_remember_slug(package_id, String(manifest["slug"]))` **до** staging/swap;
- `packages_dir(id)`, `revision_dir(id, ...)`, `runtime_path(id, ...)` сохраняют числовые параметры, но внутри используют slug;
- `_current_revisions`, `_current_artifact_keys`, `_scene_dependencies`, `_file_hashes`, `_applying`, `applied_packages()` остаются числовыми;
- для восстановления после перезапуска runtime хранит индекс `user://wired/rooms/<room>/package_slugs.json` (`{ "42": "hero_controller" }`), обновляемый при каждом apply. Индекс читается в `set_room()`/`configure()` до первых файловых операций; запись атомарная (temp + rename). Для старых пакетов значение совпадает с `str(id)`;
- `_sync_package_chain()` сначала получает runtime-манифест (в нём есть slug), запоминает slug и только потом вызывает `ArtifactStore.highest_revision(slug)` для проверки локальной ревизии. Порядок важен: до манифеста slug может быть неизвестен;
- `forget_package(id, purge)`: если slug есть в `_slugs`, удаляет каталог; если slug неизвестен, операция становится no-op и **не** трогает корень `packages`. Благодаря запрету повторного использования slug оставшийся мусорный каталог безопасен;
- зависимости применяются как раньше: каждый dependency приходит со своим манифестом и своим slug; `PackageRuntimeDependency` менять не нужно.

`ArtifactStore`:

- конструктор получает `packages_root: Callable` (как сейчас) и никакого `slug_for`;
- все методы принимают явный `slug: String`: `package_dir(slug)`, `staging_dir(slug)`, `revision_dir(slug, revision, key)`, `stage(slug, files)`, `swap(slug, revision, key)`, `prune(slug, keep_revision, keep_dir_name)`, `highest_revision(slug, exclude=0)`, `remove_files(slug, paths)`, `remove_tree(slug)`;
- `package_dir(slug)` проверяет формат `^[a-z0-9_]+$`, длину 1–64 и пускает только один сегмент; пустой slug, `/`, `..` и uppercase запрещены;
- у store нет числового id и нет способа случайно построить путь от корня: вызывающий код обязан передать валидный slug;
- это меняет все вызовы в `PackagesManager` и smoke-тесты, зато исключает схлопывание пути в корень `packages`.

`WiredPackageContext`:

- `package_id` остаётся числовой строкой;
- `_package_number()` не меняется;
- `scene_path()`/`instantiate()` идут через `PackagesManager.runtime_path(number, ...)`, который теперь знает slug;
- `root_path` для fixture/editor-контекстов не меняется.

`package_registry.gd`, `package_entry_loader.gd`, `wired_protocol.gd`, `main_scene.gd`:

- идентичность и метаданные остаются числовыми;
- `scene_dependencies` ключи остаются `"<id>:<path>"`;
- `applied_packages()` и снапшоты остаются числовыми.

Godot smoke-тесты обновляются: манифесты получают slug, ожидаемые каталоги — `user://.../packages/<slug>/...`, `WiredPackageFs` вызывается со slug, проверяется отказ на невалидный slug и сохранение числовых ключей состояния.

### 8.7. Frontend: данные и действия

`frontend/src/app/room/[room_code]/(godot)/use-room-packages.ts`:

- `RoomPackageEntry` получает `slug: string`;
- `packageFromStatus()` переносит `status.slug`;
- `buildEntries()` переносит `pkg.slug`;
- `mergePackages()` и reducer сохраняют slug как обычное поле пакета;
- добавляется действие `"updated"`:
  - обновляет пакет в `state.packages`;
  - обновляет `name`, `version`, `slug` в соответствующем `state.entries`, не сбрасывая статусы, прогресс и локальные изменения;
- `createPackage(name, authorId, version, slug)`:
  - валидирует непустые name/slug;
  - вызывает `createScriptingPackage({ name, version, slug, authorId, roomId })`;
  - создаёт каталог `files.createPackageDir(created.slug)`;
  - кладёт baseline и делает refresh;
- helper `slugOf(packageId)` берёт slug из `stateRef.current.packages` и бросает понятную ошибку, если пакета нет;
- `downloadPackage`, `removePackage`, `adoptPackage`, `emitPackage` продолжают принимать `packageId`, но все FS-вызовы делают через `slugOf(id)`;
- добавляется `updatePackageMetadata(packageId, patch: { name?: string; version?: string })`:
  - вызывает `updateScriptingPackage(packageId, patch)`;
  - делает `dispatch({ type: "updated", package: updated })`;
  - ошибку складывает в `action.error` и пробрасывает для inline-формы.

`frontend/src/api/services/scripting-packages.ts`:

- `createScriptingPackage` уже принимает payload, в тип добавляется `slug`;
- добавляется `checkPackageSlugAvailability(slug)` → `GET /scripting-packages/slug-availability?slug=...`;
- `updateScriptingPackage` уже подходит для имени/версии, менять не нужно.

### 8.8. Frontend: панель Packages

`PackagesTab.tsx`:

- в шапке появляется кнопка «Создать пакет» с иконкой `Plus`; встроенная форма удаляется;
- модальное окно на существующих animate-ui `Dialog`:
  - поля `Имя пакета`, `Версия` (по умолчанию `0.1.0`), `Slug`;
  - slug: `inputMode="text"`, авто-`toLowerCase()`, без автоматического удаления недопустимых символов (пользователь должен увидеть ошибку);
  - подсказка: «строчные латинские буквы, цифры и _, хотя бы одна буква»;
  - локальная валидация тем же regex; при невалидном slug запрос доступности не отправляется;
  - debounce 300 мс, состояние `checking | available | taken | retired | invalid | error`;
  - submit disabled, пока имя пустое, slug невалиден, slug занят/зарезервирован/проверяется, идёт создание, нет `authorId` или `!fsReady`;
  - для `retired` показывается отдельный текст: «Этот slug уже использовался и не может быть повторно использован»;
  - ошибка создания показывается в модалке, в том числе `409 slug_taken` и `409 slug_retired`;
  - после успеха модалка закрывается и сбрасывает поля;
- в карточке:
  - рядом с именем — кнопка-карандаш (`PencilIcon`, `aria-label="Редактировать имя пакета"`), по клику имя превращается в inline-поле с кнопками сохранения/отмены; Enter сохраняет, Esc отменяет; пустое имя не сохраняется;
  - рядом с версией — такой же карандаш; версия редактируется inline, пустая версия не сохраняется;
  - во время сохранения — спиннер, кнопки disabled; ошибка показывается в карточке;
  - slug отображается рядом с именем как `#{entry.slug}` в monospace вместо `#{entry.packageId}`; редактирования нет; `title="Slug пакета"`;
  - в тексте подтверждения удаления `#{entry.packageId}` заменяется на `#{entry.slug}`;
- текст шапки меняется с `packages/<id>` на `packages/<slug>`;
- пустое состояние: «Создайте первый пакет» открывает модалку;
- права: карандаши показываются всем, кому доступна карточка; сервер вернёт 403, если пользователь не автор/контрибьютор пакета или комнаты; ошибка показывается в карточке. Это согласуется с текущим поведением действий, которые тоже проверяются сервером.

## 9. Тестирование

Сервер (Jest):

- DTO: slug обязателен, нижний регистр, `_`, цифры, хотя бы одна буква, максимум 64, чисто числовой отклоняется.
- `ScriptingPackagesService`: создание с slug; `409 slug_taken`; `409 slug_retired`; tombstone при удалении; advisory-lock/транзакция; уникальный индекс/`23505`; backfill существующих; slug не меняется через update; availability endpoint с `reason`.
- `package-runtime-references`: сбор ссылок по slug и по id; resolution через индекс из репозитория; невалидные пути; rewrite в `.../packages/<slug>/...`; `buildSceneDependencies` с slug.
- `PackageClosureResolver`: резолв slug-ссылок и числовых legacy-ссылок; self-reference по slug; неизвестный slug vs пакет без опубликованной ревизии; пины и reverse dependency scan; индекс строится через `packagesRepository.find`.
- `PackageDeliveryService`: `slug` в raw и runtime manifest; артефакт в `runtime/v2`; кэш `v1` не читается.
- `PackageSyncService`: `slug` в `PackageSyncStatus`.

Frontend (Vitest):

- `godot-packages-fs`: payload `packageSlug`, staging `.<slug>.staging`, `manifest.slug`, отказ на невалидный slug; числовой legacy slug проходит.
- `package-sync`: publish/reconcile используют slug из манифеста/аргумента.
- `use-room-packages`: создание с slug, `slugOf`, метаданные, entries с slug, update reducer.
- `PackagesTab`: модалка открывается/закрывается, валидация slug, debounce availability, `slug_taken` и `slug_retired`, карандаши имени/версии, отображение `#slug`, отсутствие встроенной формы.
- существующие тесты обновляются: фикстуры пакетов получают slug, bridge-моки ждут `packageSlug`.

Godot smoke:

- `package_fs`: все операции по slug, staging/previous, отказ на `../`, `/`, uppercase, пустой slug.
- `packages_manager`: каталоги `packages/<slug>/<revision>-<key>`, манифест со slug, числовые ключи состояния, две ревизии, prune, dependency apply, purge после перезапуска через `package_slugs.json`.
- `artifact_store`: все методы принимают явный slug; пустой slug, `/`, `..` и uppercase отклоняются; путь никогда не схлопывается в корень; числовые ключи не меняются.

Интеграция:

- опубликовать пакет, в котором ссылка `res://packages/<slug>/...`; проверить runtime manifest, артефакт и фактический каталог `user://.../packages/<slug>/...`;
- старый пакет с числовым slug и числовыми ссылками продолжает применяться без переименования каталога.

## 10. Риски

1. **Гонка между availability, create и delete.** Закрывается уникальными индексами, advisory-lock по slug и транзакцией; `23505` преобразуется в `409 slug_taken`.
2. **`DB_SYNC` на общей базе.** Добавление nullable-колонки, таблицы tombstone и backfill при старте; проверить схему до запуска; иметь ручной SQL.
3. **Пропущенный вызов `collectPackageReferences`.** Любое место, читающее текст пакета, должно резолвить slug. Список мест: closure resolver, reverse scan, publish pins, dependency-enabled check, scene dependencies.
4. **Ссылка на неизвестный slug.** Должна давать понятную 4xx-ошибку при публикации/сборке, а не тихо создавать dependency с id 0.
5. **Числовой slug нового пакета.** Запрещён DTO и UI; путь-валидация при этом допускает legacy numeric.
6. **Пустой путь в `ArtifactStore`.** Store принимает только валидный slug и отклоняет пустую строку; `PackagesManager` не вызывает store, пока slug неизвестен. `forget_package` при неизвестном slug — no-op.
7. **Старые артефакты `v1`.** После смены `ARTIFACT_FORMAT_VERSION` они игнорируются и пересобираются в `v2`; старые каталоги остаются сиротами и удаляются вручную/cleanup-командой.
8. **Повторное использование slug.** Запрещено tombstone-таблицей; старые каталоги удалённых пакетов в runtime и редакторе не могут быть перепутаны с новым пакетом.
9. **Старые клиенты.** Без fallback новый пакет со slug не откроется в старом runtime/редакторе. Перезапускать сервер, frontend и runtime вместе; новые пакеты создавать после обновления.
10. **Редактирование метаданных и конкурентные изменения.** PATCH возвращает актуальный пакет; reducer обновляет только name/version/slug, не трогая статусы. Ошибка 403/409 показывается в карточке.
11. **Несколько инстансов сервера.** Текущий дизайн предполагает один локальный инстанс. При появлении rolling deploy нужен null-guard в чтении и периодический re-backfill.

## 11. Что оставляем исполнителю

- Точные имена helper-функций resolution — на усмотрение реализации; индекс slug → id строится из `packagesRepository`, правило разбора единое.
- Формат UI inline-редактора (одна строка с check/x или маленькая popover-форма) — на усмотрение реализации; обязательны Enter/Esc, отмена и ошибка.
- Нужен ли отдельный `slug_taken` message в Swagger — на усмотрение.
- Добавлять ли `slug` в `PackageRuntimeDependency` для диагностики — не требуется; если добавлять, это не должно менять resolution.

## 12. Открытые вопросы

Нет. Зафиксированы формат slug, глобальная уникальность, запрет повторного использования после удаления, backfill `str(id)`, числовые legacy-slug, отсутствие fallback, один локальный инстанс сервера, формат артефактов `v2` и набор полей модалки.
