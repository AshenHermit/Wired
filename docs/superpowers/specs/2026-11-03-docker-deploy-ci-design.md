# Docker-деплой и GitHub Actions — дизайн

Дата: 2026-11-03

## Задача

Привести Docker-образы проекта в рабочее состояние и настроить автоматический
деплой: push в `main` (и ручной запуск из панели Actions) доставляет код на
сервер, сервер сам собирает образы и пересоздаёт контейнеры. Env-файлы пишутся
на сервер из GitHub Secrets — руками по SSH заходить не нужно. Репозиторий на
сервере заранее никак не готовится.

## Что не так сегодня

Проверено по коду и файлам:

- `backend.Dockerfile` / `frontend.Dockerfile` собираются на `node:20-slim`, а
  коду нужен Node 22+ (`glob` из `node:fs/promises` в контроллере редактора,
  `import.meta.dirname` в скриптах `fetch:*`/`export:game`).
- В финальный backend-образ не копируется `packages/server/godot_project`
  (общая база проекта для редактора и рантайма) и нет нативного Godot
  (`pnpm fetch:runtime`, linux-x64 ~62 МБ) — комната запускается как
  `--headless` процесс из `godot_project/_wired`.
- Нет web-экспорта игры (`pnpm export:game`) → вкладка Game после деплоя
  показывает «сборки нет».
- `COPY . .` идёт до `pnpm install` — слой зависимостей не кэшируется.
  `.dockerignore` не исключает `godot_runtime`, `godot_editor`, `game_export`,
  `storage`, `.env`, `.worktrees`.
- `@wired-io/shared` не резолвится в рантайме: у пакета нет `main`, `build`
  собирает только `.d.ts`, а сервер импортирует оттуда значения
  (`GAME_ROOMS_TYPES`, `AVAILABLE_GAME_ROOMS_TYPES`). `require` из
  `packages/server` падает с `MODULE_NOT_FOUND` — контейнер умрёт на старте.
- В корневом `.env` нет `WIRED_GAME_TICKET_SECRET` и `NEXT_PUBLIC_HASHIDS_SALT`:
  без первого не стартует рантайм комнат, без второго меняется соль хэшей и
  все существующие `/room/<code>` перестают открываться.
- `docker-compose.yml`: устаревший `version`, нет healthcheck (и `depends_on`
  без условий), часть переменных не прокинута (`DB_USER`, `DB_NAME`,
  `WIRED_PACKAGE_READ_SECRET`, `WIRED_PACKAGE_READ_TTL_SEC`).
- `nginx/conf/default.conf` жёстко ждёт `wired.*` / `api.wired.*`, лимит тела
  запроса по умолчанию 1 МБ (загрузка пакетов упадёт на 413).
- `.github/` отсутствует.

## Цели

- Один прогон workflow на сервере, где есть только SSH и ключ, доводит его
  до работающего стека: Docker, сеть, код, `.env`, образы, контейнеры.
- Повторный прогон — пересборка и пересоздание контейнеров без потери данных
  в volume'ах (`wired_wired_db`, `wired_wired_storage`).
- Существующий деплой в `/home/Wired` (контейнеры и данные) подхватывается
  тем же compose-проектом: данные остаются, ничего постороннего не удаляется.
- Env-файлы живут в GitHub Secrets, пишутся на сервер каждым деплоем.
- После деплоя работает всё: редактор (Godot web), комнаты (нативный рантайм),
  вкладка Game (web-экспорт), загрузка пакетов.

## Не-цели

- Миграции БД: их в проекте нет, `DB_SYNC=1` синхронизирует схему при старте.
- Мультиархитектурные образы: сервер — linux/amd64.
- Откат на предыдущий образ, blue-green, бэкапы БД.
- Секреты в Docker/K8s/SSM: только GitHub Secrets → файл на сервере.
- Изменение доменной схемы или добавление TLS внутри compose: перед
  `wired_nginx` остаётся внешний nginx на `shared-net`, как сейчас.

## Принятые решения

### 1. Сборка на сервере, доставка по SSH

Workflow на `ubuntu-latest` подключается к серверу по SSH и запускает
скрипт, который лежит в репозитории. Self-hosted runner отвергнут: его надо
ставить руками на сервер, а это ровно то, чего быть не должно.

