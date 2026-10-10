# Command reference

Every command with what it does, how to use it, examples and notes. The
`/help` menu in Telegram offers these same commands — tap one and you get
its section.

## Sessions

### /new

**What it does**: Creates a new session in the current project.

**Usage**: `/new <title>`

**Examples**:
- `/new Sales analysis` → creates a session titled "Sales analysis"
- `/new` → creates a session with the default title

**Notes**: The Telegram thread is created with the first message. To create in another project: `/projects`.

### /use

**What it does**: Sets which session the chat root's messages go to.

**Usage**: `/use <ses_id>`

**Examples**:
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → the root points at that session
- `/use` → shows the current one

**Notes**: Messages inside a thread always go to that thread's session, regardless of `/use`.

### /fork

**What it does**: Forks a session up to its last message — try ideas without dirtying the original.

**Usage**: `/fork` (in the thread) or `/fork <ses_id>`

**Examples**:
- `/fork` inside a session's thread → creates a fork and tells you
- `/fork ses_xxx` → same from anywhere

**Notes**: The fork is a new session with its own thread. The original stays untouched.

### /rename

**What it does**: Renames a session — the Telegram thread and the desktop follow the change.

**Usage**: `/rename <title>` or `/rename <ses_id> <title>`

**Examples**:
- `/rename Q4 analysis` → renames the thread's session
- `/rename` (no title) → suggests 3 titles from the transcript, you pick with a tap

