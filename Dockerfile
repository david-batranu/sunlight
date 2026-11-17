# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
ENV npm_config_cache=/tmp/npm-cache
# Relative asset base keeps the image portable across root and subpath deployments.
ARG VITE_BASE=./
ARG GIT_SHA=""
ARG IMAGE_TAG=""
ENV VITE_BASE=$VITE_BASE

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.web.json tsconfig.server.json tsconfig.tests.json vite.config.ts index.html ./
COPY shared ./shared
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY public ./public
COPY tests ./tests

RUN npm run build

FROM node:24-bookworm-slim AS runtime
ARG GIT_SHA=""
ARG IMAGE_TAG=""
ENV NODE_ENV=production \
    PORT=8090 \
    HOST=0.0.0.0 \
    CACHE_DIR=/data/cache \
    GIT_SHA=$GIT_SHA \
    IMAGE_TAG=$IMAGE_TAG

WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/server/data ./server/data
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /data/cache && chown -R node:node /data

USER node
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.js"]
