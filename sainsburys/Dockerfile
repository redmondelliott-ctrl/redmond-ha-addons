FROM node:22-bookworm-slim

# Debian's Chromium (Playwright's own arm64 download is unreliable).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && rm -rf /root/.npm
COPY src ./src

CMD ["node", "src/main.mjs"]
