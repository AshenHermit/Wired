# Этапы 7–10. Динамическая доставка пакетов в Godot — результаты

Дата: 2026-10-30. Ветка: `working-on-godot-rooms`.
Статус: реализация завершена; автоматические проверки пройдены. Браузерный
e2e в этой сессии не выполнен — окружение заблокировано, чеклист ниже.

## Итог

Опубликованная ревизия остаётся неизменяемым источником для редактора.
Для игры сервер собирает отдельный runtime-артефакт на комнату: переписывает
`res://packages/<id>/...` в точные `user://wired/rooms/<room>/packages/<id>/<revision>/...`,
фиксирует ревизии всего транзитивного замыкания и выдаёт короткоживущий
HMAC-токен на чтение. Godot рекурсивно скачивает runtime-манифесты
зависимостей, проверяет размер и `sha256`, строит локальные текстуры/аудио и
пересоздаёт только затронутые корни сцен. Web-клиент получает same-origin
`apiBase` из host bridge, headless — из `--api-url` / `WIRED_API_URL`.

## Матрица ресурсов

Проверка: 31 отдельный кейс загрузки и инстанцирования из `user://`.
Версии: editor 4.5.1, native release 4.5.0, Web export 4.5.1.

| Тип / сценарий | editor | native release | Web |
| --- | --- | --- | --- |
| `.gd` (скрипт) | да | да | да |
| `.tscn` (сцена) | да | да | да |
| `.tres` (ресурс) | да | да | да |
| `.gdshader` | да | да | да |
| raw PNG/JPEG/WebP/BMP | да | да | да |
| raw WAV/OGG/MP3 | да | да | да |
| `.ctex` как `Texture2D` | нет | нет | нет |
| `.remap` без загрузчика | нет | нет | нет |
| editor `.import` из пакета | нет | нет | нет |
| `FLAG_BUNDLE_RESOURCES` из `user://` | нет | нет | нет |
| hot-swap autoload / `class_name` | нет | нет | нет |

**Итого: 24/31 в чистом headless editor, 24/31 в native release, 25/31 в Web.**
Лишний Web-проход не означает поддержку: старый `.import`, оставшийся в
IndexedDB от предыдущего прогона, позволил загрузиться одному из 7 непрошедших
кейсов; в чистом профиле он не работает. Остальные кейсы — неподдерживаемые
типы и сценарии из таблицы.

Строки таблицы сводят кейсы по типу; итоговые числа считаются по 31 кейсу,
а не по числу строк.

## Что и как доставляется

- Текстовые `.gd`, `.tscn`, `.tres` переписываются сервером. Заменяются только
  ссылки внутри строковых литералов `res://packages/<id>/<path>`; комментарии
  не трогаются. У строк `[ext_resource ...]` удаляется `uid`, чтобы UID из
  чужого проекта не перекрывал локальный ресурс.
- Бинарные файлы копируются байт-в-байт. Невалидный UTF-8 в текстовом файле —
  ошибка сборки `package_text_not_utf8:<file>`, а не молчаливая замена.
- `.gdshader` копируется как есть: это текстовый ресурс, но сервер не
  переписывает ссылки внутри шейдеров. Шейдер должен быть самодостаточным.
- Raw-изображения (`png`, `jpg`, `jpeg`, `webp`, `bmp`) и аудио (`wav`, `ogg`,
  `mp3`) остаются в артефакте исходными файлами. На клиенте рядом создаются
  `<file>.image.res` / `<file>.audio.res` и sidecar `<file>.import` с абсолютным
  `user://` путём. Производные файлы не входят в манифест, хеши и публикацию.
- `.ctex`, `.remap`, editor `.import` и `ResourceSaver.FLAG_BUNDLE_RESOURCES`
  для `user://` не используются: в 4.5.x они не дают загрузить ресурс из
  пользовательского каталога без editor import pipeline.

## `PackageRuntimeManifest`

```ts
export type PackageRuntimeDependency = {
  packageId: number;
  revision: number;
  name: string;
};

export type PackageRuntimeManifest = {
  packageId: number;
  name: string;
  revision: number;
  roomId: number;
  publishedAt: string;
  files: PackageFileEntry[];
  totalSize: number;
  dependencies: PackageRuntimeDependency[];
  /** scene filepath -> "<packageId>:<filepath>", включая саму сцену */
  sceneDependencies: Record<string, string[]>;
  download: { token: string; expiresAt: number };
};
```

- `files` описывает уже переписанный артефакт: `size` и `sha256` считаются по
  тем байтам, которые скачает клиент.
- `dependencies` — только прямые зависимости корня; транзитивное замыкание
  зафиксировано в ключе артефакта и в манифестах самих зависимостей.
- `sceneDependencies` нужен reloader-у: по нему определяется, какие живые
  корни сцен затронуты изменением файла.

