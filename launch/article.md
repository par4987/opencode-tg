# Don't run a second process for your AI agent

### A Telegram bridge that lives *inside* the OpenCode server — and the two design decisions that made it work

<!-- Portada: el GIF de 15–20s. Es lo primero que se ve; sin esto, el artículo pierde la mitad del efecto. -->

My agent runs long tasks. Ten, twenty, forty minutes. That's fine while I'm at
the desk. The problem starts when I leave: the agent hits a permission prompt,
stops, and waits. Nothing happens until I come back — sometimes an hour later.

So I built the obvious thing first, and it was wrong.

## Attempt #1: a bot next to the agent

The first version was a normal Telegram bot: a separate process, speaking the
Agent Client Protocol over stdio to a headless OpenCode instance. Clean
architecture on paper. In practice, it only ever saw the sessions **it created
itself**.

Everything else — the sessions I had open in the desktop app, the ones the TUI
started, anything that survived a restart — was invisible. To fake parity I
ended up with a SQLite mirror, a 15-minute "is this session still active?"
heuristic, and a log tail. Three approximation layers to guess what the
computer already knew.

That's the tell: when a bridge needs a copy of the state, it isn't a bridge.

## Attempt #2: live inside the server

OpenCode runs plugins in-process. A plugin receives the same event stream the
TUI renders, for every session, as it happens. No poll, no mirror, no
heuristic:

```ts
// index.ts — the whole architectural bet, in one signature
export default pluginExport;
```

Once the bridge is a plugin, `ctx.event` *is* the truth. A session starts →
there's an event. The model streams a token → there's an event. A permission is
requested → there's an event, with the request id you need to answer it.

That single change deleted a database, a timer, and a class of bugs where the
mirror disagreed with reality.

### What one thread per session buys you

Telegram groups with **Topics** enabled give you forum threads. The mapping is
almost too neat: **one session, one thread** — plus read-only threads for
subagents, so you can watch them without being able to prompt them.

- Writing in a thread is prompting that session. No `/send <id> <text>` prefix.
- The thread becomes the session's console: text, reasoning, edit diffs, tool
  output — streamed into the same message instead of a wall of notifications.
- The "typing…" indicator is the liveness signal. Messages you send mid-turn get
  coalesced and queued; you can see the queue (`/queue`) and steer it.
- `/delthread` deletes the thread and the session keeps running — the chat is a
  view, not the thing itself. `/rebuild` recreates the whole forum from the
  sessions you used recently.

The mental model stops being "a bot that reports on my agent" and becomes "my
agent, with a chat UI".

## The part worth stealing: a guard that parses instead of regexing

This is the design I'd keep if I threw away everything else.

On 2026-10-07 I ran `/sh opencode service restart` from the phone. It executed
inside the server that was hosting the plugin, killed the process — and because
the Telegram poll offset lived only in memory, the update was re-delivered on
every restart. An infinite loop, roughly every ten seconds, until I disabled the
plugin by hand.

Persisting the offset is the cure. The guard is the prevention, and a blocklist
of "bad commands" would not have prevented it: the command was plausible,
useful-looking, and not obviously destructive.

Four principles, in the order they matter:

**1. Parse, don't regex.** Split on `;`, `|`, `&&` and newlines with quote
awareness, take the command name from the first token, resolve aliases to the
canonical cmdlet. `--format=` inside a `git` command can then never be mistaken
for `Format-Volume`.

**2. Invert the default.** A short read-only allowlist (`Get-*`, `Test-*`, the
dev toolchain) passes straight through. Everything unknown asks for
confirmation — because a name the guard doesn't recognise is a name it cannot
vouch for. Unknown is not "probably fine".

**3. Scope by path, not by blanket ban.** A coding agent *has* to delete files.
`Remove-Item` is allowed inside the project folder and forbidden anywhere else.
Destruction is only permitted where the damage would be ours.

**4. Show what was parsed.** The confirmation card lists every command with
aliases resolved, so you approve what will actually run, not what you typed.

Three tiers, because the damage isn't symmetric:

```ts
export type DangerLevel = "ok" | "confirm" | "forbidden";
```

- `ok` — read-only: passes.
- `confirm` — recoverable, sometimes necessary: one tap, with an explanation in
  plain language of what it will do.