Логика деплоя живёт в `scripts/deploy-remote.sh` и каждый раз передаётся на
сервер по stdin (`ssh user@host 'bash -s -- main' < scripts/deploy-remote.sh`):
на сервере всегда исполняется версия скрипта из деплояемого коммита, а не
устаревшая копия в репозитории.

Скрипт идемпотентен:

1. `sudo -n true` проверяется один раз; `$SUDO` остаётся пустым, если sudo не
   нужен. Deploy-пользователь имеет sudo без пароля — это подтверждено; при
   sudo с паролем скрипт падает на шаге preflight до любых изменений.
2. Нет `docker`/`docker compose` → установка через `https://get.docker.com` и
   `usermod -aG docker "$USER"`; при отсутствии группы `docker` в текущей
   сессии дальше используется `$SUDO docker` (следующий SSH-сеанс уже увидит
   группу).
3. `docker network inspect shared-net` → `create`, если сети нет.
4. Каталог проекта `/home/Wired` уже существует и в нём лежит рабочая копия
   репозитория. Если `/home/Wired/.git` есть —
   `git fetch --depth 1 origin <ref>` + `git reset --hard FETCH_HEAD`; если
   каталога нет — `git clone`; если каталог есть, но это не git-репозиторий —
   скрипт останавливается с внятной ошибкой и ничего не удаляет.
5. Проверка `.env` на непустые обязательные ключи (после записи из секрета).
6. `docker compose build --pull`, затем `up -d --force-recreate --wait`.
   `--remove-orphans` не используется, `docker container prune` не
   вызывается: чужие контейнеры на сервере не трогаются. Выполняется только
   `docker image prune -f` (только dangling-образы, освобождает место после
   пересборки).

`PATH` проекта, ветка и URL репозитория — параметры скрипта с дефолтами
(`/home/Wired`, `main`, `https://github.com/AshenHermit/Wired.git`).

### 2. Env: `.env.prod` и один секрет на файл (вариант B)

Выбран владельцем проекта. Прод-переменные живут в локальном
**`.env.prod`** (gitignore), который целиком копируется в GitHub Secret
`PROD_ENV`. Workflow пишет его на сервер до сборки:

```bash
ssh ... 'umask 077 && cat > /home/Wired/.env' <<< "$PROD_ENV"
```

На сервере файл называется `.env` — это имя, которое `docker compose` читает
сам, без флагов. Локальный `.env.prod` остаётся источником правды и местом
для правок; `.env` в корне репозитория продолжает обслуживать локальный
compose и не участвует в деплое.

В репозитории появляется `.env.prod.example` — полный список ключей с
комментариями, заглушками и безопасными дефолтами, плюс строка в `.gitignore`
на `.env.prod` и `.env.prod.*`. Шаблон же служит чек-листом: секрет в GitHub
write-only, обратно его не прочитать.

`packages/server/.env` нужен только локальному `start:dev` и `export:game`
(в образе скрипт берёт значения из окружения), `frontend/.env.local` в образ
не попадает — `NEXT_PUBLIC_*` передаются build args. Оба файла остаются
локальными и в деплое не участвуют.

Секрет должен содержать `WIRED_GAME_TICKET_SECRET` и
`NEXT_PUBLIC_HASHIDS_SALT` (в текущем локальном `.env` их нет). Скрипт падает
до сборки, если ключ пуст, — вместо «контейнер поднялся, но комнаты не
работают».

### 3. Game-экспорт запекается в backend-образ

На этапе сборки образа выполняются `pnpm fetch:templates` (архив 1,35 ГБ) и
`pnpm export:game`; в финальный слой попадает только `game_export/web`
(несколько десятков МБ). Скачивание шаблонов вынесено в отдельный слой,
который зависит только от скриптов `packages/server/scripts`, поэтому на
сервере кэшируется между деплоями и повторно не грузится.

Альтернатива — отдельный контейнер-экспортёр и volume — отвергнута: тот же
объём скачивания, но появляется состояние на сервере и рассинхрон «код
новый, экспорт старый».

### 4. Nginx: домен через envsubst

