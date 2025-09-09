FROM node:20-slim

# התקנת ffmpeg/ffprobe
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
