# Node 20 על דביאן רזה
FROM node:20-slim

# התקנת ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# תקיית עבודה
WORKDIR /app

# התקנת תלויות (production בלבד)
COPY package*.json ./
RUN npm ci --omit=dev

# העתקת שאר הקוד
COPY . .

# Render מספק PORT; נדאג שהאפליקציה תאזין עליו
ENV NODE_ENV=production
# אפשר להשאיר את PORT ללא ערך קשיח; האפליקציה קוראת process.env.PORT
# ENV PORT=10000

# הרצה
CMD ["npm", "start"]
