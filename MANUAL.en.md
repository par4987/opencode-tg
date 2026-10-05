# opencode-tg — English manual

> Read this in [Español](MANUAL.md) | **English**

Your coding assistant, on your phone. The bot mirrors your OpenCode
sessions into a Telegram forum: **every session gets its own topic**, what
you write in the topic reaches the agent, and everything the agent answers
or produces comes back to the topic.

---

## The basics

| You want… | Do this |
| --- | --- |
| Talk to a session | Write in that session's topic. Every text is a prompt. |
| Start from scratch | `/new` creates a new session (with its own topic). |
| See what's there | `/sessions` lists every session with its status. |
| Switch context | `/use <id>` pins the session you talk to from the General topic. |

While the agent works, the topic shows a *"typing…"* indicator — that's the
bot's heartbeat. You don't need to wait to write: **whatever you send while
it works gets grouped by burst** (quick follow-ups travel together) and
lands in the server's inbox within seconds — you see it with `/queue` and
you can fast-track it into the running turn with ▶.

---

## Messages: what reaches the agent

| You send | The agent gets |
| --- | --- |
| Text in a topic | A direct prompt |
| A reply to an earlier message | A prompt with the quote: the quoted message rides on top, between `<<<…>>>` |
| Several lines in a row | Merged when they arrive in a burst: 2s window (agent idle) or 8s (agent working) |
| A photo (with or without caption) | An image the agent can see (caption = the prompt text) |
| A text document (.md, .txt, code) | Its content inlined into the prompt (up to 100,000 chars) |
| A binary or video | Saved to disk; the agent gets the path |
| A voice note | **Transcribed by your provider** (local whisper.cpp or cloud) — the text enters as a prompt; an open question gets it as the answer |

**Tip**: reply to the message you want to comment on — the agent sees
exactly what you're referring to, no context repeated.

---

## Files the agent sends you

When the agent produces files during a turn, the bot delivers them on its
own:

| File type | How it arrives |
| --- | --- |
| Images (.png, .jpg, .webp) | **Photo** in the topic — visible right away |
| Small text (.md, .txt up to 12 KB) | **Readable message** in the chat, title + content, in numbered parts when it doesn't fit one message |
| Everything else (big .md, .pdf, .zip, .csv, .xlsx…) | **Downloadable document** |

Delivery lands ~30 seconds after the agent creates the file — it doesn't
wait for the turn to end.

---

## Subagents

When the agent delegates to a subagent (the `task` tool), its topic shows up
in the forum badged **🤖** with the task's name. They are **read-only**: the
parent session drives their work — writing to them gets a notice and nothing
is sent (same as the desktop). When they finish, the topic **archives
itself**. `/sessions` marks them as "🤖 sub". In `config.json`,
`"subagents": "off"` hides them entirely.

## Multi-question forms: answer one by one

When the agent asks several questions in one form, the topic shows each
question numbered with **its own buttons** (`1: …`, `2: …`, `3: …`). Every
tap stores that question's answer and the **same message re-edits itself**
with the progress — "(2/3)", your pick marked with ✓ and "➔ your answer: …"
under it. You can correct any question by tapping another option while the
form isn't complete. The reply only goes out when the last question is
answered — with **all the answers together**.

## Questions and permissions: answer from the phone

- **Single questions**: inline **buttons** in the topic. Tap an option and
  the turn continues. Free-text answers go by their number, or `/txt <your answer>`.
- If a question or permission arrives while you are reading another thread,
  **General gets a short heads-up** pointing at it.
- **Permissions**: when the agent needs an approval you get a message with
  **[✅ Allow] [🔁 Always] [✖ Deny]**. "Always" saves the rule — the server
  won't ask again for that pattern. Tap and the turn continues without
  opening the PC.

---

## Commands

### Sessions

| Command | What it does |
| --- | --- |
| `/sessions` | Lists sessions: title, id, status (working / idle) |
| `/use <id>` | Pins the session you talk to from General |
| `/watch <id>` / `/watch off` | Watch (or stop watching) a session |
| `/running` | Only the sessions working right now |
| `/history` | History of the topic's session (or `/history <id>`) |
| `/kill` | Interrupts the current turn |
| `/new` | New session with its own topic — `/new <title>` creates it already named; the topic follows session renames |
| `/send <id> <text>` | Send a prompt to a session without switching topics |
| `/menu` | Main menu with buttons |
| `/usage` | Current model usage (tokens and cost of the project) |
| `/ls` | Browse the project's files from the phone — tap a folder to enter, a file to download, 📎 to attach it to your next message |
| `/find <text>` | Search files by name in the project — tap a result to download it |
| `/git` | What the agent changed in the project: status with +/- per file, and the full diff downloadable |
| `/revert` | Undo a session's last turn — inline confirmation, there is no way back |
| `/config` | See the project's config (default model, agents, MCP, permissions) — `/config model <provider/model>` changes the default for new sessions |

