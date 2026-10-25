# AWS Secrets Manager compatible endpoint.
# Zero npm dependencies: the implementation uses only Node.js core modules.
FROM node:22-alpine

ENV NODE_ENV=production \
    SM_PORT=8080 \
    SM_ADMIN_HOST=127.0.0.1 \
    SM_ADMIN_PORT=8081 \
    SM_DATA_DIR=/data \
    SM_LOG_LEVEL=info

WORKDIR /app

COPY secrets-manager/package.json ./
COPY secrets-manager/server.mjs ./
COPY secrets-manager/client.mjs ./
COPY secrets-manager/cli.mjs ./
COPY secrets-manager/seed.mjs ./
COPY secrets-manager/lib ./lib

# /data is backed by a named volume. Docker initialises a fresh volume with the
# ownership and mode of this directory, so the unprivileged user can own the
# encrypted store without needing a root entrypoint.
RUN mkdir -p /data \
 && chown -R node:node /app /data \
 && chmod 700 /data

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
