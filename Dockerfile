FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

RUN chmod +x scripts/start.sh

CMD ["./scripts/start.sh"]
