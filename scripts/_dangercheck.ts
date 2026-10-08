/**
 * _dangercheck — the shell-command guard.
 *
 * Both tiers exist because of the 2026-10-07 incident: `/sh opencode service
 * restart` killed the host mid-command, the in-memory offset died with it,
 * Telegram re-delivered the update, and the bridge looped a restart every
 * ~10s until the plugin was disabled by hand.
 *
 * The guard has two levels, because the damage is not symmetric:
 *  - "forbidden" never runs — no recovery from a format or a wipe.
 *  - "confirm" waits for a tap in Telegram — recoverable, sometimes needed.
 */
import { dangerousCommand, isForbidden, needsConfirm } from "../src/dangerous.js";

let failures = 0;
function check(label: string, ok: boolean, extra?: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${extra !== undefined ? "  " + extra : ""}`);
  if (!ok) failures += 1;
}

function main(): void {
  // ── forbidden: never runs, not even with a tap ──────────────────────────
  check("format", dangerousCommand("format C:").level === "forbidden");
  check("Format-Volume", dangerousCommand("Format-Volume -DriveLetter D").level === "forbidden");
  check("diskpart", dangerousCommand("diskpart /s script.txt").level === "forbidden");
  check("clean (diskpart)", dangerousCommand("diskpart clean").level === "forbidden");
  check("mkfs", dangerousCommand("mkfs.ext4 /dev/sda1").level === "forbidden");
  check("rm -rf", dangerousCommand("rm -rf node_modules").level === "forbidden");
  check("rm -fr", dangerousCommand("rm -fr /tmp/x").level === "forbidden");
  check("rmdir /s", dangerousCommand("rmdir /s /q build").level === "forbidden");
  check("rd /s", dangerousCommand("rd /s dist").level === "forbidden");
  check("del /s", dangerousCommand("del /s /q *.tmp").level === "forbidden");
  check("Remove-Item -Recurse", dangerousCommand("Remove-Item -Recurse -Force .").level === "forbidden");
  check("shutdown", dangerousCommand("shutdown /s /t 0").level === "forbidden");
  check("Restart-Computer", dangerousCommand("Restart-Computer").level === "forbidden");
  check("Stop-Computer", dangerousCommand("Stop-Computer").level === "forbidden");
  check("reboot", dangerousCommand("reboot now").level === "forbidden");
  // The machine-level ban also covers the word embedded in a longer line.
  check("shutdown en cadena", dangerousCommand("echo bye; shutdown /r").level === "forbidden");
  // Helpers agree with the classifier.
  check("isForbidden(format)", isForbidden("format C:") === true);
  check("isForbidden no se confunde", isForbidden("git status") === false);

  // ── confirm: recoverable, needs a tap ───────────────────────────────────
  check("service restart", dangerousCommand("opencode service restart").level === "confirm");
  check("service stop", dangerousCommand("opencode service stop").level === "confirm");
  check("mayusculas", dangerousCommand("OpenCode SERVICE Restart").level === "confirm");
  check("server restart", dangerousCommand("opencode server restart").level === "confirm");
  check("taskkill", dangerousCommand("taskkill /f /pid 1234").level === "confirm");
  check("Stop-Process", dangerousCommand("Stop-Process -Name node").level === "confirm");
  check("kill simple", dangerousCommand("kill 999").level === "confirm");
  check("pkill", dangerousCommand("pkill -f opencode").level === "confirm");
  check("reason del service restart", dangerousCommand("opencode service restart").reason === "afecta al servicio de OpenCode");
  check("needsConfirm(service)", needsConfirm("opencode service restart") === true);
  check("needsConfirm no se confunde", needsConfirm("rm -rf x") === false);
  // A forbidden command is NOT merely "confirm" — the tiers are exclusive.
  check("forbidden no es confirm", needsConfirm("format C:") === false);

  // ── harmless: pass straight through ─────────────────────────────────────
  // A false positive here would make the bot ask before every `git status`,
  // or refuse a legitimate build step.
  check("git status", dangerousCommand("git status").level === "ok");
  check("node -v", dangerousCommand("node -v").level === "ok");
  check("ls", dangerousCommand("ls -la").level === "ok");
  check("npm test", dangerousCommand("npm test").level === "ok");
  check("echo con palabra peligrosa", dangerousCommand('echo "restart computer"').level === "ok");
  check("rm de un archivo", dangerousCommand("rm archivo.txt").level === "ok");
  check("Remove-Item de un archivo", dangerousCommand("Remove-Item archivo.txt").level === "ok");
  check("cat", dangerousCommand("cat README.md").level === "ok");
  check("formato de string", dangerousCommand('git log --format="%h"').level === "ok");
  check("vacío", dangerousCommand("").level === "ok");

  console.log(failures === 0 ? "\nDANGER OK" : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
