/**
 * Local HTTP bridge to OpenCode's session forms.
 *
 * When the agent calls `question` the server opens a *form* and blocks the turn
 * until somebody answers it. Answering is `POST /session/{sid}/form/{fid}/reply`
 * — and the plugin context cannot reach that: `ctx.session` is built from a
 * fixed list in the promise adapter (`create/get/prompt/interrupt/…`) and
 * `form` is deliberately not on it. Only the TUI plugin gets the method.
 *
 * So the bridge goes out through the same process' HTTP API instead. Two things
 * are needed and neither is configured anywhere the plugin can read:
 *
 *   - the port. It is picked per start, so it is found by scanning this
 *     process' own listening sockets and confirming each candidate against
 *     `GET /info`, which reports the pid that is serving it.
 *   - the Basic-auth password. Read (never written) from `service.json`, the
 *     same file `opencode service` uses; the API user is the fixed `opencode`.
 *
 * This is additive by design: if discovery fails, nothing here throws — the
 * caller falls back to telling the user the answer belongs on the PC, and the
 * PC's own path to the form is untouched.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { log } from "./log.js";

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormField {
  key: string;
  type?: string;
  title?: string;
  description?: string;
  required?: boolean;
  /** Present on `string`/`multiselect` fields — what the buttons map to. */
  options?: FormOption[];
}

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

/** One option-bearing field of a form, flattened for the buttons. */
export interface FormChoice {
  /** Position in `form.fields` — how the callback data names the field. */
  fieldIndex: number;
  fieldKey: string;
  title: string;
  options: FormOption[];
  multiple: boolean;
}

/**
 * The fields a button can answer: only those carrying options, in field order.
 * A form without any (`question` with no choices, or a plain text field) comes
 * back empty, which is the caller's cue to point at the desktop client.
 */
export function choicesOf(form: FormInfo): FormChoice[] {
  return (form.fields ?? [])
    .map((field, fieldIndex) => ({
      fieldIndex,
      fieldKey: field.key,
      title: field.title ?? "",
      options: field.options ?? [],
      multiple: field.type === "multiselect",
    }))
    .filter((choice) => choice.options.length > 0);
}

/** `{answer: …}` collapsed to something readable in a receipt line. */
export function formatAnswer(answer: unknown): string {
  if (!answer || typeof answer !== "object") return "";
  const values = Object.values(answer as Record<string, unknown>).map((value) =>
    Array.isArray(value) ? value.join(", ") : String(value),
  );
  return values.join(" \u00b7 ").slice(0, 200);
}

/** One option picked for one field — a multiselect field expects an array. */
export function answerFor(choice: FormChoice, option: FormOption): Record<string, string | string[]> {
  return choice.multiple ? { [choice.fieldKey]: [option.value] } : { [choice.fieldKey]: option.value };
}

/** Merge one field's answer into the accumulated set — later taps overwrite. */
export function mergeAnswer(
  answers: Record<string, string | string[]>,
  partial: Record<string, string | string[]>,
): Record<string, string | string[]> {
  return { ...answers, ...partial };
}

/** True when every option-bearing field has an answer in the set. */
export function formComplete(
  choices: FormChoice[],
  answers: Record<string, string | string[]>,
): boolean {
  return choices.every((choice) => answers[choice.fieldKey] !== undefined);
}

/** Receipt line for all answers: "Título: valor · Título: valor". */
export function formatFullAnswer(
  choices: FormChoice[],
  answers: Record<string, string | string[]>,
): string {
  return choices
    .map((choice) => {
      const value = answers[choice.fieldKey];
      if (value === undefined) return "";
      const shown = Array.isArray(value) ? value.join(", ") : String(value);
      return `${choice.title ? `${choice.title}: ` : ""}${shown}`;
    })
    .filter(Boolean)
    .join(" \u00b7 ")
    .slice(0, 300);
}

/**
 * Is this typed message the answer to that question? A number picks that
 * position; otherwise the option's label or value has to match by name.
 * Returning undefined means "not an answer" and the message is a normal prompt.
 */
