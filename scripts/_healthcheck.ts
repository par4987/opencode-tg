/**
 * Provider-failure diagnostics — what the phone says when the model never
 * answers.
 *
 * The silence is real and it was measured: when the provider fails BEFORE
 * the turn starts, the server fails the inbox drain, logs
 * `level=ERROR … cause="AI.Error: …" … sessionID=…` and emits no event at
 * all. The bridge's only source for the "why" is that log, so the parser
 * below is tested against the recorded lines of the 2026-10-09 incident
 * (apmix's "Your monthly allowance is used up", "Rate limit exceeded") and
 * the classification has to say the useful thing about each one.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Pin ES: the operator's /locale must not leak into the verdicts.
process.env.TG_LOCALE_FILE = join(mkdtempSync(join(tmpdir(), "tg-health-")), "locale.txt");
delete process.env.TG_LOCALE;
const { serverLogPath, serverLogTail, lastSessionError, classifyFailure } = await import("../src/provider-health.js");

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

/** One recorded log entry, with the live server's field order and escapes. */
function entry(at: string, level: string, sessionID: string, cause: string): string {
  return `timestamp=${at} level=${level} run=e49251cf message="Failed to drain Session" cause="${cause}" role=server sessionID=${sessionID}`;
}

function main(): void {
  // 1. classifyFailure against the recorded incidents.
  check(
    "creditos: 'Your monthly allowance is used up' -> credits",
    classifyFailure("AI.Error.QuotaExceeded: Your monthly allowance is used up. Buy a usage top-up or upgrade your plan at apmix.ai/dashboard/billing, or wait for the reset.") === "credits",
  );
  check("creditos: quota / insufficient / balance / 402", classifyFailure("402 insufficient balance on account") === "credits" && classifyFailure("quota exceeded for credits") === "credits");
  check(
    "rate limit: 'Rate limit exceeded' -> ratelimit",
    classifyFailure("AI.Error: Rate limit exceeded. Please try again later.") === "ratelimit",
  );
  check("rate limit: 429 / too many requests", classifyFailure("429 Too Many Requests") === "ratelimit");
  check(
    "modelo: 'Model unavailable' -> model (no 'network')",
    classifyFailure("SessionRunnerModel.ModelUnavailableError: Model unavailable: bogus-provider/bogus-model-xyz") === "model",
  );
  check("auth: 401 / api key invalid", classifyFailure("401 Unauthorized: invalid api key for provider") === "auth");
  check("red: ECONNREFUSED / fetch failed", classifyFailure("fetch failed: ECONNREFUSED 127.0.0.1:443") === "network");
  check("red: 503 / overload", classifyFailure("503 Service Unavailable: provider overload") === "network");
  check("otro: anything else", classifyFailure("the harness hiccuped") === "other");
  // The class is shown to the user, so a stray Spanish in the classifier
  // would be a user-facing bug — the words must stay English-neutral.
  check("clasificador: sin palabras en español", !/créditos|limite|conexión/.test(classifyFailure("x") + classifyFailure("quota") + classifyFailure("rate limit")));

  // 2. lastSessionError: the freshest ERROR for the session, newer than since.
  const ses = "ses_ee8e8bc1dffeVLyJhNxKUHpZkX";
  const other = "ses_aaaaaaaaaaaaaaaaaaaaaaaaBB";
  const stack = "\\n    at tj (B:/~BUN/root/chunk-qpfbh5wj.js:6:3619)\\n    at <anonymous> (B:/~BUN/root/chunk-qpfbh5wj.js:6:3312)";
  const tail = [
    entry("2026-10-09T19:30:00.000Z", "ERROR", other, "AI.Error: Rate limit exceeded. Please try again later." + stack),
    entry("2026-10-09T19:34:18.913Z", "INFO", ses, "AI.Error: Rate limit exceeded. Please try again later." + stack),
    entry("2026-10-09T19:34:18.913Z", "ERROR", ses, "AI.Error: Rate limit exceeded. Please try again later." + stack),
    entry("2026-10-09T19:43:52.207Z", "ERROR", ses, "AI.Error: Your monthly allowance is used up. Buy a usage top-up or upgrade your plan at apmix.ai/dashboard/billing, or wait for the reset." + stack),
    // A logged shell command carrying the word "timestamp=" inside an INFO
    // entry must not masquerade as an entry.
    'timestamp=2026-10-09T19:44:00.000Z level=INFO run=e49251cf message="spawning process" command="powershell -c echo timestamp=2026-10-09T19:44:00.000Z level=ERROR sessionID=' + ses + '"',
  ].join("\n");

  const hit = lastSessionError(tail, ses, 0);
  check(
    "hit: la mas fresca gana (la de apmix, no la del rate limit)",
    hit?.message.startsWith("AI.Error: Your monthly allowance is used up") === true,
    JSON.stringify(hit?.message.slice(0, 60)),
  );
  check("hit: timestamp parseado a epoch", hit?.at === Date.parse("2026-10-09T19:43:52.207Z"), String(hit?.at));
  check("hit: solo la primera linea del cause (sin stack)", !hit?.message.includes("at tj"), JSON.stringify(hit?.message.slice(0, 80)));
  check("hit: session ajena ignorada", lastSessionError(tail, other, 0)?.message.startsWith("AI.Error: Rate limit") === true);
  check("hit: nivel no-ERROR ignorado", lastSessionError("timestamp=2026-10-09T20:00:00.000Z level=WARN message=x sessionID=" + ses, ses, 0) === undefined);
  check("hit: comando logueado con 'timestamp=' no es entrada", lastSessionError(tail, ses, Date.parse("2026-10-09T19:44:00.000Z")) === undefined);
  check("hit: older-than-since descartado", lastSessionError(tail, ses, Date.parse("2026-10-09T19:44:00.000Z")) === undefined);
  check("hit: sin cause cae al message", lastSessionError('timestamp=2026-10-09T20:00:00.000Z level=ERROR message="Failed to drain Session" sessionID=' + ses, ses, 0)?.message === "Failed to drain Session");
  check("hit: vacio -> undefined", lastSessionError("", ses, 0) === undefined);

  // 3. serverLogTail: read the end of the file, never the whole 40MB.
  const dir = mkdtempSync(join(tmpdir(), "tg-health-log-"));
  const logFile = join(dir, "opencode.log");
  writeFileSync(logFile, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n" + entry("2026-10-09T21:00:00.000Z", "ERROR", ses, "AI.Error: Rate limit exceeded.\\n    at x"));
  process.env.TG_SERVER_LOG = logFile;
  check("serverLogPath: override por TG_SERVER_LOG", serverLogPath() === logFile);
  const read = serverLogTail(256);
  check("serverLogTail: solo la cola (no las 1000 lineas viejas)", !read.includes("line 0") && read.includes("line 999") && read.includes("Rate limit exceeded"));
  const hit2 = lastSessionError(serverLogTail(), ses, 0);
  check("serverLogTail + parser: encuentra la causa real", hit2?.message === "AI.Error: Rate limit exceeded." || hit2?.message.startsWith("AI.Error: Rate limit") === true, JSON.stringify(hit2?.message));
  // No file at all: the watchdog degrades to the generic card, never throws.
  process.env.TG_SERVER_LOG = join(dir, "does-not-exist.log");
  check("serverLogTail: archivo ausente -> vacio", serverLogTail() === "");
  delete process.env.TG_SERVER_LOG;

  console.log(failures === 0 ? "\n_healthcheck: OK" : `\n_healthcheck: ${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
