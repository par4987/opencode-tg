/** tasks checks: schedule grammar, nextRun math, store roundtrip. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskSchedule } from "../src/tasks.js";
// Pin ES for this suite: formatSchedule renders through the catalog, so the
// operator's /locale choice would otherwise decide what the assertions see.
// Dynamic import: a static one is hoisted above this assignment and the env
// would arrive too late to the locale module.
process.env.TG_LOCALE_FILE = join(mkdtempSync(join(tmpdir(), "tg-task-")), "locale.txt");
delete process.env.TG_LOCALE;
const { formatSchedule, newTaskId, nextRunOf, parseScheduleDetail, parseTime, readTasks, updateTaskPrompt, writeTasks } =
  await import("../src/tasks.js");

let failures = 0;
let total = 0;
function check(name: string, condition: boolean): void {
  total += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}`);
  if (!condition) failures += 1;
}

// ── parseTime ────────────────────────────────────────────────────────────────

check("parseTime 09:00", parseTime("09:00") === 9 * 60);
check("parseTime 9:05", parseTime("9:05") === 9 * 60 + 5);
check("parseTime 24:00 → nada", parseTime("24:00") === undefined);
check("parseTime 12:60 → nada", parseTime("12:60") === undefined);
check("parseTime basura → nada", parseTime("ma\u00f1ana") === undefined);

// ── parseScheduleDetail ─────────────────────────────────────────────────────

const once = parseScheduleDetail("once", "2026-10-01 09:00");
check("once ISO", once?.type === "once" && once.at === "2026-10-01 09:00");
check("once fecha basura → nada", parseScheduleDetail("once", "cuando pueda") === undefined);
const daily = parseScheduleDetail("daily", "09:30");
check("daily 09:30", daily?.type === "daily" && daily.time === "09:30");
check("daily hora rota → nada", parseScheduleDetail("daily", "99:99") === undefined);
const weekly = parseScheduleDetail("weekly", "lun 08:15");
check("weekly lun 08:15", weekly?.type === "weekly" && weekly.weekday === "lun" && weekly.time === "08:15");
const weeklySab = parseScheduleDetail("weekly", "s\u00e1b 10:00");
check("weekly s\u00e1b con acento", weeklySab?.type === "weekly" && weeklySab.weekday === "s\u00e1b");
check("weekly dia raro → nada", parseScheduleDetail("weekly", "funday 10:00") === undefined);
const mins = parseScheduleDetail("minutes", "30");
check("minutes 30", mins?.type === "minutes" && mins.every === 30);
check("minutes 0 → nada", parseScheduleDetail("minutes", "0") === undefined);
check("minutes basura → nada", parseScheduleDetail("minutes", "media hora") === undefined);

// ── nextRunOf ────────────────────────────────────────────────────────────────

// daily: lunes 2026-09-28 10:00 ya paso → martes 29 09:00
const MON10 = new Date(2026, 8, 28, 10, 0).getTime();
const dailyNext = nextRunOf({ type: "daily", time: "09:00" }, MON10);
const dailyExpected = new Date(2026, 8, 29, 9, 0).getTime();
check("daily: hora de hoy pasada → ma\u00f1ana", dailyNext === dailyExpected);
// daily: aun no llego → hoy mismo
const MON8 = new Date(2026, 8, 28, 8, 0).getTime();
const dailyToday = nextRunOf({ type: "daily", time: "09:00" }, MON8);
check("daily: hora de hoy futura → hoy", dailyToday === new Date(2026, 8, 28, 9, 0).getTime());
// weekly: lunes 10:00, pido "lun 09:00" → lunes ya paso a las 9 → proximo lunes
const weeklyNext = nextRunOf({ type: "weekly", weekday: "lun", time: "09:00" }, MON10);
check("weekly: lunes ya paso → proximo lunes", weeklyNext === new Date(2026, 9, 5, 9, 0).getTime());
// weekly: miercoles desde lunes
const weeklyWed = nextRunOf({ type: "weekly", weekday: "mi\u00e9", time: "09:00" }, MON10);
check("weekly: miercoles desde lunes", weeklyWed === new Date(2026, 8, 30, 9, 0).getTime());
// minutes
const minsNext = nextRunOf({ type: "minutes", every: 15 }, MON10);
check("minutes: +15", minsNext === MON10 + 15 * 60_000);
// once: fecha exacta
const onceNext = nextRunOf({ type: "once", at: "2026-10-01 09:00" }, MON10);
check("once: fecha exacta", onceNext === new Date(2026, 9, 1, 9, 0).getTime());
// once con formato corto, fecha futura este anio
const onceShort = nextRunOf({ type: "once", at: "01/12 09:00" }, MON10);
check("once corto 01/12 → diciembre", onceShort === new Date(2026, 11, 1, 9, 0).getTime());

// ── formatSchedule ───────────────────────────────────────────────────────────

check("format once", formatSchedule({ type: "once", at: "2026-10-01 09:00" }).includes("2026-10-01"));
check("format daily", formatSchedule({ type: "daily", time: "09:00" }).includes("todos los d\u00edas"));
check("format weekly", formatSchedule({ type: "weekly", weekday: "lun", time: "09:00" }).includes("lun"));
check("format minutes 90 → 1 h 30 min", formatSchedule({ type: "minutes", every: 90 }).includes("1 h 30"));

// ── store roundtrip ─────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "taskscheck-"));
const file = join(dir, "tasks.json");
check("read de archivo inexistente → []", readTasks(file).length === 0);
const sample: Task = {
  id: newTaskId(),
  name: "Resumen diario",
  prompt: "Resumi lo importante de ayer",
  directory: "E:\\work\\demo",
  schedule: { type: "daily", time: "09:00" } satisfies TaskSchedule,
  enabled: true,
  createdAt: Date.now(),
  nextRun: Date.now() + 1000,
  lastRun: 0,
  lastStatus: "",
};
writeTasks([sample], file);
const back = readTasks(file);
check("roundtrip: 1 tarea", back.length === 1);
check("roundtrip: campos", back[0]?.name === "Resumen diario" && back[0]?.schedule.type === "daily");
check("roundtrip: directorio con backslashes", back[0]?.directory === sample.directory);
check("roundtrip: idempotente al sobreescribir el store", (() => {
  writeTasks([sample], file);
  return readTasks(file).length === 1;
})());
check("updateTaskPrompt actualiza y persiste", (() => {
  const u = updateTaskPrompt(sample.id, "  Nuevo prompt de prueba  ", file);
  const reread = readTasks(file).find((t) => t.id === sample.id)?.prompt;
  return u?.prompt === "Nuevo prompt de prueba" && reread === "Nuevo prompt de prueba";
})());
check("updateTaskPrompt: id inexistente → undefined", updateTaskPrompt("no-existe", "x", file) === undefined);
check("updateTaskPrompt: prompt vacio → undefined", updateTaskPrompt(sample.id, "   ", file) === undefined);
check("read de JSON roto → []", (() => {
  writeFileSync(file, "{ no json", "utf8");
  return readTasks(file).length === 0;
})());
rmSync(dir, { recursive: true, force: true });
check("id nuevo con prefijo", newTaskId().startsWith("tsk_"));

console.log(failures === 0 ? `\nTASKCHECK OK (${total})` : `\nTASKCHECK ${failures} FALLOS de ${total}`);
process.exit(failures === 0 ? 0 : 1);
