/**
 * Macros — named prompts the user can replay into a session.
 *
 * `/macro save <name> <text>` stores a prompt; `/macro run <name>` sends it
 * to the current session; `/macro list` and `/macro del <name>` manage them.
 * Stored as a JSON object keyed by name, mirroring `tasks.json`'s pattern:
 * best-effort writes, corrupt → empty.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Macro {
  name: string;
  text: string;
  /** Epoch ms when it was last saved. */
  at: number;
}

export function macrosFile(): string {
  return join(homedir(), ".opencode", "tg", "data", "macros.json");
}

export function readMacros(file: string = macrosFile()): Macro[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Macro>) : {};
    return Object.values(obj).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export function saveMacro(name: string, text: string, file: string = macrosFile()): Macro | undefined {
  const trimmed = name.trim();
  const trimmedText = text.trim();
  if (!trimmed || !trimmedText) return undefined;
  const all = readMacros(file);
  const existing = all.findIndex((m) => m.name === trimmed);
  // `readMacros` sorts newest-first, so `all[0]` holds the highest `at`.
  // Guaranteeing a strictly increasing stamp keeps the order deterministic
  // when two saves land in the same millisecond (fast CI): ties no longer
  // depend on sort stability or object insertion order.
  const newestAt = all.length > 0 ? all[0].at : 0;
  const macro: Macro = { name: trimmed, text: trimmedText, at: Math.max(Date.now(), newestAt + 1) };
  if (existing >= 0) all[existing] = macro;
  else all.push(macro);
  const obj: Record<string, Macro> = {};
  for (const m of all) obj[m.name] = m;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    /* best effort: macros work without persistence */
  }
  return macro;
}

export function deleteMacro(name: string, file: string = macrosFile()): boolean {
  const all = readMacros(file);
  const before = all.length;
  const kept = all.filter((m) => m.name !== name);
  if (kept.length === before) return false;
  const obj: Record<string, Macro> = {};
  for (const m of kept) obj[m.name] = m;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  return true;
}

export function findMacro(name: string, file: string = macrosFile()): Macro | undefined {
  return readMacros(file).find((m) => m.name === name);
}
