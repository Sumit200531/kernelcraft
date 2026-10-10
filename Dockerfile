# syntax=docker/dockerfile:1
# One image: the API serves the built web app and talks to PostgreSQL.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w @kernelcraft/web && npm run build -w @kernelcraft/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 STATIC_DIR=/app/web
WORKDIR /app/api
COPY apps/api/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-package-lock \
      fastify@5.2.1 @fastify/cors@10.0.2 @fastify/static@8.1.0 pg@8.13.1 zod@3.24.1 \
 && npm cache clean --force
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/migrations ./migrations
COPY --from=build /app/apps/web/dist /app/web
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "dist/main.js"]
