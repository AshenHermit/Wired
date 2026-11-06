# Удаление Phaser-режима — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полностью удалить Phaser-режим (`ts-game`) из Wired, сохранив работоспособность Godot-режима и доступ к старым комнатам.

**Architecture:** Удаляем Phaser-путь целиком: фронтенд-редактор, серверный headless-движок и socket.io-гейтвей, игровую часть `shared`, пакеты `client`/`playground`/`box2d`. `ts-game` остаётся только legacy-значением `Room.type` в БД. API и UI создают только `godot`.

**Tech Stack:** Next.js 16, NestJS 11, TypeORM/Postgres, pnpm workspaces, TypeScript, Jest.

**Spec:** `docs/superpowers/specs/2026-10-28-remove-phaser-design.md`

## Global Constraints

- `DB_SYNC=1`: enum `room.type` не сужаем; `GAME_ROOMS_TYPES = ["godot", "ts-game"]`.
- Создавать комнаты можно только с `type = "godot"` (`AVAILABLE_GAME_ROOMS_TYPES`).
- Дефолт `Room.type` — `"godot"`.
- `NEXT_PUBLIC_WEBSOCKET_URL` и `HASH_ID_SECRET` не меняем: от env зависит хеш ID комнат.
- Godot-модули, `godot_editor`, `godot_project`, `scripting-packages` не меняем.
- Работаем в отдельной ветке; каждый task — отдельный коммит.

## Review Focus

- Создание комнаты из UI отправляет `type: "godot"`, а не `"ts-game"`.
- Открытие старой `ts-game` комнаты не импортирует удалённый код и показывает сообщение.
- Редактирование старой `ts-game` комнаты не падает на валидации и не меняет её тип.
- Godot-редактор загружается после удаления webpack-обвязки box2d и socket.io-адаптера.
- Сервер стартует без `canvas`, `jsdom`, `phaser` и shim'а `XMLHttpRequest`.

---

### Task 1: Общий контракт `shared`

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/api/types.ts`
- Delete: `packages/shared/src/game/`, `packages/shared/src/networking/`, `packages/shared/src/scripting/`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/tsconfig.json`

**Interfaces:**
- Produces: `AVAILABLE_GAME_ROOMS_TYPES = ["godot"] as const`; `GameRoomsType`, `GAME_ROOMS_TYPES`, `Room`, `ProjectInfo` остаются.

- [ ] **Step 1: Добавить список создаваемых типов**

В `packages/shared/src/api/types.ts` после `GAME_ROOMS_TYPES`:

```ts
// ts-game оставлен только для чтения старых комнат.
export const AVAILABLE_GAME_ROOMS_TYPES = ["godot"] as const;
```

- [ ] **Step 2: Оставить в индексе только API-типы**

`packages/shared/src/index.ts`:

```ts
export * from "./api/types";
```

- [ ] **Step 3: Удалить Phaser-код и обновить пакет**

```powershell
git rm -r packages/shared/src/game packages/shared/src/networking packages/shared/src/scripting
Remove-Item -Recurse -Force packages/shared/dist -ErrorAction SilentlyContinue
```

В `packages/shared/package.json` удалить блок `dependencies`; оставить `scripts` и `devDependencies.typescript`.
В `packages/shared/tsconfig.json` убрать `"../client/src/networking/ServerAPI.ts"` из `include` и весь блок `paths` с `@box2d`.

- [ ] **Step 4: Пересобрать декларации**

Run: `pnpm --filter shared build:types`
Expected: успех; `packages/shared/dist/types` содержит только `index.d.ts` и `api/types.d.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "refactor(shared): remove Phaser game code"
```

---

### Task 2: Сервер без Phaser

**Files:**
- Create: `packages/server/src/rooms/dto/create-room.dto.spec.ts`
- Modify: `packages/server/src/rooms/dto/create-room.dto.ts`
- Modify: `packages/server/src/database/entities/room.entity.ts:59`
- Modify: `packages/server/src/main.ts`
- Modify: `packages/server/src/app.module.ts`
- Delete: `packages/server/src/ts-game/`, `packages/server/src/websocket/`, `packages/server/src/types/`, `packages/server/src/utils/fakeXMLHttpRequest.ts`
- Modify: `packages/server/package.json`
- Modify: `packages/server/tsconfig.json`
- Modify: `backend.Dockerfile`