### Маршруты

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /scripting-packages/:id/revisions/:rev/runtime-manifest?room=<id>` | публичный | подписанный runtime-манифест ревизии для комнаты |
| `GET /scripting-packages/:id/revisions/:rev/runtime-files/*path?room=<id>&token=<token>` | публичный + токен | байты файла артефакта |

Файловый маршрут без токена или с токеном для другой комнаты/пакета/ревизии
возвращает `401 package_read_token_invalid`. Write-маршруты пакетов не менялись:
JWT и `assertPackageEditing`. В v1 пакеты публичны, отдельного ACL на чтение нет.

### Токен

- HMAC-SHA256, сообщение `package-read:v1:<roomId>:<packageId>:<revision>:<expiresAt>`,
  токен `<expiresAt>.<hex>`.
- TTL по умолчанию 900 секунд (`WIRED_PACKAGE_READ_TTL_SEC`). Секрет —
  `WIRED_PACKAGE_READ_SECRET`, fallback `WIRED_GAME_TICKET_SECRET`; пустой
  секрет даёт `503 package_read_secret_missing`.
- Проверка сравнивает HMAC в constant-time и отклоняет истёкшие, поддельные и
  чужие токены. Токен даёт только чтение и не заменяет права на запись.
- Секрет подписи никогда не покидает сервер. Сам токен — краткоживущая
  read-only capability, которая приходит в манифесте и уходит в Godot.

## Cross-package и кеш

- Ссылка разрешена на пакет той же комнаты или на глобальный пакет
  (`room == null`) как библиотеку. Ссылка на пакет другой комнаты —
  `package_dependency_room_mismatch:<id>`.
- Зависимость должна быть опубликована, а указанный файл — существовать:
  `package_dependency_unpublished:<id>`,
  `package_dependency_missing_file:<packageId>:<filepath>`.
- Циклы запрещены: `package_dependency_cycle:<a->b->a>`. Ошибка возвращается
  до записи байтов, частичный артефакт не отдаётся.
- Зависимость фиксируется на последнюю опубликованную ревизию на момент
  сборки. Ключ артефакта —
  `<packagesFilesDir>/<packageId>/runtime/<roomId>/<revision>/<depsHash>/`,
  где `depsHash = sha256(JSON(sorted [packageId, revision]))`. Публикация
  библиотеки меняет ключ, поэтому старые байты не переиспользуются.
- После публикации библиотеки сервер повторно отправляет зависимые
  room-пакеты, даже если их собственная ревизия не менялась.
- Сборка идёт в `.staging-<pid>-<random>` и публикуется атомарным `rename`;
  конкурентные запросы на один артефакт разделяют одну сборку.

## Две ревизии и очистка

Клиент хранит применённую ревизию и самую высокую другую ревизию пакета;
остальные числовые каталоги удаляются только внутри каталога этого пакета.
Старая сцена, которая ссылается на ревизию глубже этого окна, после очистки
ломается — известное ограничение v1. Текущая и предыдущая ревизии сохраняются
специально, чтобы пережить один откат/обновление.

## Горячая перезагрузка

- `PackageReloader` подписан на `package_applied`, копит изменения пакетов и
  делает один `_flush` через `RELOAD_DEBOUNCE_SEC = 0.2`.
- Пересоздаются только topmost-корни с meta `_wired_package_id`, у которых
  изменённый файл входит в `sceneDependencies`. Вложенные package-корни
  пересоздаются вместе с внешней сценой.
- Новый инстанс создаётся до удаления старого. Если сцена не загрузилась,
  старый корень остаётся, пишется `WIRED_PACKAGE_RELOAD_FAILED`.
- Сохраняются имя, индекс в родителе, export-переменные скрипта, transform
  (`position`, `rotation`, `scale`, `size`) и пользовательские meta-ключи.
  Значения-`Node` пропускаются; `Array`/`Dictionary` копируются глубоко.
- Дочерние узлы, Node-ссылки и внешние ссылки не переносятся: они принадлежат
  сцене, а не корню.
- Autoload, глобальные `class_name` и регистрации на старте не горячо
  перезагружаются: нужен перезапуск runtime.

## Известные ограничения

1. Сцена, сохранённая со ссылкой на ревизию старше двух, после cleanup не
   загрузится.
2. При пересоздании корня теряются дочерние узлы, пользовательское состояние
   детей и внешние ссылки. Export-переменные сохраняются только у корня.
3. Скрипты пакета недоверенные и исполняются с правами runtime; изоляции
   процессов и ограничений ресурсов в v1 нет.
4. В Web `user://` живёт в IndexedDB и переживает перезагрузку страницы.
   Старые `.import`/`.res` могут влиять на последующие прогоны, пока не
   очищены данные сайта.
5. Метаданные пакетов и runtime-manifest публичны; файлы артефакта защищены
   только read-only токеном конкретной ревизии одной комнаты.
6. `.gdshader` не переписывается сервером; ссылки `res://packages/...` внутри
   шейдера не будут разрешены.
7. Hot-swap autoload/`class_name` не поддерживается — только перезапуск.

## Реализация

- `packages/shared/src/api/types.ts` — `PackageRuntimeDependency`,
  `PackageRuntimeManifest`.
- `packages/server/src/scripting-packages/package-read-url.service.ts` — HMAC
  read URL.
- `packages/server/src/scripting-packages/package-runtime-references.ts` —
  разбор, переписывание, зависимости сцен.
- `packages/server/src/scripting-packages/package-delivery.service.ts` —
  сборка и кеш runtime-артефактов, поиск зависимых пакетов.
- `packages/server/src/scripting-packages/scripting-packages.controller.ts` —
  `runtime-manifest` и `runtime-files`.
- `packages/server/src/godot-game/package-sync.service.ts` — повторная
  отправка зависимых пакетов после публикации.
- `frontend/src/app/room/[room_code]/(godot)/GameTab.tsx`,
  `game-bridge.ts` — same-origin `apiBase`.
- `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd` —
  рекурсивная синхронизация, производные ресурсы, две ревизии.
- `packages/server/godot_project/_wired/_wired/scripts/global/package_reloader.gd` —
  пересоздание корней сцен.
- `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`,
  `_wired/web/shell.html` — bridge и проверка `apiBase`.
- `packages/server/godot_project/_wired/tests/*_smoke.gd` — headless-проверки.

## Проверки

Все команды запускались из корня репозитория на Godot
`4.5.1.stable.custom_build.f62fdbde1`.

| Команда | Результат |
| --- | --- |
| `pnpm --filter server exec jest package-read-url.service.spec` | pass, 1 suite / 4 tests |
| `pnpm --filter server exec jest package-runtime-references.spec` | pass, 1 / 11 |
| `pnpm --filter server exec jest package-delivery.service.spec` | pass, 1 / 27 |
| `pnpm --filter server exec jest scripting-packages.controller.spec` | pass, 1 / 15 |
| `pnpm --filter server exec jest package-sync.service.spec` | pass, 1 / 25 |
| `pnpm --filter server exec jest package-revisions.service.spec` | pass, 1 / 25 |
| `pnpm --filter frontend exec vitest run GameTab.test.tsx` | pass, 1 file / 3 tests |
| `pnpm check-types:frontend` | pass |
| `pnpm --filter server build` | pass |
| `pnpm --filter frontend lint` | fail: 7 errors / 17 warnings в файлах вне этапов 7–10 |
| `pnpm --filter server lint` | fail: 115 errors / 28 warnings (долг и моки тестов) |
| `packages_manager_smoke.gd` | pass, exit 0 |
| `package_assets_smoke.gd` | pass, exit 0 |
| `package_reloader_smoke.gd` | pass, exit 0 |
| `pnpm export:game` | pass; `index.html` содержит `apiBase`/`sameOriginApiBase` |

Шесть Jest-наборов дают 107 тестов. Оба lint-прогона падают на существующем
долге; frontend-ошибки — в файлах, не изменявшихся этапами 7–10, а targeted
ESLint по пяти основным runtime-файлам (`package-read-url.service.ts`,
`package-runtime-references.ts`, `package-delivery.service.ts`,
`scripting-packages.controller.ts`, `package-sync.service.ts`) проходит
чисто. `server lint` дополнительно переформатировал четыре файла, изменения
откачены. Godot smoke-тесты печатают ожидаемые ошибки негативных кейсов
(битый PNG, отсутствующая сцена) и завершаются кодом 0.

## Сквозной сценарий (не выполнен)

Статус: заблокирован. Локальный backend на `:3000` не запущен; работает
только frontend dev server на `:3001` без backend. Backend использует общую
удалённую Postgres с `DB_SYNC=1`, а сценарий требует Google-сессии, комнаты и
публикации тестовых пакетов. Создавать пользователей, комнаты и пакеты в
общей базе в этой задаче запрещено, поэтому браузерная проверка не
выполнялась; пункты ниже остаются pending.

Предусловия: `pnpm dev:server`; `pnpm --filter frontend dev -- -p 3001`;
вход через Google; Godot-комната; `pnpm export:game`.

- [ ] Создать library-пакет: `hero.gd`, `tex.png`, `beep.wav`; опубликовать
  ревизию 1.
- [ ] Создать game-пакет: `main.tscn` ссылается на library через
  `res://packages/<library>/...`, у корня `@export var score := 1`;
  опубликовать ревизию 1.
- [ ] Открыть Game: iframe получает same-origin `apiBase`, запросов к
  `127.0.0.1:3000` нет, сцена инстанцируется, текстура и звук на месте.
- [ ] Выставить `score = 42`, опубликовать library ревизию 2 с изменённым
  ассетом: зависимый game-пакет переотправляется, сцена пересоздаётся,
  `score` остаётся 42, ассет обновлён.
- [ ] Перезайти игроком: получает те же зафиксированные ревизии, повторной
  загрузки чужой ревизии нет.
- [ ] Опубликовать library ревизии 3–4 и проверить задокументированное
  поведение сцены, ссылающейся глубже двух ревизий.
- [ ] Изменить autoload/`class_name` в пакете: без перезапуска runtime эффекта
  нет, после перезапуска изменение применяется.
- [ ] Повторить сценарий на headless runtime (`pnpm dev:server` + комната):
  поведение совпадает с Web.
