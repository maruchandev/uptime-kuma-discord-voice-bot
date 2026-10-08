FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/cache && chown node:node /app/cache
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

USER node
CMD ["node", "src/index.js"]
