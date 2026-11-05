# Larkway bridge in a container. Usage, caveats and known limitations: docs/docker.md

# ---- build: bundle the CLI + bridge into dist/ (no node_modules needed at runtime) ----
FROM node:20-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:20-bookworm-slim
# curl is required by @larksuite/cli's postinstall, which downloads its binary with it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl ripgrep \
  && rm -rf /var/lib/apt/lists/*
# Agent CLIs (latest at build time; rebuild the image to update them).
RUN npm i -g @anthropic-ai/claude-code @openai/codex @larksuite/cli
# glab (GitLab CLI): pinned release .deb, verified against the release's checksums.txt.
ARG GLAB_VERSION=1.123.0
ARG TARGETARCH
RUN set -eux; \
    deb="glab_${GLAB_VERSION}_linux_${TARGETARCH}.deb"; \
    base="https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads"; \
    cd /tmp; \
    curl -fsSLO "$base/$deb"; \
    curl -fsSLO "$base/checksums.txt"; \
    grep "  $deb\$" checksums.txt | sha256sum -c -; \
    dpkg -i "$deb"; \
    rm -f "$deb" checksums.txt

WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/bin/larkway.mjs ./bin/larkway.mjs
COPY --from=build /src/package.json ./package.json
COPY scripts/docker/get-bot-open-id.cjs ./scripts/get-bot-open-id.cjs
RUN chmod +x bin/larkway.mjs && ln -s /app/bin/larkway.mjs /usr/local/bin/larkway \
 && chown -R node:node /home/node

# Non-root: Claude Code refuses bypassPermissions (Larkway's default mode) when run as root.
USER node
ENV LARKWAY_HOME=/home/node/.larkway
# Foreground bridge. `larkway start` is not used: on Linux it delegates to systemd,
# which a container does not have. Restarts are handled by the container runtime.
CMD ["node", "/app/dist/main.js"]
