/**
 * i18n — the strings a contributor would translate first.
 *
 * The bot's interface today is Spanish-first (its users are), with the
 * command list in English. Every string added since 2026-10-07 rides this
 * catalog; the older literals are the documented migration backlog and
 * land here pull-request by pull-request.
 *
 * `TG_LOCALE=en` picks the English catalog; anything else falls back to
 * the Spanish originals. A new locale is a new object in CATALOGS —
 * nothing else.
 */

type Catalog = Record<string, string>;

const ES: Catalog = {
  // legacy keys (kept for the migration backlog)
  sending_prompt: "📤 a la sesión",
  queued_notice: "📥 está trabajando — encolado. Se envía solo al terminar el turno.",
  voice_transcribing: "🎤 Transcribiendo",
  subagent_readonly: "🤖 Este hilo es un subagente",
  subagent_owner: "de",
  subagent_advice: "su tarea la maneja la sesión padre. Escribile al hilo del padre.",
  archived_badge: "📦",
  session_not_found_restart:
    "🚫 Esa sesión no está activa en el server — se reinició o la cerraste en la PC, y no se recarga sola. Abrila en la PC y reintentá, o creá otra con /new.",

  // /sh — run a shell command in the session (the server's shell is
  // PowerShell on Windows: no `&&`, use `;`).
  sh_needs_cmd: "Decime el comando: <code>/sh <comando></code>",
  sh_sent: "⌨️ Corriendo en la sesión…",
  sh_done: "⌨️ Listo (exit {exit})",
  sh_timeout: "⌨️ Sigue corriendo después de {secs}s — el resultado llega al hilo cuando termine.",
  sh_ps_note: "Ojo: el shell de la sesión es PowerShell — <code>&&</code> no funciona, usá <code>;</code>.",

  // /note — synthetic message in the transcript, agent asleep.
  note_needs_text: "Decime la nota: <code>/note <texto></code>",
  note_added: "📝 Nota al transcript — el agente la verá en su próximo turno, sin despertarse ahora.",

  // /instructions — persistent per-session instruction entries.
  instr_header: "📋 Instrucciones persistentes de la sesión:",
  instr_empty: "📋 Sin instrucciones persistentes. <code>/instructions <clave> <texto></code> agrega una.",
  instr_added: "✅ Instrucción <code>{key}</code> guardada.",
  instr_deleted: "🗑 Instrucción <code>{key}</code> eliminada.",
  instr_del_needs_key: "Decime la clave: <code>/instructions del <clave></code>",
  instr_needs_key_value: "Formato: <code>/instructions <clave> <texto></code> (o <code>del <clave></code> para borrar)",

  // /perms — saved permission rules (the "always" answers).
  perms_header: "🔐 Permisos guardados (los «siempre»):",
  perms_empty: "🔐 Sin permisos guardados.",
  perms_deleted: "🗑 Permiso eliminado — el server volverá a preguntar.",
  perms_not_found: "No encuentro ese permiso — mirá <code>/perms</code> de nuevo.",
  perms_needs_id: "Decime el id: <code>/perms del <id></code>",

  // /turns — the session's own turn diff.
  turns_header: "🔀 Cambios de los turnos de la sesión:",
  turns_empty: "🔀 Sin cambios de turno registrados.",

  // /log — the session's server-side log (SSE sample).
  log_header: "🧾 Log de la sesión (últimos {n} eventos):",
  log_empty: "🧾 El log no emitió eventos en la ventana de lectura.",

  // /terminal — the session's persistent PTY, read-only.
  term_none: "🖥 Sin terminal activa para esta sesión (aparece cuando el agente corre algo interactivo).",
  term_header: "🖥 Terminal de la sesión:",

  // /detach — the chat root stops pointing at a session.
  detach_done: "🚪 Raíz del chat desacoplada — lo que escribas acá ya no va a ninguna sesión hasta <code>/use</code> o entrar a un hilo.",
  detach_none: "La raíz ya no apunta a ninguna sesión.",

  // /rename without argument — suggestions from the transcript.
  rename_suggesting: "🤔 Mirando la conversación para sugerir títulos…",
  rename_suggest_fail: "No pude generar sugerencias — el modelo tardó o falló. Podés pasar el título a mano: <code>/rename <título></code>.",

  // error receipts — the most visible strings when something fails.
  err_generic: "No se pudo {action}: {detail}",
  err_no_session: "Escribilo en el hilo de una sesión, o <code>/use</code> primero.",
  err_no_target: "No sé qué sesión — escribilo en su hilo, o <code>/rename &lt;ses_id&gt; &lt;título&gt;</code>.",
  err_no_text: "Decime el texto: <code>/send &lt;texto&gt;</code>",
  err_no_cmd: "Decime el comando: <code>/sh &lt;comando&gt;</code>",
  err_no_note: "Decime la nota: <code>/note &lt;texto&gt;</code>",
  err_no_title: "Decime el título: <code>/rename &lt;nuevo título&gt;</code>",
  err_no_project: "Decime el proyecto: <code>/move &lt;directorio&gt;</code> — <code>/projects</code> los lista.",
  err_no_perm_id: "Decime el id: <code>/perms del &lt;id&gt;</code>",
  err_no_instr_key: "Decime la clave: <code>/instructions del &lt;clave&gt;</code>",
  err_no_mcp_server: "Decime el server: <code>/mcp {action} &lt;server&gt;</code>",
  err_no_command_text: "Formato: <code>/commands run &lt;texto&gt;</code> — en el hilo de una sesión.",
  err_no_sub_arg: "Escribilo en el hilo de una sesión (o <code>/use</code> primero).",
  err_in_thread_use: "Escribilo en el hilo de una sesión (o <code>/use</code> primero).",
  err_in_thread_project: "Escribilo en el hilo de una sesión (ese es su proyecto).",
  err_in_thread_revert: "Escribilo en el hilo de una sesión, o <code>/revert &lt;ses_id&gt;</code>.",
  err_in_thread_context: "Escribilo en el hilo de una sesión, o <code>/context &lt;ses_id&gt;</code>.",
  err_in_thread_fork: "Escribilo en el hilo de una sesión, o <code>/fork &lt;ses_id&gt;</code>.",
  err_in_thread_export: "Escribilo en el hilo de una sesión, o <code>/export &lt;ses_id&gt;</code>.",
  err_in_thread_turns: "Escribilo en el hilo de una sesión, o <code>/turns &lt;ses_id&gt;</code>.",
  err_in_thread_log: "Escribilo en el hilo de una sesión, o <code>/log &lt;ses_id&gt;</code>.",
  err_in_thread_terminal: "Escribilo en el hilo de una sesión, o <code>/terminal &lt;ses_id&gt;</code>.",
  err_in_thread_move: "Escribilo en el hilo de una sesión, o <code>/move &lt;ses_id&gt; &lt;directorio&gt;</code>.",
};

