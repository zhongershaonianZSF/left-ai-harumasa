# 六课斥候请假小助手 · CloudBase 云托管 Dockerfile
# 云托管会注入 PORT 环境变量，server.js 已监听 process.env.PORT
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
