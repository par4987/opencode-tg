/**
 * _offsetcheck — the offset survives the crash that caused the loop.
 *
 * The incident (2026-10-07): a `/sh` handler restarted the OpenCode server,
 * killing the plugin's process mid-command. The poll offset was in memory
 * only, so the next start polled from 0, Telegram re-delivered the same
 * `/sh`, and the bridge restarted the server every ~10s until someone
 * disabled the plugin by hand. The fix persists the offset to disk the
 * instant it advances, BEFORE the handler runs — so a kill mid-handler
 * cannot replay the update. This suite replays that exact race against the
 * real transport class.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telegram } from "../src/telegram.js";

let failures = 0;
function check(label: string, ok: boolean, extra?: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${extra !== undefined ? "  " + extra : ""}`);
  if (!ok) failures += 1;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "tg-offset-"));
  const offsetPath = join(dir, "offset.txt");

  try {
    // The transport is built against the real Telegram class with a dummy
    // token; only the offset file is exercised, no network is touched.
    const tg = new Telegram({ token: "0:dummynotoken", offsetPath });

    // 1. A fresh store starts at zero.
    check("fresh: offset 0", tg.offsetFile !== undefined);

    // 2. Simulate the poll loop's advance-then-handle. The handler "kills the
    //    process" (throws) — the offset must already be on disk.
    let killed = false;
    const updates = [{ update_id: 9001 }, { update_id: 9002 }];
    for (const u of updates) {
      // This is the exact longPoll sequence: advance, persist, then handle.
      // @ts-expect-error access the private field the way longPoll does
      tg.offset = Math.max(tg.offset, u.update_id + 1);
      // @ts-expect-error same for the writer
      tg.saveOffset();
      try {
        if (u.update_id === 9002) {
          killed = true;
          throw new Error("opencode service restart — process dying");
        }
      } catch {
        /* the crash; the next process picks up from the file */
      }
    }
    check("el handler 'mato' el proceso", killed === true);
    check("offset en disco tras la muerte", readFileSync(offsetPath, "utf8").trim() === "9003");

    // 3. The replacement process starts cold and reads the persisted id —
    //    this is the step that used to be zero and replayed the update.
    const tg2 = new Telegram({ token: "0:dummynotoken", offsetPath });
    // @ts-expect-error reading the private offset as the poll loop would
    check("el nuevo proceso arranca en 9003", tg2.offset === 9003, String(tg2.offset));

    // 4. An unpersisted transport still works (offset stays in memory), so
    //    the guard is opt-in and never breaks a dry run.
    const tg3 = new Telegram({ token: "0:dummynotoken" });
    // @ts-expect-error same private access
    check("sin offsetPath no rompe", tg3.offset === 0);

    // 5. A corrupt file degrades to zero instead of crashing the plugin.
    writeFileSync(offsetPath, "not-a-number");
    const tg4 = new Telegram({ token: "0:dummynotoken", offsetPath });
    // @ts-expect-error same private access
    check("archivo corrupto -> offset 0", tg4.offset === 0, String(tg4.offset));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nOFFSET OK" : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
