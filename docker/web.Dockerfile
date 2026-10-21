# The web app, built for the v2 API and served by nginx, which also forwards /api to the api container (one origin: the refresh
# cookie works and no CORS is needed). Build from the repository root: docker build -f docker/web.Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public public
COPY src src
ENV VITE_USE_API=v2 VITE_API_BASE_URL=/api VITE_SHOW_DATA_SOURCE=true
RUN npx vite build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