- `forbidden` — never runs, not even after a tap: disk formatting, shadow-copy
  deletion, key exfiltration. There's no "approve" for unrecoverable.

The asymmetry is the point. A system that asks for the same confirmation for
`ls` and `rm -rf /` trains you to tap through dialogs, which is the same as
having no guard.

<!-- Captura: la tarjeta de confirmación en Telegram, con el comando ya resuelto. -->

## Watchdogs beat mute timeouts

The second failure mode is quieter: the prompt is delivered, the turn never
starts, and nothing happens. The bridge used to sit there until a generic
timeout fired, which tells you nothing.

Now a watchdog (90s by default) reads the server log and reports the actual
cause: credits exhausted, rate limit, model retired. It's the difference between
"the agent is thinking" and "the agent is dead and you should stop waiting".

Same principle for leadership: when you run more than one OpenCode instance,
only one may poll Telegram without racing to HTTP 409. A leader lock with a
watchdog lets a deposed leader step aside cleanly instead of two processes
fighting over `getUpdates`.

## Voice stays on your machine

Voice notes are transcribed before they reach the agent, and the default is
**local**: whisper.cpp under `~/.opencode/tg/stt`, no cloud, no key, no audio
leaving the machine.

```jsonc
"stt": { "provider": "local" }
```

If you'd rather use an API, point it at any OpenAI-compatible endpoint and keep
the key in `.env`, never in the config file. The trade-off is yours to make, but
the private option should be the one that works out of the box.

## Zero runtime dependencies (really)

`@opencode/plugin` is imported **type-only**, so it's erased at build time:

```ts
import type { Plugin } from "@opencode/plugin";
```

The published package has no `dependencies`. Nothing to audit, nothing to break
on a transitive update, no `node_modules` shipped next to the plugin. For a
component that lives inside someone else's server, that's not minimalism for its
own sake — it's the difference between "installs" and "installs and keeps
working after the next update".

## Installing it

OpenCode installs npm plugins with Bun at startup, so it's one line:

```jsonc
// opencode.jsonc
{
  "plugin": ["opencode-tg"]
}
```

Then the credentials, in `~/.opencode/tg/.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC...
ALLOWED_USERS=123456789
```

Create the bot with [@BotFather](https://t.me/BotFather), enable topics in
`/topics` → *Enable*, and add the bot to a group as an administrator so it can
create and manage the threads. Restart OpenCode and the threads appear.

It starts in `"mode": "dry"`: it logs what it *would* send without touching
Telegram. You can validate the token, the group, and the routing before anything
goes live:

```jsonc
// ~/.opencode/tg/config.json  (outside the package, survives updates)
{ "mode": "live", "mirror": "all" }
```

`mirror: "watched"` only mirrors the sessions you mark with `/watch`, which is
what I'd use on a shared or work machine.

## What I'd do differently

**Start with the event stream, not the protocol.** The ACP version was
architecturally respectable and functionally blind. The in-process version has
fewer moving parts *and* more information.

**Write the guard after the incident, not instead of it.** Every rule in
`dangerous.ts` maps to something that actually happened. Invented threat models
produce rules that don't fire; measured ones produce rules that do.

**Make the safe mode the default.** `dry` first, `live` on purpose. A tool that
can send messages as you should require an explicit act to start doing it.

**Treat the poll offset as state.** Anything kept only in memory becomes a bug
the first time the process dies at the wrong moment.

---

The project is MIT and lives here: **https://github.com/par4987/opencode-tg**

It passes 32 test suites (820 checks) and a typecheck on every push, plus a
twice-weekly dependency audit that only pushes an update when the whole suite is
still green.

If you run long sessions and want the phone as a remote, I'd genuinely like to
know what would make you trust it with a destructive command — that's the
question the guard exists to answer, and the one I'm least sure I got right.

<!--
Notas para publicar:
- dev.to/Medium: pegar sin el bloque de notas.
- La imagen de portada y la captura del guard son las dos únicas que hacen falta.
- Canónica: el artículo vive acá y se linkea desde el post del Discord, no al revés.
- Crosspost: dev.to (canonical), luego Medium con canonical apuntando a dev.to.
-->
