# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com \
    CORS_ALLOW_ORIGIN=* \
    RATE_LIMIT_WINDOW_MS=60000 \
    RATE_LIMIT_MAX=120 \
    RPC_RETRY_ATTEMPTS=3 \
    RPC_RETRY_BASE_DELAY_MS=250 \
    LOG_LEVEL=info
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8788') + '/api/indexer/v1/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["npm", "start"]
