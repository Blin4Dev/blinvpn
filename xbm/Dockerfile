FROM node:20-alpine

WORKDIR /app

# Копируем код — config.json монтируется через volume
COPY package.json .
COPY src/ ./src/

# Не-root пользователь
USER node

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:4100/health || exit 1

CMD ["node", "src/server.js"]
