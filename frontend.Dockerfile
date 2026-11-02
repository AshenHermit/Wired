# syntax=docker/dockerfile:1
#
# Frontend-образ: Next.js 16. NEXT_PUBLIC_* вшиваются в бандл на этапе сборки,
# поэтому изменение любого из них требует пересборки образа (workflow делает это).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

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

FROM manifests AS build
COPY . .
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_WEBSOCKET_URL
ARG NEXT_PUBLIC_HASHIDS_SALT
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL \
    NEXT_PUBLIC_WEBSOCKET_URL=$NEXT_PUBLIC_WEBSOCKET_URL \
    NEXT_PUBLIC_HASHIDS_SALT=$NEXT_PUBLIC_HASHIDS_SALT
RUN pnpm build:frontend

FROM base AS final
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/frontend ./frontend
# Прод-зависимости кладутся последними: иначе их перетрёт dev-дерево из build.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/frontend/node_modules ./frontend/node_modules
EXPOSE 3000
WORKDIR /app/frontend
CMD ["node", "node_modules/.bin/next", "start", "-p", "3000"]
