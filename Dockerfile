FROM node:22-alpine AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build

FROM node:22-alpine AS production
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
WORKDIR /app
RUN corepack enable && addgroup -S vibeable && adduser -S vibeable -G vibeable && mkdir -p /data && chown vibeable:vibeable /data
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/server/migrations ./server/migrations
USER vibeable
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["sh", "-c", "node dist-server/server/scripts/migrate.js && node dist-server/server/index.js"]
