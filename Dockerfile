# VEILRUNNERS — the game page and the co-op relay in one small Node process.
#   docker build -t veilrunners .
#   docker run -p 8080:8080 veilrunners
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN node tools/build.mjs

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/dist ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "serve.mjs"]
