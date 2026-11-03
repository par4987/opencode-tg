# Post para el Discord de OpenCode

**Antes de publicar:** `npm view opencode-tg version` tiene que responder. Si da
404, el plugin todavía no está en npm y el `"plugin": ["opencode-tg"]` del post no
funciona.

**Dónde:** en el canal de proyectos/comunidad del server (el de showcase, si
existe). No en `#general` ni por DM a maintainers. Un solo post; si preguntan,
respondés en el hilo.

**Adjunto:** el GIF de 15–20s. Sin GIF, el post rinde bastante menos.

---

## Versión principal (inglés)

**opencode-tg — control OpenCode from Telegram, no second process**

Your agent runs on the PC; the phone is the remote. This is a plugin that lives
*inside* the OpenCode server, so it sees exactly the sessions and events the
desktop sees — no companion bot process, no mirrored database, no activity
heuristics.

What it actually does:

- **One forum thread per session** (and per subagent). Writing in a thread is
  prompting that session; the reply streams back live with text, reasoning, edit
  diffs and tool output.
- **Questions and permissions with inline buttons.** Approve or deny without
  opening the laptop.
- **A three-tier shell guard.** Read-only passes through, service-breaking
  commands ask for confirmation with a plain-language explanation, irreversible
  or evasion-vector commands are blocked. It came out of a real incident where a
  restart command wedged the bot.
- **Voice notes transcribed on your machine** with whisper.cpp — no cloud, no
  keys. Or point it at any OpenAI-compatible API.
- **The rest of the loop:** scheduled tasks, model/agent switching, CI run
  reports, transcript export, thread archive/unarchive, a live per-session
  dashboard, and a dead-prompt watchdog that tells you the real cause (out of
  credits, rate limit, retired model) when a turn never starts.
- **12 UI languages**, switchable from the phone.

Install:

```jsonc
{ "plugin": ["opencode-tg"] }
```

Then `~/.opencode/tg/.env` with `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS`,
restart OpenCode, and the bridge creates a thread per session. It starts in
`"mode": "dry"` by default: it logs what it *would* send without touching
Telegram, so you can check the wiring before going live.

Repo: https://github.com/par4987/opencode-tg — MIT, zero runtime dependencies
(`@opencode/plugin` is type-only).

[GIF]

Feedback welcome, especially from people who run long sessions and want the
phone as a remote. What would it take for you to trust it with a destructive
command?

---

## Versión corta (si el canal pide brevedad)

**opencode-tg** — Telegram bridge that runs inside the OpenCode server. One forum
thread per session; write in a thread to prompt the agent, get the reply
streamed live, approve permissions with buttons, answer questions, send voice
notes transcribed locally. Zero runtime deps, MIT.

```jsonc
{ "plugin": ["opencode-tg"] }
```

https://github.com/par4987/opencode-tg

[GIF]

---

## Notas de publicación

- **No prometas lo que no probaste.** El post no dice "works with every
  provider"; dice lo que el repo hace y lo respalda con el código.
- **Respondé cada comentario.** En un server de 95k personas, un hilo con
  respuestas del autor sube; uno abandonado muere.
- **No lo repostees** en el mismo server ni lo mandes por DM. Un post, un hilo.
- Si alguien reporta un bug en el hilo: pasalo a un issue y contestá con el
  link. Eso convierte curiosos en usuarios.
- **Crosspost con texto distinto** (no copiar-pegar) en r/LocalLLaMA,
  r/ChatGPTCoding, r/selfhosted, Show HN y X. Mismo GIF, distinto ángulo.
