# AGENTS.md

Wired is a browser-based Godot game platform: Next.js frontend + NestJS API/asset server + shared TypeScript contracts. The Godot editor runs entirely client-side as WASM.

## Repo map

- `frontend/` — Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui (`components.json`, new-york style, animate-ui registry). `(browser)` group holds login/rooms; `room/[room_code]` holds the Godot editor.
- `packages/server/` — NestJS 11 + TypeORM/Postgres, Swagger at `/api/docs`. Modules: `auth`, `users`, `rooms`, `scripting-packages`, `godot-editor-provider`; `godot-game` is an empty stub.
- `packages/shared/` — only API types/payloads (`src/api/types.ts`), imported via tsconfig path aliases. No runtime package build is needed for dev; `build:types` emits declarations only.
- `docs/superpowers/{specs,plans}/` — checked-in design docs, including the decision to drop Phaser and support only Godot.
- No CI, no migrations, and only two Jest specs.

## Architecture facts that bite

- **Godot-only.** `GAME_ROOMS_TYPES` must keep legacy `"ts-game"` because `DB_SYNC=1` and old rows exist; only `AVAILABLE_GAME_ROOMS_TYPES` (`["godot"]`) can be created. Don't narrow the entity enum or delete legacy `ts-game` handling without a DB plan.
- Room/package/user URLs use Hashids, not raw IDs (`frontend/src/utils/hash-utils.ts`). The secret is `NEXT_PUBLIC_WEBSOCKET_URL + type`, so changing that env var breaks every existing `/room/<code>` link. Decode before calling the API.
- API calls are browser-only: `frontend/src/api/services/*` → `client-api.ts` axios with `NEXT_PUBLIC_BACKEND_URL` and `Authorization: Bearer` copied from the `access_token` cookie. `server-api.ts` and `remote-api.ts` are unused. Don't add server-side fetches expecting the auth cookie to propagate.
- Godot editor assets (`packages/server/godot_editor/`, ~80 MB WASM) and the starter project (`godot_project/_wired/`) are committed. `godot-editor-provider.controller.ts` serves them from **cwd-relative** paths, so run the server through pnpm from `packages/server` (root scripts do); `node packages/server/dist/...` from the repo root will 404.
- COOP/COEP headers (`frontend/next.config.ts` and the editor controller) are required by the WASM editor (SharedArrayBuffer). The `/api/*` rewrite proxies to `NEXT_PUBLIC_BACKEND_URL`; Godot asset URLs depend on it.
- UI auth is Google OAuth only. Backend also has email/password endpoints. The Google callback sets the cookie on `COMMON_DOMAIN`, then redirects to `SITE_HOST`.
- The room "Game" tab is a placeholder; there is no game server.

## Commands

```bash
pnpm install
pnpm dev:server                          # Nest watch; needs the Postgres in packages/server/.env
pnpm --filter frontend dev -- -p 3001    # backend owns :3000; SITE_HOST expects :3001
pnpm check-types:frontend
pnpm --filter server build               # also the server typecheck (no separate script)
pnpm --filter frontend build             # next build --webpack
pnpm --filter frontend lint
pnpm --filter server lint                # eslint --fix
pnpm build                               # recursive: server + frontend
```

- Single test: `pnpm --filter server exec jest create-room.dto.spec` (Jest `rootDir` is `packages/server/src`, pattern `*.spec.ts`).
- `pnpm --filter server test` is currently red because `src/auth/auth.service.spec.ts` is an unconfigured Nest scaffold (missing providers). Run the spec you touched; don't chase that pre-existing failure.
- Root `pnpm dev` is not a full-stack command (`server` has `start:dev`, not `dev`). Use the two dev commands above.
- Next uses Webpack intentionally (`--webpack`); don't switch to Turbopack casually.

## Env and deploy

- Three gitignored env files, not one: root `.env` (Docker Compose), `packages/server/.env` (Nest, loaded from the package cwd), and `frontend/.env.local` (Next). Changing a URL or port often means editing more than one. Never commit or echo their contents.
- The current env points `DB_HOST` at a **remote shared Postgres** with `DB_SYNC=1`. Starting the server auto-mutates the schema; treat entity/DB changes as production-affecting.
- Docker: `docker compose up --build`. Compose expects an external `shared-net` network (nginx joins it), so create it first. Frontend `NEXT_PUBLIC_*` values are Docker build args — rebuild the frontend image after changing them.
- Server build emits `packages/server/dist/server/src/main.js`; `start:prod` depends on that path.
- The editor controller uses `glob` from `node:fs/promises` (Node 22+ API) while the Dockerfiles pin Node 20. Verify in-container behavior before relying on `/godot-project-info/wired` there.

## Conventions

- Conventional Commits (`feat:`, `refactor(server):`, `chore:`) are the norm.
- Server Prettier: single quotes, trailing commas. ESLint is type-aware; server/frontend lint scripts auto-fix.
- UI copy and docs are largely Russian; match the language and UTF-8 encoding of the file you edit.
- API contract changes belong in `packages/shared/src/api/types.ts` plus matching server DTOs/entities. There is no codegen.
