# 基于 Node 20 LTS
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用构建缓存）
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 复制应用代码
COPY server.js ./
COPY public ./public

# 数据与报告目录（必须挂载持久卷，否则容器重建会丢数据）
VOLUME ["/app/data", "/app/reports"]

ENV NODE_ENV=production
ENV PORT=3081

EXPOSE 3081

CMD ["node", "server.js"]