**Notes**: The title is capped at 128 characters (Telegram's topic-name limit).

### /detach

**What it does**: Detaches the chat root from its session — what you write there goes to no session.

**Usage**: `/detach`

**Examples**:
- `/detach` → the root goes free
- `/use <ses_id>` → couples it again

**Notes**: Session threads are unaffected.

### /archive

**What it does**: Archives the thread's session — in a private chat it deletes the thread and silences the session.

**Usage**: `/archive` or `/archive <ses_id>`

**Examples**:
- `/archive` in a thread → the thread disappears from the chat
- `/archive ses_xxx` → same from anywhere

**Notes**: `/unarchive` brings it back (recreates the thread in a private chat).

### /unarchive

**What it does**: Wakes an archived session — recreates its thread and reactivates the mirror.

**Usage**: `/unarchive` or `/unarchive <ses_id>`

**Examples**:
- `/unarchive` at the root → recreates the archived session's thread

**Notes**: If the thread was deleted, a new one is created with the current title.

### /delthread

**What it does**: Deletes the forum thread without touching the session.

**Usage**: `/delthread` or `/delthread <ses_id>`

**Examples**:
- `/delthread` in a thread → the thread disappears

**Notes**: The session still exists — its next event recreates the thread. To silence it for real: `/archive`.

### /rebuild

**What it does**: Wipes ALL session threads and rebuilds the forum clean.

**Usage**: `/rebuild` (with inline confirmation)

**Examples**:
- `/rebuild` → deletes the mapped threads (one by one, confirmed) and recreates the ones for the sessions you used recently (up to 12, the most recent on top)

**Notes**: Old messages are not re-imported — `/export` downloads each session's transcript. It only recreates threads for sessions you used within `rebuildIdleHours` (default 24h): the server stamps every session's `updated` on restart, so ordering by it resurrected sessions nobody had touched for days; `idle` is the last real activity. Every delete is confirmed before the mapping is forgotten — if Telegram rejects one (rate limit, a cut), the thread stays mapped and the next `/rebuild` retries; a session whose thread survived is not duplicated. Threads left **orphaned** (unmapped) cannot be cleaned by the bot alone: the Bot API has no "list topics", so delete those by hand once.

## Files and code

### /ls

**What it does**: Browses the session's project files.

**Usage**: `/ls [folder]`

**Examples**:
- `/ls` → lists the project's root directory
- `/ls src` → enters the src folder
- Tap a file → it downloads
- 📎 on a text file → attaches it to your next message

**Notes**: The button indexes expire — if a tap says "stale listing", reopen `/ls`.

### /find

**What it does**: Fuzzy file search by name.

**Usage**: `/find <text>`

**Examples**:
- `/find navbar` → files whose name contains "navbar"
- `/find .test.` → files with ".test." in the name

**Notes**: Searches the session's whole project.

### /git

**What it does**: What the agent touched in the project — status with `+/−` and a downloadable diff.

**Usage**: `/git`

**Examples**:
- `/git` → project status
- "View the diff" → preview + downloadable `.patch`

**Notes**: It is the project's diff, not the session's — several agents can share it.

### /revert

**What it does**: Undoes a session's last turn (with confirmation).

**Usage**: `/revert` or `/revert <ses_id>`

**Examples**:
- `/revert` in a thread → proposes undoing the last turn
- You confirm with the button → the turn is undone

**Notes**: Only the last turn. For more: repeat `/revert`.

### /export

**What it does**: Downloads a session's full transcript as JSON.

**Usage**: `/export` or `/export <ses_id>`

**Examples**:
- `/export` in a thread → the transcript JSON arrives
- `/export ses_xxx` → same from anywhere

**Notes**: With the session open on the PC, the export is complete. Closed, there may be no transcript on disk (a server persistence bug).

### /sh

**What it does**: Runs a shell command INSIDE the session — in the background, without waking the agent.

**Usage**: `/sh <command>`

**Examples**:
- `/sh node -v` → `v24.21.0`
- `/sh git status` → the repo's status
- `/sh ls` → the directory's contents

**Notes**: The session's shell is PowerShell — `&&` does not work, use `;`. The output reaches the thread.

**Protected commands**: the command is **parsed** (not regex-matched: real names, aliases resolved) and falls into one of three levels:

- **Passes straight through**: pure reads (`Get-*`, `Test-*`, `ls`, `cat`) and the dev toolchain (`git`, `node`, `npm`, `cargo`, `python`...). A false positive here would have the bot asking confirmation before every `git status`.
- **Asks confirmation**: recoverable but able to cut the service or leave the machine — restarting the server, killing processes, installing software, network calls, remote execution, scheduled tasks. The card **explains what each command does** (what will happen, not just the text) and you must tap "Confirm and run". The pending is deleted **before** executing, so a crash cannot re-trigger it.
- **Blocked, no exception**: what has no way back — formatting and wiping disks, boot and system recovery, the registry, users and credentials, secrets (`.env`, `.ssh`, browser profiles, the `Env:` drive), defenses (antivirus, firewall, BitLocker), log clearing, and every evasion vector (`iex`, `Invoke-Command`, nested `powershell`/`cmd`, `-EncodedCommand`, `Add-Type`, direct .NET/COM access, function and alias definitions). Not even confirming runs it: that is what the PC's console is for.

Deletion is **path-scoped**: `Remove-Item` (and `rm`, `del`, `rmdir`...) is allowed inside the project folder — a coding agent has to be able to delete `node_modules` — and blocked outside. Deleting the whole project (`.`) or its `.git` asks for confirmation.

**Why** (2026-10-07 incident): `/sh opencode service restart` killed the process hosting the plugin; since the poll offset lived only in memory, Telegram re-delivered the update on every restart and the server entered a ~10s loop until the plugin was disabled by hand. The persistent offset is the cure; this guard is the prevention.

### /note

**What it does**: Leaves a note in the transcript — the agent reads it on its next turn, without waking up now.

**Usage**: `/note <text>`

**Examples**:
- `/note Prioritize the sales module` → the agent sees it as context

**Notes**: It is a synthetic message — it does not run the agent.

### /turns

**What it does**: What the session's turns changed — finer-grained than `/git`.

**Usage**: `/turns` or `/turns <ses_id>`

**Examples**:
- `/turns` in a thread → the turns' changes

**Notes**: Can be empty if the server recorded no turn changes.

## Project and config

### /config

**What it does**: Reads and edits the project's `opencode.jsonc` — the model default for new sessions.

**Usage**: `/config` or `/config model <provider/model>`

**Examples**:
- `/config` → shows the current config
- `/config model nvidia/z-ai/glm-5.3` → changes the default (live reload)

**Notes**: The change applies to NEW sessions — no server restart needed.

### /worktree

**What it does**: Lists the project's worktrees or creates a new one.

**Usage**: `/worktree` or `/worktree new <name>`

**Examples**:
- `/worktree` → list with buttons that open sessions in each worktree
- `/worktree new feature-x` → creates the worktree

**Notes**: Tap a worktree to open a session there.

### /move

**What it does**: Moves a session to another project.

**Usage**: `/move <directory>`

**Examples**:
- `/move E:\Projects\Other` → the thread's session moves to that project

**Notes**: The Telegram thread stays the same — only the working directory changes.

### /mcp

**What it does**: Lists the MCP servers or connects/disconnects one.

**Usage**: `/mcp` or `/mcp connect|disconnect <server>`

**Examples**:
- `/mcp` → list with status (🟢 connected / 🔴 not)
- `/mcp disconnect abap-docs` → disconnects it
- `/mcp connect abap-docs` → reconnects it

**Notes**: Adding a new server (PUT) stays on the PC.

### /commands

**What it does**: Lists the config's custom commands or runs one.

**Usage**: `/commands` or `/commands run <text>`

**Examples**:
- `/commands` → the list (init, review, etc.)
- `/commands run init` → runs the "init" command in the thread's session

**Notes**: Custom commands are defined in the project's `opencode.jsonc`.

## Info and debug

### /context

**What it does**: Tokens, cost, model limit and compactions of a session.

**Usage**: `/context` or `/context <ses_id>`

**Examples**:
- `/context` in a thread → that session's context usage

**Notes**: The model is recovered from the transcript if the server's payload does not track it.

### /locale

**What it does**: Switches the bot's language — the `/help` menu, cards and every message follow instantly.

**Usage**: `/locale` (with buttons) or `/locale <es|en>`

**Examples**:
- `/locale` → card with one button per language (the current one with ✓)
- `/locale es` → switches directly; the confirmation arrives IN the chosen language

**Notes**: The choice persists in `~/.opencode/tg/locale.txt` — a restart does not lose it. `TG_LOCALE` in `.env` becomes the initial value. A new language is a new object in `CATALOGS` (src/locale.ts) plus its `COMMANDS.<language>.md` — no extra code.

### /bots

**What it does**: Shows the multi-bot layout: which bot mirrors which project or session, who is free, and the primary bot (the hub) covering everything else.

**Usage**: `/bots`

**Examples**:
- `/bots` → one line per bot with its claim (project, session or "free") and the active topology

**Notes**: Extra bots are declared as `TELEGRAM_BOT_TOKEN_<NAME>` in `~/.opencode/tg/.env` — never in the repo. The topology (`single` / `per-project` / `per-session`) and the explicit mapping (`assign`) live in the `"bots"` block of `config.json`. With a single bot the card explains how to add another. Every extra bot needs topics enabled in BotFather, just like the primary.

### /release

**What it does**: Gives THIS bot back to the pool — `per-session` topology only. Its session falls to the hub until another one claims the bot.

**Usage**: `/release` (from the chat of the bot you want to free)

**Examples**:
- `/release` → "🧹 released — its session falls back to the hub"

**Notes**: The bot is also freed automatically when the session that claimed it is archived (`/archive`). In `single` and `per-project` the command answers that it does not apply. When the session wakes up, its next turn claims a free bot automatically.

### /ci

**What it does**: Shows the repo's latest GitHub Actions runs — which workflow, on which commit, and green or red. The evidence that a push landed whole: typecheck, suites, and twice a week the dependency seal.

**Usage**: `/ci`, `/ci <n>` or `/ci <workflow>`

**Examples**:
- `/ci` → the last 6 runs with their state and a link on the sha
- `/ci 12` → the last 12
- `/ci deps` → only the `deps-audit` workflow runs

**Notes**: Reads GitHub's REST API with no dependencies. The repo is public, so it works with no token (60 calls/hour per IP); a `GITHUB_TOKEN` in `~/.opencode/tg/.env` raises the limit and reaches private repos. The default repo is `par4987/opencode-tg` — a fork overrides it with `"ci": { "repo": "owner/repo" }` in `config.json` or `TG_CI_REPO`.