**Interfaces:**
- Consumes: `AVAILABLE_GAME_ROOMS_TYPES` из Task 1.
- Produces: `CreateRoomDto` принимает только `godot`; `Room.type` по умолчанию `godot`.

- [ ] **Step 1: Написать падающий тест DTO**

`packages/server/src/rooms/dto/create-room.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRoomDto } from './create-room.dto';

async function typeErrors(type: string) {
  const dto = plainToInstance(CreateRoomDto, {
    name: 'Room',
    authorId: 1,
    type,
  });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'type');
}

describe('CreateRoomDto', () => {
  it('accepts godot', async () => {
    expect(await typeErrors('godot')).toHaveLength(0);
  });

  it('rejects legacy ts-game', async () => {
    expect(await typeErrors('ts-game')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter server exec jest create-room.dto.spec.ts`
Expected: FAIL — `rejects legacy ts-game` получает 0 ошибок.

- [ ] **Step 3: Ограничить DTO и дефолт комнаты**

В `create-room.dto.ts` импортировать `AVAILABLE_GAME_ROOMS_TYPES`, поставить `example: 'godot'`, `enum: AVAILABLE_GAME_ROOMS_TYPES`, `@IsEnum(AVAILABLE_GAME_ROOMS_TYPES)`; тип поля оставить `GameRoomsType`.
В `room.entity.ts:59` заменить `default: 'ts-game'` на `default: 'godot'`.

- [ ] **Step 4: Прогнать тест**

Run: `pnpm --filter server exec jest create-room.dto.spec.ts`
Expected: PASS, 2 теста.

- [ ] **Step 5: Удалить Phaser-модули и их подключение**

```powershell
git rm -r packages/server/src/ts-game packages/server/src/websocket packages/server/src/types
git rm packages/server/src/utils/fakeXMLHttpRequest.ts
```

В `main.ts` удалить строки 1–2, 7–8, 10, импорт `IoAdapter` и `app.useWebSocketAdapter(...)`.
В `app.module.ts` удалить импорты и записи `GameModule`, `WebsocketModule`, `TypesModule`.

- [ ] **Step 6: Вычистить зависимости и пути**

`packages/server/package.json` — удалить:
`@box2d`, `@geckos.io/phaser-on-nodejs`, `canvas`, `jsdom`, `phaser`, `react`, `react-dom`, `xmlhttprequest`, `easy-event-emitter`, `socket.io`, `@nestjs/platform-socket.io`, `@nestjs/websockets`; devDeps: `@types/jsdom`, `@types/react`, `@types/react-dom`.
`packages/server/tsconfig.json` — удалить path `@box2d`.
`backend.Dockerfile` — удалить `COPY .../packages/box2d/build ...` и комментарии про canvas.

- [ ] **Step 7: Собрать сервер**

Run: `pnpm build:server`
Expected: успех, без ошибок про удалённые модули.

- [ ] **Step 8: Commit**

```bash
git add packages/server backend.Dockerfile
git commit -m "refactor(server): remove Phaser runtime and gateway"
```

---

### Task 3: Фронтенд — только Godot

**Files:**
- Modify: `frontend/src/app/room/[room_code]/page-client.tsx`
- Delete: `frontend/src/app/room/[room_code]/(ts-game)/`, `frontend/src/icons/phaser_logo.tsx`, `frontend/src/api/services/getTypes.ts`
- Modify: `frontend/src/app/(browser)/_components/rooms.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/PackagesList.tsx:13`
- Modify: `frontend/tsconfig.json`
- Modify: `frontend/package.json`
- Modify: `frontend/next.config.ts`

**Interfaces:**
- Consumes: `Room` из `@wired-io/shared`; `AVAILABLE_GAME_ROOMS_TYPES` не обязателен здесь — тип при создании фиксирован `"godot"`.
- Produces: `/room/[room_code]` рендерит `GodotRoomPageClient` для `godot` и заглушку для `ts-game`.

- [ ] **Step 1: Удалить Phaser-редактор и сервис типов**

```powershell
git rm -r "frontend/src/app/room/[room_code]/(ts-game)"
git rm frontend/src/icons/phaser_logo.tsx frontend/src/api/services/getTypes.ts
```

