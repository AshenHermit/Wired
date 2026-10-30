# AGENTS.md

Wired is a browser-based Godot game platform: Next.js frontend + NestJS API/asset server + shared TypeScript contracts. The Godot editor runs entirely client-side as WASM.

## Repo map

- `frontend/` — Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui (`components.json`, new-york style, animate-ui registry). `(browser)` group holds login/rooms; `room/[room_code]/(godot)/` holds the editor, Packages tab, and Game tab.
- `packages/server/` — NestJS 11 + TypeORM/Postgres, Swagger at `/api/docs`. Entrypoints: `src/main.ts`, `src/app.module.ts`. Modules: `auth`, `users`, `rooms`, `scripting-packages`, `godot-editor-provider`, `godot-game` (room runtime, tickets, package sync, game export). `godot_game` is not a stub.
- `packages/shared/` — only API types/payloads (`src/api/types.ts`), imported via tsconfig path aliases. No runtime package build is needed for dev; `build:types` emits declarations only.
- `packages/server/godot_editor/` (committed WASM editor, ~80 MB) and `packages/server/godot_project/_wired/` (shared base Godot project) are committed assets.
- `docs/superpowers/{specs,plans}/` — checked-in design docs, including dropping Phaser and Godot-only multiplayer/packages.
- No CI, no migrations, no root README. Tests: 32 server Jest specs + 7 frontend Vitest files.

## Architecture facts that bite

- **Godot-only.** `GAME_ROOMS_TYPES` must keep legacy `"ts-game"` because `DB_SYNC=1` and old rows exist; only `AVAILABLE_GAME_ROOMS_TYPES` (`["godot"]`) can be created. Don't narrow the entity enum or delete legacy `ts-game` handling without a DB plan.
- Room/package/user URLs use Hashids, not raw IDs (`frontend/src/utils/hash-utils.ts`). The salt is `NEXT_PUBLIC_HASHIDS_SALT`, falling back to `NEXT_PUBLIC_WEBSOCKET_URL`, then a constant. Changing it invalidates every existing `/room/<code>` link. Decode before calling the API.
- API calls are browser-only: `frontend/src/api/services/*` → `client-api.ts` axios with `NEXT_PUBLIC_BACKEND_URL` and `Authorization: Bearer` copied from the `access_token` cookie (`AUTH_COOKIE_NAME`). `server-api.ts` and `remote-api.ts` are unused. Don't add server-side fetches expecting the auth cookie to propagate.
- Server paths are resolved from **cwd** at config load (`src/config/config.ts`): editor assets, `godot_project`, `storage`, `game_export`. Run the server through pnpm from `packages/server` (root scripts do); launching `node packages/server/dist/...` from the repo root 404s assets and writes storage to the wrong place.
- COOP/COEP headers (`frontend/next.config.ts` and the editor/export controllers) are required by the WASM editor (SharedArrayBuffer). They are set on `/:path*`, not just `/room/*`, because client-side navigation does not reload the document. The `/api/*` rewrite proxies to `NEXT_PUBLIC_BACKEND_URL`; Godot asset URLs depend on it.
- UI auth is Google OAuth only. Backend also has email/password endpoints. The Google callback sets the cookie on `COMMON_DOMAIN`, then redirects to `SITE_HOST`.
- The room "Game" tab runs the client-side Godot Web export in a same-origin iframe. `POST /rooms/:id/game/connection` starts/reuses that room's native Godot runtime and mints a single-use ticket (request a fresh one per attempt); `GET /rooms/:id/game/status` reads state without starting anything; `GET /rooms/:id/game/packages` reports how far the runtime/clients have applied published revisions. All are browser-only and called through `/api/*`.
- Runtime package delivery signs short-lived read URLs with `WIRED_PACKAGE_READ_SECRET` (fallback `WIRED_GAME_TICKET_SECRET`) and `WIRED_PACKAGE_READ_TTL_SEC` (default 900s). Artifacts are built under `<PACKAGES_FILES_DIR>/<packageId>/runtime/v1/<roomId>/<revision>/<artifactKey>/`; only the newest three per `<package>/<room>/<revision>` are retained. Every dependency publish creates a new artifact key for each dependent, so storage grows with publishes, bounded by that retention window; stale directories are pruned after a successful build.
- The Web export is a **build artifact** (`packages/server/game_export/web` by default, `GODOT_GAME_EXPORT_DIR` overrides it, gitignored). Keep it **outside** `godot_project/_wired`: that directory is the shared base project for every room and `GET /godot-project-info/wired` copies its files into the editor FS (it also skips `build/`, `storage/`, `.godot/`). Run `pnpm export:game` before opening the Game tab; the backend serves the export at `/game-export/*` with COOP/COEP. A clean Docker deploy must mount or build this directory - the image only contains `dist` and `node_modules`, so otherwise the tab correctly reports a missing build.

