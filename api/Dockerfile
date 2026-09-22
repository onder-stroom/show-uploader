FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
# Copy the lockfile + every workspace manifest so pnpm can resolve the graph.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY ui/package.json ui/
COPY watcher/package.json watcher/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile

FROM base AS ui-builder
# Vite bakes VITE_* into the bundle at build time. ui/.env is gitignored, so on
# a clean server build these must arrive as build args (from the stack .env).
ARG VITE_ZITADEL_DOMAIN
ARG VITE_ZITADEL_CLIENT_ID
ARG VITE_POCKETBASE_URL
ARG VITE_MINIO_CONSOLE_URL
ENV VITE_ZITADEL_DOMAIN=$VITE_ZITADEL_DOMAIN \
    VITE_ZITADEL_CLIENT_ID=$VITE_ZITADEL_CLIENT_ID \
    VITE_POCKETBASE_URL=$VITE_POCKETBASE_URL \
    VITE_MINIO_CONSOLE_URL=$VITE_MINIO_CONSOLE_URL
COPY ui/ ui/
RUN pnpm --filter @show-uploader/ui build

FROM base AS api-builder
COPY packages/domain/ packages/domain/
COPY api/src/ api/src/
COPY api/tsconfig.json api/
RUN pnpm --filter @show-uploader/api build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY ui/package.json ui/
COPY watcher/package.json watcher/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile --prod --filter @show-uploader/api...
COPY --from=api-builder /app/api/dist api/dist
COPY --from=api-builder /app/packages/domain/dist packages/domain/dist
COPY --from=ui-builder /app/ui/dist ui/dist
# tsc does not copy .sql files; migration runner reads them at runtime
COPY api/src/db/migrations/ api/dist/db/migrations/
EXPOSE 3000
CMD ["node", "api/dist/index.js"]
