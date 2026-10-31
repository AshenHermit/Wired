FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY . .

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# The editor is no longer committed: the build downloads the pinned 4.7.2 web
# editor exactly as `pnpm fetch:editor` does for a clean checkout. An offline
# build must pre-populate packages/server/godot_editor (fetch on the host and
# add it to the build context) before `docker build` runs.
RUN pnpm --filter server fetch:editor
RUN pnpm run build:server
RUN pnpm run build:shared

FROM base
# Room runtime endpoints must go through the public proxy in the deployed image.
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/packages/server/node_modules /app/packages/server/node_modules
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/server/godot_editor /app/packages/server/godot_editor
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/node_modules /app/packages/shared/node_modules
EXPOSE 3000
CMD [ "pnpm", "start:server" ]