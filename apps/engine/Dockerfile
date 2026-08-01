# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────
# FlowForge — production image (post-merge zeliai monorepo)
# Reference: docs/CONTAINER-PER-TENANT.md sezione 2
#
# Build context = root zeliai (NON apps/flowforge-runtime/). Cosi possiamo
# COPY dai paths reali del monorepo.
#
# Build:
#   cd /path/to/zeliai/
#   docker build -f apps/flowforge-runtime/Dockerfile -t flowforge:v1.1.0 .
#
# Stage 1: builder (build-time deps + compila TS + bundle editor Vite)
# Stage 2: runtime (debian bookworm-slim, non-root, read-only fs friendly)
#
# Security:
#   - Non-root user (UID 65532 — distroless convention)
#   - tini come PID 1 (zombie reaping, signal handling)
#   - HEALTHCHECK su /health
#   - Filesystem read-only compatibile (write solo a /data tmpfs/volume)
# ─────────────────────────────────────────────────────────────────────

# #215 P1-15: pin base image al digest SHA256 (supply-chain integrity).
# Pre-fix usava `node:22-alpine` floating → attacker che compromette il
# tag (rare, ma successo: codecov 2020, ua-parser-js 2021) può iniettare
# malware al prossimo rebuild. Digest pinning → solo l'immagine BIT-FOR-BIT
# identica passa il pull.
# Update procedure:
#   bash scripts/update-base-image-digest.sh
# Quel script fa pull + estrae il digest + aggiorna questo file.
# Override per dev: docker build --build-arg NODE_IMAGE=node:22-bookworm-slim .
#
# 2026-06-14 — MIGRAZIONE OS Alpine→Debian (bookworm-slim, glibc): i moduli
# nativi (better-sqlite3/isolated-vm/argon2/@duckdb/node-api) sono più robusti su
# glibc, e i client DB (mysql2/mongodb/tedious) non hanno attriti musl. I nodi
# girano IDENTICI (JS). ⚠️ DEPLOY: pinnare il digest con
# `bash scripts/update-base-image-digest.sh` (qui tag flottante finché non si fa
# il primo pull sul server) e verificare il build (`docker build`) — cambio OS.
ARG NODE_IMAGE=node:22-bookworm-slim

# ═══════════════════════════════════════════════════════════════════
# STAGE 1 — BUILDER
# ═══════════════════════════════════════════════════════════════════
FROM ${NODE_IMAGE} AS builder
WORKDIR /build

# Build-time deps (native modules: better-sqlite3, isolated-vm, argon2, duckdb).
# Debian/glibc: niente libc6-compat (shim musl). build-essential = gcc/g++/make.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.1.1 --activate

# 1. Copy workspace manifests + root tsconfig (referenced by packages/*/tsconfig.json extends)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/flowforge-runtime/package.json   apps/flowforge-runtime/
COPY apps/flowforge-editor/package.json    apps/flowforge-editor/
COPY apps/flowforge-cli/package.json       apps/flowforge-cli/
# @zeliai/database: il ROOT package.json lo dichiara dependency (script
# db:migrate/seed), quindi pnpm install nel build DEVE poterlo risolvere come
# membro del workspace, altrimenti ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. Il runtime
# NON lo importa → basta il solo manifest (nessuna build, nessun src nel context).
COPY packages/database/package.json        packages/database/
COPY packages/flowforge/                    packages/flowforge/
COPY packages/shared/                       packages/shared/
COPY packages/logger/                       packages/logger/

# Strip everything except package.json files inside packages/{flowforge,shared,logger}/
# (we want only the manifests for pnpm to resolve workspace deps)
RUN find packages/flowforge packages/shared packages/logger -type f ! -name 'package.json' -delete 2>/dev/null || true \
 && find packages/flowforge packages/shared packages/logger -type d -empty -delete 2>/dev/null || true

# 2. Install deps con --shamefully-hoist (TUTTE le deps + transitive
#    direttamente in node_modules/ top-level). Risolve il problema del
#    bundle ESM che cerca `argon2`, `@duckdb/node-api`, ecc. al top
#    quando i workspace pnpm li tengono nested in .pnpm-store symlinks.
#
# `.npmrc` locale all'immagine: shamefully-hoist=true + no-TTY-safe.
# Non interferisce con dev locale (questo .npmrc esiste solo nell'image).
RUN printf 'shamefully-hoist=true\nconfirm-modules-purge=false\nstrict-peer-dependencies=false\n' > .npmrc

# ⚠️ MIGRAZIONE OS: la cache dello store pnpm DEVE essere isolata per libc —
# altrimenti i moduli nativi compilati per musl (Alpine) vengono RIUSATI su
# glibc (Debian) → runtime crash "libc.musl-x86_64.so.1 cannot open" su
# better-sqlite3. `id=pnpm-store-bookworm` separa la cache glibc dalla musl.
# Inoltre `pnpm rebuild` (build-from-source) FORZA la ricompilazione dei moduli
# nativi per la libc corrente, a prova di qualsiasi residuo di cache/prebuild.
RUN --mount=type=cache,id=pnpm-store-bookworm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline \
      --filter @flowforge/runtime... --filter @flowforge/editor... \
 && npm_config_build_from_source=true pnpm rebuild better-sqlite3 argon2 \
 && pnpm rebuild isolated-vm re2

# 3. Copy source flowforge-related
COPY apps/flowforge-runtime/        apps/flowforge-runtime/
COPY apps/flowforge-editor/         apps/flowforge-editor/
COPY apps/flowforge-cli/            apps/flowforge-cli/
COPY packages/flowforge/            packages/flowforge/
COPY packages/shared/               packages/shared/
COPY packages/logger/               packages/logger/

