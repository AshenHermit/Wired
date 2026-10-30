# Динамическая доставка пакетов в Godot: этапы 7–10

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Доставлять опубликованные пакеты в Godot-рантайм и Web-клиент без перезапуска проекта, с серверным переписыванием путей, подписанными read-only URL, генерацией текстур/аудио и пересозданием живых веток сцен с сохранением export-переменных корня.

**Architecture:** Опубликованные ревизии остаются неизменяемым источником для редактора. Сервер собирает отдельный runtime-артефакт на комнату: переписывает `res://packages/<id>/...` в точные `user://wired/rooms/<room>/packages/<id>/<revision>/...`, считает хеши уже переписанных файлов и выдаёт короткоживущий HMAC-токен на чтение. Godot рекурсивно скачивает runtime-манифесты зависимостей, проверяет хеши, генерирует локальные `ImageTexture`/`AudioStream` и `.import`, а затем `PackageReloader` пересоздаёт только затронутые корни сцен. Web получает same-origin API base от хоста; headless продолжает использовать `--api-url`.

**Tech Stack:** NestJS 11, TypeORM/Postgres, Jest, общие типы `@wired-io/shared`, Godot 4.5 GDScript, Next.js/React 19, Vitest.

**Spec:** `docs/superpowers/plans/2026-10-28-godot-multiplayer-foundation.md` (нерешённые вопросы 3–4), `docs/superpowers/specs/2026-10-30-godot-packages-stage6.md`.

## Global Constraints

- Целевая версия Godot — 4.5.x. Проверенная матрица: editor 4.5.1, native release 4.5.0, Web export 4.5.1.
- Поддерживаются только текстовые `.gd`, `.tscn`, `.tres`; raw-изображения (`png`, `jpg`, `jpeg`, `webp`, `bmp`) и аудио (`wav`, `ogg`, `mp3`) конвертируются в runtime-ресурсы.
- Не использовать `.ctex`, `.remap`, editor `.import` из пакета и `ResourceSaver.FLAG_BUNDLE_RESOURCES` для `user://`. Это проверенно не работает в 4.5.x.
- Сервер переписывает только текст. Бинарные файлы копируются байт-в-байт; невалидный UTF-8 в текстовом файле — ошибка сборки артефакта.
- Публикуемые пакеты пока публичны. Клиент не получает прав на запись, публикацию, удаление или изменение пакетов. Все write-маршруты остаются на JWT + `assertPackageEditing`.
- Runtime-токен — только чтение, TTL по умолчанию 900 секунд, привязка к `roomId`, `packageId`, `revision`. Секрет: `WIRED_PACKAGE_READ_SECRET`, fallback `WIRED_GAME_TICKET_SECRET`; секрет никогда не уходит в браузер.
- Ссылка на пакет из другой комнаты запрещена. Глобальный пакет (`room == null`) можно использовать как библиотеку. Циклы зависимостей запрещены.
- Runtime хранит не более двух ревизий каждого пакета: текущую и предыдущую. Старые ссылки глубже двух ревизий — документированное ограничение v1.
- Пересоздание сцены сохраняет export-переменные корня, имя и transform. Дочернее состояние и внешние ссылки сбрасываются.
- Autoload, глобальные `class_name` и регистрации на старте не горячо перезагружаются: для них нужен перезапуск runtime.
- Существующие raw-маршруты `GET /:id/manifest` и `GET /:id/revisions/:rev/files/*path` не меняются: редактор продолжает работать с исходными файлами.
- Лимиты пакета не меняются: 2000 файлов, 64 МБ на файл, 256 МБ суммарно.
- Server Prettier: single quotes, trailing commas. Conventional Commits. Русские UI-строки и документация — UTF-8.
- Не менять enum `GAME_ROOMS_TYPES` и не трогать legacy `ts-game`.
- После изменений frontend выполнять `pnpm check-types:frontend`; после server — `pnpm --filter server build`.

## Review Focus

- Пакет ссылается на неопубликованную, чужую или отсутствующую зависимость, либо образует цикл: runtime-манифест обязан вернуть понятную 4xx-ошибку и не отдать частичный артефакт.
- Переписывание портит `.tscn`/`.tres`/`.gd`: uid, кавычки, относительные пути или невалидный UTF-8. Бинарные файлы и сцены вне пакетов должны остаться нетронутыми.
- Кеш артефакта отдаёт старые байты после публикации зависимости. Ключ кеша обязан включать ревизии всего замыкания, а рантайм — сравнивать зависимости, а не только номер ревизии корня.
- Горячая перезагрузка теряет состояние или дублирует узлы: при ошибке инстанцирования старый корень остаётся, а одно изменение не должно перезагружать сцену дважды.
- Подписанный URL переиспользуется для другой комнаты/пакета/ревизии, истекает или позволяет выйти за пределы артефакта через `..`.
- Web-клиент снова обращается к `127.0.0.1:3000`, потому что хост не передал API base.

---

## Структура файлов

- `packages/shared/src/api/types.ts` — публичный контракт runtime-манифеста.
- `packages/server/src/config/{config.ts,config.interface.ts}` — секрет и TTL чтения пакетов.
- `packages/server/src/scripting-packages/package-read-url.service.ts` — HMAC-токены.
- `packages/server/src/scripting-packages/package-runtime-references.ts` — чистые функции разбора/переписывания/зависимостей сцен.
- `packages/server/src/scripting-packages/package-delivery.service.ts` — сборка runtime-артефактов и поиск зависимых пакетов.
- `packages/server/src/scripting-packages/package-delivery.module.ts` — провайдеры доставки.
- `packages/server/src/scripting-packages/scripting-packages.controller.ts` — runtime-маршруты.
- `packages/server/src/godot-game/package-sync.service.ts` — повторная отправка зависимых пакетов.
- `frontend/src/app/room/[room_code]/(godot)/game-bridge.ts` — `apiBase` в configure-payload.
- `frontend/src/app/room/[room_code]/(godot)/GameTab.tsx` — same-origin API base.
- `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd` — рекурсивная синхронизация, производные ресурсы, метаданные сцен.
- `packages/server/godot_project/_wired/_wired/scripts/global/package_reloader.gd` — пересоздание корней сцен.
- `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd` — wiring reloader и API base.
- `packages/server/godot_project/_wired/_wired/web/shell.html` — проверка same-origin `apiBase` из host bridge.
- `packages/server/godot_project/_wired/tests/` — headless smoke-тесты GDScript.
- `docs/superpowers/specs/2026-10-30-godot-package-runtime-delivery.md` — итоговая матрица и ограничения.

---

### Задача 1: Контракт runtime-манифеста, конфиг и подписанные read URL

**Files:**
- Modify: `packages/shared/src/api/types.ts`
- Modify: `packages/server/src/config/config.interface.ts`
- Modify: `packages/server/src/config/config.ts`
- Modify: `packages/server/src/config/config.spec.ts`
- Create: `packages/server/src/scripting-packages/package-read-url.service.ts`
- Test: `packages/server/src/scripting-packages/package-read-url.service.spec.ts`

