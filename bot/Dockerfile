FROM node:20-alpine

# Cấu hình thư mục app
WORKDIR /app

# Ưu tiên copy package.json để cache npm install
COPY package*.json ./
RUN npm install --production

# Copy toàn bộ file code vào image
COPY . .

# Mở cổng API
EXPOSE 4000

# Khởi chạy bot
CMD ["node", "index.js"]
