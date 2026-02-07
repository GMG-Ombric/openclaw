FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

ARG TARGETARCH=amd64
ARG GOGCLI_VERSION=0.9.0
RUN set -eu; \
      arch="${TARGETARCH}"; \
      case "${arch}" in \
        amd64|arm64) ;; \
        *) echo "unsupported TARGETARCH=${arch}" >&2; exit 1 ;; \
      esac; \
      url="https://github.com/steipete/gogcli/releases/download/v${GOGCLI_VERSION}/gogcli_${GOGCLI_VERSION}_linux_${arch}.tar.gz"; \
      echo "[openclaw] downloading gogcli from ${url}"; \
      curl -fsSL "${url}" -o /tmp/gogcli.tgz; \
      tar -xzf /tmp/gogcli.tgz -C /tmp; \
      install -m 0755 /tmp/gog /usr/local/bin/gog; \
      rm -rf /tmp/gog /tmp/gogcli.tgz

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","dist/index.js","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured"]
