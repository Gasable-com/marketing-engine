# Build the static app, then serve it from nginx. The runtime image holds no
# toolchain, no sources and no token.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

# Where the app will be mounted, e.g. /marketing/. Baked in at build time
# because the asset URLs in index.html are written then.
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
RUN npm run build

FROM nginx:alpine AS runtime

# envsubst, for the config template.
RUN apk add --no-cache gettext

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint-dashboard.sh

# nginx's own default config would otherwise also listen on 80.
RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/docker-entrypoint-dashboard.sh"]
