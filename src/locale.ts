/**
 * i18n scaffold — the strings a contributor would translate first.
 *
 * The bot's interface today is Spanish-first (its users are), with the
 * command list in English. A full migration is mechanical: replace each
 * literal in index.ts with `t("key")`. This catalog holds the most visible
 * strings so that migration is pull-request-friendly.
 *
 * `TG_LOCALE=en` picks the English catalog; anything else falls back to
 * the Spanish originals.
 */

type Catalog = Record<string, string>;

const ES: Catalog = {
  sending_prompt: "📤 a la sesión",
  queued_notice: "📥 está trabajando — encolado. Se envía solo al terminar el turno.",
  voice_transcribing: "🎤 Transcribiendo",
  session_not_found_restart: "🚫 Esa sesión no está activa en el server — se reinició o la cerraste en la PC, y no se recarga sola. Abrila en la PC y reintentá, o creá otra con /new.",
  subagent_readonly: "🤖 Este hilo es un subagente",
  subagent_owner: "de",
  subagent_advice: "su tarea la maneja la sesión padre. Escribile al hilo del padre.",
  archived_badge: "📦",
};

const EN: Catalog = {
  sending_prompt: "📤 to the session",
  queued_notice: "📥 is working — queued. It sends itself when the turn ends.",
  voice_transcribing: "🎤 Transcribing",
  session_not_found_restart: "🚫 That session is not active in the server — it restarted or you closed it on the PC, and it does not reload on its own. Open it on the PC and retry, or make a new one with /new.",
  subagent_readonly: "🤖 This thread is a subagent",
  subagent_owner: "of",
  subagent_advice: "the parent session drives its task. Write to the parent's thread.",
  archived_badge: "📦",
};

const CATALOGS: Record<string, Catalog> = { es: ES, en: EN };

export function locale(): string {
  const value = (process.env.TG_LOCALE ?? "").toLowerCase();
  return CATALOGS[value] ? value : "es";
}

export function t(key: string): string {
  return CATALOGS[locale()][key] ?? ES[key] ?? key;
}