export function pickOption(choice: FormChoice, text: string): FormOption | undefined {
  const trimmed = text.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= choice.options.length) return choice.options[index - 1];
  const lower = trimmed.toLowerCase();
  return choice.options.find((o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower);
}

/**
 * A free-text answer for one field: commas split a multiselect, anything else
 * rides as the plain string the server already accepts for `string` fields.
 */
export function answerFree(choice: FormChoice, text: string): Record<string, string | string[]> {
  const trimmed = text.trim();
  return choice.multiple
    ? { [choice.fieldKey]: trimmed.split(",").map((part) => part.trim()).filter(Boolean) }
    : { [choice.fieldKey]: trimmed };
}

/**
 * `/txt <respuesta>` — the explicit door to a free-text answer. The
 * `@BotName` suffix that group chats add to commands is ignored.
 */
export function parseFreeCommand(text: string): string | undefined {
  const match = /^\/txt(?:@\w+)?\s+([\s\S]+)$/i.exec(text.trim());
  const answer = match?.[1].trim();
  return answer ? answer : undefined;
}

/** `service.json` lives under XDG config; on Windows that is `~/.config`. */
function serviceJsonPaths(): string[] {
  const paths: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) paths.push(join(xdg, "opencode", "service.json"));
  paths.push(join(homedir(), ".config", "opencode", "service.json"));
  paths.push(join(homedir(), ".opencode", "service.json"));
  return paths;
}

/**
 * The API password, read-only. Returns "" when unavailable rather than
 * throwing: an unanswered question must never take the bridge down.
 */
export function servicePassword(): string {
  for (const path of serviceJsonPaths()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { password?: unknown };
      if (typeof parsed.password === "string" && parsed.password.length > 0) return parsed.password;
    } catch {
      // A malformed or locked file just means no password this time round.
    }
  }
  return "";
}

/**
 * Ports this process is listening on.
 *
 * The HTTP server lives in the plugin's own process, so its listener is one of
 * our active handles — no subprocess, no scan. `_getActiveHandles` is internal
 * and absent on runtimes that do not ship it, in which case `netstat` answers
 * the same question the slow way.
 */
function ownPorts(): number[] {
  const ports = new Set<number>();
  try {
    const introspect = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    for (const handle of introspect?.() ?? []) {
      const address = (handle as { address?: () => unknown } | null)?.address?.();
      if (address && typeof address === "object" && typeof (address as { port?: unknown }).port === "number") {
        ports.add((address as { port: number }).port);
      }
    }
  } catch {
    // Introspection is a nicety; netstat below covers its absence.
  }
  if (ports.size > 0) return [...ports];
  return netstatPorts();
}

/** Ports listening under this pid, via `netstat -ano` (Windows). */
function netstatPorts(): number[] {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const ports = new Set<number>();
    const pid = String(process.pid);
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const cols = line.trim().split(/\s+/);
      // cols: proto, local, foreign, state, pid
      if (cols.length < 5 || cols[cols.length - 1] !== pid) continue;
      const port = Number(cols[1]?.split(":").pop());
      if (Number.isFinite(port)) ports.add(port);
    }
    return [...ports];
  } catch {
    return [];
  }
}

export interface ServerInfo {
  version?: string;
  pid?: number;
  urls?: string[];
}

/**
 * Speaks OpenCode's local API. Everything is lazy: nothing is probed until a
 * form actually needs answering, so a bridge that never sees a question never
 * touches the network.
 */
export class FormClient {
  private base = "";
  private auth = "";
  private probing = false;

  /** True once the API endpoint is known. */
  get ready(): boolean {
    return this.base.length > 0;
  }

