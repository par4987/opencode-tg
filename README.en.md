# opencode-tg

[![CI](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml/badge.svg)](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml)

> Read this in [Español](README.md) | **English**

Control [OpenCode](https://opencode.ai) from your phone: every server
session gets its own Telegram topic, and writing in the topic is sending the
agent a prompt.

It runs **inside** the OpenCode server as a plugin. There is no separate
process to start, binary to maintain, or duplicated state: it sees exactly
the same sessions and events as the desktop, because it is part of the same
server. `@opencode/plugin` as types only — **zero runtime dependencies**.

## From your phone

- **The topic is an agent console**: write and it is a prompt; the answer
  streams back into the same topic (text, reasoning, edit diffs, tool
  output).
- **Heartbeats**: "typing…" while the turn runs. Anything you send mid-turn
  is grouped and delivered when the turn finishes.
- **Questions and permissions with buttons**: the agent asks or requests
  permission and you answer with a tap, without opening the PC — including
  an "Always" that saves the rule server-side.
- **Multimedia reaches the agent**: photos, text documents inlined, binaries
  to disk with their path. **Voice notes are transcribed on your own
  machine** (local whisper.cpp, no cloud, no keys) or via an OpenAI
  compatible API.
- **Files the agent produces come to you on their own**: photo if it is an
  image, readable message for small text (`.md`/`.txt` in numbered parts),
  document attachment for the rest.
- **Everything under control**: `/models` mirrors the desktop picker (the
  project's model marked ✅), `/usagestats` with tokens, cost and streak,
  scheduled tasks (`/newtask`, `/tasks`), and the server inbox with
  reordering and fast-tracking (`/queue`, `/flush`).
- **When the provider fails, you hear about it**: if the model never starts
  the turn (credits used up, rate limited, a retired model), a watchdog
  tells you the real cause at the 90s mark — not a mute timeout that
  explains nothing.
- **Optional multi-bot**: extra bots (`TELEGRAM_BOT_TOKEN_<NAME>` in the
  `.env`) with a one-bot-per-project or one-bot-per-session topology.
  `/bots` shows the layout; see the MANUAL.

The full user manual is in [`MANUAL.md`](MANUAL.md) (Español) /
[`MANUAL.en.md`](MANUAL.en.md) (English), and the command reference is in
[`docs/COMMANDS.en.md`](docs/COMMANDS.en.md) — which is also what `/help`
serves from the bot.

## Configuration

1. Register the plugin in OpenCode's config (global `opencode.jsonc` or the
   project's) pointing at the directory:

   ```jsonc
   "plugins": [
     { "package": "C:/path/to/opencode-tg" }
   ]
   ```

2. Create `~/.opencode/tg/.env` (never committed to the repo):

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   ALLOWED_USERS=123456789
   ```

3. Adjust `config.json` next to the plugin: `mode` (`off`/`dry`/`live`),
   `mirror` (`all`/`watched`), `bots` (multi-bot topology), `coalesceMs`,
   `coalesceBusyMs`, `archiveAfterDays`, `render.*`. Start in `dry` to
   validate without touching Telegram.

Exercised against OpenCode 2.0.15–2.0.22; the finer per-version details
(permissions, sessions after a restart, leader watchdogs) live in the
[`MANUAL.en.md`](MANUAL.en.md), *Server details* section.

## Voice (optional — per user)

Voice notes are transcribed before reaching the agent. Without an `stt`
entry the bot explains how to enable it — the feature is opt-in by design.

**Local — whisper.cpp (free, private):**

```jsonc
"stt": { "provider": "local" }
```

Requirements: [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) on the PATH
(Windows: `winget install ffmpeg`) — it decodes Telegram's OGG/Opus to the
WAV whisper.cpp reads — and `whisper-blas-bin-x64.zip` from the
[whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases)
into `~/.opencode/tg/stt/Release/`, plus a ggml model (e.g.
[ggml-small.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin))
into `~/.opencode/tg/stt/models/` — those are the default paths. Mind the
RAM: whisper loads the model **plus** its buffers, so small (465 MB) wants
roughly 600 MB free; on a tight machine a smaller model still works —
[ggml-base.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin)
(~140 MB) or
[ggml-tiny.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin)
(~75 MB) — point `stt.model` at the file.

**Cloud — any OpenAI-compatible API** (Groq, OpenAI, self-hosted):

```jsonc
"stt": {
  "provider": "openai-compatible",
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "whisper-large-v3-turbo"
}
```

Common `stt` options: `whisper` and `model` (local paths), `baseUrl` +
`model` + `STT_API_KEY` (cloud, the key goes in the `.env`), `language`
(defaults to `es`).

## Docker

`docker/` ships the `Dockerfile`, `compose.yaml` and the config that mount
OpenCode + the plugin in a container — see [`docs/DOCKER.md`](docs/DOCKER.md)
for the full walkthrough.

## Languages

Spanish by default; today **Español, English, Português, Deutsch, Français, Italiano, Bahasa Indonesia, Русский, Türkçe, 中文（简体）, 한국어 and العربية**. From the bot,
`/locale` switches the language and remembers it; from the `.env`,
`TG_LOCALE=<code>`. Catalogs live in `src/locale.ts` — a new language is a
new object, nothing else.

## For anyone extending it

```sh
npm install
npm run typecheck   # tsc with the project's tsconfig — 0 errors
npm test            # the 24 suites (646 checks) with their own runner
```

GitHub Actions runs both on every push (`.github/workflows/ci.yml`). The
[`deps-audit`](.github/workflows/deps-audit.yml) workflow updates
dependencies and seals vulnerabilities on Mondays and Thursdays, and only
pushes when everything stays green — from the phone, `/ci` shows the latest
runs.

```
index.ts          the whole plugin: commands, handlers, event pump
src/              transport (telegram), topics, renderer, coalescing,
                  ingest, media-out, tasks, config, forms, desktop-models
scripts/          test suite + example generators (_gen_*)
MANUAL.md         end-user manual
```

## License

[MIT](LICENSE) © 2026 par4987
