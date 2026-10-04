# Docker

The plugin is **in-process**: it lives inside the OpenCode server, so there
is nothing to containerize on its own. The pattern that works is mounting
the plugin into a containerized OpenCode.

## docker-compose.yml

```yaml
services:
  opencode:
    image: ghcr.io/anomalyco/opencode:latest
    command: ["serve", "--port", "4096"]
    volumes:
      - ./:/workspace
      - ./opencode-tg:/plugins/opencode-tg
      - ./opencode-config:/root/.config/opencode
    working_dir: /workspace
```

With `/root/.config/opencode/opencode.jsonc` registering the plugin:

```jsonc
{
  "plugins": [
    { "package": "/plugins/opencode-tg" }
  ]
}
```

And the credentials the plugin reads:

```
/root/.config/opencode/tg/.env        TELEGRAM_BOT_TOKEN, ALLOWED_USERS
/root/.config/opencode/tg/config.json mode: "live", mirror, coalesce...
/root/.config/opencode/tg/stt/         optional whisper.cpp binaries
```

## Notes

- The bot token and `~/.opencode/tg/*` must live in the container's home
  — mount them read-only if you prefer.
- Voice transcription (`stt.provider: "local"`) needs the whisper.cpp
  binaries inside the container; the `"openai-compatible"` provider works
  without them.
- The plugin takes the local API auth from `service.json` automatically —
  inside the container it is created by the server on first run.
