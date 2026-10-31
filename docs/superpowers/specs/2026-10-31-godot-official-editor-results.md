# Этап 7. Официальный Godot 4.7.2 вместо кастомной сборки — результаты

Дата: 2026-10-31. Ветка: `working-on-godot-rooms`.
Статус: Реализовано (кроме ручного e2e на 4.7.2).

## Итог

Кастомная сборка Godot с патчем `Module["FS"] = FS` больше не нужна и больше не
лежит в git. Редактор скачивается закреплённой официальной сборкой
**4.7.2-stable** через `pnpm fetch:editor`, а файловые операции пакетов идут
через `wired_bridge` (`package_fs.gd` + `plugin.gd`), а не через `rtenv.FS`:
официальная сборка не экспортирует Emscripten `FS`, и `rtenv` в ней нет.
Чистая установка теперь — `pnpm install && pnpm fetch:editor`.

Каталог `packages/server/godot_editor/` удалён из индекса git (12 файлов,
83 652 389 байт, из них `godot.editor.wasm` — 83 049 195 байт) и добавлен в
`.gitignore`. Это не удаление из истории: старые файлы по-прежнему достаются
из любого коммита до этого этапа, например
`git show <commit>^:packages/server/godot_editor/godot.editor.wasm > godot.editor.wasm`.
История git не переписывалась, поэтому ~80 МБ остаются в прошлых объектах.

Ручной e2e на реальном 4.7.2 **не выполнялся** (см. чеклист ниже): статус
этапа — «реализовано, кроме ручного e2e».

## Что изменилось

| Файл | Было | Стало |
| --- | --- | --- |
| `packages/server/godot_editor/*` (индекс git) | 12 файлов в репозитории, `godot.editor.wasm` 83 049 195 байт | `git rm -r --cached`; файлы на диске пересоздаются скриптом |
| `.gitignore` | каталога редактора нет в списке | строка `packages/server/godot_editor/` (игнорируется весь каталог, включая `VERSION`) |
| `backend.Dockerfile` (стадия `build`) | редактор приходил из контекста (`COPY . .`) | `RUN pnpm --filter server fetch:editor` + комментарий, что офлайн-сборке нужен заранее подготовленный каталог |
| `backend.Dockerfile` (финальная стадия) | копировались только `node_modules`, `packages/server/dist`, `packages/shared/dist` | добавлен `COPY --from=build /app/packages/server/godot_editor /app/packages/server/godot_editor` |
| `packages/server/godot_project/_wired/project.godot` | `PackedStringArray("4.5", "GL Compatibility")` | `PackedStringArray("4.7", "GL Compatibility")` |
| `AGENTS.md` | «`godot_editor/` — committed WASM editor, ~80 MB» | редактор не в git: `pnpm fetch:editor` качает закреплённый 4.7.2, версия/размер/sha512 — в `packages/server/scripts/fetch-godot-editor.mjs` |
| `AGENTS.md` (команды) | — | добавлена `pnpm fetch:editor` |
| `AGENTS.md` (факты) | — | добавлено: файловые операции пакетов идут через `wired_bridge`/`package_fs.gd` → `Engine.copyToFS`, `rtenv.FS` больше нет; `GODOT_RUNTIME_PATH` для `export:game` обязан быть 4.7.2; Docker-образ качает редактор на сборке и требует сети |
| `docs/superpowers/specs/2026-10-31-godot-official-editor-js-bridge-design.md` | `Статус: утверждено` | `Статус: Реализовано (кроме ручного e2e на 4.7.2)` |
| `docs/superpowers/specs/2026-10-31-godot-official-editor-results.md` | — | этот документ |

## Восстановление каталога редактора

Удаление на диске и повторная загрузка проверены на Windows:

```powershell
Remove-Item -Recurse -Force packages/server/godot_editor
pnpm fetch:editor
```

Фактический результат `pnpm fetch:editor`:

```
[fetch:editor] Скачивание Godot_v4.7.2-stable_web_editor.zip
[fetch:editor] Размер: 54031095 байт (51.53 MiB)
[fetch:editor] sha512: 03ad6b4b4d96f0f7d85bf4fdcf29535891b79d52ee94a11e96895463a2745347b8f601b455e7a58135bf641df43fc25296bc257bbfce593d477dfa64a2272268
[fetch:editor] Распаковано файлов: 12
[fetch:editor] Готово: 4.7.2-stable
[fetch:editor] Каталог редактора: C:\Users\hermit\webdev\Wired\packages\server\godot_editor
```

Проверка после скачивания:

- `packages/server/godot_editor/godot.editor.wasm` — 96 413 171 байт (> 40 МБ),
  суммарно каталог 96 865 615 байт (12 файлов).
- `VERSION` — `4.7.2-stable`.
- Новый wasm больше прежнего кастомного (96,4 МБ против 83,0 МБ): официальная
  сборка 4.7.2 включает больше кода, это ожидаемо и не является регрессом.
- `git check-ignore -v packages/server/godot_editor/VERSION` → правило
  `.gitignore:7:packages/server/godot_editor/`.

Повторный запуск без `--force` при совпадающем `VERSION` выходит без сети;
`--force` перекачивает архив.

## Docker

`docker build` **не выполнялся**: в этом окружении нет Docker CLI/демона.
Точная команда и ошибка:

```
> docker build -f backend.Dockerfile .
docker : Имя "docker" не распознано как имя командлета, функции, файла сценария
или исполняемой программы. Проверьте правильность имени и повторите попытку.
CategoryInfo: ObjectNotFound: (docker:String) [], CommandNotFoundException
```

Поэтому изменение Dockerfile проверено только чтением: стадия `build` качает
редактор сразу после `pnpm install --frozen-lockfile`, финальная стадия копирует
каталог из `build`; комментарий в Dockerfile фиксирует, что офлайн-сборка должна
заранее положить `packages/server/godot_editor` в контекст. Сетевой доступ к
GitHub при `docker build` теперь обязателен. Проверить в CI/на машине с Docker
нужно отдельно.

## Ручной e2e checklist (не выполнен, статус: pending)

Предусловия: `pnpm install`; `pnpm fetch:editor`; Postgres из
`packages/server/.env`; `pnpm dev:server`;
`pnpm --filter frontend dev -- -p 3001`; вход через Google; комната типа
`godot`. Для шагов с Game-вкладкой — `pnpm export:game` на 4.7.2.

1. **Создать пакет** (вкладка Packages → «Создать пакет»).
   Ожидается: карточка «загружен», в доке FileSystem появился пустой
   `packages/<packageId>/`, в консоли браузера — `WIRED_EDITOR_RESCAN_DONE`;
   ошибок моста нет. В IndexedDB (`/home/web_user/room-<id>`, store
   `FILE_DATA`) появляется префикс каталога пакета.
2. **Скачать ревизию** (кнопка «Скачать в редактор» у пакета с опубликованной
   ревизией). Ожидается: файлы появились в `packages/<packageId>/`,
   опубликованная и загруженная ревизии совпадают, карточка «загружен»;
   в IndexedDB видны записи `.../Wired/packages/<packageId>/<файл>`.
3. **Emit** (изменить файл в редакторе → «Emit»). Ожидается: публикуется новая
   ревизия, карточка и база обновляются, в Game-вкладке клиент получает эту
   ревизию; ошибок в консоли нет.
4. **Удалить** («Убрать из редактора»). Ожидается: исчезает только
   `packages/<packageId>/`; соседние пакеты и остальной проект целы; записи
   этого каталога пропадают из IndexedDB после перезагрузки страницы.
5. **Перезагрузить страницу.** Ожидается: пакет снова «не загружен»; если
   каталог остался в IndexedDB, он показан как «локальные изменения».
