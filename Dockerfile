# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- deps + build ------------------------------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# --- runtime -----------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
ENV PORT=47311
EXPOSE 47311
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "dist/main.js"]