**Interfaces:**
- Consumes: существующие `PackageFileEntry`, `AppConfigService`.
- Produces:
  - `PackageRuntimeDependency = { packageId: number; revision: number; name: string }`
  - `PackageRuntimeManifest = { packageId; name; revision; roomId; publishedAt; files: PackageFileEntry[]; totalSize; dependencies: PackageRuntimeDependency[]; sceneDependencies: Record<string,string[]>; download: { token: string; expiresAt: number } }`
  - `PackageReadUrlService.createToken(subject, nowSec?): { token: string; expiresAt: number }`
  - `PackageReadUrlService.verifyToken(token, subject, nowSec?): boolean`
  - `AppConfig.packages.readSecret: string`, `AppConfig.packages.readTtlSec: number`

- [ ] **Step 1: Добавить типы в shared**

После `PackageManifest` добавить:

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
  /** scene filepath -> "<packageId>:<filepath>" dependencies, including itself */
  sceneDependencies: Record<string, string[]>;
  download: { token: string; expiresAt: number };
};
```

- [ ] **Step 2: Написать падающий тест сервиса токенов**

```ts
import { ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { PackageReadUrlService } from './package-read-url.service';

const config = (secret: string, ttl = 900) =>
  ({ packages: { readSecret: secret, readTtlSec: ttl } }) as AppConfigService;

describe('PackageReadUrlService', () => {
  const subject = { roomId: 7, packageId: 42, revision: 3 };

  it('creates a token bound to room/package/revision and rejects expiry', () => {
    const service = new PackageReadUrlService(config('read-secret'));
    const { token, expiresAt } = service.createToken(subject, 1_000);
    expect(expiresAt).toBe(1_900);
    expect(service.verifyToken(token, subject, 1_899)).toBe(true);
    expect(service.verifyToken(token, subject, 1_900)).toBe(false);
  });

  it('rejects a token used for another room, package or revision', () => {
    const service = new PackageReadUrlService(config('read-secret'));
    const { token } = service.createToken(subject, 1_000);
    expect(service.verifyToken(token, { ...subject, roomId: 8 }, 1_001)).toBe(false);
    expect(service.verifyToken(token, { ...subject, packageId: 43 }, 1_001)).toBe(false);
    expect(service.verifyToken(token, { ...subject, revision: 4 }, 1_001)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const service = new PackageReadUrlService(config('read-secret'));
    const { token } = service.createToken(subject, 1_000);
    const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expect(service.verifyToken(tampered, subject, 1_001)).toBe(false);
  });

  it('fails closed when the read secret is missing', () => {
    const service = new PackageReadUrlService(config(''));
    expect(() => service.createToken(subject, 1_000)).toThrow(
      ServiceUnavailableException,
    );
  });
});
```

- [ ] **Step 3: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter server exec jest package-read-url.service.spec`
Expected: FAIL — модуль/класс не найден.

- [ ] **Step 4: Добавить конфиг**

В `config.interface.ts`:

```ts
packages: {
  readSecret: string;
  readTtlSec: number;
};
```

В `config.ts`:

```ts
packages: {
  readSecret:
    process.env.WIRED_PACKAGE_READ_SECRET ??
    process.env.WIRED_GAME_TICKET_SECRET ??
    '',
  readTtlSec: intFromEnv('WIRED_PACKAGE_READ_TTL_SEC', 900),
},
```

Добавить в `config.spec.ts` проверку, что env `WIRED_PACKAGE_READ_SECRET` и `WIRED_PACKAGE_READ_TTL_SEC` попадают в `config().packages` (с восстановлением env после теста).

- [ ] **Step 5: Реализовать `PackageReadUrlService`**

```ts
export type PackageReadSubject = {
  roomId: number;
  packageId: number;
  revision: number;
};

@Injectable()
export class PackageReadUrlService {
  constructor(private readonly configService: AppConfigService) {}

  createToken(
    subject: PackageReadSubject,
    nowSec = Math.floor(Date.now() / 1000),
  ): { token: string; expiresAt: number };

  verifyToken(
    token: string,
    subject: PackageReadSubject,
    nowSec = Math.floor(Date.now() / 1000),
  ): boolean;
}
```

Правила:
- `secret = configService.packages.readSecret`; пустой секрет → `ServiceUnavailableException('package_read_secret_missing')`.
- `expiresAt = nowSec + configService.packages.readTtlSec`.
- Сообщение HMAC: `package-read:v1:<roomId>:<packageId>:<revision>:<expiresAt>`.
- Токен: `` `${expiresAt}.${hmacSha256Hex(secret, message)}` ``.
- Проверка: формат, `expiresAt > nowSec`, пересчёт HMAC, сравнение через `timingSafeEqual` по буферам одинаковой длины; любая ошибка → `false`, не бросать.
- Не логировать токен.

- [ ] **Step 6: Запустить тест**

Run: `pnpm --filter server exec jest package-read-url.service.spec`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/api/types.ts \
  packages/server/src/config/config.ts \
  packages/server/src/config/config.interface.ts \
  packages/server/src/config/config.spec.ts \
  packages/server/src/scripting-packages/package-read-url.service.ts \
  packages/server/src/scripting-packages/package-read-url.service.spec.ts
git commit -m "feat(packages): add signed runtime read urls"
```

---

### Задача 2: Чистые функции разбора и переписывания ссылок

**Files:**
- Create: `packages/server/src/scripting-packages/package-runtime-references.ts`
- Test: `packages/server/src/scripting-packages/package-runtime-references.spec.ts`

**Interfaces:**
- Consumes: `PackageFileEntry` не нужен; на вход идут `Buffer` и текст.
- Produces:
  - `PackageTextFile = { filepath: string; text: string }`
  - `PackageFileReference = { packageId: number; filepath: string }`
  - `isTextPackageFile(filepath: string): boolean`
  - `decodePackageText(filepath: string, data: Buffer): string`
  - `collectPackageReferences(text: string): PackageFileReference[]`
  - `rewritePackageReferences(text, { roomId, revisionByPackage }): string`
  - `stripExtResourceUids(filepath: string, text: string): string`
  - `buildSceneDependencies(packageId, files, dependencies): Record<string, string[]>`

- [ ] **Step 1: Написать падающие тесты**

```ts
import {
  buildSceneDependencies,
  collectPackageReferences,
  decodePackageText,
  rewritePackageReferences,
  stripExtResourceUids,
} from './package-runtime-references';

describe('package runtime references', () => {
  it('collects absolute package references', () => {
    expect(
      collectPackageReferences(
        'const A = preload("res://packages/5/lib/a.gd")\n' +
          '[ext_resource path="res://packages/6/tex.png" type="Texture2D"]',
      ),
    ).toEqual([
      { packageId: 5, filepath: 'lib/a.gd' },
      { packageId: 6, filepath: 'tex.png' },
    ]);
  });

  it('rewrites every package prefix to the pinned runtime revision', () => {
    const revisions = new Map([[5, 3], [6, 9]]);
    expect(
      rewritePackageReferences(
        'preload("res://packages/5/lib/a.gd") + "res://packages/6/tex.png"',
        { roomId: 7, revisionByPackage: revisions },
      ),
    ).toBe(
      'preload("user://wired/rooms/7/packages/5/3/lib/a.gd") + ' +
        '"user://wired/rooms/7/packages/6/9/tex.png"',
    );
  });

  it('strips uid only from ext_resource lines', () => {
    const text =
      '[gd_scene load_steps=2 format=3 uid="uid://scene"]\n' +
      '[ext_resource type="Script" uid="uid://script" path="a.gd" id="1"]\n';
    const rewritten = stripExtResourceUids('main.tscn', text);
    expect(rewritten).toContain('uid="uid://scene"');
    expect(rewritten).not.toContain('uid="uid://script"');
  });

  it('rejects invalid UTF-8 in text files', () => {
    expect(() => decodePackageText('x.gd', Buffer.from([0xff, 0xfe]))).toThrow(
      'package_text_not_utf8:x.gd',
    );
  });

  it('builds transitive same-package and cross-package scene dependencies', () => {
    const files = [
      {
        filepath: 'main.tscn',
        text:
          '[ext_resource type="Script" path="scripts/hero.gd" id="1"]\n' +
          '[ext_resource type="Texture2D" path="res://packages/6/tex.png" id="2"]',
      },
      {
        filepath: 'scripts/hero.gd',
        text: 'const Util = preload("res://packages/5/lib/util.gd")',
      },
      { filepath: 'lib/util.gd', text: 'extends Node' },
    ];
    const dependencies = new Map([
      [6, [{ filepath: 'tex.png', text: 'binary-placeholder' }]],
    ]);
    expect(buildSceneDependencies(5, files, dependencies)).toEqual({
      'main.tscn': [
        '5:main.tscn',
        '5:scripts/hero.gd',
        '5:lib/util.gd',
        '6:tex.png',
      ],
    });
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter server exec jest package-runtime-references.spec`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать функции**

Правила:
- `isTextPackageFile`: расширение `.tscn`, `.tres`, `.gd` (case-insensitive).
- `decodePackageText`: `new TextDecoder('utf-8', { fatal: true }).decode(data)`; при ошибке бросить `Error('package_text_not_utf8:<filepath>')`.
- `collectPackageReferences`: искать только внутри строковых литералов: `(["'])res:\/\/packages\/(\d+)\/([^"'\r\n]+)\1`; нормализовать `path.posix.normalize`, убрать ведущий `/`, отбросить пустой путь, вернуть уникальные пары в порядке появления. Комментарии и произвольный текст не должны создавать зависимости.
- `rewritePackageReferences`: заменять `res://packages/<id>/` на `user://wired/rooms/<roomId>/packages/<id>/<revision>/`. Если для встреченного `<id>` нет ревизии в map — бросить `Error('package_reference_not_rewritable:<id>')`.
- `stripExtResourceUids`: только строки, чей trimmed-вариант начинается с `[ext_resource`; удалить один атрибут ` uid="..."`.
- `buildSceneDependencies`: для каждого `.tscn` в `files` построить DFS по цитируемым путям и абсолютным `res://packages/<id>/...`. Относительные пути разрешать от каталога текущего файла. Включать сам scene-key `"<rootId>:<scenePath>"`, скрипты, `.tres`, текстуры, аудио и транзитивные `preload`/`load`. Для cross-package использовать `dependencies`. Отсутствующие цели не включать (валидация — в задаче 3). Результат — отсортированные уникальные ключи `"<packageId>:<filepath>"`.

- [ ] **Step 4: Запустить тест**

Run: `pnpm --filter server exec jest package-runtime-references.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/package-runtime-references.ts \
  packages/server/src/scripting-packages/package-runtime-references.spec.ts
git commit -m "feat(packages): rewrite runtime package references"
```

---

### Задача 3: Сборка runtime-артефактов и модуль доставки

**Files:**
- Create: `packages/server/src/scripting-packages/package-delivery.module.ts`
- Create: `packages/server/src/scripting-packages/package-delivery.service.ts`
- Test: `packages/server/src/scripting-packages/package-delivery.service.spec.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.module.ts`

**Interfaces:**
- Consumes: `PackageStorageService`, `PackageReadUrlService`, репозитории `ScriptingPackage`/`ScriptingPackageRevision`, функции задачи 2, типы задачи 1.
- Produces:
  - `PackageDeliveryService.getRuntimeManifest(packageId, revision, roomId): Promise<PackageRuntimeManifest>`
  - `PackageDeliveryService.resolveRuntimeFile(packageId, revision, roomId, filepath): Promise<{ path: string; size: number }>`
  - `PackageDeliveryModule` экспортирует `PackageStorageService`, `PackageReadUrlService`, `PackageDeliveryService`.

- [ ] **Step 1: Написать падающий тест сборки артефакта**

Использовать реальный `PackageStorageService` с временным `packagesFilesDir`, замоканными репозиториями и `PackageReadUrlService`.

```ts
it('rewrites package paths, strips ext_resource uid and pins dependency revisions', async () => {
  await writePublished(5, 3, {
    'main.tscn':
      '[gd_scene format=3]\n' +
      '[ext_resource type="Script" uid="uid://x" path="res://packages/5/hero.gd" id="1"]\n' +
      '[ext_resource type="Texture2D" path="res://packages/6/tex.png" id="2"]\n',
    'hero.gd': 'extends Node',
  });
  await writePublished(6, 9, { 'tex.png': Buffer.from([137, 80, 78, 71]) });

  const manifest = await service.getRuntimeManifest(5, 3, 7);

  expect(manifest.roomId).toBe(7);
  expect(manifest.dependencies).toEqual([
    { packageId: 6, revision: 9, name: 'Library' },
  ]);
  expect(manifest.files.map((f) => f.filepath)).toEqual([
    'hero.gd',
    'main.tscn',
  ]);
  expect(await readArtifact(5, 3, 7, 'main.tscn')).toContain(
    'path="user://wired/rooms/7/packages/5/3/hero.gd"',
  );
  expect(await readArtifact(5, 3, 7, 'main.tscn')).toContain(
    'path="user://wired/rooms/7/packages/6/9/tex.png"',
  );
  expect(await readArtifact(5, 3, 7, 'main.tscn')).not.toContain('uid="uid://x"');
  expect(manifest.download.token).toBeTruthy();
});
```

Дополнительные тесты:
- повторный вызов не перечитывает файлы (spy на `readPublishedFile`) и возвращает тот же манифест;
- зависимость из другой комнаты → `BadRequestException` с `package_dependency_room_mismatch:6`;
- неопубликованная зависимость → `package_dependency_unpublished:6`;
- отсутствующий файл зависимости → `package_dependency_missing_file:6:tex.png`;
- цикл `5 -> 6 -> 5` → `package_dependency_cycle`;
- `resolveRuntimeFile(..., '../x')` → `NotFoundException`;
- бинарный файл не меняется, хеш совпадает с исходным.

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter server exec jest package-delivery.service.spec`
Expected: FAIL — сервис не найден.

- [ ] **Step 3: Реализовать `PackageDeliveryService`**

Публичные методы:

```ts
async getRuntimeManifest(
  packageId: number,
  revision: number,
  roomId: number,
): Promise<PackageRuntimeManifest>;

async resolveRuntimeFile(
  packageId: number,
  revision: number,
  roomId: number,
  filepath: string,
): Promise<{ path: string; size: number }>;
```

Внутренний артефакт:

```ts
type RuntimeArtifact = {
  packageId: number;
  name: string;
  revision: number;
  roomId: number;
  publishedAt: string;
  files: PackageFileEntry[];
  totalSize: number;
  dependencies: PackageRuntimeDependency[];
  sceneDependencies: Record<string, string[]>;
  dir: string;
};
```

Правила сборки:
- Загрузить опубликованную ревизию с `package.room`; если пакет комнатный и `room.id !== roomId` → `BadRequestException('package_dependency_room_mismatch:<id>')`; если ревизия не published → `NotFoundException`.
- Рекурсивно разрешить ссылки из задачи 2. Для каждой зависимости брать **последнюю published** ревизию; проверять комнату (та же или `null`), наличие referenced-файла, отсутствие цикла. Стек цикла возвращать в сообщении.
- Для same-package ссылок также проверять наличие файла; иначе `package_dependency_missing_file:<rootId>:<path>`.
- `revisionByPackage` содержит корень и всё транзитивное замыкание.
- `decodePackageText` может бросить `package_text_not_utf8:<file>`; перехватить и вернуть `BadRequestException` с этим сообщением.
- `depsHash = sha256Hex(JSON.stringify(sortedClosure.map(([id, rev]) => [id, rev])))`.
- Каталог: `<packagesFilesDir>/<packageId>/runtime/<roomId>/<revision>/<depsHash>/`.
- Если `manifest.json` уже есть — вернуть его без чтения исходников.
- Сборка в `<dir>.staging-<pid>-<random>`, затем `rename` в целевой каталог; при гонке удалить staging и прочитать существующий `manifest.json`. Держать in-flight `Map<string, Promise<RuntimeArtifact>>`.
- Для каждого raw-файла: текстовый — `decodePackageText`, `rewritePackageReferences`, `stripExtResourceUids`, `Buffer.from`; бинарный — исходные байты. Считать `size`/`sha256` заново, писать в staging, `files` сортировать по `filepath`.
- `dependencies` — только прямые зависимости корня; `sceneDependencies` — из `buildSceneDependencies` по всему замыканию.
- `manifest.json` содержит все поля артефакта, кроме `dir`; писать в staging до rename.
- `getRuntimeManifest` добавляет `download: readUrls.createToken({ roomId, packageId, revision })`.
- `resolveRuntimeFile`: вызвать `ensureArtifact`, проверить, что `filepath` есть в `artifact.files`, затем `resolvePackagePath(artifact.dir, filepath)`; иначе `NotFoundException`. Вернуть `{ path, size }`.

- [ ] **Step 4: Добавить модуль**

```ts
@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([ScriptingPackage, ScriptingPackageRevision]),
  ],
  providers: [
    PackageStorageService,
    PackageReadUrlService,
    PackageDeliveryService,
  ],
  exports: [
    PackageStorageService,
    PackageReadUrlService,
    PackageDeliveryService,
  ],
})
export class PackageDeliveryModule {}
```

В `scripting-packages.module.ts`: импортировать `PackageDeliveryModule`, убрать `PackageStorageService` из `providers` (провайдер теперь в delivery-модуле). `PackageRevisionsService` продолжает получать его через импорт.

- [ ] **Step 5: Запустить тесты**

Run: `pnpm --filter server exec jest package-delivery.service.spec package-revisions.service.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scripting-packages/package-delivery.module.ts \
  packages/server/src/scripting-packages/package-delivery.service.ts \
  packages/server/src/scripting-packages/package-delivery.service.spec.ts \
  packages/server/src/scripting-packages/scripting-packages.module.ts
git commit -m "feat(packages): build per-room runtime artifacts"
```

---

### Задача 4: Runtime-маршруты манифеста и файлов

**Files:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.spec.ts`

**Interfaces:**
- Consumes: `PackageDeliveryService.getRuntimeManifest`, `resolveRuntimeFile`, `PackageReadUrlService.verifyToken`.
- Produces:
  - `GET /scripting-packages/:id/revisions/:revision/runtime-manifest?room=<id>`
  - `GET /scripting-packages/:id/revisions/:revision/runtime-files/*path?room=<id>&token=<token>`

- [ ] **Step 1: Написать падающие тесты контроллера**

```ts
it('returns a signed runtime manifest for a published revision and room', async () => {
  delivery.getRuntimeManifest.mockResolvedValue({ packageId: 5, revision: 3 });
  await expect(
    controller.runtimeManifest(5, 3, 7),
  ).resolves.toMatchObject({ packageId: 5 });
  expect(delivery.getRuntimeManifest).toHaveBeenCalledWith(5, 3, 7);
});

it('rejects a runtime file with a token for another room', async () => {
  readUrls.verifyToken.mockReturnValue(false);
  await expect(
    controller.runtimeFile(5, 3, ['a.gd'], 8, 'bad', response),
  ).rejects.toBeInstanceOf(UnauthorizedException);
});
```

Добавить проверку, что для валидного токена вызывается `delivery.resolveRuntimeFile(5,3,7,'a.gd')` и в ответ пишутся `Content-Type: application/octet-stream` и `Content-Length`.

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter server exec jest scripting-packages.controller.spec`
Expected: FAIL — методов нет.

- [ ] **Step 3: Добавить зависимости и маршруты**

В конструктор контроллера добавить `private readonly delivery: PackageDeliveryService`, `private readonly readUrls: PackageReadUrlService`.

```ts
@Get(':id/revisions/:revision/runtime-manifest')
async runtimeManifest(
  @Param('id', ParseIntPipe) id: number,
  @Param('revision', ParseIntPipe) revision: number,
  @Query('room', ParseIntPipe) room: number,
): Promise<PackageRuntimeManifest> {
  return this.delivery.getRuntimeManifest(id, revision, room);
}

@Get(':id/revisions/:revision/runtime-files/*path')
async runtimeFile(
  @Param('id', ParseIntPipe) id: number,
  @Param('revision', ParseIntPipe) revision: number,
  @Param('path') path: string | string[],
  @Query('room', ParseIntPipe) room: number,
  @Query('token') token: string,
  @Res() res: Response,
): Promise<void>;
```

Правила:
- `filepath = Array.isArray(path) ? path.join('/') : path`.
- Нет токена или `verifyToken` вернул `false` → `UnauthorizedException('package_read_token_invalid')`.
- `resolveRuntimeFile` → `createReadStream(file.path)`, `Content-Type: application/octet-stream`, `Content-Length: file.size`; ошибка стрима уничтожает ответ, как в существующем `downloadFile`.
- Runtime-маршруты публичные (без `@UseAuthGuard`), но требуют `room` и валидный токен для файлов.
- Не логировать `token`.

- [ ] **Step 4: Запустить тест**

Run: `pnpm --filter server exec jest scripting-packages.controller.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/scripting-packages.controller.ts \
  packages/server/src/scripting-packages/scripting-packages.controller.spec.ts
git commit -m "feat(packages): serve signed runtime manifests and files"
```

---

### Задача 5: Поиск зависимых room-пакетов

**Files:**
- Modify: `packages/server/src/scripting-packages/package-delivery.service.ts`
- Modify: `packages/server/src/scripting-packages/package-delivery.service.spec.ts`

**Interfaces:**
- Consumes: опубликованные raw-файлы, `collectPackageReferences`.
- Produces: `PackageDeliveryService.findDependentRoomPackages(packageId: number): Promise<Array<{ packageId: number; roomId: number; revision: number }>>`

- [ ] **Step 1: Написать падающий тест**

```ts
it('finds room packages that reference the published package transitively', async () => {
  await writePublished(10, 1, { 'a.gd': 'preload("res://packages/5/x.gd")' });
  await writePublished(11, 1, { 'b.gd': 'preload("res://packages/10/a.gd")' });
  await writePublished(5, 2, { 'x.gd': 'extends Node' });

  await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
    { packageId: 10, roomId: 7, revision: 1 },
    { packageId: 11, roomId: 7, revision: 1 },
  ]);
});
```

Добавить:
- глобальный пакет-библиотека может быть промежуточным звеном: `5 <- global 12 <- room 13`; публикация `5` возвращает `13`;
- глобальный зависимый пакет сам в результат не попадает (у него нет runtime);
- пакет из другой комнаты, который ссылается на `5`, не попадает;
- прямой и транзитивный зависимые возвращаются один раз;
- цикл в данных не вешает обход (visited set).

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter server exec jest package-delivery.service.spec`
Expected: FAIL — метода нет.

- [ ] **Step 3: Реализовать метод**

Правила:
- Загрузить **все** пакеты, включая глобальные (`room == null`): глобальная библиотека может быть промежуточным звеном между room-пакетами. Для каждого — последнюю published-ревизию.
- Для каждой ревизии прочитать raw-файлы и собрать `collectPackageReferences`.
- Построить обратный граф `referencedPackageId -> packageId`.
- Обойти от `packageId` транзитивно; вернуть только room-пакеты, отсортированные по `packageId`. Глобальные пакеты в результат не включать.
- Не включать сам `packageId`.
- Без кеша в v1: публикация случается редко, лимиты пакета ограничивают объём.
- Если файл не читается, логировать `warn` и пропустить пакет, не ломая публикацию.

- [ ] **Step 4: Запустить тест**

Run: `pnpm --filter server exec jest package-delivery.service.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/package-delivery.service.ts \
  packages/server/src/scripting-packages/package-delivery.service.spec.ts
git commit -m "feat(packages): find packages dependent on a library"
```

---

### Задача 6: Повторная отправка зависимых пакетов после публикации

**Files:**
- Modify: `packages/server/src/godot-game/package-sync.service.ts`
- Modify: `packages/server/src/godot-game/package-sync.service.spec.ts`
- Modify: `packages/server/src/godot-game/godot-game.module.ts`

**Interfaces:**
- Consumes: `PackageDeliveryService.findDependentRoomPackages`.
- Produces: при публикации `B` сервер отправляет `package <B> <revB>` и `package <A> <revA>` для каждого зависимого room-пакета `A`, даже если `revA` не менялась.

- [ ] **Step 1: Написать падающий тест**

```ts
it('re-dispatches dependent room packages when a library publishes', async () => {
  delivery.findDependentRoomPackages.mockResolvedValue([
    { packageId: 99, roomId: 7, revision: 4 },
  ]);
  packages.findOne
    .mockResolvedValueOnce(roomPackage)
    .mockResolvedValueOnce({ id: 99, name: 'Game', room: { id: 7 } });

  await service.revisionPublished(42, 3);

  expect(runtime.sendPackage).toHaveBeenCalledWith('7', 42, 3);
  expect(runtime.sendPackage).toHaveBeenCalledWith('7', 99, 4);
});
```

Дополнительно:
- публикация глобальной библиотеки (у неё нет своей комнаты) всё равно вызывает `findDependentRoomPackages` и отправляет зависимые room-пакеты;
- зависимый пакет без запущенного runtime остаётся `pending` и отправляется при `onRuntimeReady`;
- повторная публикация той же ревизии библиотеки не отправляет собственный пакет дважды, но может обновить зависимые.

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter server exec jest package-sync.service.spec`
Expected: FAIL — зависимый пакет не отправлен.

- [ ] **Step 3: Реализовать**

- Добавить `PackageDeliveryService` в конструктор `PackageSyncService`; в `beforeEach` существующего spec добавить четвёртый аргумент `delivery` с `findDependentRoomPackages: jest.fn().mockResolvedValue([])`.
- В `GodotGameModule` импортировать `PackageDeliveryModule`.
- Для пакета с комнатой сначала отправить/поставить в очередь собственный runtime-пакет, затем вызвать `findDependentRoomPackages(packageId)`.
- Для глобального пакета (`room == null`) собственный runtime не трогать, но всё равно вызвать `findDependentRoomPackages(packageId)` и отправить зависимые room-пакеты.
- Для каждого зависимого:
  - ключ `${roomId}:${packageId}`;
  - если записи нет — создать `SyncRecord` с его `revision` и `publishedAt` из последней published-ревизии ( delivery уже вернул revision; `publishedAt` можно взять `new Date()` для сортировки статуса, но `getStatuses` должен показывать фактическую ревизию);
  - если запись есть и `revision` совпадает — сбросить `runtimeState`/`runtimeError`/`attempts`/`nextAttemptAt`, очистить клиентов и вызвать `dispatch(record, true)`;
  - если `revision` отличается — обновить запись.
- Не рекурсировать `revisionPublished` для зависимых: это привело бы к повторному поиску и лишним отправкам.
- Ошибку `findDependentRoomPackages` логировать, но не отменять публикацию.

- [ ] **Step 4: Запустить тесты**

Run: `pnpm --filter server exec jest package-sync.service.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/godot-game/package-sync.service.ts \
  packages/server/src/godot-game/package-sync.service.spec.ts \
  packages/server/src/godot-game/godot-game.module.ts
git commit -m "feat(game): re-dispatch packages after library updates"
```

---

### Задача 7: Same-origin API base для Web-клиента

**Files:**
- Modify: `frontend/src/app/room/[room_code]/(godot)/game-bridge.ts`
- Modify: `frontend/src/app/room/[room_code]/(godot)/GameTab.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/GameTab.test.tsx`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd`
- Modify: `packages/server/godot_project/_wired/_wired/web/shell.html`

**Interfaces:**
- Consumes: `GameConfigurePayload`, bridge config, `PackagesManager.configure`.
- Produces:
  - `GameConfigurePayload.apiBase: string`
  - `PackagesManager.set_api_base(url: String) -> bool`
  - Web configure payload содержит `apiBase: "<origin>/api"`.

- [ ] **Step 1: Написать падающий тест GameTab**

В существующем тесте, где проверяется `wired:configure`, добавить в `expect.objectContaining`:

```ts
apiBase: `${window.location.origin}/api`,
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter frontend exec vitest run GameTab.test.tsx`
Expected: FAIL — в payload нет `apiBase`.

- [ ] **Step 3: Добавить `apiBase` в контракт и отправку**

`game-bridge.ts`:

```ts
export type GameConfigurePayload = {
  endpoint: string;
  ticket: string;
  room: number;
  apiBase: string;
};
```

`GameTab.tsx`, рядом с `postGameConfigure`:

```ts
postGameConfigure(frame, {
  endpoint: connection.endpoint,
  ticket: connection.ticket,
  room: connection.roomId,
  apiBase: `${window.location.origin}/api`,
});
```

`apiBase` — абсолютный same-origin URL, потому что `HTTPRequest` в Web-сборке не должен зависеть от относительных URL.

- [ ] **Step 4: Добавить `set_api_base` в `PackagesManager`**

```gdscript
func set_api_base(url: String) -> bool:
	var value := url.strip_edges()
	if value.is_empty():
		return false
	if not (value.begins_with("http://") or value.begins_with("https://")):
		return false
	base_url = value.trim_suffix("/")
	return true
```

`bool` нужен вызывающему: Web-клиент обязан явно упасть с понятной ошибкой, если хост не передал API base, а не молча ходить на `127.0.0.1:3000`.

Вызывать в `main_scene._run_client` после получения bridge config и до `_net.start_client`:

```gdscript
var api_base := str(config.get("apiBase", ""))
if api_base.is_empty():
	_fail("No API base received from the Wired host")
	return
if not _packages.set_api_base(api_base):
	_fail("Invalid API base received from the Wired host")
	return
```

`shell.html` валидирует `apiBase` до передачи в движок: принимается только абсолютный `http(s)` URL на том же origin, иначе значение отбрасывается.

Headless не меняется: `--api-url` / `WIRED_API_URL` / default.

- [ ] **Step 5: Запустить тест и типы**

Run:
```bash
pnpm --filter frontend exec vitest run GameTab.test.tsx
pnpm check-types:frontend
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/room/[room_code]/\(godot\)/game-bridge.ts \
  frontend/src/app/room/[room_code]/\(godot\)/GameTab.tsx \
  frontend/src/app/room/[room_code]/\(godot\)/GameTab.test.tsx \
  packages/server/godot_project/_wired/_wired/scripts/main_scene.gd \
  packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd \
  packages/server/godot_project/_wired/_wired/web/shell.html
git commit -m "feat(game): pass same-origin api base to web build"
```

---

### Задача 8: Рекурсивная синхронизация runtime-манифестов в Godot

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd`
- Create: `packages/server/godot_project/_wired/tests/packages_manager_smoke.gd`

**Interfaces:**
- Consumes: `PackageRuntimeManifest`, `download.token`, `sceneDependencies`.
- Produces:
  - `fetch_runtime_manifest(package_id: int, revision: int) -> Dictionary`
  - `sync_package(package_id: int, revision_hint: int = 0) -> Dictionary`
  - `runtime_path(package_id: int, revision: int, filepath: String) -> String`
  - `current_revision(package_id: int) -> int`
  - `scene_dependencies(package_id: int, scene_path: String) -> PackedStringArray`
  - `instantiate_scene(package_id: int, scene_path: String, revision: int = 0) -> Node`
  - signal `package_applied(package_id: int, revision: int, changed_files: PackedStringArray)`

- [ ] **Step 1: Написать падающий smoke-тест**

`tests/packages_manager_smoke.gd` extends `SceneTree`, в `_initialize()`:

```gdscript
var manager := PackagesManager.new()
manager.configure("http://127.0.0.1:1", "7")
assert(manager.runtime_path(5, 3, "scripts/hero.gd") ==
	"user://wired/rooms/7/packages/5/3/scripts/hero.gd")
assert(manager._changed_files(
	{"a.gd": "1", "b.gd": "2"},
	{"a.gd": "1", "b.gd": "3", "c.gd": "4"},
) == PackedStringArray(["b.gd", "c.gd"]))
quit(0)
```

Добавить проверку, что `sync_package` рекурсивно вызывает зависимости в порядке «сначала зависимости, потом корень» через тестовый seam `_sync_order` (массив, заполняемый в `_sync_package` до сетевых вызовов).

- [ ] **Step 2: Запустить smoke и убедиться, что он падает**

Run (подставить путь редактора из `packages/server/.env`, не выводить его в лог):
```powershell
& $env:GODOT_EDITOR_PATH --headless --path packages/server/godot_project/_wired --script res://tests/packages_manager_smoke.gd --quit-after 600
```
Expected: FAIL — методов нет.

- [ ] **Step 3: Реализовать загрузку runtime-манифеста**

- `fetch_runtime_manifest(package_id, revision)`:
  `GET /scripting-packages/%d/revisions/%d/runtime-manifest?room=%d`; вернуть `{ok,error,manifest}`; 404 → `ok=false`, `error="runtime_manifest_missing"`.
- `runtime_path(package_id, revision, filepath)`:
  `"user://wired/rooms/%s/packages/%d/%d/%s" % [room, package_id, revision, filepath]`.
- `current_revision(package_id)` из `_current_revisions`.
- `scene_dependencies(package_id, scene_path)` из `_scene_dependencies`.
- `instantiate_scene(package_id, scene_path, revision=0)`:
  - revision 0 → `current_revision`;
  - `ResourceLoader.load(runtime_path(...), "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)`;
  - `packed.instantiate()`;
  - установить meta `_wired_package_id`, `_wired_package_scene`, `_wired_package_revision`;
  - вернуть `Node` или `null`.

- [ ] **Step 4: Реализовать рекурсивный `sync_package`**

- Ключ защиты от повторного входа: per-package `_applying` с ожиданием и таймаутом; цикл по графу зависимостей защищён цепочкой вызовов (`chain`), а не парой `package_id:revision`.
- Сначала `fetch_runtime_manifest`; для каждого `manifest.dependencies` вызвать `sync_package(dep.package_id, dep.revision)`.
- Скачивать файлы по `base_url + "/scripting-packages/%d/revisions/%d/runtime-files/%s?room=%d&token=%s"`.
- Проверять `size` и `sha256` уже переписанного файла из манифеста.
- Писать в `packages/<id>/.staging`; хранить текущую и предыдущую ревизии:
  - существующую целевую ревизию переименовать в `.previous` на время замены;
  - staging → `<newRev>`;
  - после успешной замены удалить `.previous` и все числовые ревизии, кроме новой и самой высокой оставшейся.
- После swap:
  - `_current_revisions[package_id] = revision`;
  - `_scene_dependencies[package_id] = manifest.sceneDependencies`;
  - `changed = _changed_files(old_hashes, new_hashes)`;
  - `_file_hashes[package_id] = new_hashes`;
  - `package_applied.emit(package_id, revision, changed)`.
- `_changed_files(old: Dictionary, new: Dictionary) -> PackedStringArray`: ключи, где хеш отсутствует/отличается, отсортированные.
- При ошибке скачивания/проверки — удалить staging, вернуть `{ok:false,error}`, `package_failed.emit`.

- [ ] **Step 5: Запустить smoke**

Run: та же команда.
Expected: PASS, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd \
  packages/server/godot_project/_wired/tests/packages_manager_smoke.gd
git commit -m "feat(game): sync runtime package manifests recursively"
```

---

### Задача 9: Производные текстуры и аудио

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd`
- Create: `packages/server/godot_project/_wired/tests/package_assets_smoke.gd`

**Interfaces:**
- Consumes: staging-каталог, финальный каталог, список файлов.
- Produces: локальные `<file>.image.res` / `<file>.audio.res` и sidecar `<file>.import`; при ошибке — откат staging.

- [ ] **Step 1: Написать падающий smoke-тест**

`package_assets_smoke.gd`:
- создать `user://asset-test` и 1×1 PNG (байты из проверенного фикстура);
- вызвать `manager._derive_assets(staging, final, ["tex.png"])`;
- `assert(ResourceLoader.load(final + "/tex.png") is Texture2D)`;
- создать WAV 0.1 с и проверить `ResourceLoader.load(final + "/beep.wav") is AudioStreamWAV`;
- проверить, что `.import` содержит `[remap]`, `type="ImageTexture"`/`AudioStreamWAV` и абсолютный `user://` путь.

- [ ] **Step 2: Запустить smoke и убедиться, что он падает**

Run:
```powershell
& $env:GODOT_EDITOR_PATH --headless --path packages/server/godot_project/_wired --script res://tests/package_assets_smoke.gd --quit-after 600
```
Expected: FAIL — `_derive_assets` нет.

- [ ] **Step 3: Реализовать `_derive_assets`**

```gdscript
const TEXTURE_EXTENSIONS := ["png", "jpg", "jpeg", "webp", "bmp"]
const AUDIO_STREAM_TYPES := {
	"wav": "AudioStreamWAV",
	"ogg": "AudioStreamOggVorbis",
	"mp3": "AudioStreamMP3",
}
```

Для каждого файла:
- текстура:
  ```gdscript
  var image := Image.load_from_file(source_path)
  if image == null: return failure
  var texture := ImageTexture.create_from_image(image)
  if ResourceSaver.save(texture, staging_path + ".image.res") != OK: return failure
  ```
  sidecar:
  ```ini
  [remap]

  importer="texture"
  type="ImageTexture"
  path="<final_dir>/<filepath>.image.res"
  ```
- аудио:
  ```gdscript
  var stream: AudioStream = null
  match ext:
      "wav": stream = AudioStreamWAV.load_from_file(source_path)
      "ogg": stream = AudioStreamOggVorbis.load_from_file(source_path)
      "mp3": stream = AudioStreamMP3.load_from_file(source_path)
  ```
  сохранить `<file>.audio.res`, sidecar с `type=<AudioStreamType>`.
- sidecar писать в staging, но `path` указывает на финальный каталог (после rename).
- `_derive_assets` вызывать после проверки всех хешей и до rename staging → final.
- При любой ошибке вернуть `{ok:false,error:"asset_derive_failed:<file>"}`; `sync_package` удаляет staging и не меняет current.
- `.res` и `.import` не добавлять в манифест и не публиковать.

- [ ] **Step 4: Запустить smoke**

Run: та же команда.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/packages_manager.gd \
  packages/server/godot_project/_wired/tests/package_assets_smoke.gd
git commit -m "feat(game): derive runtime textures and audio"
```

---

### Задача 10: Горячее пересоздание корней сцен

**Files:**
- Create: `packages/server/godot_project/_wired/_wired/scripts/global/package_reloader.gd`
- Create: `packages/server/godot_project/_wired/tests/package_reloader_smoke.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`

**Interfaces:**
- Consumes: `PackagesManager.package_applied`, `scene_dependencies`, `instantiate_scene`.
- Produces:
  - `PackageReloader.setup(packages: PackagesManager) -> void`
  - `PackageReloader.reload_for(package_id: int, changed_files: PackedStringArray) -> void`
  - логи `WIRED_PACKAGE_RELOADED` / `WIRED_PACKAGE_RELOAD_FAILED`.

- [ ] **Step 1: Написать падающий smoke-тест**

`package_reloader_smoke.gd` extends `SceneTree`:
- создать `user://wired/rooms/7/packages/5/1/fixture.tscn` с корнем `Node2D` и скриптом с `@export var score := 1`;
- `manager.configure(..., "7")`, вручную выставить `_current_revisions[5] = 1` и `_scene_dependencies[5]`, чтобы `instantiate_scene` работал без сети;
- `var node = manager.instantiate_scene(5, "fixture.tscn")`; `root.add_child(node)`; `node.score = 42`; `node.position = Vector2(3, 4)`;
- `root.add_child(reloader)`; `reloader.setup(manager)`; `reloader.reload_for(5, PackedStringArray(["fixture.tscn"]))`; дождаться кадра;
- `assert` старый instance id исчез, новый `score == 42`, `position == Vector2(3,4)`, meta сохранены;
- отдельный кейс: битый `.tscn` → старый узел остаётся, лог `WIRED_PACKAGE_RELOAD_FAILED`.

- [ ] **Step 2: Запустить smoke и убедиться, что он падает**

Run:
```powershell
& $env:GODOT_EDITOR_PATH --headless --path packages/server/godot_project/_wired --script res://tests/package_reloader_smoke.gd --quit-after 600
```
Expected: FAIL — `PackageReloader` нет.

- [ ] **Step 3: Реализовать `PackageReloader`**

```gdscript
extends Node
class_name PackageReloader

const RELOAD_DEBOUNCE_SEC := 0.2
```

Правила:
- `setup(packages)` сохраняет ссылку и подключает `packages.package_applied` к `_on_package_applied`.
- `_on_package_applied(package_id, revision, changed_files)` накапливает изменения в `_pending[package_id]`, планирует один `_flush` через `RELOAD_DEBOUNCE_SEC`.
- `_flush` обходит дерево от `get_tree().root` и собирает topmost-узлы с meta `_wired_package_id`.
- Для каждого корня:
  - `scene_path = node.get_meta("_wired_package_scene")`;
  - `deps = packages.scene_dependencies(node_package_id, scene_path)`;
  - если в `deps` есть `"<changed_package_id>:<changed_file>"` — пересоздать.
- Пересоздание:
  1. `_capture_state(old)` — имя, индекс, export-переменные, transform;
  2. `new = packages.instantiate_scene(package_id, scene_path)`;
  3. если `new == null` — лог `WIRED_PACKAGE_RELOAD_FAILED` и оставить старый;
  4. `parent.remove_child(old)`;
  5. `new.name = old_name`; применить state; `parent.add_child(new)`; `parent.move_child(new, old_index)`;
  6. `old.queue_free()`.
- `_capture_state`:
  - export-переменные: `usage & PROPERTY_USAGE_SCRIPT_VARIABLE` и `usage & PROPERTY_USAGE_STORAGE`; значение по `prop.name`;
  - `position`, `rotation`, `scale`, `size`, если свойства есть;
  - значения-`Node` не переносятся, `Array`/`Dictionary` копируются глубоко.
- Пользовательские meta-ключи (кроме `_wired_package_*`) копируются на новый корень; meta-значения-`Node` пропускаются.
- Не сохранять дочерние узлы и внешние ссылки. Nested package roots пересоздаются вместе с внешней сценой.
- `package_applied` от пакета-библиотеки без live-узлов — no-op.
- Autoload/`class_name` не трогать; в docs указать перезапуск.

- [ ] **Step 4: Подключить в `main_scene.gd`**

После создания `_packages`:

```gdscript
var reloader := PackageReloader.new()
add_child(reloader)
reloader.setup(_packages)
```

- [ ] **Step 5: Запустить smoke**

Run: та же команда.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/global/package_reloader.gd \
  packages/server/godot_project/_wired/_wired/scripts/main_scene.gd \
  packages/server/godot_project/_wired/tests/package_reloader_smoke.gd
git commit -m "feat(game): reload package scene roots in place"
```

---

### Задача 11: Документация, проверка и e2e-чеклист

**Files:**
- Create: `docs/superpowers/specs/2026-10-30-godot-package-runtime-delivery.md`
- Modify: `docs/superpowers/plans/2026-10-28-godot-multiplayer-foundation.md`

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: документированные ограничения, матрица проверки, обновлённый статус этапов 7–10.

- [ ] **Step 1: Записать итоговый документ**

Содержимое:
- таблица «тип ресурса → editor / native release / web» из 31 теста (24/31; web 25/31 из-за старого `.import` в IndexedDB);
- что поддерживается: `.gd`, `.tscn`, `.tres`, `.gdshader`, raw texture/audio + производные `.res`/`.import`;
- что не поддерживается: `.ctex` с `Texture2D`, `.remap` без loader, `FLAG_BUNDLE_RESOURCES` из `user://`, editor `.import`, hot-swap autoload/`class_name`;
- правила cross-package: та же комната или global, без циклов, две ревизии;
- формат `PackageRuntimeManifest`, TTL токена, restricted read-only;
- известное ограничение: старая сцена, ссылающаяся на ревизию глубже двух, ломается после cleanup;
- e2e-сценарий: library + game package, публикация, обновление library, пересоздание сцены, сохранение export-переменной, перезапуск runtime.

- [ ] **Step 2: Обновить мастер-план**

В `docs/superpowers/plans/2026-10-28-godot-multiplayer-foundation.md` отметить этапы 7–10 и добавить ссылку на новый план/документ. Не переписывать историю этапов 1–6.

- [ ] **Step 3: Запустить все целевые проверки**

```bash
pnpm --filter server exec jest package-read-url.service.spec
pnpm --filter server exec jest package-runtime-references.spec
pnpm --filter server exec jest package-delivery.service.spec
pnpm --filter server exec jest scripting-packages.controller.spec
pnpm --filter server exec jest package-sync.service.spec
pnpm --filter server exec jest package-revisions.service.spec
pnpm --filter frontend exec vitest run GameTab.test.tsx
pnpm check-types:frontend
pnpm --filter server build
pnpm --filter frontend lint
pnpm --filter server lint
```

Godot smoke:
```powershell
& $env:GODOT_EDITOR_PATH --headless --path packages/server/godot_project/_wired --script res://tests/packages_manager_smoke.gd --quit-after 600
& $env:GODOT_EDITOR_PATH --headless --path packages/server/godot_project/_wired --script res://tests/package_assets_smoke.gd --quit-after 600
& $env:GODOT_EDITOR_PATH --headless --path packages/server/godot_project/_wired --script res://tests/package_reloader_smoke.gd --quit-after 600
```

- [ ] **Step 4: Собрать Web export и проверить вручную**

```bash
pnpm export:game
```

Проверить:
- Game tab в браузере получает `apiBase` и не ходит на `127.0.0.1:3000`;
- пакет с PNG/WAV загружается, сцена инстанцируется, текстура и звук на месте;
- после публикации library зависимая сцена перезагружается, export-переменная корня сохраняется;
- повторный вход игрока получает те же ревизии;
- headless runtime (`pnpm dev:server` + комната) ведёт себя так же.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-30-godot-package-runtime-delivery.md \
  docs/superpowers/plans/2026-10-28-godot-multiplayer-foundation.md \
  docs/superpowers/plans/2026-10-30-godot-package-runtime-delivery.md
git commit -m "docs: record package runtime delivery"
```

---

## Самопроверка плана

- **Покрытие spec:** вопрос 3 (какие ресурсы грузятся) закрыт задачами 2, 8, 9 и матрицей в задаче 11; вопрос 4 (как запрашивать файлы) — задачами 1, 3, 4, 7. Переписывание путей — задачи 2–3. Cross-package — задачи 2–6. Горячая перезагрузка — задача 10.
- **Порядок:** типы → чистые функции → артефакты → HTTP → dependents → web base → runtime sync → assets → reloader → docs. Каждая задача заканчивается независимо проверяемым результатом.
- **Типы:** `PackageRuntimeManifest.download.token/expiresAt`, `PackageRuntimeDependency.packageId/revision/name`, `sceneDependencies` как `"<packageId>:<filepath>"` используются одинаково в задачах 1, 3, 8, 10.
- **Review Focus:** для каждого пункта есть тест: задачи 3/5 (зависимости), 2/3 (порча текста), 3/5/8 (кеш), 10 (state/duplicate), 1/4 (token/traversal), 7 (localhost).
- **Осознанно не входит:** авторизация публичных пакетов, hot-swap autoload/`class_name`, хранение больше двух ревизий, переписывание бинарных `.scn`, editor-импорт `.ctex`.