`nginx/conf/default.conf` → `nginx/conf/default.conf.template`, монтируется в
`/etc/nginx/templates` (штатный механизм образа `nginx`). В compose сервису
передаётся `COMMON_DOMAIN`. `server_name` становится
`${COMMON_DOMAIN}` для фронтенда и `api.${COMMON_DOMAIN}` для API — это
совпадает с `site.apiDomain = 'api.' + COMMON_DOMAIN` в конфиге сервера и
работает и для `wired.example.com`, и для `example.com`. Официальный
entrypoint подставляет только имена переменных, присутствующие в окружении,
поэтому `$host`, `$http_upgrade` и прочие переменные nginx не ломаются.

Дополнительно: `client_max_body_size 64m` на API-сервере (загрузка пакетов),
healthcheck'и для `db`, `backend`, `frontend`, убран `version`.

### 5. Node в образах

Базовый образ — `node:22-bookworm-slim` (LTS, удовлетворяет требованию
`>=22`). pnpm фиксируется полем `packageManager` в корневом `package.json`
(`pnpm@10.12.1`, та же версия, что в локальном окружении и локфайле) и
активируется через `corepack`.

Backend-образ ставит системные библиотеки, нужные линкованному бинарю Godot
даже в `--headless`: `libasound2`, `libpulse0`, `libfontconfig1`,
`libfreetype6`, `libx11-6`, `libxcursor1`, `libxinerama1`, `libxrandr2`,
`libxi6`, `libgl1`, `libdbus-1-3`. Без них `fetch:runtime` проходит, а спавн
комнаты падает на старте процесса.

Контейнеры остаются под root, как сейчас. Рабочий каталог `/app` совпадает с
ожиданиями конфига (пути резолвятся от cwd). Причина: существующий volume
`wired_wired_storage` записан контейнером, работавшим от root, и переход на
`node` сделал бы старые файлы нечитаемыми/незаписываемыми без ручного
`chown` на сервере — то есть первый же деплой потребовал бы SSH. Смена
пользователя — отдельная задача с миграцией прав.

### 6. Фикс `@wired-io/shared`

- `packages/shared/tsconfig.build.json`: CommonJS, `outDir: dist`,
  `rootDir: src`, declarations.
- `packages/shared/package.json`: `main: dist/index.js`,
  `types: dist/index.d.ts`, `build: tsc -p tsconfig.build.json`.
- Корневой `build:shared` переключается на `build`; `build` сервера получает
  `prebuild`, чтобы `pnpm --filter server build` не падал на чистом клоне.
- Frontend не затрагивается: Next резолвит shared через `tsconfig` paths и
  компилирует исходники сам.

## Образы

### backend.Dockerfile (переписывается)

