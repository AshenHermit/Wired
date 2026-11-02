# Docker-деплой и GitHub Actions — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать рабочие образы backend/frontend с Godot-редактором, рантаймом и web-экспортом, починить compose/nginx и настроить деплой из GitHub Actions на сервер с доставкой `.env` из секретов.

**Architecture:** Образы собираются на сервере из свежего checkout (`/home/Wired`), compose-проект `wired` пересоздаёт контейнеры поверх существующих volume'ов. Workflow на `ubuntu-latest` прогоняет тесты, затем по SSH пишет `.env` из секрета `PROD_ENV` и выполняет `scripts/deploy-remote.sh`, переданный по stdin.

**Tech Stack:** Docker (BuildKit, multi-stage), Docker Compose, nginx, Node 22 + pnpm 10, NestJS, Next.js 16, Godot 4.8-beta2 (закреплённые скрипты), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-03-docker-deploy-ci-design.md`

## Global Constraints

- Node в образах — `node:22-bookworm-slim`; pnpm — `10.12.1` через поле `packageManager` и corepack.
- Деплой-каталог по умолчанию `/home/Wired`; compose-проект — `name: wired`; volume'ы `wired_wired_db`, `wired_wired_storage` не переименовывать и не удалять.
- В деплое запрещены `--remove-orphans`, `docker container prune`, `docker volume rm`, `git clean`.
- Версии Godot не менять: 4.8-beta2, только через `packages/server/scripts/fetch-*`.
- Прод БД — сервис `db` из compose; `STORAGE_DIR=/app/storage` задаётся в compose, volume монтируется туда же.
- Контейнеры работают от root (существующие файлы в volume'ах принадлежат root).
- Обязательные ключи деплоя: `WIRED_GAME_TICKET_SECRET`, `NEXT_PUBLIC_HASHIDS_SALT` — при пустом значении скрипт падает до сборки.
- Коммиты — Conventional Commits (`feat:`, `fix:`, `chore:`), текст ошибок и docs — по-русски, UTF-8.

## Review Focus

- **CRLF в `.env` (Windows-источник):** значение с хвостовым `\r` ломает пароль БД и URL; пользователь ожидает, что деплой нормализует файл сам. Тест — Task 7, шаг 3.
- **`$` в значениях `.env`:** compose интерполирует `$VAR` и обнуляет секрет молча; пользователь ожидает предупреждение в шаблоне. Тест — Task 2, шаг 3.
- **Существующий root-ownership:** каталог `/home/Wired` или файлы в `wired_wired_storage` от прошлого деплоя; пользователь ожидает понятную ошибку, а не тихую потерю доступа. Тесты — Task 3 (target volume) и Task 7 (проверка записи).
- **Относительный `STORAGE_DIR`:** compose падает «mount path must be absolute»; пользователь ожидает, что путь задаёт compose, а не env. Тест — Task 3, шаг 1.
- **Невалидный nginx-шаблон после envsubst:** `$host`/`$http_upgrade` не должны быть съедены подстановкой; пользователь ожидает `nginx -t` зелёным. Тест — Task 4, шаг 3.

---

### Task 1: Runtime-сборка `@wired-io/shared`

**Files:**
- Create: `packages/shared/tsconfig.build.json`
- Modify: `packages/shared/package.json`, `package.json`, `packages/server/package.json`

**Interfaces:**
- Produces: `@wired-io/shared` с `main: dist/index.js`, `types: dist/index.d.ts`, скриптом `build`; `GAME_ROOMS_TYPES` и `AVAILABLE_GAME_ROOMS_TYPES` доступны через `require`.
- Consumes: ничего.

- [ ] **Step 1: Убедиться, что пакет не резолвится**

Run (из `packages/server`): `node -e "console.log(require('@wired-io/shared').GAME_ROOMS_TYPES)"`
Expected: FAIL, `Cannot find module '@wired-io/shared'`.

- [ ] **Step 2: Создать `packages/shared/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "node",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": false,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Обновить манифесты**

