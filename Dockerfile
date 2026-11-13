# syntax=docker/dockerfile:1
FROM node:22-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -C server build && pnpm -C web build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/app/data/fly.db \
    WEB_DIST=/app/web/dist
EXPOSE 8787
CMD ["node", "server/dist/api-main.js"]
