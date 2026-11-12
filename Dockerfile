# HackerAI Remote Control bridge for Touchless (#960).
#
# A web panel (port 8790) where you connect the phone (Touchless secure sign-in) and paste HackerAI's Remote Control
# command. The panel runs HackerAI's local client (@hackerai/local) in this container as the unprivileged "node"
# user, with the `touchless` CLI on the PATH, so the commands HackerAI's agent runs land here and not on the host.
# The panel itself runs as root only so its settings (tokens, password hash) stay unreadable to that user.
# Build context is relay/:
#   cd relay/hackerai-bridge && docker compose up -d --build     then open http://localhost:8790

# ---- build stage: the client and its optional node-pty (interactive terminals), compiled here --------------------
FROM node:22-bookworm-slim AS build
ARG HACKERAI_LOCAL_VERSION=0.8.9
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The client exits after an hour without commands. Each exit drops HackerAI's open tasks ("computer disconnected"),
# so the bridge keeps it running: HACKERAI_LOCAL_IDLE_TIMEOUT_MS sets a timeout again (unset: none). The build
# stops if the client's code no longer has the line this replaces (MIT-licensed; see packages/local in its repo).
RUN npm install -g --no-audit --no-fund "@hackerai/local@${HACKERAI_LOCAL_VERSION}" \
 && f=/usr/local/lib/node_modules/@hackerai/local/dist/index.js \
 && grep -q '^const IDLE_TIMEOUT_MS = 60 \* 60 \* 1000;' "$f" \
 && sed -i 's/^const IDLE_TIMEOUT_MS = 60 \* 60 \* 1000;/const IDLE_TIMEOUT_MS = Number(process.env.HACKERAI_LOCAL_IDLE_TIMEOUT_MS) > 0 ? Number(process.env.HACKERAI_LOCAL_IDLE_TIMEOUT_MS) : Infinity;/' "$f" \
 && grep -q 'process.env.HACKERAI_LOCAL_IDLE_TIMEOUT_MS' "$f" \
 && hackerai-local --help > /dev/null

# ---- runtime ------------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim
# Tools an agent expects in a shell; nothing that needs extra privileges. HackerAI's own file tools run python3.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq less procps python3 git wget unzip file \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib/node_modules/@hackerai /usr/local/lib/node_modules/@hackerai
RUN ln -s /usr/local/lib/node_modules/@hackerai/local/dist/index.js /usr/local/bin/hackerai-local \
 && chmod 0755 /usr/local/lib/node_modules/@hackerai/local/dist/index.js

COPY cli/touchless.mjs /opt/touchless/touchless.mjs
RUN printf '#!/bin/sh\nexec node /opt/touchless/touchless.mjs "$@"\n' > /usr/local/bin/touchless \
 && chmod 0755 /usr/local/bin/touchless /opt/touchless/touchless.mjs
COPY panel /opt/bridge/panel

# Settings: root only. The agent's files: the "node" user, kept across restarts by a volume. ~/.hackerai holds the
# client's machine identity (environment-id): on a volume too, so after a restart or rebuild HackerAI sees the same
# computer and its open tasks continue instead of "Selected computer unavailable".
RUN mkdir -p /config /home/node/work/touchless-out /home/node/.hackerai/local \
 && chmod 0700 /config /home/node/.hackerai /home/node/.hackerai/local \
 && chown -R node:node /home/node/work /home/node/.hackerai
ENV BRIDGE_CONFIG_DIR=/config \
    BRIDGE_PANEL_PORT=8790 \
    BRIDGE_PROXY_PORT=8791 \
    BRIDGE_AGENT_UID=1000 \
    BRIDGE_AGENT_GID=1000 \
    BRIDGE_AGENT_HOME=/home/node \
    BRIDGE_WORK_DIR=/home/node/work \
    BRIDGE_CLI=/opt/touchless/touchless.mjs \
    TOUCHLESS_URL=http://127.0.0.1:8791/mcp \
    TOUCHLESS_CLIENT_NAME=HackerAI \
    TOUCHLESS_OUT_DIR=/home/node/work/touchless-out
WORKDIR /home/node/work
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/api/session',{headers:{Host:'localhost'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/bridge/panel/server.mjs"]