## Commands

```bash
pnpm install
pnpm dev:server                          # Nest watch; needs the Postgres in packages/server/.env
pnpm --filter frontend dev -- -p 3001    # backend owns :3000; SITE_HOST expects :3001
pnpm check-types:frontend
pnpm --filter server build               # also the server typecheck (no separate script)
pnpm --filter frontend build             # next build --webpack
pnpm --filter frontend lint              # eslint, no auto-fix
pnpm --filter server lint                # eslint --fix
pnpm export:game                         # rebuild the Godot Web export; needs GODOT_RUNTIME_PATH
pnpm build                               # recursive: server + frontend (not shared declarations)
```

- Server tests: `pnpm --filter server test` (Jest, `rootDir` `packages/server/src`, `*.spec.ts`). Currently green: 31 suites/314 tests pass and `room-runtime.integration` is skipped unless opted in.
- Single server spec: `pnpm --filter server exec jest create-room.dto.spec`.
- Opt-in real-Godot integration: `WIRED_GODOT_INTEGRATION=1 GODOT_RUNTIME_PATH=<godot-console.exe> pnpm --filter server exec jest room-runtime.integration --runInBand`.
- Frontend tests: `pnpm --filter frontend test` (Vitest + jsdom, co-located `src/**/*.test.{ts,tsx}`). Single file: `pnpm --filter frontend exec vitest run GameTab`.
- `pnpm export:game` itself reads `packages/server/.env` for `GODOT_RUNTIME_PATH`/`GODOT_RUNTIME_PROJECT_PATH`; it fails fast if the executable or `project.godot` is missing.
- Root `pnpm dev` is not a full-stack command (`server` has `start:dev`, not `dev`). Use the two dev commands above.
- Next uses Webpack intentionally (`--webpack`); don't switch to Turbopack casually.

## Env and deploy

- Three gitignored env files, not one: root `.env` (Docker Compose), `packages/server/.env` (Nest and `export:game`, loaded from the package cwd), and `frontend/.env.local` (Next). Changing a URL or port often means editing more than one. Never commit or echo their contents.
- The current env points `DB_HOST` at a **remote shared Postgres** with `DB_SYNC=1`. Starting the server auto-mutates the schema; treat entity/DB changes as production-affecting.
- Runtime knobs (see `src/config/config.ts` for defaults): `GODOT_RUNTIME_PATH`, `GODOT_RUNTIME_PROJECT_PATH`, `GODOT_GAME_EXPORT_DIR`, `GODOT_ROOM_PORT_START/END`, `GODOT_ROOM_IDLE_TIMEOUT_MS`, `GODOT_ROOM_API_URL`, `GODOT_GAME_TICKET_RATE_LIMIT`/`_RATE_WINDOW_MS`, and `WIRED_GAME_TICKET_SECRET` (mandatory; never send it to the browser).
- Docker: `docker compose up --build`. Compose expects an external `shared-net` network (nginx joins it), so create it first; it also defines its own `db` service. Frontend `NEXT_PUBLIC_*` values are Docker build args — rebuild the frontend image after changing them.
- Server build emits `packages/server/dist/server/src/main.js`; `start:prod` depends on that path.
- The editor controller uses `glob` from `node:fs/promises` (Node 22+ API), while the Dockerfiles pin Node 20. `export:game` also declares Node >= 22. Verify in-container behavior before relying on `/godot-project-info/wired` or `export:game` there.

## Conventions

- Conventional Commits (`feat:`, `refactor(server):`, `chore:`) are the norm.
- Server Prettier: single quotes, trailing commas. ESLint is type-aware; server `lint` auto-fixes, frontend `lint` does not.
- UI copy and docs are largely Russian; match the language and UTF-8 encoding of the file you edit.
- API contract changes belong in `packages/shared/src/api/types.ts` plus matching server DTOs/entities. There is no codegen.
