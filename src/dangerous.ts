/**
 * Guard for shell commands that can take the bridge — or the machine — down.
 *
 * Measured incident (2026-10-07): `/sh opencode service restart` ran inside
 * the server, killed the process hosting the plugin, and because the poll
 * offset lived only in memory the update was re-delivered on every restart —
 * an infinite loop of ~10s until the plugin was disabled by hand. The offset
 * persistence is the cure; this is the prevention.
 *
 * Two tiers, because the damage is not symmetric:
 *
 *  - "forbidden" never runs, not even after a tap. There is no recovery from
 *    a formatted disk or a wiped project, so no confirmation is enough —
 *    the bot simply refuses and says why. Deletion, formatting, mass erasure
 *    and machine power state live here.
 *  - "confirm" waits for an explicit tap in Telegram. It can hurt (restart
 *    the service, kill a process the bridge depends on) but it is recoverable
 *    and sometimes necessary — so the person decides, knowing the stakes.
 */
export type DangerLevel = "forbidden" | "confirm";

export interface DangerMatch {
  /** "forbidden" never runs; "confirm" needs a tap first. */
  level: DangerLevel;
  /** What the user is about to do, in plain words, for the card. */
  reason: string;
}

/**
 * The hard block list. Matched anywhere in the command, case-insensitive.
 * A false positive costs one refused command; a missed match costs a
 * destroyed machine — so the patterns lean wide.
 */
const FORBIDDEN: Array<{ test: RegExp; reason: string }> = [
  // Formatting a volume: no recovery. The lookbehind keeps git's own
  // `--format=...` out of the blast radius — that formats a string, not a
  // disk.
  { test: /(?<![-\w])format(-?(volume|disk))?(\s|$)/i, reason: "formatea un disco" },
  // Wiping a disk or partition table.
  { test: /\b(clear-disk|clean|mkfs|fdisk|parted)\b/i, reason: "destruye la tabla de particiones o el disco" },
  // Disk-level surgery through the interactive tool.
  { test: /\bdiskpart\b/i, reason: "opera a nivel de disco" },
  // Mass, recursive deletion: takes a whole tree with it. Plain `rm file` is
  // fine; `-rf`/`-fr`/`--recursive` is what turns a cleanup into a wipe.
  // Flags in either order, and PowerShell's spaced `-Recurse -Force`.
  { test: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i, reason: "borrado masivo recursivo" },
  { test: /\b(rmdir|rd)\s+\/s\b/i, reason: "borrado masivo recursivo" },
  { test: /\bdel\s+\/[a-z]*s\b/i, reason: "borrado masivo recursivo" },
  { test: /\bremove-item\b[^|;\n]*(-[a-z]*r[a-z]*f|--recurse|--recursive|-[a-z]*f[a-z]*r)/i, reason: "borrado masivo recursivo" },
  // Machine power state: the bridge, the server and every session die with it.
  { test: /\b(shutdown|reboot|halt|poweroff|restart-computer|stop-computer|suspend|hibernate)\b/i, reason: "apaga o reinicia la máquina" },
];

/**
 * The confirm tier: recoverable but able to interrupt the service.
 */
const CONFIRM: Array<{ test: RegExp; reason: string }> = [
  // The OpenCode service itself: stop/restart kills the process the plugin
  // lives in, and start/restart while it is down changes who holds the token.
  { test: /\bopencode\s+(service|server)\b/i, reason: "afecta al servicio de OpenCode" },
  // Process killing: takes down the server, the TUI, or the bot's own poll.
  { test: /\b(taskkill|stop-process|pkill|killall|kill)\b/i, reason: "mata procesos del sistema" },
];

/**
 * A command is classed by the worst tier it hits. Harmless commands —
 * `git status`, `node -v`, `ls` — pass straight through as "ok".
 */
export function dangerousCommand(text: string): DangerMatch {
  const cmd = text.trim();
  if (!cmd) return { level: "ok" as DangerLevel, reason: "" };
  for (const { test, reason } of FORBIDDEN) {
    if (test.test(cmd)) return { level: "forbidden", reason };
  }
  for (const { test, reason } of CONFIRM) {
    if (test.test(cmd)) return { level: "confirm", reason };
  }
  return { level: "ok" as DangerLevel, reason: "" };
}

/** True only when the command may run after an explicit confirmation. */
export function needsConfirm(text: string): boolean {
  return dangerousCommand(text).level === "confirm";
}

/** True when the command must never run, confirmation or not. */
export function isForbidden(text: string): boolean {
  return dangerousCommand(text).level === "forbidden";
}
