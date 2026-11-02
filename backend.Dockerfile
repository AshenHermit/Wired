# syntax=docker/dockerfile:1
#
# Backend-образ: NestJS + Godot 4.8-beta2 (web-редактор, нативный рантайм,
# шаблоны экспорта) + собранный web-экспорт игры.
# Версии Godot берутся только из packages/server/scripts/fetch-*.mjs.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    XDG_DATA_HOME=/opt/godot-data
# Библиотеки нужны и для `--headless` прогона Godot (экспорт и рантайм комнат).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libasound2 \
        libpulse0 \
        libfontconfig1 \
        libfreetype6 \
        libx11-6 \
        libxcursor1 \
        libxinerama1 \
        libxrandr2 \
        libxi6 \
        libgl1 \
        libdbus-1-3 \
        libudev1 \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Зависимости ставятся отдельным слоем: код меняется чаще манифестов.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY frontend/package.json ./frontend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# Ассеты редактора и шаблоны экспорта зависят только от закреплённых версий.
FROM base AS assets
COPY packages/server/scripts ./packages/server/scripts
RUN node packages/server/scripts/fetch-godot-editor.mjs \
    && node packages/server/scripts/fetch-godot-templates.mjs

FROM base AS runtime
COPY packages/server/scripts ./packages/server/scripts
RUN node packages/server/scripts/fetch-godot-runtime.mjs

FROM manifests AS build
COPY . .
RUN pnpm build:shared \
    && pnpm build:server
COPY --from=assets /opt/godot-data /opt/godot-data
COPY --from=runtime /app/packages/server/godot_runtime ./packages/server/godot_runtime
RUN node packages/server/scripts/export-godot-web.mjs

FROM base AS final
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/godot_editor ./packages/server/godot_editor
COPY --from=build /app/packages/server/godot_runtime ./packages/server/godot_runtime
COPY --from=build /app/packages/server/godot_project ./packages/server/godot_project
COPY --from=build /app/packages/server/game_export ./packages/server/game_export
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/server/package.json ./packages/server/package.json
# Пути в src/config/config.ts резолвятся от cwd: cwd должен быть packages/server.
WORKDIR /app/packages/server
EXPOSE 3000
CMD ["node", "dist/server/src/main.js"]
