# opencode-tg

[![CI](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml/badge.svg)](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml)

> Read this in [Español](README.md) | **English**

Bidirectional bridge between [OpenCode](https://opencode.ai) and Telegram:
every server session gets its own topic in a Telegram forum, and the topic
is a complete agent console — prompts, answers, questions with buttons,
permissions, produced files and scheduled tasks.

It runs **inside** the OpenCode server as a plugin (`@opencode/plugin` as
types only, **zero runtime dependencies**), so it sees the same sessions
and events as the desktop — no separate process, no bot duplicating state.

## What it does

- **One topic per session**: writing in the topic is a prompt; the answer
  renders live (text, reasoning, edit diffs, tool output).
- **Heartbeats**: "typing…" while the turn runs; messages sent while the
  agent works are grouped by burst and delivered together.
- **Reply-context**: replying to a topic message injects the quote into
  the prompt (with Telegram's forum echo filtered out).
- **Multimedia**: photos → the agent sees them; text documents → inlined
  into the prompt; binaries → disk with the path; **voice notes →
  transcription** with your provider of choice (see below).
- **Produced files**: the agent creates a file mid-turn and the bot
  delivers it on its own — photo if it's an image, readable message for
  small text (`.md`/`.txt` in numbered parts), document attachment for the
  rest.
- **Multi-question forms**: each question with its own numbered buttons,
  same-message progress "(2/3)", reply with all the answers at the end.
- **Questions and permissions** with inline buttons — answerable from the
  phone, including an "Always" that saves the rule server-side.
- **Server inbox** with reordering, fast-tracking (steer) and `/flush`.
- **Scheduled tasks** with a persistent wizard (`/newtask`, `/tasks`).
- **`/models`** mirrors the desktop picker; **`/usagestats`** brings
  tokens, cost and streak.

The full user manual is in [`MANUAL.md`](MANUAL.md) (Español) /
[`MANUAL.en.md`](MANUAL.en.md) (English).

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
   `mirror` (`all`/`watched`), `coalesceMs`, `coalesceBusyMs`,
   `archiveAfterDays`, `render.*`. Start in `dry` to validate without
   touching Telegram.

## Voice (optional — each user picks)

Voice notes are transcribed before reaching the agent. Without an `stt`
key the bot points at the README — the feature is opt-in by design.

**Local — whisper.cpp (free, private):**

```jsonc
"stt": { "provider": "local" }
```

Requirements: [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) on the PATH
(Windows: `winget install ffmpeg`) — it decodes Telegram's OGG/Opus into
the WAV whisper.cpp reads — plus `whisper-blas-bin-x64.zip` from the
[whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases)
into `~/.opencode/tg/stt/Release/` and a ggml model (e.g.
[ggml-small.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin))
into `~/.opencode/tg/stt/models/` — those are the default paths.

**Cloud — any OpenAI-compatible API** (Groq, OpenAI, self-hosted):

```jsonc
"stt": {
  "provider": "openai-compatible",
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "whisper-large-v3-turbo"
}
```

Use Groq's `baseUrl` above or `https://api.openai.com/v1` with model
`whisper-1`. The key lives in `~/.opencode/tg/.env`:

```
STT_API_KEY=...
```

Common `stt` options: `whisper` and `model` (local paths), `baseUrl` +
`model` + `STT_API_KEY` (cloud), `language` (defaults to `es`).

## Server compatibility

- **Permissions**: servers 2.0.19+ ship the build agent with `{"*", "*", "allow"}` as its first rule, so `ask` rules from the config's `permissions` (root or `agents.*`) are shadowed — permission prompts only arrive when the *server* decides to ask (e.g. `external_directory` or `.env` reads). When one arrives, the bot shows its three buttons (✅ once · 🔁 always · ✖ deny) and settles it over the local API.
- **Inactive sessions**: the server only serves sessions it holds in memory by id — after a restart (or once the PC closes one) every id-addressed endpoint 404s until it is reopened (verified live: GET, prompt, inbox, fork, context). The plugin absorbs it where it can: `/ls`, `/git`, `/find`, `/config`, `/worktree` and `/new` resolve the directory from the plugin's own records (tracked session + on-disk `<id>.json`), and `/export` falls back to the on-disk `<id>.jsonl`, so they keep working. What genuinely needs the server (prompts, `/usage`, `/context`, `/compact`, `/fork`, `/revert`, `/kill`, `/queue`) answers with the honest "not active — open it on the PC" notice instead of a cryptic 404.
- **Poll watchdog**: every plugin instance watches the leadership seat — its own or another member's — and waiting instances re-contest the election every 5s. Before this, a hand-off-installed leader had no watcher: its poll hung, the lock heartbeat froze, and no healthy instance ever re-contested — the bot went deaf until a manual restart (measured 2026-10-05). A live process whose heartbeat froze past 60s loses the lock (wedged seizure, see `_leadercheck`).
- **Topics deleted from the phone**: removing a thread with Telegram's native delete used to leave an orphaned mapping — the mirror talked to a grave forever. The transport now detects "message thread not found", drops the mapping (keeping the archived state) and retries at the chat root; the next event rebuilds the thread. Symmetrically: `/archive` in a private chat removes the thread (Telegram cannot close topics there) and `/unarchive` rebuilds it fresh.
- The plugin has been exercised against 2.0.15–2.0.22; typechecking uses the current generation's `@opencode/plugin`.

## Tests and verification

```sh
npm install
npm run typecheck   # tsc with the project's tsconfig — 0 errors
npm test            # the 13 suites (~175 checks) with their own runner
```

GitHub Actions runs both on every push (`.github/workflows/ci.yml`).

## Structure

```
index.ts          the whole plugin: commands, handlers, event pump
src/              transport (telegram), topics, renderer, coalescing,
                  ingest, media-out, tasks, config, forms, stt, models
scripts/          the test suites + example generators (_gen_*)
MANUAL.md/.en.md  end-user manual (Spanish / English)
```