1. `base`: `node:22-bookworm-slim`, `corepack enable`, `WORKDIR /app`.
2. `manifests` ← `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
   `packages/*/package.json`, `frontend/package.json`; `pnpm install
   --frozen-lockfile` (полный, с devDeps) с cache-mount на store.
3. `prod-deps` — те же манифесты, `pnpm install --prod --frozen-lockfile`.
4. `assets` ← только `packages/server/scripts`; `pnpm --filter server
   fetch:editor` и `fetch:templates`. Слой не инвалидируется правками кода.
5. `build` ← весь исходник; `pnpm build:shared`, `pnpm build:server`,
   `pnpm export:game` (использует runtime из `fetch:runtime`).
6. `runtime` ← `packages/server/scripts`; `pnpm --filter server fetch:runtime`.
7. `final`: системные библиотеки, `NODE_ENV=production`, копии `node_modules`
   (prod), `packages/server/dist`, `packages/shared/dist`, `godot_editor`,
   `godot_runtime`, `godot_project`, `game_export`, манифесты workspace.
   `USER node`, `EXPOSE 3000`, `CMD ["node", "packages/server/dist/server/src/main.js"]`.

`fetch:runtime` вынесен в отдельный слой после `assets`, чтобы смена кода не
перекачивала 62 МБ.

### frontend.Dockerfile (переписывается)

1. `base` + `pnpm install` (как выше).
2. `build`: `ARG`/`ENV` для четырёх `NEXT_PUBLIC_*`, `pnpm build:frontend`.
3. `final`: `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, копии
   `/app/node_modules` (prod), `/app/frontend/node_modules`, `.next`, `public`,
   `package.json`, `next.config.ts`. Пользователь `node`, `EXPOSE 3000`,
   `CMD ["node_modules/.bin/next", "start", "-p", "3000"]`.
   `pm2`, который сейчас ставится и не используется, убирается.

## Docker Compose

- `version` удаляется. Добавляется `name: wired`.

  Это ключевой пункт для существующего деплоя. Имя compose-проекта задаёт
  префикс контейнеров, volume'ов и сети: без `name` compose берёт имя
  каталога. Сейчас проект запущен из `/home/Wired`, поэтому префикс и так
  `wired`, а данные лежат в `wired_wired_db` / `wired_wired_storage`. Явное
  `name: wired` фиксирует это имя навсегда: деплой из любого другого каталога
  или через другой путь не создаст новые пустые volume'ы и не оставит старые
  данные сиротами.
- `db`: собственный Postgres из compose (прод не использует удалённую общую
  базу). `DB_HOST=db`, `POSTGRES_USER=postgres`, `POSTGRES_DB=postgres`,
  `POSTGRES_PASSWORD=${DB_PASSWORD}`; healthcheck `pg_isready -U postgres`
  с `start_period` — реальный, а не декоративный.
- `backend`: `depends_on: db: condition: service_healthy`; healthcheck через
  `node -e "fetch('http://127.0.0.1:3000/api/docs')…"`; в `environment`
  добавляются `DB_USER`, `DB_NAME`, `WIRED_PACKAGE_READ_SECRET`,
  `WIRED_PACKAGE_READ_TTL_SEC`, `AUTH_COOKIE_NAME`, `GODOT_ROOM_*` (таймауты
  и лимиты) с дефолтами из `.env`.
  `STORAGE_DIR` задаётся в compose константой `/app/storage`, а volume
  монтируется туда же: `${STORAGE_DIR}` из `.env` как target ломается, если
  значение относительное (compose требует абсолютный путь), и не должен
  управляться из env.
- `frontend`: `depends_on: backend: service_healthy`; healthcheck на `/`.
- `wired_nginx`: шаблон конфига, `COMMON_DOMAIN`, `depends_on` по здоровью
  бэкенда и фронтенда.
- Сеть `shared-net` остаётся `external: true`; её создаёт deploy-скрипт.
- `logging` (json-file, `max-size: 10m`, `max-file: 3`) для всех сервисов —
  иначе Godot-рантайм и логи комнат забивают диск.

## GitHub Actions

`.github/workflows/deploy.yml`:

- Триггеры: `push: branches: [main]`, `workflow_dispatch`.
- `concurrency: group: deploy-production, cancel-in-progress: false` — второй
  деплой ждёт, а не рвёт первый.
- `permissions: contents: read`.
- Job `verify` (ubuntu-latest): `pnpm/action-setup` (версия из
  `packageManager`), `actions/setup-node` с кэшем pnpm, `pnpm install
  --frozen-lockfile`, `pnpm build:shared`, `pnpm --filter server test`,
  `pnpm --filter frontend test`, `pnpm check-types:frontend`.
- Job `deploy` (`needs: verify`): checkout → запись ключа в
  `~/.ssh/id_ed25519` → `ssh-keyscan` в `known_hosts` → запись `PROD_ENV` в
  `/home/Wired/.env` → запуск `scripts/deploy-remote.sh` по stdin с нужным ref.
- Секреты: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `SSH_PORT`
  (опционально, дефолт 22), `PROD_ENV`. Переменная `DEPLOY_PATH`
  (опционально, дефолт `/home/Wired`).

`verify` — моё решение, а не требование задачи: деплой непроверенного `main`
на единственный сервер дороже, чем две минуты тестов. Убирается удалением
джобы и `needs`.

## .env.prod.example

Список ключей (значения-заглушки, без секретов):

- Compose/порты: `DB_EXTERNAL_PORT`, `BACKEND_EXTERNAL_PORT`,
  `FRONTEND_EXTERNAL_PORT`, `NGINX_EXTERNAL_PORT`, `TZ`, `PORT`,
  `STORAGE_DIR`.
- БД: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`, `DB_PASSWORD`, `DB_SYNC`.
- Auth/домен: `AUTH_SECRET`, `AUTH_COOKIE_NAME`, `GOOGLE_AUTH_CLIENT_ID`,
  `GOOGLE_AUTH_CLIENT_SECRET`, `GOOGLE_AUTH_CALLBACK`, `SITE_HOST`,
  `COMMON_DOMAIN`.
- Игра: `WIRED_GAME_TICKET_SECRET`, `WIRED_PACKAGE_READ_SECRET`,
  `WIRED_PACKAGE_READ_TTL_SEC`, `GODOT_ROOM_*`.
- Frontend (build args): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BACKEND_URL`,
  `NEXT_PUBLIC_WEBSOCKET_URL`, `NEXT_PUBLIC_HASHIDS_SALT`.

## Риски и ограничения

- Холодная сборка на сервере скачивает ~1,4 ГБ (редактор, рантайм, шаблоны)
  и занимает минуты; при отсутствии исходящего доступа к GitHub образ не
  соберётся. RAM хоста 16 ГБ — с запасом хватает на буфер шаблонов (1,35 ГБ)
  и параллельный экспорт Godot.
- Первый прогон с существующим стеком: контейнеры того же проекта
  пересоздаются, volume'ы остаются. Если на хосте заняты порты из
  `DB_EXTERNAL_PORT`/`BACKEND_EXTERNAL_PORT`/`FRONTEND_EXTERNAL_PORT`/
  `NGINX_EXTERNAL_PORT`, `up` упадёт на конфликте — это видно сразу, данные
  не затрагиваются. Контейнеры и volume'ы вне проекта `wired` деплой не
  трогает: чистку пользователь делает сам.
- `docker compose up --force-recreate` перезапускает backend → активные
  комнаты и их Godot-процессы завершаются; клиенты переподключаются.
- `DB_SYNC=1` мутирует схему при старте; откат кода не откатывает схему.
- `NEXT_PUBLIC_*` вшиваются в бандл при сборке: смена домена требует
  пересборки фронтенда (compose делает это каждый деплой).
- Секрет `PROD_ENV` — единственная точка отказа: ошибка в нём ломает деплой,
  но проверка обязательных ключей в скрипте ловит пустые значения.
- Файл `.env.prod` на Windows почти наверняка с CRLF: скрипт снимает `\r`
  перед проверкой, иначе значение `DB_PASSWORD` уедет с хвостовым `\r` и
  Postgres не пустит приложение.
- `$` в значениях `.env` compose интерполирует (`$HOST` станет пустотой или
  чужой переменной). В шаблоне это описано; секреты с `$` надо либо не
  использовать, либо экранировать как `$$`.
- Рабочая копия в `/home/Wired` могла быть создана под root: `git fetch`
  упадёт на ownership. Скрипт проверяет запись в каталог и падает с
  подсказкой про `chown`, а не чинит права молча.
- Внешний nginx (vhost, DNS, TLS) остаётся вне репозитория и настраивается
  один раз руками; деплой проверяет стек через `Host`-заголовок, не полагаясь
  на edge.

## Проверка результата

1. `docker compose config` — валидный итоговый файл, все переменные подставлены.
2. `docker build` обоих образов на чистом клоне.
3. В контейнере backend: `node -e "require('@wired-io/shared')"` резолвится;
   экспорт игры в образе уже отработал и `game_export/web/index.wasm` на месте.
4. `curl` к контейнеру `wired_nginx` с `-H 'Host: <COMMON_DOMAIN>'`:
   фронтенд отдаёт страницу, `/api/docs` открывается, `/game-export/index.html`
   доступен. Проверка не зависит от внешнего nginx.
5. Комната: создать комнату, открыть редактор, вкладка Game → рантайм
   стартует, тикет выдаётся, статус `running`.
6. Повторный прогон workflow: контейнеры пересозданы, `docker volume ls`
   по-прежнему показывает `wired_wired_db`/`wired_wired_storage`, старые
   комнаты и пользователи на месте.
