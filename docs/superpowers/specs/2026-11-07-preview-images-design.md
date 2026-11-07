# Preview-изображения комнат и пакетов + переиспользуемый media upload

Дата: 2026-11-07
Статус: proposal

## 1. Задача

У комнаты и у пакета появляется опциональное preview-изображение. Его можно задать, заменить и сбросить в настройках (комната — `RoomEditingPanel`, пакет — `PackageEditDialog`): выбрать файл или вставить картинку из буфера обмена. Upload сразу отправляет байты на сервер и получает URL; сохранение настроек отдельно записывает этот URL (или `null`) в сущность.

Если preview есть, он показывается миниатюрой слева на карточках комнат, пакетов в комнате и пакетов в workshop. Если нет — карточка остаётся текстовой как сейчас, без пустого плейсхолдера.

Upload API и UI-компонент общие, чтобы позже тем же путём загружать аватар пользователя (аватары в этой задаче не делаем).

## 2. Goals

- Опциональное поле preview у `Room` и `ScriptingPackage` (строка-URL или `null`).
- Общий `POST` upload изображений: auth, multipart, сохранение в `STORAGE_DIR/uploads` под уникальным хеш-именем, ответ с публичным URL.
- Общий frontend-компонент: выбрать файл / paste из clipboard → сразу upload → отдать URL родителю; умеет показать текущее изображение, заменить и очистить (локально до save).
- В настройках комнаты и пакета: редактор preview; «Сохранить» биндит URL/`null` через существующие update/create payload.
- Карточки `RoomCard`, `PackageCard` (Packages tab), `WorkshopPackageCard`: при наличии URL — миниатюра слева с `object-fit: cover`; без URL — без изменений layout.
- `WorkshopPackageSummary` и listing API отдают preview, чтобы витрина могла его показать.
- i18n-строки для upload/ошибок в `frontend/messages/{en,ru}.json`.

## 3. Non-goals

- Не реализуем загрузку/смену аватара пользователя в UI — только закладываем переиспользуемый API и компонент.
- Не удаляем и не GC-им старые файлы при смене/очистке preview: orphans на диске допустимы.
- Не делаем серверный или клиентский crop / принудительный квадрат при загрузке.
- Не делаем CDN, signed upload URLs, временные «черновики» с переносом при save.
- Не добавляем миграционный фреймворк: схема через `DB_SYNC=1`.
- Не меняем runtime Godot, bridge, package revision storage.

## 4. Anti-goals

- Upload endpoint, который сам пишет в Room/Package: ломает «upload ≠ bind» и мешает переиспользованию под аватар.
- Пустой image-блок на карточке без preview.
- Сохранение байтов прямо в корень `STORAGE_DIR` рядом с packages/godot_rooms.
- Принятие произвольных MIME/размеров без лимита (DoS через storage).
- Хардкод user-facing строк в компонентах в обход next-intl.

## 5. Constraints

- `DB_SYNC=1` на общей Postgres: новое nullable-поле появляется при старте сервера; отката миграциями нет.
- Frontend ходит в API только из браузера через axios + Bearer cookie; cookie не httpOnly и не прокидывается в RSC.
- Страницы с COOP/COEP: картинки с API должны быть same-origin (через `/api/*` rewrite) или отдаваться с подходящим `Cross-Origin-Resource-Policy`, иначе `<img>` ломается под `require-corp`.
- Уже есть `serveStaticAsset` + `contentTypeFor` (png/jpg/jpeg/webp); новый GET должен их переиспользовать, без копипасты.
- `STORAGE_DIR` резолвится из cwd пакета server при загрузке конфига.
- UI copy и docs — преимущественно русский; строки интерфейса — en+ru через next-intl.

## 6. Рассмотренные подходы

### A. Общий media-upload + URL в сущности (выбран)

`POST /media` (или эквивалент) сохраняет файл и возвращает URL. Room/Package хранят опциональную строку. Настройки: upload сразу, save биндит. Карточки читают поле.

Плюсы: совпадает с «upload ≠ bind», один API/компонент на комнату, пакет и будущий аватар, минимум инфраструктуры поверх `STORAGE_DIR`. Минусы: orphans на диске (осознанно принято).

### B. Upload прямо на сущность

`POST /rooms/:id/preview` и `POST /packages/:id/preview` сразу пишут файл и поле.

Плюсы: меньше шагов для одной фичи. Минусы: ломает выбранный UX, для аватара нужен третий путь, слабее переиспользование.

### C. Временный blob → ассоциация при save

Upload кладёт черновик; save переносит/привязывает.

Плюсы: теоретически удобнее GC. Минусы: лишняя механика при уже принятых orphans.

**Выбрано A**, с уточнениями: файлы в `STORAGE_DIR/uploads`, имена — уникальный хеш.

## 7. How

### 7.1 Storage и имена файлов

- Каталог: `<STORAGE_DIR>/uploads` (создавать при необходимости).
- Имя файла: криптостойкий уникальный хеш (например `randomBytes(32).toString('hex')`) + расширение из разрешённого MIME (`.png` / `.jpg` / `.webp`). Не использовать оригинальное имя клиента.
- Builder call: не дедуплицируем по content-hash в v1 — проще и предсказуемее при orphans; коллизии имён практически невозможны.