  /**
   * Find this process' API port and load the password. Resolves false — never
   * throws — when either is unavailable, so callers can degrade to "answer on
   * the PC".
   */
  async connect(): Promise<boolean> {
    if (this.ready) return true;
    if (this.probing) return false;
    this.probing = true;
    try {
      const password = servicePassword();
      if (!password) {
        log("WARN", "forms: sin password en service.json — no se puede responder desde acÃ¡");
        return false;
      }
      const auth = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
      const candidates = ownPorts();
      const confirmed: string[] = [];
      for (const port of candidates) {
        const info = await probe(port, auth);
        if (!info) continue;
        // The plugin runs inside the server, so its pid is the server's pid —
        // that match is what stops us from talking to some other OpenCode.
        if (info.pid !== undefined && info.pid === process.pid) {
          this.set(`http://127.0.0.1:${port}/api`, auth);
          log("INFO", `forms: API local en :${port} (pid ${info.pid})`);
          return true;
        }
        confirmed.push(`http://127.0.0.1:${port}/api`);
      }
      if (confirmed.length === 1) {
        this.set(confirmed[0], auth);
        log("WARN", `forms: API local en ${confirmed[0]} pero su pid no coincide con ${process.pid} — se usa igual`);
        return true;
      }
      if (confirmed.length > 1) {
        log("WARN", `forms: ${confirmed.length} APIs candidatas, ninguna con nuestro pid — omitido`);
      } else {
        log("WARN", `forms: ninguna API local respondiÃ³ entre ${candidates.length} puertos`);
      }
      return false;
    } finally {
      this.probing = false;
    }
  }

  private set(base: string, auth: string): void {
    this.base = base.replace(/\/$/, "");
    this.auth = auth;
  }

  private async call(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    if (!this.ready && !(await this.connect())) throw new Error("API local de OpenCode no disponible");
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      // 409 is the form already settled (answered on the PC first) — callers
      // treat it as success-with-nothing-to-do, so surface it verbatim.
      const text = await response.text().catch(() => "");
      throw new Error(`${method} ${path} â†’ ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text().catch(() => "");
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as { data?: unknown };
      return parsed.data ?? parsed;
    } catch {
      return text;
    }
  }

  /** Every form still open in a session. */
  async list(sessionID: string): Promise<FormInfo[]> {
    const data = await this.call("GET", `/session/${encodeURIComponent(sessionID)}/form`);
    return Array.isArray(data) ? (data as FormInfo[]) : [];
  }

  /** One form, with its `state` (`pending` / `answered` / `cancelled`). */
  async get(sessionID: string, formID: string): Promise<{ state?: { status?: string } } | undefined> {
    return (await this.call("GET", `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`)) as
      | { state?: { status?: string } }
      | undefined;
  }

  /**
   * Any other endpoint of the local API — models, agents, providers, MCP,
   * per-session stats. The form endpoints stay private; this is the door for
   * the rest of the surface. Resolves undefined for empty bodies (204).
   */
  async request<T = unknown>(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown): Promise<T | undefined> {
    return (await this.call(method, path, body)) as T | undefined;
  }

  /**
   * Answer a form.
   *
   * `409` is somebody — the PC, or a second tap — settling it first. `400` is
   * declared for two opposite things: a rejected answer, and a form that is no
   * longer there (they are ephemeral, and the body comes back empty, so the
   * status alone cannot say which). Asking the server is one extra GET, on the
   * failure path only, and it is what stops a lost race from being reported to
   * the user as if they had made a mistake.
   */
  async reply(sessionID: string, formID: string, answer: FormAnswer): Promise<"ok" | "already"> {
    try {
      await this.call("POST", `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, { answer });
      return "ok";
    } catch (error) {
      const message = String((error as Error).message);
      if (message.includes("\u2192 409")) return "already";
      if (message.includes("\u2192 400") && !(await this.stillOpen(sessionID, formID))) return "already";
      throw error;
    }
  }

  /** Anything but a successful read means the form is gone — settled already. */
  private async stillOpen(sessionID: string, formID: string): Promise<boolean> {
    try {
      await this.get(sessionID, formID);
      return true;
    } catch {
      return false;
    }
  }

  /** Drop a form nobody will answer, so the PC stops showing it. */
  async cancel(sessionID: string, formID: string): Promise<void> {
    await this.call("DELETE", `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`);
  }
}

/** Ask one port whether it is an OpenCode API. Returns null when it is not. */
async function probe(port: number, auth: string): Promise<ServerInfo | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/info`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as ServerInfo;
    return typeof parsed?.pid === "number" || Array.isArray(parsed?.urls) ? parsed : null;
  } catch {
    return null;
  }
}
