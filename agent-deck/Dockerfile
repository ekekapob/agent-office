# Agent Deck — read-only dashboard for Claude Code sessions (see README.md, ADR-0009).
#
#   docker build -t agent-deck .
#   docker run --rm -p 127.0.0.1:7777:7777 -v "$HOME/.claude:/data/claude:ro" agent-deck
#   or: docker compose up --build
#
# Zero npm dependencies, so there is no install step: the image is Node plus this folder.
FROM node:20-alpine

LABEL org.opencontainers.image.title="agent-deck" \
      org.opencontainers.image.description="Local isometric dashboard for Claude Code sessions. Reads ~/.claude, never calls a model."

# docker mode: liveness by file freshness (no host PIDs), reported in /api/health as mode "docker".
ENV NODE_ENV=production \
    AGENTDECK_MODE=docker

WORKDIR /app

# .dockerignore drops recordings, smoke output, logs and local config.
COPY --chown=node:node . /app

# Claude Code's files are bind-mounted read-only at /data/claude (compose.yaml).
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7777/api/health >/dev/null || exit 1

USER node

CMD ["node", "server.js", "--no-open", "--host", "0.0.0.0", "--data-root", "/data/claude"]