### 7.2 Media API

- Модуль Nest (например `media`): controller + тонкий storage helper.
- `POST /media` (multipart field `file`):
  - только authenticated;
  - принимает `image/png`, `image/jpeg`, `image/webp`;
  - лимит размера **2 MiB** (builder call; не путать с `MAX_PACKAGE_FILE_SIZE`);
  - magic-bytes / MIME check, не только `Content-Type` заголовка;
  - пишет в `uploads/`, возвращает `{ url: string }` где `url` — путь вида `/media/<filename>` (same-origin через frontend `/api` rewrite) либо полный path, который фронт сможет подставить в `src` без утечки backend host в карточках. Builder call: предпочесть относительный `/media/<file>`, а axios/base URL для `<img>` резолвить тем же префиксом, что и остальные asset URL (`withApiPrefix` / аналог).
- `GET /media/:filename`:
  - публичное чтение (preview на публичных карточках/workshop без auth);
  - отдача через `serveStaticAsset` из корня `STORAGE_DIR/uploads`;
  - `crossOriginIsolation: false` не обязателен для non-document image, но выставить `Cross-Origin-Resource-Policy: same-origin` (или эквивалент, совместимый с COEP страницы) и корректный `Content-Type` из `contentTypeFor`;
  - path traversal блокируется `resolveWithin`.
- Нет DELETE endpoint в этой задаче.

### 7.3 Модель данных

- `Room.previewImage: string | null` — nullable varchar, default `null`.
- `ScriptingPackage.previewImage: string | null` — то же.
- Shared: поле в `Room`, `ScriptingPackage`, `WorkshopPackageSummary`; опционально в `CreateRoomPayload` / `UpdateRoomPayload` / `UpdateScriptingPackagePayload` (и create package, если форма создания это позволит без усложнения — иначе только update + create room).
- Clear: клиент шлёт `previewImage: null`; DTO должны принимать `null` явно (не только `undefined`/omit).
- Валидация URL на bind (builder call): принимать только наши `/media/<hex>.<ext>` (или согласованный префикс), чтобы нельзя было записать произвольный external URL в preview комнаты/пакета. Для будущего `User.picture` это ограничение можно ослабить отдельно (Google URL уже внешний).

### 7.4 Права на bind

- Upload: любой залогиненный пользователь (файл ещё ни к чему не привязан).
- Запись `previewImage` в Room/Package — теми же guard/правилами, что и обычный update метаданных / создание комнаты. Отдельных ACL для картинки нет.

### 7.5 Копирование / workshop

Там, где сервер уже копирует метаданные пакета (публикация в workshop, fork, add-to-room), копировать и `previewImage` (та же строка URL, без дублирования файла). Room copy — аналогично, если копируются name/description.

### 7.6 Frontend: переиспользуемый компонент

- Например `ImageUploadField`: props `value: string | null`, `onChange(next: string | null)`, optional `disabled`.
- UX: превью текущего изображения (если value), кнопки «Загрузить» / «Вставить» (или единая dropzone + слушатель paste, когда поле в фокусе/наведено), «Удалить» → `onChange(null)`.
- На выборе файла или paste: сразу `FormData` → `POST /media`, на успех `onChange(url)`; ошибки через toast/inline + i18n.
- Не привязан к Room/Package — родитель пишет URL в свой form state и отправляет на save.

### 7.7 Settings

- `RoomEditingPanel`: поле preview (create + edit).
- `PackageEditDialog`: поле preview.
- Сохранение через существующие create/update API с новым полем.

### 7.8 Карточки

- Общий маленький презентационный кусок (опционально) или локальный `<img>` слева.
- Размер миниатюры — компактный квадрат/прямоугольник фиксированной ширины (builder call, ~64–96px), `object-fit: cover`, `object-position: center`.
- Без `previewImage` — прежний markup, без пустого слота.

### 7.9 Тесты

- Server: DTO/validation upload (MIME, size, auth), GET traversal negative, update room/package с URL и с `null`, workshop summary включает поле.
- Frontend: компонент upload (file + paste mock), карточка с/без preview (layout regress).

## 8. Оставлено билдеру

- Точное имя Nest-модуля/роута (`media` vs `uploads`), структура файлов.
- Точная длина хеша и способ генерации (достаточно 32 random bytes hex).
- Точный размер миниатюры и мелкий CSS, лишь бы «слева» и cover.
- Нужен ли отдельный `CreateScriptingPackagePayload.previewImage` или только через edit после create.
- Как именно резолвить `/media/...` в `img.src` рядом с существующим `withApiPrefix`.
- Magic-bytes библиотека vs ручная проверка сигнатур.

## 9. Success

В настройках комнаты и пакета можно загрузить или вставить картинку, сохранить, увидеть миниатюру слева на соответствующих карточках; очистить preview и снова увидеть текстовую карточку; тот же upload-компонент и `POST /media` готовы к будущему аватару без нового storage path.
