/**
 * Scheduled tasks — the bridge's own alarm clock, modelled after the
 * reference bot: a JSON store, a schedule grammar, and a `nextRun` that the
 * leader's 30-second tick compares against `Date.now()`. Everything here is
 * pure or file-bound so it can be tested without the bridge running.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TaskSchedule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; weekday: string; time: string }
  | { type: "minutes"; every: number };

export interface Task {
  id: string;
  name: string;
  prompt: string;
  /** Project directory the runner opens the task's session in. */
  directory: string;
  /** Model the session is born with — undefined = the server's default. */
  model?: { id: string; providerID: string };
  schedule: TaskSchedule;
  enabled: boolean;
  createdAt: number;
  /** Timestamps, 0 = never. */
  nextRun: number;
  lastRun: number;
  lastStatus: string;
}

/** Where the reference bot kept them, so both bots can share the file. */
export function tasksFile(): string {
  return join(homedir(), ".opencode", "tg", "data", "tasks.json");
}

export function readTasks(file: string = tasksFile()): Task[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Task[]) : [];
  } catch {
    return [];
  }
}

export function writeTasks(tasks: Task[], file: string = tasksFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(tasks, null, 2), "utf8");
  } catch {
    // A store that cannot be written fails the save loudly at the caller; a
    // crash here would take the whole bridge down for a scheduler's sake.
  }
}

// ── schedule grammar ────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  dom: 0,
  lun: 1,
  mar: 2,
  mie: 3,
  mié: 3,
  jue: 4,
  vie: 5,
  sab: 6,
  sáb: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** "09:00" / "9:05" → minutes since midnight, or undefined. */
export function parseTime(input: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/**
 * The wizard's free-text step, interpreted according to the schedule type
 * chosen before it: a date for `once`, a time for `daily`, day+time for
 * `weekly`, plain minutes for `minutes`.
 */
export function parseScheduleDetail(type: TaskSchedule["type"], input: string): TaskSchedule | undefined {
  const text = input.trim().toLowerCase();
  if (type === "minutes") {
    const n = Number(text);
    if (Number.isFinite(n) && n >= 1 && n <= 60 * 24 * 7) return { type, every: Math.round(n) };
    return undefined;
  }
  if (type === "daily") {
    const t = parseTime(text);
    return t === undefined ? undefined : { type, time: text };
  }
  if (type === "once") {
    // "2026-10-01 09:00" or "01/10 09:00" — validated by constructing a Date.
    const m = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(text);
    if (m) return { type, at: text };
    const m2 = /^(\d{1,2})\/(\d{1,2})[ t](\d{1,2}):(\d{2})$/.exec(text);
    if (m2) return { type, at: text };
    return undefined;
  }
  // weekly: "lun 09:00"
  const m = /^([a-záé]{2,9})\s+(\d{1,2}:\d{2})$/.exec(text);
  if (!m) return undefined;
  const day = WEEKDAYS[m[1]];
  const t = parseTime(m[2]);
  if (day === undefined || t === undefined) return undefined;
  return { type: "weekly", weekday: m[1], time: m[2] };
}

/** The next due moment at or after `from` (default: now). 0 = unparsable. */
export function nextRunOf(schedule: TaskSchedule, from = Date.now()): number {
  if (schedule.type === "minutes") {
    return from + schedule.every * 60_000;
  }
  if (schedule.type === "once") {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(schedule.at.trim().toLowerCase());
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
      return d.getTime();
    }
    const m2 = /^(\d{1,2})\/(\d{1,2})[ t](\d{1,2}):(\d{2})$/.exec(schedule.at.trim().toLowerCase());
    if (m2) {
      // Day/month, the order the region actually writes: "01/12" is December 1st.
      const d = new Date(from);
      d.setMonth(Number(m2[2]) - 1, Number(m2[1]));
      d.setHours(Number(m2[3]), Number(m2[4]), 0, 0);
      if (d.getTime() < from) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
    }
    return 0;
  }
  const t = parseTime(schedule.time);
  if (t === undefined) return 0;
  if (schedule.type === "daily") {
    const d = new Date(from);
    d.setHours(Math.floor(t / 60), t % 60, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const target = WEEKDAYS[schedule.weekday.trim().toLowerCase()];
  if (target === undefined) return 0;
  const d = new Date(from);
  d.setHours(Math.floor(t / 60), t % 60, 0, 0);
  let add = (target - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= from) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

/** Human-readable schedule for listings and receipts. */
export function formatSchedule(schedule: TaskSchedule): string {
  if (schedule.type === "once") return `una vez \u2014 ${schedule.at}`;
  if (schedule.type === "daily") return `todos los d\u00edas \u2014 ${schedule.time}`;
  if (schedule.type === "weekly") return `cada ${schedule.weekday} \u2014 ${schedule.time}`;
  const every = schedule.every;
  if (every < 60) return `cada ${every} min`;
  if (every % 60 === 0) return `cada ${every / 60} h`;
  return `cada ${Math.floor(every / 60)} h ${every % 60} min`;
}

/** Fresh id, without pulling a uuid dependency for four randoms. */
export function newTaskId(): string {
  return `tsk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── wizard draft: survives restarts ─────────────────────────────────────────

/** A half-built task, step by step — persisted so a restart cannot eat it. */
export interface TaskDraft {
  step: "name" | "prompt" | "schedule" | "model" | "type" | "detail" | "confirm";
  name: string;
  prompt: string;
  directory?: string;
  directoryName?: string;
  model?: { id: string; providerID: string };
  scheduleType?: TaskSchedule["type"];
  schedule?: TaskSchedule;
  updatedAt: number;
}

export function draftFile(): string {
  return join(homedir(), ".opencode", "tg", "data", "task-draft.json");
}

export function readDraft(file: string = draftFile()): TaskDraft | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TaskDraft;
    if (parsed && typeof parsed.step === "string") return parsed;
  } catch {
    /* a corrupt draft is no draft */
  }
  return undefined;
}

export function writeDraft(draft: TaskDraft, file: string = draftFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...draft, updatedAt: Date.now() }, null, 2), "utf8");
  } catch {
    /* losing the persistence mirror is survivable while the live wizard runs */
  }
}

export function clearDraft(file: string = draftFile()): void {
  try {
    if (existsSync(file)) writeFileSync(file, "", "utf8");
  } catch {
    /* nothing to clear */
  }
}

/**
 * "lun 29/09 09:30" — hand-rolled so the runtime's Intl support cannot turn
 * a receipt into "Invalid Date" somewhere down the line.
 */
export function fmtDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "?";
  const d = new Date(ts);
  const days = ["dom", "lun", "mar", "mi\u00e9", "jue", "vie", "s\u00e1b"];
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