const EN: Catalog = {
  sending_prompt: "📤 to the session",
  queued_notice: "📥 is working — queued. It sends itself when the turn ends.",
  voice_transcribing: "🎤 Transcribing",
  subagent_readonly: "🤖 This thread is a subagent",
  subagent_owner: "of",
  subagent_advice: "the parent session drives its task. Write to the parent's thread.",
  archived_badge: "📦",
  session_not_found_restart:
    "🚫 That session is not active in the server — it restarted or you closed it on the PC, and it does not reload on its own. Open it on the PC and retry, or make a new one with /new.",

  sh_needs_cmd: "Give me the command: <code>/sh <command></code>",
  sh_sent: "⌨️ Running in the session…",
  sh_done: "⌨️ Done (exit {exit})",
  sh_timeout: "⌨️ Still running after {secs}s — the result reaches the thread when it finishes.",
  sh_ps_note: "Heads-up: the session's shell is PowerShell — <code>&&</code> does not work, use <code>;</code>.",

  note_needs_text: "Give me the note: <code>/note <text></code>",
  note_added: "📝 Noted into the transcript — the agent sees it on its next turn, without waking now.",

  instr_header: "📋 Persistent instructions for the session:",
  instr_empty: "📋 No persistent instructions. <code>/instructions <key> <text></code> adds one.",
  instr_added: "✅ Instruction <code>{key}</code> saved.",
  instr_deleted: "🗑 Instruction <code>{key}</code> removed.",
  instr_del_needs_key: "Give me the key: <code>/instructions del <key></code>",
  instr_needs_key_value: "Format: <code>/instructions <key> <text></code> (or <code>del <key></code> to remove)",

  perms_header: "🔐 Saved permissions (the “always” ones):",
  perms_empty: "🔐 No saved permissions.",
  perms_deleted: "🗑 Permission removed — the server will ask again.",
  perms_not_found: "Cannot find that permission — run <code>/perms</code> again.",
  perms_needs_id: "Give me the id: <code>/perms del <id></code>",

  turns_header: "🔀 The session's turn changes:",
  turns_empty: "🔀 No turn changes recorded.",

  log_header: "🧾 Session log (last {n} events):",
  log_empty: "🧾 The log emitted nothing within the read window.",

  term_none: "🖥 No active terminal for this session (one appears when the agent runs something interactive).",
  term_header: "🖥 The session's terminal:",

  detach_done: "🚪 Chat root detached — what you write here goes to no session until <code>/use</code> or entering a thread.",
  detach_none: "The root already points at no session.",

  rename_suggesting: "🤔 Reading the conversation to suggest titles…",
  rename_suggest_fail: "Could not generate suggestions — the model took too long or failed. Pass a title by hand: <code>/rename <title></code>.",

  err_generic: "Could not {action}: {detail}",
  err_no_session: "Write it in a session's thread, or <code>/use</code> first.",
  err_no_target: "I don't know which session — write it in its thread, or <code>/rename &lt;ses_id&gt; &lt;title&gt;</code>.",
  err_no_text: "Give me the text: <code>/send &lt;text></code>",
  err_no_cmd: "Give me the command: <code>/sh &lt;command></code>",
  err_no_note: "Give me the note: <code>/note <text></code>",
  err_no_title: "Give me the title: <code>/rename &lt;new title&gt;</code>",
  err_no_project: "Give me the project: <code>/move &lt;directory&gt;</code> — <code>/projects</code> lists them.",
  err_no_perm_id: "Give me the id: <code>/perms del &lt;id&gt;</code>",
  err_no_instr_key: "Give me the key: <code>/instructions del &lt;key&gt;</code>",
  err_no_mcp_server: "Give me the server: <code>/mcp {action} &lt;server&gt;</code>",
  err_no_command_text: "Format: <code>/commands run &lt;text></code> — in a session's thread.",
  err_no_sub_arg: "Write it in a session's thread (or <code>/use</code> first).",
  err_in_thread_use: "Write it in a session's thread (or <code>/use</code> first).",
  err_in_thread_project: "Write it in a session's thread (that's its project).",
  err_in_thread_revert: "Write it in a session's thread, or <code>/revert &lt;ses_id&gt;</code>.",
  err_in_thread_context: "Write it in a session's thread, or <code>/context &lt;ses_id&gt;</code>.",
  err_in_thread_fork: "Write it in a session's thread, or <code>/fork &lt;ses_id&gt;</code>.",
  err_in_thread_export: "Write it in a session's thread, or <code>/export &lt;ses_id&gt;</code>.",
  err_in_thread_turns: "Write it in a session's thread, or <code>/turns &lt;ses_id&gt;</code>.",
  err_in_thread_log: "Write it in a session's thread, or <code>/log &lt;ses_id&gt;</code>.",
  err_in_thread_terminal: "Write it in a session's thread, or <code>/terminal &lt;ses_id&gt;</code>.",
  err_in_thread_move: "Write it in a session's thread, or <code>/move &lt;ses_id&gt; &lt;directory&gt;</code>.",
};

const CATALOGS: Record<string, Catalog> = { es: ES, en: EN };

export function locale(): string {
  const value = (process.env.TG_LOCALE ?? "").toLowerCase();
  return CATALOGS[value] ? value : "es";
}

/** Translate a key; `{placeholders}` fill from the second argument. */
export function t(key: string, values: Record<string, string | number> = {}): string {
  const raw = CATALOGS[locale()][key] ?? ES[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
}