6. **Проверить IndexedDB** в DevTools → Application → IndexedDB →
   `/home/web_user/room-<id>` → `FILE_DATA`: после шага 2 записи пакета есть,
   после шага 4 — нет.
7. Дополнительно (регресс официальной сборки): в консоли
   `window.editor.editor.rtenv === undefined` — это ожидаемо, весь файловый
   обмен идёт через мост; при недоступном мосте панель показывает
   «Мост редактора недоступен» и продолжает опрос, не ломая редактор.

Пока чеклист не пройден, нельзя утверждать, что 4.7.2 не изменил поведение
плагина и `force_fs_sync()`.

## Проверки

Автоматические (Windows, локально):

| Команда | Результат | Код |
| --- | --- | --- |
| `pnpm --filter server test` | 31 набор прошёл, 1 пропущен (`room-runtime.integration`); 314 тестов прошли, 1 пропущен (315) | 0 |
| `pnpm --filter server build` | `nest build` без ошибок, `dist/server/src/main.js` на месте | 0 |
| `pnpm --filter frontend test` | 7 файлов, 78 тестов, все прошли | 0 |
| `pnpm check-types:frontend` | `tsc --noEmit` чисто | 0 |
| `pnpm --filter frontend lint` | 7 errors / 17 warnings — все в файлах, не менявшихся этим этапом | 1 |
| `pnpm --filter server test:scripts` | 11 тестов (`unzip.test.mjs`, `editor-install.test.mjs`), все прошли | 0 |

`pnpm --filter frontend lint` падал и до этапа: `git diff HEAD -- frontend`
пуст, то есть рабочее дерево frontend совпадает с закоммиченным состоянием
задач 1–6. Ошибки находятся в `api-client.ts`, `homepage-client.tsx`,
`rooms.tsx`, `user.tsx`, `layout.tsx`, `animate-ui/…/slot.tsx`,
`animate-ui/…/sliding-number.tsx`, `ImageBackground.tsx`, `user-store.ts` и
относятся к правилам `no-explicit-any`, `react/display-name`,
`react-hooks/purity`/`refs`/`static-components`. Это ранее существовавшие
нарушения; в рамках этапа 7 не исправлялись (правка не входит в задачу и
затронула бы чужие файлы). ESLint по изменённым здесь файлам не применим: все
изменения — markdown, Dockerfile, `.gitignore` и `project.godot`.

## Решения и ограничения

- Файлы редактора не удалены из истории git: переписывание истории вне рамок
  этапа, поэтому ~80 МБ остаются в прошлых объектах. Каталог на диске после
  `pnpm fetch:editor` — 96,9 МБ и в git не попадает.
- `.dockerignore` не менялся: `packages/server/godot_editor` попадает в
  контекст сборки, если каталог уже скачан локально. Это делает контекст
  больше (~97 МБ), зато офлайн-сборка может использовать заранее
  подготовленный каталог без отдельного volume mount. Если это станет
  проблемой, каталог нужно исключить в `.dockerignore` и монтировать
  редактор как volume.
- Образ backend теперь зависит от сети и доступности GitHub при `docker build`.
- В дизайн-доке URL релиза указан как
  `github.com/godotengine/godot-builds/releases/download/<version>/<zip>`, а
  скрипт качает с `github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_web_editor.zip`
  (этот URL работает и проверен размером/sha512). Расхождение в тексте дизайна
  не исправлялось, чтобы не расширять правку документа; фактическим
  источником истины остаётся `packages/server/scripts/fetch-godot-editor.mjs`.
- `sync()` через `JavaScriptBridge.force_fs_sync()` не имеет колбэка: ошибка
  записи в IndexedDB не всплывает, `replace`/`delete` сообщают об успехе до
  фактической персистенции. Это осознанный регресс относительно
  `FS.syncfs(false, callback)`, зафиксированный в дизайне.
