# La versión web de cac (W1). Se construye desde `app/`:
#   docker build -f web/Dockerfile .
FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/security-headers.conf /etc/nginx/snippets/security-headers.conf
# Bajo /app/ porque así llegan las rutas: el Gateway no reescribe el prefijo.
COPY --from=build /src/dist-web /usr/share/nginx/html/app
EXPOSE 8080