### Agent setup

| Command | What it does |
| --- | --- |
| `/models` | Switch model — **exact mirror of the desktop picker** (provider → model, with search) |
| `/agents` | List available agents |
| `/mcp` | Connected MCP servers |
| `/skills` | Installed skills, with invocation buttons |
| `/skill <id> <text>` | Invoke a skill with your text as the prompt |
| `/compact` | Compact the session's context |

### Message queue (inbox)

While the agent works your messages sit in the server's inbox — it
survives restarts and delivers on its own:

| Command | What it does |
| --- | --- |
| `/queue` | See the queue: reorder with ↑↓, fast-track with ▶, cancel with ✖, replace with ✏️, or "Send in this order" |
| `/flush` | Pushes everything enqueued NOW. With text (`/flush <text>`) it injects it straight into the running turn |

### Stats

| Command | What it does |
| --- | --- |
| `/usagestats [days]` | Tokens, cost, sessions, prompts, steps, cache and streak of the last days (default 7, up to 90) |

### Scheduled tasks

| Command | What it does |
| --- | --- |
| `/newtask` | Six-step wizard: project → reference session → prompt → model → interval → confirm. The draft persists: if you stop halfway, `/newtask` resumes where you left it |
| `/tasks` | List your tasks: pause, run now, **edit the prompt (✏️)** or delete |

Each run opens a **new session** with the model you picked, runs the
prompt, and the result lands in the task's topic.

### Forum topics

| Command | What it does |
| --- | --- |
| `/archive` | Archives the session's topic (visible but closed) |
| `/unarchive` | Reopens it |
| `/delthread` | Deletes the forum topic (the session lives on in OpenCode) |

Topics archive themselves after idle days (`archiveAfterDays`) and reopen
on their own if the session revives.

### Projects

| Command | What it does |
| --- | --- |
| `/projects` | Pick which project a new session lives in (only shows projects that exist on disk) |

---

## Configuration (optional)

Everything lives in `config.json` next to the plugin; the token and the
allowed-chats list in `~/.opencode/tg/.env`.

| Key | Default | What it controls |
| --- | --- | --- |
| `mode` | `"dry"` | `"off"` disabled · `"dry"` log only · `"live"` active |
| `mirror` | `"all"` | `"all"` mirrors every session · `"watched"` only the watched ones |
| `coalesceMs` | `2000` | Window (ms) to merge burst messages when the session is idle |
| `coalesceBusyMs` | `8000` | Burst window (ms) while the agent works; then it enters the queue |
| `archiveAfterDays` | `0` (off) | Idle days before topics auto-archive |
| `stt.provider` | — | Voice transcription: `"local"` (whisper.cpp) or `"openai-compatible"` (see the README) |
| `render.showReasoning` | `true` | Show the agent's reasoning in the topic |
| `render.showDiffs` | `true` | Show diffs on file edits |
| `render.editIntervalMs` | `1400` | How often the live message updates |

---

## Known state

- **Voice notes**: opt-in per user — local whisper.cpp (default) or any
  OpenAI-compatible API; see the README's Voice section.
- **Archiving in a private chat**: Telegram does not let a bot close topics
  there — `/archive` goes silent on the bot's side (no mirror, no
  heads-ups) and badges the thread with 📦; `/unarchive` wakes it.
  `/delthread` does delete the topic, but an active session recreates it
  on its next event.
- **Sessions after a server restart**: the server only holds sessions the
  PC keeps open — after a restart, writing to a thread whose session is
  no longer open answers "🚫 that session is not active in the server".
  It is not a bot bug: open it on the PC and it keeps working, or make a
  new one with `/new`. The project commands (`/ls`, `/git`, `/find`,
  `/config`, `/worktree`) and `/export` keep working regardless because
  they read from disk.
- Inline texts travel complete in numbered parts; anything over 12 KB
  rides as a document.

*Generated 2026-09-30 by the agent of the «Problemas al activar el bot de
Telegram» session.*