`packages/shared/package.json`: добавить `"main": "dist/index.js"`, `"types": "dist/index.d.ts"`, скрипт `"build": "tsc -p tsconfig.build.json"`; `build:types` оставить.
Корневой `package.json`: `build:shared` → `pnpm --filter shared build`; добавить `"packageManager": "pnpm@10.12.1"` и `"engines": { "node": ">=22" }`.
`packages/server/package.json`: добавить `"prebuild": "pnpm --filter shared build"`.

- [ ] **Step 4: Собрать и проверить резолв**

Run: `pnpm build:shared`, затем из `packages/server`:
`node -e "console.log(require('@wired-io/shared').GAME_ROOMS_TYPES, require('@wired-io/shared').AVAILABLE_GAME_ROOMS_TYPES)"`
Expected: `[ 'godot', 'ts-game' ] [ 'godot' ]`.

- [ ] **Step 5: Проверить, что фронтенд не сломан**

Run: `pnpm check-types:frontend`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/tsconfig.build.json packages/shared/package.json packages/server/package.json package.json
git commit -m "build(shared): emit CommonJS runtime build"
```

---

### Task 2: `.env.prod.example`, gitignore и dockerignore

**Files:**
- Create: `.env.prod.example`
- Modify: `.gitignore`, `.dockerignore`

**Interfaces:**
- Produces: шаблон прод-переменных, на который опираются Task 3 (compose) и Task 8 (workflow/README).
- Consumes: ничего.

- [ ] **Step 1: Проверить отсутствие**

Run: `node -e "const fs=require('fs');process.exit(fs.existsSync('.env.prod.example')?0:1)"`
Expected: exit 1 (шаблона нет).

- [ ] **Step 2: Создать `.env.prod.example`**

Секции и ключи (значения — заглушки, секретов нет):

```dotenv
# ВНИМАНИЕ: значения с символом $ compose интерполирует. Секрет с $ пишите как $$
# Порты наружу
DB_EXTERNAL_PORT=5432
BACKEND_EXTERNAL_PORT=3000
FRONTEND_EXTERNAL_PORT=3001
NGINX_EXTERNAL_PORT=8080
TZ=UTC
PORT=3000

# Postgres (сервис db из compose; наружу не выставляется без нужды)
DB_HOST=db
DB_PORT=5432
DB_USER=postgres
DB_NAME=postgres
DB_PASSWORD=change-me
DB_SYNC=1

# Домен и auth: COMMON_DOMAIN — только домен, без схемы и без api.
COMMON_DOMAIN=example.com
SITE_HOST=https://example.com
AUTH_SECRET=change-me
AUTH_COOKIE_NAME=access_token
GOOGLE_AUTH_CLIENT_ID=change-me
GOOGLE_AUTH_CLIENT_SECRET=change-me
GOOGLE_AUTH_CALLBACK=https://api.example.com/auth/google/callback

# Игра
WIRED_GAME_TICKET_SECRET=change-me
WIRED_PACKAGE_READ_SECRET=change-me
WIRED_PACKAGE_READ_TTL_SEC=900
GODOT_ROOM_IDLE_TIMEOUT_MS=300000
GODOT_ROOM_PORT_START=19100
GODOT_ROOM_PORT_END=19199
GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM=32
GODOT_ROOM_WS_MAX_TOTAL=512

