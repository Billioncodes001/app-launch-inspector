FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.server.json tsconfig.ui.json vite.config.ts ./
COPY src ./src
COPY ui ./ui
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    INSPECTOR_MODE=hosted INSPECTOR_HOST=0.0.0.0 INSPECTOR_DATA_DIR=/data \
    HOME=/tmp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mkdir /data && chown node:node /data && chmod 700 /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui-dist ./ui-dist
COPY deploy/healthcheck.mjs ./deploy/healthcheck.mjs
COPY deploy/worker-healthcheck.mjs ./deploy/worker-healthcheck.mjs
USER node
EXPOSE 8795
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "dist/cli.js"]
