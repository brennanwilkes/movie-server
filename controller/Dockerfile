FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. Only express; Node 20 has global fetch.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY web ./web

ENV CONTROLLER_PORT=8088
EXPOSE 8088

CMD ["node", "server.js"]
