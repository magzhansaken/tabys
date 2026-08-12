# Кабинет: Next.js standalone — образ без node_modules разработки.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# ВАЖНО: Next.js подставляет NEXT_PUBLIC_* в код В МОМЕНТ СБОРКИ, а не запуска.
# Поэтому адрес API приходит сюда как build arg, иначе на сервере кабинет
# стучался бы в localhost и не работал.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.js ./next.config.js
EXPOSE 3001
CMD ["npx", "next", "start", "-p", "3001"]
