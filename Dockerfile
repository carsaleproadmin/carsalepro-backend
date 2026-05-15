# syntax=docker/dockerfile:1.7
# Multi-stage build for CarSalePro backend.

# ---------- deps: install production deps only ----------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl ca-certificates
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# ---------- build: compile TypeScript + generate Prisma client ----------
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl ca-certificates
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY tsconfig*.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---------- runner: minimal runtime image ----------
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache openssl ca-certificates tini

# Copy production deps from deps stage
COPY --from=deps /app/node_modules ./node_modules
# Replace with build's @prisma/client (generated)
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