# Frontend (вшиваются в бандл при сборке)
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_BACKEND_URL=https://api.example.com
NEXT_PUBLIC_WEBSOCKET_URL=wss://api.example.com
NEXT_PUBLIC_HASHIDS_SALT=change-me
```

- [ ] **Step 3: Обновить `.gitignore` и `.dockerignore`**

`.gitignore`: добавить `.env.prod`, `.env.prod.*`, `!.env.prod.example`.
`.dockerignore`: добавить `**/.env`, `**/.env.*`, `packages/server/godot_editor`, `packages/server/godot_runtime`, `packages/server/game_export`, `packages/server/storage`, `.worktrees`, `.superpowers`, `docs`.

- [ ] **Step 4: Проверить правила**

Run: `git check-ignore -v .env.prod` → ожидается совпадение с правилом `.env.prod`.
Run: `git check-ignore -v .env.prod.example` → exit 1 (файл не игнорируется).

- [ ] **Step 5: Commit**

```bash
git add .env.prod.example .gitignore .dockerignore
git commit -m "chore: add production env template and build ignores"
```

---

### Task 3: Compose: имя проекта, healthcheck'и, env, volume'ы

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: ключи из `.env.prod.example` (Task 2), `default.conf.template` (Task 4).
- Produces: сервисы `db`, `backend`, `frontend`, `wired_nginx` с healthcheck'ами; volume'ы `wired_wired_db`/`wired_wired_storage`; точка монтирования `/app/storage`.

- [ ] **Step 1: Написать проверку, которая падает**

Run:
```bash
node -e "const t=require('fs').readFileSync('docker-compose.yml','utf8');const need=[/^name: wired$/m,/target: \/app\/storage/,/STORAGE_DIR=\/app\/storage/,/pg_isready/,/client_max_body_size|nginx\/conf/];const miss=need.filter(r=>!r.test(t));if(miss.length){console.error('missing',miss);process.exit(1)}"
```
Expected: exit 1 (в текущем файле нет `name`, absolute storage, healthcheck).

- [ ] **Step 2: Переписать `docker-compose.yml`**

Требования по сервисам:
- Верхний уровень: `name: wired`, без `version`.
- `db`: `image: postgres:18.1`, `POSTGRES_USER=${DB_USER}`, `POSTGRES_DB=${DB_NAME}`, `POSTGRES_PASSWORD=${DB_PASSWORD}`, volume `wired_db:/var/lib/postgresql`, healthcheck `["CMD-SHELL","pg_isready -U ${DB_USER} -d ${DB_NAME}"]`, `interval: 10s`, `timeout: 5s`, `retries: 10`, `start_period: 20s`.
- `backend`: build `backend.Dockerfile`; `depends_on: db: {condition: service_healthy}`; env — текущий список плюс `DB_USER`, `DB_NAME`, `AUTH_COOKIE_NAME`, `WIRED_PACKAGE_READ_SECRET`, `WIRED_PACKAGE_READ_TTL_SEC`, `GODOT_ROOM_IDLE_TIMEOUT_MS`, `GODOT_ROOM_PORT_START`, `GODOT_ROOM_PORT_END`, `GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM`, `GODOT_ROOM_WS_MAX_TOTAL`; `STORAGE_DIR=/app/storage` литералом; volume `wired_storage:/app/storage`; healthcheck `["CMD","node","-e","fetch('http://127.0.0.1:3000/api/docs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`, `interval: 15s`, `timeout: 5s`, `retries: 10`, `start_period: 60s`.
- `frontend`: build args и env — четыре `NEXT_PUBLIC_*`; без `depends_on`.
- `wired_nginx`: `image: nginx:stable`, volume `./nginx/conf:/etc/nginx/templates:ro`, env `COMMON_DOMAIN=${COMMON_DOMAIN}`, `depends_on` backend+frontend `service_healthy`, сети `wired` и `shared-net`, порт `${NGINX_EXTERNAL_PORT}:8080`.
- Все сервисы: `restart: always`, `logging: {driver: json-file, options: {max-size: "10m", max-file: "3"}}`.
- `networks: wired` (bridge), `shared-net` (external: true); `volumes: wired_db`, `wired_storage`.

- [ ] **Step 3: Проверить конфиг**

Run: `docker compose --env-file .env.prod.example config > /dev/null`
Expected: exit 0, без предупреждений о неопределённых переменных.
Run: `docker compose --env-file .env.prod.example config | grep -E "name: wired|wired_wired_"` (в PowerShell: `docker compose --env-file .env.prod.example config | Select-String "wired_wired_"`)
Expected: имя проекта и оба volume'а с префиксом `wired_`.

- [ ] **Step 4: Проверить, что проверка из шага 1 проходит**

Повторить команду шага 1 → exit 0.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "fix(compose): pin project name, add healthchecks and prod env"
```

---

### Task 4: Nginx-шаблон с доменом из env

**Files:**
- Create: `nginx/conf/default.conf.template` (переименование из `nginx/conf/default.conf`)
- Modify: ничего в compose (монтирование уже задано в Task 3)

**Interfaces:**
- Consumes: `COMMON_DOMAIN` из окружения контейнера.
- Produces: `/etc/nginx/conf.d/default.conf` после envsubst; upstream'ы `wired_frontend_upstream`, `wired_backend_upstream` без изменений.

- [ ] **Step 1: Проверка, которая падает**

Run: `node -e "const fs=require('fs');process.exit(fs.existsSync('nginx/conf/default.conf.template')?0:1)"`
Expected: exit 1.

- [ ] **Step 2: Создать шаблон**

Скопировать текущий `default.conf` и заменить:
- `server_name ~^wired\..+$;` → `server_name ${COMMON_DOMAIN};`
- `server_name ~^api\.wired\..+$;` → `server_name api.${COMMON_DOMAIN};`
- в API-сервер добавить `client_max_body_size 64m;`
Остальное (map, upstream'ы, таймауты 86400s, заголовки) не трогать. Удалить старый `default.conf`.

- [ ] **Step 3: Проверить шаблон через nginx**

Run:
```bash
docker run --rm -e COMMON_DOMAIN=example.com \
  -v "$PWD/nginx/conf:/etc/nginx/templates:ro" nginx:stable nginx -t
```
Expected: `syntax is ok`, `test is successful`; в выводе нет пустого `server_name`.

- [ ] **Step 4: Commit**

```bash
git add nginx/conf
git commit -m "feat(nginx): render server names from COMMON_DOMAIN"
```

---

### Task 5: Backend-образ с Godot и экспортом

**Files:**
- Modify: `backend.Dockerfile`

**Interfaces:**
- Consumes: `pnpm build:shared`/`build:server` (Task 1), скрипты `fetch:editor`, `fetch:runtime`, `fetch:templates`, `export:game`.
- Produces: образ с `/app/packages/server/{dist,godot_editor,godot_runtime,godot_project,game_export}`, `/app/packages/shared/dist`, `CMD ["node","packages/server/dist/server/src/main.js"]`.

- [ ] **Step 1: Проверка, которая падает**

Run: `node -e "const t=require('fs').readFileSync('backend.Dockerfile','utf8');const ok=/node:22-bookworm-slim/.test(t)&&!/node:20-slim/.test(t)&&/fetch:runtime/.test(t)&&/export:game/.test(t)&&/godot_project/.test(t);process.exit(ok?0:1)"`
Expected: exit 1.

- [ ] **Step 2: Переписать `backend.Dockerfile`**

Структура (точные значения обязательны):
1. `FROM node:22-bookworm-slim AS base`; `ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH XDG_DATA_HOME=/opt/godot-data`; `corepack enable`; `WORKDIR /app`.
2. `FROM base AS manifests`: копировать `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packages/*/package.json`, `frontend/package.json`; `pnpm install --frozen-lockfile` с `--mount=type=cache,id=pnpm,target=/pnpm/store`.
3. `FROM manifests AS prod-deps`: те же манифесты, `pnpm install --prod --frozen-lockfile`.
4. `FROM base AS assets`: `COPY packages/server/scripts ./packages/server/scripts`; `node packages/server/scripts/fetch-godot-editor.mjs`; `node packages/server/scripts/fetch-godot-templates.mjs`.
5. `FROM manifests AS runtime`: только `packages/server/scripts`, `node packages/server/scripts/fetch-godot-runtime.mjs`.
6. `FROM manifests AS build`: `COPY . .`; `pnpm build:shared`; `pnpm build:server`; `COPY --from=assets /opt/godot-data /opt/godot-data`; `COPY --from=runtime /app/packages/server/godot_runtime packages/server/godot_runtime`; `node packages/server/scripts/export-godot-web.mjs`.
7. `FROM node:22-bookworm-slim AS final`: `apt-get install -y --no-install-recommends libasound2 libpulse0 libfontconfig1 libfreetype6 libx11-6 libxcursor1 libxinerama1 libxrandr2 libxi6 libgl1 libdbus-1-3`; `ENV NODE_ENV=production PORT=3000 XDG_DATA_HOME=/opt/godot-data`; `WORKDIR /app`; копии: `prod-deps` → `/app/node_modules`, `/app/packages/server/node_modules`; `build` → `packages/server/dist`, `packages/server/godot_editor`, `packages/server/godot_project`, `packages/server/game_export`, `packages/shared/dist`; плюс `packages/shared/package.json`, `packages/server/package.json`, корневые `package.json`, `pnpm-workspace.yaml`; `EXPOSE 3000`; `CMD ["node","packages/server/dist/server/src/main.js"]`.

- [ ] **Step 3: Собрать образ**

Run: `docker build -f backend.Dockerfile -t wired-backend:test .`
Expected: успешная сборка; в логах `export:game` завершился без ошибок.

- [ ] **Step 4: Проверить содержимое образа**

Run: `docker run --rm -w /app wired-backend:test node -e "console.log(require('@wired-io/shared').GAME_ROOMS_TYPES)"`
Expected: `[ 'godot', 'ts-game' ]`.
Run: `docker run --rm --entrypoint ls wired-backend:test /app/packages/server/game_export/web/index.wasm`
Expected: путь напечатан, exit 0.
Run: `docker run --rm --entrypoint ls wired-backend:test /app/packages/server/godot_runtime`
Expected: каталог версии и `runtime.json`.

- [ ] **Step 5: Commit**

```bash
git add backend.Dockerfile
git commit -m "build(server): bake godot editor, runtime and web export"
```

---

### Task 6: Frontend-образ

**Files:**
- Modify: `frontend.Dockerfile`

**Interfaces:**
- Consumes: `build:frontend`, четыре `NEXT_PUBLIC_*` build arg.
- Produces: образ с `/.next`, `public`, `package.json`, `next.config.ts`, `node_modules`; `CMD ["node_modules/.bin/next","start","-p","3000"]`.

- [ ] **Step 1: Проверка, которая падает**

Run: `node -e "const t=require('fs').readFileSync('frontend.Dockerfile','utf8');if(/node:22-bookworm-slim/.test(t)&&!/pm2/.test(t)&&/next.*start/.test(t))process.exit(0);process.exit(1)"`
Expected: exit 1.

- [ ] **Step 2: Переписать `frontend.Dockerfile`**

1. `FROM node:22-bookworm-slim AS base`; `PNPM_HOME`/`PATH`, `corepack enable`, `WORKDIR /app`.
2. `manifests` + `pnpm install --frozen-lockfile` (cache mount).
3. `prod-deps` + `pnpm install --prod --frozen-lockfile`.
4. `build` из `manifests`: `COPY . .`; `ARG`/`ENV` для `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_WEBSOCKET_URL`, `NEXT_PUBLIC_HASHIDS_SALT`; `pnpm build:frontend`.
5. `final`: `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `WORKDIR /app`; копии из `prod-deps` — `/app/node_modules`, `/app/frontend/node_modules`; из `build` — `/app/frontend`; `EXPOSE 3000`; `CMD` из Interfaces.

- [ ] **Step 3: Собрать и проверить**

Run: `docker build -f frontend.Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://example.com --build-arg NEXT_PUBLIC_BACKEND_URL=https://example.com --build-arg NEXT_PUBLIC_WEBSOCKET_URL=wss://example.com --build-arg NEXT_PUBLIC_HASHIDS_SALT=test -t wired-frontend:test .`
Expected: успешная сборка.
Run: `docker run --rm --entrypoint ls wired-frontend:test /app/frontend/.next/BUILD_ID`
Expected: путь напечатан.

- [ ] **Step 4: Commit**

```bash
git add frontend.Dockerfile
git commit -m "build(frontend): drop pm2 and run next start on node 22"
```

---

### Task 7: Скрипт удалённого деплоя

**Files:**
- Create: `scripts/deploy-remote.sh` (chmod +x)

**Interfaces:**
- Consumes: `/home/Wired` (git checkout), `/home/Wired/.env`, `docker compose`.
- Produces: CLI `deploy-remote.sh [ref]`, переменные `DEPLOY_PATH`, `GIT_REMOTE`, `DRY_RUN`; коды выхода: `2` — preflight (нет каталога/прав), `3` — каталог не git, `4` — невалидный `.env`.

- [ ] **Step 1: Проверка, которая падает**

Run: `node -e "process.exit(require('fs').existsSync('scripts/deploy-remote.sh')?0:1)"`
Expected: exit 1.

- [ ] **Step 2: Написать скрипт**

Требуемое поведение и функции:
- `set -Eeuo pipefail`; `REF=${1:-main}`; `DEPLOY_PATH=${DEPLOY_PATH:-/home/Wired}`; `GIT_REMOTE=${GIT_REMOTE:-https://github.com/AshenHermit/Wired.git}`.
- `log()` с префиксом `[deploy]`.
- `detect_sudo()`: `SUDO=""`; если `id -u` не 0 и `sudo -n true` работает — `SUDO=sudo`; если root — пусто; иначе `exit 2` с сообщением, что нужен sudo без пароля.
- `ensure_docker()`: если нет `docker compose version` — `$SUDO sh -c 'curl -fsSL https://get.docker.com | sh'`; `$SUDO usermod -aG docker "$USER"`; если группа в текущей сессии не активна — `DOCKER="$SUDO docker"`, иначе `DOCKER=docker`.
- `ensure_network()`: `$DOCKER network inspect shared-net >/dev/null 2>&1 || $DOCKER network create shared-net`.
- `sync_code()`: если `[ -d "$DEPLOY_PATH/.git" ]` — `git -C "$DEPLOY_PATH" config --global --add safe.directory "$DEPLOY_PATH"` (ignore failure), проверка `[ -w "$DEPLOY_PATH/.git" ] || exit 2` с подсказкой `chown -R "$USER" "$DEPLOY_PATH"`, затем `git fetch --depth 1 origin "$REF"` + `git reset --hard FETCH_HEAD`; elif `[ -e "$DEPLOY_PATH" ]` — `exit 3`; else `git clone --depth 1 --branch "$REF" "$GIT_REMOTE" "$DEPLOY_PATH"`.
- `normalize_env()`: `sed -i 's/\r$//' "$DEPLOY_PATH/.env"`; убрать пробелы вокруг `=`? нет; только CRLF.
- `validate_env()`: цикл по списку `DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD AUTH_SECRET COMMON_DOMAIN SITE_HOST WIRED_GAME_TICKET_SECRET NEXT_PUBLIC_HASHIDS_SALT NEXT_PUBLIC_API_URL NEXT_PUBLIC_BACKEND_URL NEXT_PUBLIC_WEBSOCKET_URL`; значение берётся из `awk -F= '/^KEY=/{print substr($0,index($0,"=")+1)}'`; пусто → `exit 4` с именем ключа. Файл отсутствует → `exit 4`.
- `compose()`: `$DOCKER compose --project-directory "$DEPLOY_PATH" -f "$DEPLOY_PATH/docker-compose.yml" "$@"`.
- `DRY_RUN=1`: печатать команды вместо выполнения (для `sync_code`, `ensure_*`, `compose`), не требовать docker.
- Основной поток: `detect_sudo`, `ensure_docker`, `ensure_network`, `sync_code`, `normalize_env`, `validate_env`, `compose build --pull`, `compose up -d --force-recreate --wait`, `$DOCKER image prune -f`.

- [ ] **Step 3: Проверить синтаксис и dry-run**

Run: `bash -n scripts/deploy-remote.sh` (если bash нет — `docker run --rm -v "$PWD/scripts:/s:ro" bash:5 bash -n /s/deploy-remote.sh`)
Expected: exit 0.
Run (PowerShell): `$env:DRY_RUN="1"; $env:DEPLOY_PATH="/tmp/wired-test"; bash scripts/deploy-remote.sh main`
Expected: печатает план, exit 0, ничего не меняет.
Run: `$env:DEPLOY_PATH="/tmp/non-git"; bash scripts/deploy-remote.sh` после создания каталога без `.git`
Expected: `exit 3`.

- [ ] **Step 4: Проверить нормализацию CRLF**

Run (bash): `printf 'DB_HOST=db\r\n' > /tmp/crlf.env && sed -i 's/\r$//' /tmp/crlf.env && ! grep -q $'\r' /tmp/crlf.env`
Expected: exit 0. Это ровно та команда, которую вызывает `normalize_env`.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-remote.sh
git commit -m "feat(deploy): add idempotent remote deploy script"
```

---

### Task 8: Workflow деплоя

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `scripts/deploy-remote.sh` (Task 7), `.env.prod.example` (Task 2).
- Produces: workflow `Deploy` с job'ами `verify` и `deploy`.

- [ ] **Step 1: Проверка, которая падает**

Run: `node -e "process.exit(require('fs').existsSync('.github/workflows/deploy.yml')?0:1)"`
Expected: exit 1.

- [ ] **Step 2: Написать workflow**

Требования:
- `name: Deploy`; `on: {push: {branches: [main]}, workflow_dispatch: {}}`; `concurrency: {group: deploy-production, cancel-in-progress: false}`; `permissions: {contents: read}`.
- `verify` (ubuntu-latest): `actions/checkout@v4`; `pnpm/action-setup@v4` (без `version:` — берётся из `packageManager`); `actions/setup-node@v4` с `node-version: 22` и `cache: pnpm`; `pnpm install --frozen-lockfile`; `pnpm build:shared`; `pnpm --filter server test`; `pnpm --filter frontend test`; `pnpm check-types:frontend`.
- `deploy` (`needs: verify`, `environment: production`): checkout; `mkdir -p ~/.ssh`; запись `secrets.SSH_PRIVATE_KEY` в `~/.ssh/id_ed25519` с `chmod 600`; `ssh-keyscan -p ${SSH_PORT:-22} -H "$SSH_HOST" >> ~/.ssh/known_hosts`; запись env: `printf '%s\n' "$PROD_ENV" | ssh ... 'umask 077 && cat > "$DEPLOY_PATH/.env"'`; затем `ssh ... "DEPLOY_PATH='$DEPLOY_PATH' bash -s -- '$GITHUB_REF_NAME'" < scripts/deploy-remote.sh`.
- `env` job'а: `SSH_HOST: ${{ secrets.SSH_HOST }}`, `SSH_USER`, `SSH_PORT: ${{ secrets.SSH_PORT || '22' }}`, `DEPLOY_PATH: ${{ vars.DEPLOY_PATH || '/home/Wired' }}`, `PROD_ENV: ${{ secrets.PROD_ENV }}`.
- Не логировать `PROD_ENV`; `set -x` не использовать.

- [ ] **Step 3: Проверить YAML**

Run: `docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:latest`
Expected: без ошибок.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy to production on main and manual dispatch"
```

---

### Task 9: Разовая настройка и приёмочная проверка

**Files:** нет изменений в коде.

**Interfaces:**
- Consumes: секреты репозитория, SSH-доступ, DNS/внешний nginx.

- [ ] **Step 1: Заполнить секреты**

`SSH_HOST`, `SSH_USER` (пользователь с sudo без пароля), `SSH_PRIVATE_KEY`, `PROD_ENV` — содержимое `.env.prod`. `SSH_PORT` и переменная `DEPLOY_PATH` — опционально.

- [ ] **Step 2: Запустить workflow вручную** (`workflow_dispatch`) и убедиться, что `verify` и `deploy` зелёные.

- [ ] **Step 3: Проверить стек на сервере**

- `docker ps` — четыре контейнера `wired_*` в состоянии `healthy`.
- `curl -H 'Host: <COMMON_DOMAIN>' http://127.0.0.1:${NGINX_EXTERNAL_PORT}/` — 200.
- `curl -H 'Host: api.<COMMON_DOMAIN>' http://127.0.0.1:${NGINX_EXTERNAL_PORT}/api/docs` — 200.
- `docker volume ls | grep wired_wired_` — оба volume'а на месте, старые комнаты открываются.

- [ ] **Step 4: Повторный прогон** — контейнеры пересозданы, данные сохранены, экспорт игры открывается во вкладке Game.