# 4. Build packages — SOLO le deps transitive del runtime + editor
#    (sintassi pnpm `@pkg^...` = deps di @pkg ESCLUSO @pkg stesso).
#    Evita di buildare community-node-sdk + altri pkg non usati che hanno
#    deps proprie non installate dal filter mirato sopra.
RUN pnpm --filter '@flowforge/runtime^...' build \
 && pnpm --filter '@flowforge/editor^...' build

# 5. Build runtime + editor
#    Editor build clean: cancella tsBuildInfo stantia (pulisce cache TS
#    incrementale che a volte causa falsi-positivi TS1117 nei build cold).
RUN rm -rf apps/flowforge-editor/node_modules/.tmp \
 && pnpm --filter @flowforge/runtime build \
 && pnpm --filter @flowforge/editor build

# ═══════════════════════════════════════════════════════════════════
# STAGE 2 — RUNTIME
# ═══════════════════════════════════════════════════════════════════
FROM ${NODE_IMAGE} AS runtime

# Runtime essentials (Debian: sqlite3, tini → /usr/bin/tini, wget per healthcheck).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini \
        ca-certificates \
        wget \
        tzdata \
        sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (UID 65532 = distroless convention). Debian: groupadd/useradd.
RUN groupadd -g 65532 flowforge \
 && useradd  -u 65532 -g flowforge -d /app -s /usr/sbin/nologin -M flowforge \
 && mkdir -p /app /data \
 && chown -R flowforge:flowforge /app /data

WORKDIR /app
USER flowforge:flowforge

# Copy built artifacts dal builder (preserve ownership)
COPY --chown=flowforge:flowforge --from=builder /build/apps/flowforge-runtime/dist    /app/apps/flowforge-runtime/dist
COPY --chown=flowforge:flowforge --from=builder /build/apps/flowforge-editor/dist     /app/apps/flowforge-editor/dist
COPY --chown=flowforge:flowforge --from=builder /build/node_modules                    /app/node_modules
COPY --chown=flowforge:flowforge --from=builder /build/packages/flowforge              /app/packages/flowforge
COPY --chown=flowforge:flowforge --from=builder /build/apps/flowforge-runtime/node_modules /app/apps/flowforge-runtime/node_modules
COPY --chown=flowforge:flowforge --from=builder /build/package.json                    /app/package.json
COPY --chown=flowforge:flowforge --from=builder /build/pnpm-workspace.yaml             /app/pnpm-workspace.yaml

# Community defaults baking (2026-05-30):
# Copia i 7 community nodes ufficiali (telegram, slack, github, notion, stripe,
# linear, discord) nell'image come "defaults". Il bootstrap runtime
# (community-nodes-bootstrap.ts) li copia in /data/installed-nodes/ al primo
# boot del tenant — cosi\` ogni tenant nuovo ha out-of-the-box tutti i community
# senza dover passare per UI install.
COPY --chown=flowforge:flowforge community-nodes/telegram/src   /app/community-defaults/community_telegram
COPY --chown=flowforge:flowforge community-nodes/slack/src      /app/community-defaults/community_slack
COPY --chown=flowforge:flowforge community-nodes/github/src     /app/community-defaults/community_github
COPY --chown=flowforge:flowforge community-nodes/notion/src     /app/community-defaults/community_notion
COPY --chown=flowforge:flowforge community-nodes/stripe/src     /app/community-defaults/community_stripe
COPY --chown=flowforge:flowforge community-nodes/linear/src     /app/community-defaults/community_linear
COPY --chown=flowforge:flowforge community-nodes/discord/src    /app/community-defaults/community_discord
COPY --chown=flowforge:flowforge community-nodes/hubspot/src    /app/community-defaults/community_hubspot
COPY --chown=flowforge:flowforge community-nodes/salesforce/src /app/community-defaults/community_salesforce

# Default env (overridable a runtime via -e flags)
ENV NODE_ENV=production \
    PORT=3100 \
    HOST=0.0.0.0 \
    TZ=Europe/Rome \
    LOG_LEVEL=info \
    NODE_OPTIONS=--enable-source-maps \
    FLOWFORGE_DB_PATH=/data/flowforge.sqlite \
    FLOWFORGE_DATA_DIR=/data \
    FLOWFORGE_UI_DIR=/app/apps/flowforge-editor/dist

# Mandatory env runtime (no default, must be provided at docker run):
#   FLOWFORGE_MASTER_PASSWORD   (vault encryption)
#   FLOWFORGE_INTERNAL_TOKEN    (service-to-service auth)
#   FLOWFORGE_SSO_SECRET        (JWT verify shared con portal)
#   FLOWFORGE_TENANT_ID         (set by orchestrator a provision)
#   FLOWFORGE_LICENSE_KEY       (validato vs portal)
#   FLOWFORGE_LIARA_BASE_URL    (default 172.17.0.1:3006 — Docker host gateway)
#   FLOWFORGE_PORTAL_URL        (https://flowforge.automazionezeli.com)

# Healthcheck — runtime espone /health su :3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- --timeout=3 http://127.0.0.1:${PORT}/health || exit 1

VOLUME ["/data"]
EXPOSE 3100

LABEL org.opencontainers.image.title="FlowForge" \
      org.opencontainers.image.description="Workflow automation runtime (ZeliAI SaaS, container-per-tenant)" \
      org.opencontainers.image.vendor="ZeliAI" \
      org.opencontainers.image.licenses="proprietary"

# tini handles SIGTERM/SIGINT propagation + zombie reaping (PID 1).
# Debian: il pacchetto `tini` installa il binario in /usr/bin/tini (Alpine: /sbin).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/flowforge-runtime/dist/main.js"]
