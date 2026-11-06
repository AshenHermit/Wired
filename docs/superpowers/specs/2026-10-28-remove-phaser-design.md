# Отказ от Phaser-режима

Дата: 2026-10-28

## Зачем

Платформа Wired изначально работала на Phaser (`ts-game`), затем появился Godot.
Сейчас поддерживается только Godot, а Phaser-режим остаётся мёртвым грузом:
отдельный редактор, headless-сервер, WebSocket-гейтвей, Monaco-типизация и
тяжёлые зависимости. Нужно удалить его, не затронув Godot-редактор, комнаты,
пакеты, авторизацию и работу с БД.

## Цели

- В репозитории не остаётся кода, зависимостей и пакетов, относящихся к Phaser.
- Godot-режим работает как раньше: редактор, загрузка проекта, создание комнат.
- Старые комнаты с `type = 'ts-game'` остаются в БД и открываются с понятным
  сообщением, что режим отключён.
- Сборка, типизация и линт проходят.

## Не-цели

- Не переделываем Godot-редактор и его интеграцию.
- Не удаляем и не мигрируем данные комнат/пакетов в Postgres.
- Не меняем авторизацию, CRUD комнат и пакетов.
- Не трогаем `NEXT_PUBLIC_WEBSOCKET_URL`: от него фактически зависит
  `HASH_ID_SECRET` (хеш ID комнат), хотя это выглядит как ошибка. Если убрать
  переменную, сломаются существующие ссылки на комнаты.

## Ограничения

- `DB_SYNC=1` в окружении. Поэтому enum `room.type` в БД **не сужаем**:
  `GAME_ROOMS_TYPES` остаётся `["godot", "ts-game"]`, иначе TypeORM при
  синхронизации может упасть на существующих строках.
- `@wired-io/shared/src/api/types.ts` — общий контракт фронтенда и сервера,
  он остаётся.

## Подход

Удалить Phaser-путь целиком. `ts-game` сохраняется только как legacy-значение
типа комнаты:

- `GAME_ROOMS_TYPES` — значения, допустимые в БД (оба).
- `AVAILABLE_GAME_ROOMS_TYPES = ["godot"]` — значения, которые можно создать
  через API/UI.
- Дефолт комнаты меняется с `ts-game` на `godot`.

## Изменения

### frontend

- Удалить `src/app/room/[room_code]/(ts-game)/`.
- Удалить `src/icons/phaser_logo.tsx`.
- Удалить `src/api/services/getTypes.ts` (использовался только Monaco-редактором
  ts-game).
- `src/app/room/[room_code]/page-client.tsx`: убрать импорт ts-game; для
  `room.type === "ts-game"` показывать заглушку, иначе `GodotRoomPageClient`.
- `src/app/(browser)/_components/rooms.tsx`: убрать `GameTypeSelect`, импорт
  PhaserLogo и поле «Game Type»; форма создаёт комнаты с `type: "godot"`,
  валидация по `AVAILABLE_GAME_ROOMS_TYPES`.
- `src/app/room/[room_code]/(godot)/PackagesList.tsx`: убрать закомментированный
  импорт из `(ts-game)`.
- `tsconfig.json`: убрать paths `@wired-io/client` и `@box2d`.
- `package.json`: убрать `@box2d`.
- `next.config.ts`: убрать webpack-обвязку под box2d (она больше не нужна).

### server

- Удалить `src/ts-game/`, `src/websocket/`, `src/types/`,
  `src/utils/fakeXMLHttpRequest.ts`.
- `src/main.ts`: убрать импорт `@geckos.io/phaser-on-nodejs` и подмену
  `XMLHttpRequest`.
- `src/app.module.ts`: убрать `GameModule`, `WebsocketModule`, `TypesModule`.
- `src/database/entities/room.entity.ts`: `default: 'godot'`, enum оставить общий.
- `src/rooms/dto/create-room.dto.ts`: пример `godot`, валидация по
  `AVAILABLE_GAME_ROOMS_TYPES`.
- `package.json`: убрать `@box2d`, `@geckos.io/phaser-on-nodejs`, `canvas`,
  `jsdom`, `phaser`, `react`, `react-dom`, `xmlhttprequest`, `@types/jsdom`,
  `@types/react`, `@types/react-dom`.
- `tsconfig.json`: убрать path `@box2d`.
- `backend.Dockerfile`: убрать копирование `packages/box2d/build` и комментарий
  про canvas.

### shared

- Оставить `src/api/types.ts`; удалить `src/game/`, `src/networking/`,
  `src/scripting/`.
- `src/index.ts` экспортирует только `./api/types`.
- `package.json`: убрать все зависимости, использовавшиеся игровым кодом.
- `tsconfig.json`: убрать include `../client/...` и path `@box2d`.

### Удаляемые пакеты и скрипты

- `packages/client/`
- `playground/`
- `packages/box2d/`
- `test_scripts/cat_player.ts`
- root `package.json`: скрипты `dev:client`, `dev:playground`; настройка
  `pnpm.onlyBuiltDependencies.canvas`.

### Инфраструктура

- `pnpm-workspace.yaml`: убрать `playground`.
- Обновить `pnpm-lock.yaml` после удаления пакетов.
- `docker-compose.yml` и `frontend.Dockerfile`: `NEXT_PUBLIC_WEBSOCKET_URL`
  оставляем (см. ограничения).

## Проверка

1. `git grep -i phaser` — совпадений нет (кроме истории git).
2. `git grep -n "@wired-io/client\|@box2d\|ts-game"` — только legacy-значения
   типа, заглушка и комментарии.
3. `pnpm check-types:frontend`.
4. `pnpm build:server`.
5. `pnpm --filter frontend build`.
6. Ручная проверка: создать комнату → открывается Godot-редактор; открыть
   старую ts-game комнату → сообщение об отключённом режиме.
