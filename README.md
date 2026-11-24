<div align="center">

<img src="./frontend/public/logo_splash.png" alt="Wired" height="96">

# Wired

**Браузерная платформа для создания и запуска многопользовательских Godot-игр**

[![Deploy](https://img.shields.io/github/actions/workflow/status/AshenHermit/Wired/deploy.yml?branch=main&label=deploy&style=flat-square)](https://github.com/AshenHermit/Wired/actions/workflows/deploy.yml)
[![Version](https://img.shields.io/badge/version-0.5.0-7c3aed?style=flat-square)](https://github.com/AshenHermit/Wired/releases)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-3c873a?style=flat-square)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.12.1-f9ad00?style=flat-square)](https://pnpm.io)
[![Godot](https://img.shields.io/badge/Godot-4.8--beta2-478cbf?style=flat-square)](https://godotengine.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Возможности](#возможности) • [Архитектура](#архитектура) • [Быстрый старт](#быстрый-старт) • [Тесты](#тесты) • [Документация](#документация)

</div>

Wired совмещает редактор Godot в браузере, серверный рантайм для каждой комнаты и систему контент-пакетов. Редактор работает целиком на клиенте как WASM; игра запускается нативным Godot-процессом, который поднимает бэкенд. Сетевой код пишет ядро `_wired`, а автор пакета лишь регистрирует сцены, компоненты игрока и сущности.

> [!NOTE]
> Проект в активной разработке: текущая версия `0.5.0`. Новые комнаты создаются только с типом `godot`; legacy-тип `ts-game` сохранён в enum только для существующих записей БД.

## Возможности

- **Godot-редактор в браузере.** Официальная сборка 4.8-beta2 в WASM, файловая система пакетов через JS-Bridge, инкрементальная загрузка и кеш редакторских ассетов.
- **Игра в комнате.** Клиентский Web-экспорт в iframe и нативный рантайм на сервере; WebSocket-соединения проксируются бэкендом, порты рантайма наружу не открываются.
- **Пакеты комнаты.** Публикация ревизий, имена slug, метаданные, теги, hot reload без перезапуска игры, общий кеш артефактов в браузере.
- **История ревизий в git.** У каждого пакета свой bare-репозиторий SHA-256; ревизия — коммит, `commitSha` хранится в БД, чтение идёт по нему. Есть команды миграции, очистки, экспорта, gc и repair.
- **Многопользовательский режим.** Сервер авторитетен для состояния комнаты; сцены, компоненты игрока и динамические сущности регистрируются в реестре `_wired`.
- **Документация в продукте.** Разделы `/docs` и `/devlog` собираются из markdown в `frontend/content/`, Swagger доступен на `/api/docs`.

## Архитектура

```text
frontend/                 Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui
  src/app/(browser)/      логин, главная, /docs, /devlog
  src/app/room/...        редактор, вкладки Packages и Game, диалоги
  src/godot/bridge/       мост к WASM-редактору и клиентским пакетам
  content/{docs,devlog}/  markdown-источники страниц документации
packages/shared/          API-типы и константы, импортируются и клиентом, и сервером
packages/server/          NestJS 11 + TypeORM/Postgres, Godot-рантайм, экспорт, загрузка ассетов
  godot_project/_wired/   базовый проект, общий для всех комнат (коммитится)
  godot_editor/           WASM-редактор (артефакт, gitignore)
  godot_runtime/          нативный рантайм (артефакт, gitignore)
  game_export/            Web-экспорт игры (артефакт, gitignore)
docs/superpowers/         спецификации и планы
```

Ключевые решения, которые важно знать перед изменениями:

- Редактор и экспорт требуют заголовков COOP/COEP для SharedArrayBuffer — они выставлены на `/:path*`, а не только на `/room/*`.
- Файлы пакетов идут через мост редактора (`godot-packages-fs.ts` → `editor-bridge.ts` → `plugin.gd`), а не через `rtenv.FS`: официальная сборка 4.8-beta2 не экспортирует Emscripten `FS`.
- Пути сервера резолвятся от cwd; запускать сервер нужно через pnpm из `packages/server`, иначе ассеты и storage окажутся не там.
- URL-ы комнат, пакетов и пользователей используют Hashids. Соль `NEXT_PUBLIC_HASHIDS_SALT` нельзя менять без инвалидации всех существующих ссылок.
- API живёт только в браузере: `frontend/src/api/services/*` → axios с `NEXT_PUBLIC_BACKEND_URL` и токеном из cookie. Серверного API-клиента с cookie нет.
- Схема БД создаётся через `DB_SYNC=1`, миграций нет: изменения entity влияют на БД при старте сервера.

## Быстрый старт

### Требования

- Node.js **22+**, pnpm **10.12.1** (`corepack enable`), Git **2.29+** для SHA-256-репозиториев пакетов.
- Postgres — локальный или доступный по сети.
- Docker с Compose — только для контейнерного запуска.

### Локальная разработка

```bash
corepack enable
pnpm install

# Ассеты и рантайм фиксированной версии 4.8-beta2 (скачиваются, не коммитятся)
pnpm fetch:editor
pnpm fetch:runtime
pnpm fetch:templates

# Заполните packages/server/.env и frontend/.env.local (см. раздел «Окружение»)
pnpm dev:server                              # NestJS Watch, порт 3000
pnpm --filter frontend dev -- -p 3001        # Next.js, порт 3001
```

> [!IMPORTANT]
> Перед открытием вкладки Game один раз соберите Web-экспорт: `pnpm export:game`. Без него бэкенд не сможет отдать игру. Экспорт живёт вне `godot_project/_wired` — это общий базовый проект, который копируется в редактор.

### Docker Compose

Compose поднимает `db`, `backend`, `frontend` и `nginx`; внешняя сеть `shared-net` должна существовать. Контейнерный образ сам скачивает Godot-ассеты и собирает экспорт при сборке.

```bash
docker network create shared-net
# Заполните корневой .env (порты, домены, секреты и параметры БД)
docker compose up --build -d
```

Публичные адреса задаются `COMMON_DOMAIN` / `SITE_HOST`: API ожидается на `api.<COMMON_DOMAIN>`, WS — на `wss://api.<COMMON_DOMAIN>/rooms/{room}/game/ws`. В проде деплой идёт через workflow `.github/workflows/deploy.yml`, который передаёт `scripts/deploy-remote.sh` по SSH и перезаписывает `.env` из секрета `PROD_ENV`.

### Окружение

Файлы окружения не коммитятся; шаблон — `.env.prod.example`.

| Файл | Назначение |
| --- | --- |
| `.env` | локальный Docker Compose |
| `.env.prod` | источник правд для прода; попадает в секрет `PROD_ENV` |
| `packages/server/.env` | NestJS dev и `export:game`, читается из cwd пакета |
| `frontend/.env.local` | Next.js, `NEXT_PUBLIC_*` |

Обязательные группы ключей: `DB_*`, `AUTH_SECRET`, `AUTH_COOKIE_NAME`, Google OAuth (`GOOGLE_AUTH_CLIENT_*`, `GOOGLE_AUTH_CALLBACK`), `COMMON_DOMAIN`, `SITE_HOST`, `WIRED_GAME_TICKET_SECRET`, `WIRED_PACKAGE_READ_SECRET`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_WEBSOCKET_URL`, `NEXT_PUBLIC_HASHIDS_SALT`. Хранение ревизий в git включается `WIRED_PACKAGE_GIT_STORAGE=1`; перевод существующих каталогов — `pnpm --filter server packages:git-migrate -- --all` с этим же флагом в окружении.

> [!WARNING]
> Никогда не коммитьте и не выводите содержимое env-файлов: там секреты подписи тикетов, чтения пакетов и OAuth. Значения `NEXT_PUBLIC_*` вшиваются в бандл при сборке образа — их изменение требует пересборки фронтенда.

## Тесты и проверки

```bash
pnpm --filter server test                  # Jest, *.spec.ts
pnpm --filter frontend test                # Vitest + jsdom
pnpm --filter server test:scripts          # node --test для fetch/export-скриптов
pnpm check-types:frontend
pnpm --filter server check-types
pnpm --filter frontend lint
pnpm --filter server lint                  # с автофиксом
pnpm --filter frontend validate:content    # front matter docs/devlog
pnpm build                                  # shared + server + frontend
```

Один серверный спек: `pnpm --filter server exec jest create-room.dto.spec`. Интеграционный тест с реальным Godot включается отдельно: `WIRED_GODOT_INTEGRATION=1 GODOT_RUNTIME_PATH=<godot-console.exe> pnpm --filter server exec jest room-runtime.integration --runInBand`.

## Документация

- [Начало работы с пакетами](frontend/content/docs/getting-started.md), [регистрация сущностей](frontend/content/docs/entity-registration.md), [API пакетов](frontend/content/docs/api-reference.md), [руководство по мультиплееру](frontend/content/docs/multiplayer-guide.md) — те же страницы доступны в приложении по адресу `/docs`.
- [Дневник разработки](frontend/content/devlog/) — в приложении по адресу `/devlog`; шаблон записи — `frontend/content/devlog/_template.md`.
- Swagger бэкенда: `/api/docs`.
- Спецификации, планы и комментарии к архитектуре: `docs/superpowers/`.
- Правила разработки и структурирования кода: `AGENTS.md`, `docs/frontend-conventions.md`.
- Версия синхронизирована в четырёх `package.json`; релиз отмечается аннотированным тегом `vX.Y.Z`.
