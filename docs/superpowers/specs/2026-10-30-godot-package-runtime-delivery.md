# Этапы 7–10. Динамическая доставка пакетов в Godot — результаты

Дата: 2026-10-30. Ветка: `working-on-godot-rooms`.
Статус: реализация завершена; целевые Jest/Vitest, typecheck, server build и
Godot smokes пройдены, lint-долг остаётся (см. «Проверки»). Браузерный e2e в
этой сессии не выполнен — окружение заблокировано, чеклист ниже.

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
Версии: editor 4.5.1, native release 4.5.0 (`4.5-stable.official`),
Web export 4.5.1.

| Тип / сценарий | editor | native release | Web |
| --- | --- | --- | --- |
| `.gd` (скрипт) | да | да | да |
| `.tscn` (сцена) | да | да | да |
| `.tres` (ресурс) | да | да | да |
| `.gdshader` | да | да | да |
| raw PNG/JPEG/WebP/BMP + runtime sidecar | да | да | да |
| raw WAV/OGG/MP3 + runtime sidecar | да | да | да |
| `.ctex` как `Texture2D` | нет | нет | нет |
| `.remap`, указывающий на `.ctex` | нет | нет | нет |
| editor `.import` с `path` в `.godot/imported/...` | нет | нет | нет |
| `FLAG_BUNDLE_RESOURCES` из `user://` | нет | нет | нет |
| hot-swap autoload / `class_name` | нет | нет | нет |

**Итого: 24/31 в чистом headless editor, 24/31 в native release, 25/31 в Web.**
Лишний Web-проход не означает поддержку: старый `.import`, оставшийся в
IndexedDB от предыдущего прогона, позволил загрузиться одному из 7 непрошедших
кейсов; в чистом профиле он не работает. Остальные кейсы — неподдерживаемые
типы и сценарии из таблицы.

Строки таблицы сводят кейсы по типу; итоговые числа считаются по 31 кейсу,
а не по числу строк. Поштучный список с результатами — в приложении A.

Важное различие: editor-формат `.import`, чей `[remap] path` ведёт в
`.godot/imported/...`, не работает. Рантайм генерирует собственный sidecar
`<file>.import` с абсолютным `user://...res` — это и есть поддерживаемый
механизм для raw PNG/audio. `.remap` сам по себе не удовлетворяет type hint
`Texture2D`; рантайм использует свой sidecar/remap на `.res`, а не внешний
`.ctex`.

## Что и как доставляется

- Текстовые `.gd`, `.tscn`, `.tres` переписываются сервером. Заменяются только
  ссылки внутри строковых литералов `res://packages/<id>/<path>`; комментарии
  не трогаются. У строк `[ext_resource ...]` удаляется `uid`, чтобы UID из
  чужого проекта не перекрывал локальный ресурс.
- Бинарные файлы копируются байт-в-байт. Невалидный UTF-8 в текстовом файле —
  ошибка сборки `package_text_not_utf8:<file>`, а не молчаливая замена.
  Бинарный `.scn` также копируется байт-в-байт, но ссылки внутри него не
  переписываются: поддержка `.scn` в v1 не заявлена.
- `.gdshader` копируется как есть: это текстовый ресурс, но сервер не
  переписывает ссылки внутри шейдеров. Шейдер должен быть самодостаточным.
- Raw-изображения (`png`, `jpg`, `jpeg`, `webp`, `bmp`) и аудио (`wav`, `ogg`,
  `mp3`) остаются в артефакте исходными файлами. На клиенте рядом создаются
  `<file>.image.res` / `<file>.audio.res` и sidecar `<file>.import` с абсолютным
  `user://` путём. Производные файлы не входят в манифест, хеши и публикацию.
- Производные ресурсы не сохраняют авторские настройки импорта (filter,
  repeat, mipmaps, compression, loop points): это runtime-представление по
  умолчанию. Один нечитаемый raw-ассет прерывает применение всего пакета с
  `asset_derive_failed:<path>`; staging откатывается, текущая ревизия остаётся.
- Editor `.import` с `path` в `.godot/imported/...` и внешний `.remap` на
  `.ctex` не работают (см. выше). `.ctex` и `FLAG_BUNDLE_RESOURCES` для
  `user://` не используются: в 4.5.x они не дают загрузить ресурс из
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
JWT и `assertPackageEditing`.

