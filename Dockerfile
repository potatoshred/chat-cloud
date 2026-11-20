FROM node:24-alpine AS build

# Match the pnpm version used by the upstream GitHub Actions workflow.
ARG PNPM_VERSION=12.6.0
WORKDIR /app

RUN npm install --global pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY rspack.config.ts tsconfig.json .oxlintrc.json LICENSE ./
COPY src ./src
# 构建入口 scripts/build.mjs：按环境选择目标，容器此处为 CHAT_SERVER_API=true。
COPY scripts ./scripts
RUN CHAT_SERVER_API=true pnpm build

FROM node:24-alpine AS auth
WORKDIR /app
RUN mkdir -m 700 /data && chown node:node /data
COPY --chown=node:node deploy/auth/server.mjs deploy/auth/password.mjs deploy/auth/api-proxy.mjs deploy/auth/data-store.mjs deploy/auth/style.css ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]

FROM nginx:stable-alpine AS runtime

LABEL org.opencontainers.image.title="chat-cloud" \
      org.opencontainers.image.source="https://github.com/potatoshred/chat-cloud" \
      org.opencontainers.image.licenses="MIT"

COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=nginx:nginx /app/dist/ /usr/share/nginx/html/

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# Skip the base image's startup scripts: this configuration needs no templating.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
