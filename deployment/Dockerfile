FROM node:latest

WORKDIR /usr/src/app

COPY package.json package.json

RUN npm install

COPY . .

EXPOSE 3009

CMD ["node", "index.js"]