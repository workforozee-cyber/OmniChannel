# One container: API + website + in-process scheduler. Used by render.yaml (and works on any Docker host).
FROM node:22-alpine AS api
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src ./src
COPY api/scripts ./scripts
COPY api/migrations ./migrations
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
# Browser calls same-origin /api; Next forwards to the API inside the container.
ENV NEXT_PUBLIC_API_URL="" INTERNAL_API_URL=http://127.0.0.1:4000 NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=api /app/api/node_modules ./api/node_modules
COPY --from=api /app/api/dist ./api/dist
COPY --from=api /app/api/migrations ./api/migrations
COPY --from=api /app/api/package.json ./api/
COPY --from=web /app/web/.next ./web/.next
COPY --from=web /app/web/public ./web/public
COPY --from=web /app/web/node_modules ./web/node_modules
COPY --from=web /app/web/package.json /app/web/next.config.mjs ./web/
COPY start.mjs ./
USER node
EXPOSE 3000
CMD ["node", "start.mjs"]
