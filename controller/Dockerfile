FROM node:20-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Only express; Node 20 has global fetch.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js metrics.js ./
COPY lib ./lib
COPY oscar-winners.json film-awards.json person-awards.json intl-languages.json ./
COPY web ./web
# The CRF probe's standalone calibration tool. lib/probe.js runs the same measurement in-process;
# this is the version a human drives by hand (`docker exec controller /app/scripts/probe-film.sh`).
# It lives in the image because the host's ffmpeg 4.2 lacks blockdetect/blurdetect and would
# measure with a different x265 build.
COPY scripts ./scripts

ENV CONTROLLER_PORT=8088
EXPOSE 8088

CMD ["node", "server.js"]
