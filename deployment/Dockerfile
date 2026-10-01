FROM node:22-alpine

WORKDIR /usr/src/app

# Build tools are only needed if a prebuilt better-sqlite3 binary isn't available; removed afterwards
COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

COPY . .

# SQLite database + stats.json live here (mounted as a volume, survives rebuilds)
ENV DATA_DIR=/usr/src/app/data
RUN mkdir -p /usr/src/app/data
VOLUME ["/usr/src/app/data"]

EXPOSE 3009

CMD ["node", "index.js"]
