# OpenCode + the Telegram bridge, one container.
#
# The plugin is in-process: the image only needs OpenCode; the plugin and
# its credentials mount in. Build from the repo root:
#
#   docker build -f docker/Dockerfile -t opencode-tg .
#   docker compose -f docker/compose.yaml up -d
#
FROM ghcr.io/anomalyco/opencode:latest

# The bot's state (topics mapping, lock election) and secrets live in
# /root/.opencode/tg — mount a volume (or a read-only host path) there.
VOLUME ["/root/.opencode/tg"]

# The workspace the sessions run in — mount your project here.
VOLUME ["/workspace"]
WORKDIR /workspace

EXPOSE 4096

CMD ["serve", "--port", "4096"]
