FROM node:16.4.2-alpine

WORKDIR /usr/src/app

RUN apk update && apk upgrade

COPY package.json ./

RUN npm install

COPY . .

EXPOSE 3009

CMD ["node", "index.js"]