FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY shared ./shared
COPY server ./server
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    AUTOSTAGE_DATA_DIR=/app/data \
    AUTOSTAGE_LISTEN_HOST=0.0.0.0 \
    AUTOSTAGE_DISABLE_CHROME_SANDBOX=1
EXPOSE 4310
CMD ["node", "--import", "tsx", "server/index.ts"]
