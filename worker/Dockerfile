FROM node:22-alpine AS builder
RUN apk add --no-cache ffmpeg python3 make g++ && corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY ui/package.json ui/
COPY watcher/package.json watcher/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile --filter @show-uploader/worker...
COPY packages/domain/ packages/domain/
COPY worker/src/ worker/src/
COPY worker/tsconfig.json worker/
RUN pnpm --filter @show-uploader/worker build

FROM node:22-alpine
RUN apk add --no-cache ffmpeg && corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY ui/package.json ui/
COPY watcher/package.json watcher/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile --prod --filter @show-uploader/worker...
COPY --from=builder /app/worker/dist worker/dist
COPY --from=builder /app/packages/domain/dist packages/domain/dist
CMD ["node", "worker/dist/index.js"]
