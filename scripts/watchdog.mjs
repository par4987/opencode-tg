#!/usr/bin/env node
/**
 * Watchdog externo para opencode-tg — correr cada 20 min (Windows Task
 * Scheduler o cron). NO reemplaza al guardián interno del plugin: es la capa
 * que queda cuando el lider es una instancia con código viejo, o cuando el
 * proceso entero se cuelga.
 *
 * Salud (todo desde fuera, sin secrets):
 *  1. lock del líder existe, su pid vive y el beat es fresco (< 5 min);
 *  2. el plugin.log tuvo líneas en los últimos 20 min (proceso escribiendo);
 *  3. si hay sesiones activas en el server (vía /api/session/active), el log
 *     muestra entregas recientes — si no, el mirror está ciego.
 *
 * Reparación: borrar el lock. El tick del líder ve el asiento perdido, cede, y
 * una instancia fresca toma el liderazgo con el catch-up — lo único que ha
 * restaurado la cobertura en tres días. NUNCA mata el server: las sesiones
 * vivas (el trabajo del usuario) se pierden al reiniciarlo. Si el proceso
 * del líder está muerto, solo se loguea (o se reinicia con
 * TG_WATCHDOG_RESTART=1, opt-in).
 *
 * Log: ~/.opencode/tg/logs/watchdog.log (UTC).
 */
import { readFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TG_DIR = join(homedir(), ".opencode", "tg");
const LOG_DIR = join(TG_DIR, "logs");
const PLUGIN_LOG = join(LOG_DIR, "plugin.log");
const WATCHDOG_LOG = join(LOG_DIR, "watchdog.log");
const WINDOW_MS = 20 * 60 * 1000;
const STALE_BEAT_MS = 5 * 60 * 1000;

function wlog(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* read-only home — nothing to do */
  }
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 23);
  try {
    appendFileSync(WATCHDOG_LOG, `${stamp} ${line}\n`, "utf8");
  } catch {
    /* log is best-effort */
  }
}

function readLock() {
  let files = [];
  try {
    files = readdirSync(TG_DIR).filter((f) => /^leader-.*\.lock$/.test(f));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(TG_DIR, f), "utf8"));
      if (typeof parsed.pid === "number") return { file: join(TG_DIR, f), ...parsed };
    } catch {
      /* corrupt or being rewritten — try the next one */
    }
  }
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLogTail() {
  try {
    return readFileSync(PLUGIN_LOG, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l));
  } catch {
    return [];
  }
}

function lineTime(l) {
  const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  return m ? Date.parse(m[1] + "Z") : NaN;
}

/** Candidate ports of the CLI server, from "forms: API local en :PORT" lines.
 * The most recent line can name a transient probe of another server (the
 * desktop app's), so take every port seen recently and let the first one
 * that actually answers win — frequency breaks ties. */
function apiCandidates(lines) {
  const stats = new Map();
  for (const l of lines) {
    const m = l.match(/API local en :(\d+)/);
    if (!m) continue;
    const t = lineTime(l);
    if (Number.isNaN(t)) continue;
    const p = m[1];
    if (!stats.has(p)) stats.set(p, { port: Number(p), last: t, count: 0 });
    const s = stats.get(p);
    s.last = Math.max(s.last, t);
    s.count += 1;
  }
  return [...stats.values()]
    .sort((a, b) => b.last - a.last || b.count - a.count)
    .map((s) => s.port)
    .slice(0, 6);
}

async function activeSessions(ports) {
  if (ports.length === 0) return null; // unknown — treat as "no information"
  let pw = null;
  try {
    pw = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8")).password;
  } catch {
    /* no service.json — skip the API check */
  }
  if (!pw) return null;
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/active`, {
        headers: { Authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64") },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      return Object.keys(body?.data ?? {});
    } catch {
      /* port stale — next candidate */
    }
  }
  return null;
}

async function main() {
  const now = Date.now();
  const lines = readLogTail();
  const recent = lines.filter((l) => {
    const t = lineTime(l);
    return !Number.isNaN(t) && now - t <= WINDOW_MS;
  });
  const deliveries = recent.filter((l) => /coalesce|reply:|título sincronizado|sesión nueva/i.test(l));
  const churn = recent.filter((l) => /cede el asiento|líder local muerto/i.test(l)).length;
  const dnsFails = recent.filter((l) => /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(l)).length;
  const lock = readLock();
  const checks = [];
  let healthy = true;

  // 1. Leader presence, process and beat.
  if (!lock) {
    checks.push("sin lock de líder");
    healthy = false;
  } else if (!pidAlive(lock.pid)) {
    checks.push(`proceso líder ${lock.pid} MUERTO`);
    healthy = false;
  } else {
    const beatAge = Math.round((now - (lock.beat ?? 0)) / 1000);
    checks.push(`líder ${lock.pid} vivo, beat ${beatAge}s`);
    if (beatAge > STALE_BEAT_MS / 1000) {
      checks.push(`beat viejo (${Math.round(beatAge / 60)} min)`);
      healthy = false;
    }
  }

  // 2. Plugin log activity.
  if (recent.length === 0) {
    checks.push("plugin.log en silencio 20 min");
    healthy = false;
  } else {
    checks.push(`log: ${recent.length} líneas, ${deliveries.length} entregas, ${churn} handovers, ${dnsFails} fallos DNS`);
  }

  // 3. Blindness: sessions running on the server but nothing delivered.
  const active = await activeSessions(apiCandidates(lines));
  if (active === null) {
    checks.push("API: sin información");
  } else if (active.length > 0) {
    checks.push(`API: ${active.length} sesión(es) activa(s)`);
    if (deliveries.length === 0) {
      checks.push("mirror ciego: activas sin entrega");
      healthy = false;
    }
  } else {
    checks.push("API: sin sesiones activas (idle)");
  }

  // A network outage is not a mirror fault: repairing into it is useless.
  if (dnsFails > 20 && deliveries.length === 0) {
    healthy = true;
    checks.push(`red caída (${dnsFails} fallos) — no se repara`);
  }

  if (healthy) {
    wlog(`OK · ${checks.join(" · ")}`);
    return;
  }

  wlog(`UNHEALTHY · ${checks.join(" · ")}`);
  if (lock && pidAlive(lock.pid)) {
    try {
      unlinkSync(lock.file);
      wlog(`reparación: lock ${lock.file.split(/[\\/]/).pop()} borrado — handover forzado`);
    } catch (e) {
      wlog(`reparación falló: ${e.message}`);
    }
  } else if (lock && process.env.TG_WATCHDOG_RESTART === "1") {
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("opencode", [], {
        cwd: "E:\\Projects\\Default Project",
        detached: true,
        stdio: "ignore",
        shell: true,
      });
      child.unref();
      wlog(`reparación: OpenCode relanzado (pid ${child.pid}) — TG_WATCHDOG_RESTART=1`);
    } catch (e) {
      wlog(`reparación (restart) falló: ${e.message}`);
    }
  } else if (lock) {
    wlog(`proceso ${lock.pid} muerto — reiniciá OpenCode a mano (o TG_WATCHDOG_RESTART=1)`);
  } else {
    wlog("no hay lock ni líder — abrí OpenCode para que el puente arranque");
  }
}

main();
