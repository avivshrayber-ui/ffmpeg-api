# Node 20 על Debian רזה
FROM node:20-slim

# התקנת ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# תקיית עבודה
WORKDIR /app

# התקנת תלויות (production) – בלי לדרוש package-lock.json
COPY package*.json ./
RUN npm install --omit=dev

# העתקת שאר הקוד
COPY . .

# משתני סביבה
ENV NODE_ENV=production

# הרצה
CMD ["npm", "start"]