Манифест публичен и содержит токен: любой, кто знает `packageId`, `revision` и
`room`, может получить манифест и скачать байты, пока токен жив. Токен
ограничивает только область (room/package/revision) и время (TTL), а не
пользователя, и не является ACL-защитой.

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
- `network.gd` объявляет применённую ревизию всем клиентам. Явное применение
  broadcast-ится всегда, даже при том же номере ревизии: артефакт мог
  измениться из-за обновления зависимости. Новому peer-у уходит только
  последняя ревизия.
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

1. Сцена, сохранённая со ссылкой на ревизию глубже окна, ломается после
   cleanup — см. «Две ревизии и очистка».
2. При пересоздании корня теряются дочерние узлы, пользовательское состояние
   детей и внешние ссылки. Export-переменные сохраняются только у корня.
3. Скрипты пакета недоверенные и исполняются с правами runtime; изоляции
   процессов и ограничений ресурсов в v1 нет.
4. В Web `user://` живёт в IndexedDB и переживает перезагрузку страницы.
   Старые `.import`/`.res` могут влиять на последующие прогоны, пока не
   очищены данные сайта.
5. Манифест публичен и содержит токен; это не ACL — см. «Маршруты».
6. `.gdshader` не переписывается сервером; ссылки `res://packages/...` внутри
   шейдера не будут разрешены.
7. Hot-swap autoload/`class_name` не поддерживается; правило — в «Горячая
   перезагрузка».

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
- `packages/server/godot_project/_wired/_wired/scripts/network/network.gd` —
  объявление ревизий клиентам, включая повторный broadcast при неизменном
  номере ревизии.
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
| `pnpm --filter server lint` | fail: 114 errors / 28 warnings (pre-existing debt) |
| `packages_manager_smoke.gd` | pass, exit 0 |
| `package_assets_smoke.gd` | pass, exit 0 |
| `package_reloader_smoke.gd` | pass, exit 0 |
| `pnpm export:game` | pass; `index.html` содержит `apiBase`/`sameOriginApiBase` |

