FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY . .

FROM base AS prod-deps
# Install system dependencies for canvas native module
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
# Install system dependencies for canvas native module
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build:server
RUN pnpm run build:shared

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/box2d/build /app/packages/box2d/build
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/node_modules /app/packages/shared/node_modules
EXPOSE 3000
CMD [ "pnpm", "start:server" ]