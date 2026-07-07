FROM node:20-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Only express; Node 20 has global fetch.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js metrics.js ./
COPY oscar-winners.json ./
COPY web ./web

ENV CONTROLLER_PORT=8088
EXPOSE 8088

CMD ["node", "server.js"]