Шесть Jest-наборов дают 107 тестов. В
`scripting-packages.controller.spec.ts` был один diagnostic, внесённый этой
веткой (`require-await` на mock `resolveRuntimeFile`); он исправлен на
promise-mock без `async`. Остальной долг frontend/server lint — pre-existing.
Полные lint-команды по-прежнему падают; targeted ESLint по пяти основным
runtime-файлам (`package-read-url.service.ts`,
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

Предусловия: изолированная/локальная Postgres (не общая remote с `DB_SYNC=1`);
`pnpm dev:server`; `pnpm --filter frontend dev -- -p 3001`; вход через Google;
Godot-комната; `pnpm export:game`.

- [ ] Создать library-пакет: `hero.gd`, `tex.png`, `beep.wav`; опубликовать
  ревизию 1.
- [ ] Создать game-пакет: `main.tscn` ссылается на library через
  `res://packages/<library>/...`, у корня `@export var score := 1`;
  опубликовать ревизию 1.
- [ ] Открыть Game: iframe получает same-origin `apiBase`, запросов к
  `127.0.0.1:3000` нет, сцена инстанцируется, текстура и звук на месте.
- [ ] Временным тестовым скриптом или тестовым RPC выставить `score = 42` у
  живого корня; опубликовать library ревизию 2 с изменённым ассетом: зависимый
  game-пакет переотправляется, сцена пересоздаётся, `score` остаётся 42, ассет
  обновлён. Хук в продакшн-код не добавляется.
- [ ] Перезайти игроком: получает те же зафиксированные ревизии, повторной
  загрузки чужой ревизии нет.
- [ ] Опубликовать library ревизии 3–4 и проверить задокументированное
  поведение сцены, ссылающейся глубже двух ревизий.
- [ ] Изменить autoload/`class_name` в пакете: без перезапуска runtime эффекта
  нет, после перезапуска изменение применяется.
- [ ] Повторить сценарий на headless runtime (`pnpm dev:server` + комната):
  поведение совпадает с Web.

## Приложение A. 31 кейс матрицы

Гарнесс: `C:\Users\hermit\AppData\Local\Temp\opencode\godot-dynload-test`
(`main.gd`, `fixtures/`, `build/`); в репозиторий не входит и не коммитится.
Имена кейсов — значения `DYNTEST <name>` из `main.gd`.

| № | Кейс | editor 4.5.1 | native release 4.5-stable | Web 4.5.1 |
| --- | --- | --- | --- | --- |
| 1 | `script_load` | PASS | PASS | PASS |
| 2 | `script_source_reload` | PASS | PASS | PASS |
| 3 | `scene_plain` | PASS | PASS | PASS |
| 4 | `scene_with_script` | PASS | PASS | PASS |
| 5 | `scene_texture_relative` | PASS | PASS | PASS |
| 6 | `scene_texture_absolute_res` | PASS | PASS | PASS |
| 7 | `scene_embedded_script` | PASS | PASS | PASS |
| 8 | `png_resource_loader` | PASS | PASS | PASS |
| 9 | `png_image` | PASS | PASS | PASS |
| 10 | `png_imagetexture_res` | PASS | PASS | PASS |
| 11 | `scene_texture_image_res` | PASS | PASS | PASS |
| 12 | `ctex_resource_loader` | PASS | PASS | PASS |
| 13 | `png_remap_resource_loader` | PASS | PASS | PASS |
| 14 | `scene_texture_ctex` | FAIL | FAIL | FAIL |
| 15 | `scene_texture_ctex_abs` | FAIL | FAIL | FAIL |
| 16 | `scene_texture_ctex_typed` | PASS | PASS | PASS |
| 17 | `scene_relative_tres` | PASS | PASS | PASS |
| 18 | `scene_texture_remap` | FAIL | FAIL | FAIL |
| 19 | `scene_relative_png` | FAIL | FAIL | FAIL |
| 20 | `scene_editor_text_user` | PASS | PASS | PASS |
| 21 | `scene_editor_bundled_user` | FAIL | FAIL | FAIL |
| 22 | `scene_editor_bundled_script_user` | FAIL | FAIL | FAIL |
| 23 | `script_preload_user` | PASS | PASS | PASS |
| 24 | `class_name_reload` | PASS | PASS | PASS |
| 25 | `tres_gradient` | PASS | PASS | PASS |
| 26 | `shader_text` | PASS | PASS | PASS |
| 27 | `wav_resource_loader` | FAIL | FAIL | PASS |
| 28 | `wav_direct_load` | PASS | PASS | PASS |
| 29 | `wav_res_import` | PASS | PASS | PASS |
| 30 | `scene_audio_res` | PASS | PASS | PASS |
| 31 | `cache_ignore` | PASS | PASS | PASS |

Провенанс:

- **editor**: `editor.log`, строка `DYNTEST SUMMARY 24/31 passed`.
- **native release**: `release.log` пустой, поэтому колонка восстановлена
  прогоном существующего `build/dynload-test.exe` после удаления
  `%APPDATA%\Godot\app_userdata\dynload-test\pkg`; результат —
  `release-clean.log`, `24/31`. Бинарник сообщает
  `4.5-stable.official.876b29033`; в плане он назван native release 4.5.0.
- **Web**: отдельного поштучного лога нет. Колонка восстановлена из итога
  `25/31` и единственного дополнительного прохода `wav_resource_loader`:
  остальные 30 кейсов совпадают с editor. Это реконструкция по run notes, а не
  сохранённый лог.
- **Причина Web +1**: старый `.import` в IndexedDB от предыдущего прогона
  (sidecar кейса `wav_resource_loader`) уже указывал на созданный `.res`,
  поэтому кейс прошёл. В чистом профиле кейс падает, как в editor/native. Это
  не поддержка типа.
- **Контроль механизма**: повторный native-прогон без очистки `user://pkg` дал
  `25/31`, и единственным дополнительным PASS был `wav_resource_loader`
  (`release-rerun.log`). Это воспроизводит тот же stale-sidecar эффект и
  объясняет, почему оба «лишних» прохода нельзя считать поддержкой.

Итог приложения: editor и native release — 24 PASS / 7 FAIL; Web — 25 PASS /
6 FAIL, дельта ровно `wav_resource_loader`.
