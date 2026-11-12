# Размер пакета в панели Packages

Дата: 2026-11-12
Статус: proposal

## 1. Интент

На странице комнаты в панели Packages карточка пакета показывает версию,
опубликованную ревизию и состояние runtime, но не размер. Чтобы понять,
насколько пакет тяжёлый, приходится открывать его файлы. Нужно показывать
размер прямо в карточке, в КБ или МБ (решение пользователя). Тот же размер
нужен и в каталоге workshop: там выбирают, что добавить в комнату, и вес
пакета — часть этого выбора.

Размер — это сумма размеров файлов последней **опубликованной** ревизии
пакета. Зависимости не учитываются.

## 2. Goals

- `GET /rooms/:id/game/packages` отдаёт `sizeBytes` для каждого пакета:
  сумма `files[].size` последней ревизии в статусе `published`, либо `null`,
  если опубликованных ревизий нет.
- Карточка пакета в `PackagesTab` показывает размер рядом с версией и
  ревизией: меньше 1 МБ — в КБ, от 1 МБ — в МБ, одна цифра после запятой,
  число форматируется под текущую локаль.
- `GET /scripting-packages/workshop` отдаёт `sizeBytes` в каждом
  `WorkshopPackageSummary`; карточка `WorkshopBrowser` показывает размер
  рядом с ревизией.
- Никаких новых запросов и изменений схемы БД: `getStatuses` уже читает
  последние опубликованные ревизии вместе с `files`, а `WORKSHOP_SELECT`
  уже джойнит ту же ревизию латеральным подзапросом.

## 3. Non-goals

- Размер зависимостей и суммарный размер пакета вместе с ними.
- Размер runtime-артефакта (`runtime/v2/...`), zip/манифеста или локальной
  копии в редакторе.
- Показ размера в диалоге публикации/превью пакета и в остальных местах,
  кроме карточки комнаты и каталога workshop.
- Кэширование или хранение размера в БД.

## 4. Anti-goals

- N+1 запросов за манифестами на каждый 10-секундный опрос панели.
- Второй расчёт размера на клиенте (по файлам редактора или манифесту),
  который может разойтись с серверным.
- Захардкоженные «КБ/МБ» в компоненте: единицы живут в `messages`.

## 5. Approaches

| Вариант | Что даёт | Чем платим |
|---|---|---|
| **A. Считать на сервере и отдавать в `PackageSyncStatus`** (выбрано) | Один уже существующий запрос, точные данные из БД, ноль изменений схемы | Одно новое поле в публичном типе |
| B. Добавить размер в `ScriptingPackage` | Поле доступно везде | Пришлось бы считать размер в листингах комнат, workshop и профиля: это свойство ревизии, а не пакета; лишние JOIN-ы на горячих ручках |
| C. Фронтенд тянет манифест каждого пакета | Без серверных изменений | N дополнительных запросов каждые 10 секунд; для неопубликованных пакетов манифеста нет |

Для каталога workshop выбран тот же серверный принцип: `WORKSHOP_SELECT`
уже джойнит последнюю опубликованную ревизию, поэтому сумма считается в
том же латеральном подзапросе. Альтернатива — выбирать `files` в TS и
суммировать в `toSummary` — тянет jsonb всех файлов на каждый листинг,
хотя клиенту нужно одно число.

## 6. Design

### 6.1. Общий тип

`packages/shared/src/api/types.ts`, `PackageSyncStatus`:

```ts
/**
 * Sum of file sizes of the package's latest published revision. Dependencies
 * are not included. `null` when the package has no published revision.
 */
sizeBytes: number | null;
```

Поле аддитивное: остальные потребители `RoomPackagesStatus` (игровая
вкладка, синхронизация пакетов) его просто не читают.

`WorkshopPackageSummary` (там же):

```ts
/**
 * Sum of file sizes of the listing's published revision. Dependencies are
 * not included. Workshop rows always have a published revision.
 */
sizeBytes: number;
```

### 6.2. Сервер

`packages/server/src/godot-game/package-sync/package-sync.service.ts`,
`getStatuses`:

- `latestPublishedRevisions` уже возвращает строки ревизий с `files` и
  фильтрует `status: 'published'`.
- `StatusReporter.toStatus` начинает возвращать
  `Omit<PackageSyncStatus, 'sizeBytes'>`: репортёр отвечает только за
  состояние синхронизации и не знает про файлы.
- В `getStatuses` поле добавляется при сборке:

```ts
sizeBytes: revision
  ? revision.files.reduce((sum, file) => sum + file.size, 0)
  : null,
```

Дополнительных запросов к БД нет: `files` уже в выборке.

### 6.3. Сервер: каталог workshop

`packages/server/src/scripting-packages/workshop/package-workshop.service.ts`.
В латеральный подзапрос `WORKSHOP_SELECT` добавляется сумма:

```sql
SELECT revision, "publishedAt",
       COALESCE((SELECT SUM((f->>'size')::bigint)
                 FROM jsonb_array_elements(files) AS f), 0) AS "sizeBytes"
FROM scripting_package_revision
WHERE "packageId" = p.id AND status = 'published'
  AND "publishedAt" IS NOT NULL
ORDER BY revision DESC
LIMIT 1
```

- `WorkshopRow.sizeBytes: string` — Postgres отдаёт `bigint` строкой, как и
  уже существующий `total`.
- `toSummary` кладёт `sizeBytes: Number(row.sizeBytes)`.
- `LIST_SQL`, `LOOKUP_SQL` и `SUMMARY_SQL` собираются из `WORKSHOP_SELECT`,
  поэтому правка одна и покрывает список, точечный поиск и результат
  публикации.

### 6.4. Фронтенд

- `room-packages/model.ts`: `RoomPackageEntry.sizeBytes: number | null`.
  `buildEntries` берёт `remoteState?.sizeBytes ?? null`.
- Новый чистый хелпер `frontend/src/utils/format-file-size.ts`:
  `formatFileSize(bytes: number): { value: number; unit: "kb" | "mb" }`.
  Порог — 1 МиБ (1 048 576 байт); хелпер не округляет, `next-intl`
  рендерит число с максимум одной цифрой после запятой.
  Для 0 байт возвращает `{ value: 0, unit: "kb" }`.
- `PackagesTab.tsx`, `PackageCard`: в строке метаданных после опубликованной
  ревизии, если `entry.sizeBytes !== null`:

```tsx
<span>
  {t(unit === "kb" ? "card.sizeKb" : "card.sizeMb", {
    value: numberFormat.number(value, { maximumFractionDigits: 1 }),
  })}
</span>
```

где `numberFormat = useFormatter()` из `next-intl`. Порядок в строке:
`версия 0.1.0 · опубликована ревизия 2 · 1,4 МБ`. Если опубликованной
ревизии нет, размер не показывается.

- Ключи в `frontend/messages/{ru,en}.json`:
  - `Packages.card`: ru `"sizeKb": "· {value} КБ"`, `"sizeMb": "· {value} МБ"`;
    en `"sizeKb": "· {value} KB"`, `"sizeMb": "· {value} MB"`.
- `frontend/src/components/packages/WorkshopBrowser.tsx`,
  `WorkshopPackageCard`: размер выводится в строке метаданных после ревизии,
  тем же `useFormatter()` и `formatFileSize`. Точка не нужна — элементы
  строки уже разделены `gap`. Компонент общий, поэтому размер появляется и
  на главной, и в диалоге комнаты.
- Ключи `Workshop` в тех же файлах (без ведущей точки):
  ru `"sizeKb": "{value} КБ"`, `"sizeMb": "{value} МБ"`;
  en `"sizeKb": "{value} KB"`, `"sizeMb": "{value} MB"`.

### 6.5. Тесты

- `package-sync.service.spec.ts`: `getStatuses` возвращает сумму размеров
  файлов последней опубликованной ревизии; `null`, когда опубликованных
  ревизий нет; черновики не учитываются.
- `package-workshop.service.spec.ts`: SQL листинга содержит сумму по
  `jsonb_array_elements(files)`; `toSummary` отдаёт `sizeBytes` числом.
- `PackagesTab.test.tsx`: карточка показывает `1.4 MB` для
  `sizeBytes: 1_468_006` и `500 KB` для `512_000` (тестовая локаль — en);
  при `sizeBytes: null` размер не рендерится.
- `WorkshopBrowser.test.tsx`: карточка каталога показывает `1,4 МБ` (ru) и
  `1.4 MB` (en) для `sizeBytes: 1_468_006`.
- `format-file-size.test.ts`: порог КБ/МБ, округление, ноль.

## 7. Риски

- `files` — `jsonb`, но `PackageFileEntry.size` обязателен, а published
  ревизия проходит проверку файлов на диске; отдельная обработка битых
  данных не нужна.
- Стоимость опроса не меняется: сумма считается по уже загруженным строкам.
- В workshop `SUM` возвращает `bigint`, который драйвер отдаёт строкой;
  `Number(...)` безопасен для реальных размеров пакета. Пустая ревизия даёт
  `COALESCE(..., 0)`, то есть `0`, а не `null`.

## 8. Что остаётся на усмотрение билдера

- Точное имя/расположение хелпера и функция округления (одна цифра после
  запятой, без принудительного `.0`).
- Показывать ли `0 КБ` для опубликованного пустого пакета — да, это
  осмысленный размер; `null` означает «нечего показывать».
- В workshop `0` для пустой ревизии показывается как `0 КБ`: ревизия там
  всегда опубликована, поэтому скрывать нечего.
