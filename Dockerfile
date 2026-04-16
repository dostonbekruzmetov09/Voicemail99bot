# Node.js bazaviy tasviri
FROM node:24-slim

# FFmpeg o'rnatish
RUN apt-get update && apt-get install -y ffmpeg && apt-get clean

# Ishchi papkani yaratish
WORKDIR /app

# Paketlarni ko'chirish va o'rnatish
COPY package*.json ./
RUN npm install

# Qolgan barcha fayllarni ko'chirish
COPY . .

# Papkalarni yaratish
RUN mkdir -p temp logs

# Botni ishga tushirish
CMD ["node", "bot.js"]
