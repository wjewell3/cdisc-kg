# ── Stage 1: build deps (native modules need build tools) ────────────────────
FROM node:22-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY index.js snapshot.js graph-loader.js atc-map.json ./

# Data volume — SQLite DB will be mounted here
VOLUME ["/data"]

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/data/aact.db

EXPOSE 3001

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