- [ ] **Step 2: Обновить страницу комнаты**

В `page-client.tsx` убрать импорт `TSRoomPageClientNoSSR`; вместо ветки `ts-game` вернуть заглушку, затем безусловно `GodotRoomPageClient`:

```tsx
if (room.type === "ts-game") {
  return (
    <div className="w-screen h-screen flex items-center justify-center p-8 text-center">
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold">
          Phaser rooms are no longer supported
        </h1>
        <p className="text-muted-foreground">
          This room uses the retired ts-game mode. Create a new Godot room to
          continue.
        </p>
      </div>
    </div>
  );
}
return <GodotRoomPageClient room={room} />;
```

- [ ] **Step 3: Убрать выбор типа из формы комнаты**

В `rooms.tsx`:
- убрать импорты `GAME_ROOMS_TYPES`, `GameRoomsType`, `PhaserLogo`, `GodotLogo`, `Tabs*`, `cn`, `Controller`;
- `RoomEditingFields` оставить только `name` и `description`;
- из `defaultValues` и `reset` убрать `type`;
- при создании вызывать `createRoom({ ...data, type: "godot", authorId: user.id })`;
- удалить JSX-блок `Game Type` и компонент `GameTypeSelect`;
- `updateRoomCb` отправляет только `name`/`description`, поэтому legacy-комната не меняет тип.

- [ ] **Step 4: Убрать следы в Godot-пакетах и конфигах**

Удалить строку `// import { FileCard } from "../(ts-game)/Editor";` в `PackagesList.tsx`.
В `frontend/tsconfig.json` удалить paths `@wired-io/client` и `@box2d`.
В `frontend/package.json` удалить `@box2d`, `@monaco-editor/react`, `just-debounce-it`.
В `next.config.ts` удалить импорт `path` и весь блок `webpack`.

- [ ] **Step 5: Проверить типы и сборку**

Run: `pnpm check-types:frontend`
Expected: PASS.
Run: `pnpm --filter frontend build`
Expected: PASS; Godot-страница собирается.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "refactor(frontend): remove Phaser editor, keep Godot"
```

---

### Task 4: Удалить вспомогательные пакеты

**Files:**
- Delete: `packages/client/`, `packages/box2d/`, `playground/`, `test_scripts/cat_player.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

- [ ] **Step 1: Удалить пакеты и пример**

```powershell
git rm -r packages/client packages/box2d playground
git rm test_scripts/cat_player.ts
```

- [ ] **Step 2: Обновить workspace и скрипты**

В `pnpm-workspace.yaml` оставить `packages/*` и `frontend`.
В корневом `package.json` удалить `dev:client`, `dev:playground` и весь блок `pnpm` с `onlyBuiltDependencies`.

- [ ] **Step 3: Обновить lockfile**

Run: `pnpm install --lockfile-only`
Expected: `pnpm-lock.yaml` обновлён, ошибок нет.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore: remove Phaser client, playground and box2d packages"
```

---

### Task 5: Финальная проверка

- [ ] **Step 1: Проверить отсутствие Phaser-кода**

Run: `git grep -I -i -E "phaser|@geckos|@box2d|@wired-io/client" -- . ':!pnpm-lock.yaml' ':!docs'`
Expected: пусто (бинарные файлы и lockfile исключены).

Run: `git grep -n "ts-game"`
Expected: только `GAME_ROOMS_TYPES`, комментарий legacy, заглушка в `page-client.tsx` и тест DTO.

- [ ] **Step 2: Прогнать тесты и сборки**

Run: `pnpm --filter server test`
Run: `pnpm build:server`
Run: `pnpm check-types:frontend`
Run: `pnpm --filter frontend build`
Expected: всё PASS.

- [ ] **Step 3: Ручной сценарий**

1. Создать комнату в UI → в БД `type = 'godot'`, открывается Godot-редактор.
2. Открыть старую `ts-game` комнату → сообщение «Phaser rooms are no longer supported», без ошибок в консоли.
3. Отредактировать старую `ts-game` комнату (имя/описание) → сохранение проходит, `type` остаётся `ts-game`.
4. Загрузить Godot-проект и пакеты → работает как до изменений.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: verify Phaser removal"
```
