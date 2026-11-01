/**
 * Estado persistente del dashboard fijado por hilo.
 *
 * Cada hilo de Telegram puede tener un mensaje anclado (pin) que resume la
 * sesión que lo espeja: título, modelo, tokens, coste y estado inactivo. El
 * mapa clave = message_thread_id → { chatId, messageId, sessionID } se
 * persiste en tokenStateDir() para que sobreviva a un /reload (el plugin se
 * reconstruye y el dashboard se reanuda donde quedó).
 *
 * El archivo es un objeto plano `{ [threadId]: { chatId, messageId, sessionID } }`
 * porque JSON no conserva Map y las claves numéricas se pierden al serializar;
 * se guardan como strings y se leen de vuelta.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { tokenStateDir } from "./bots.js";

export interface DashboardEntry {
  chatId: number;
  messageId: number;
  /** Sesión a la que pertenece el hilo espejado (vacío si el hilo aún no se resolvió). */
  sessionID: string;
}

export function dashboardStatePath(): string {
  return join(tokenStateDir(), "dashboard-state.json");
}

/** Lee el estado guardado. Archivo ausente o corrupto → mapa vacío. */
export function readDashboardState(): Map<number, DashboardEntry> {
  const state = new Map<number, DashboardEntry>();
  let raw: string;
  try {
    raw = readFileSync(dashboardStatePath(), "utf8");
  } catch {
    return state;
  }
  let parsed: Record<string, DashboardEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, DashboardEntry>;
  } catch {
    return state;
  }
  for (const [threadId, entry] of Object.entries(parsed ?? {})) {
    const n = Number(threadId);
    if (!Number.isFinite(n) || !entry || typeof entry.chatId !== "number" || typeof entry.messageId !== "number") continue;
    state.set(n, entry as DashboardEntry);
  }
  return state;
}

/** Sobrescribe el estado completo. Best effort: el dashboard vive sin el archivo. */
export function writeDashboardState(state: Map<number, DashboardEntry>): void {
  try {
    const file = dashboardStatePath();
    mkdirSync(dirname(file), { recursive: true });
    const plain: Record<string, DashboardEntry> = {};
    for (const [threadId, entry] of state) plain[String(threadId)] = entry;
    writeFileSync(file, JSON.stringify(plain), "utf8");
  } catch {
    /* best effort */
  }
}

/** Añade o actualiza la entrada de un hilo y la persiste. */
export function setDashboardEntry(
  state: Map<number, DashboardEntry>,
  threadId: number,
  entry: DashboardEntry,
): void {
  state.set(threadId, entry);
  writeDashboardState(state);
}

/** Elimina la entrada de un hilo (desanclado) y la persiste. */
export function removeDashboardEntry(state: Map<number, DashboardEntry>, threadId: number): boolean {
  const removed = state.delete(threadId);
  if (removed) writeDashboardState(state);
  return removed;
}
