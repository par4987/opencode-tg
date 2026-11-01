/**
 * The receipt for `/reload`.
 *
 * The reload endpoint rebuilds every loaded location — which includes this
 * plugin. The transport that asked for the reload can therefore disappear
 * before it gets to say "done", and the user would only see "reloading…"
 * forever. The marker is written before the POST and cleared when the old
 * instance delivers its receipt; if it never does, the next instance to boot
 * finds it and finishes the job. Stale markers (an API error with no restart,
 * a crash before the POST) expire after a couple of minutes.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { tokenStateDir } from "./bots.js";

export interface ReloadNotice {
  chatId: number;
  threadId?: number;
  /** When the POST was issued. */
  at: number;
  /** `done` = the endpoint answered 204; `pending` = still in flight. */
  stage: "pending" | "done";
  /** Duration of the reload, when the endpoint answered. */
  secs?: number;
}

export function reloadNoticePath(): string {
  return join(tokenStateDir(), "reload-notice.json");
}

export function writeReloadNotice(notice: ReloadNotice): void {
  try {
    const file = reloadNoticePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(notice), "utf8");
  } catch {
    /* best effort: the reload matters more than its receipt */
  }
}

export function clearReloadNotice(): void {
  try {
    unlinkSync(reloadNoticePath());
  } catch {
    /* already gone */
  }
}

/** A marker for this chat that is still worth announcing, if any. */
export function readFreshReloadNotice(chatId: number, maxAgeMs = 180_000): ReloadNotice | undefined {
  let parsed: ReloadNotice;
  try {
    parsed = JSON.parse(readFileSync(reloadNoticePath(), "utf8")) as ReloadNotice;
  } catch {
    return undefined;
  }
  if (
    !parsed ||
    parsed.chatId !== chatId ||
    (parsed.stage !== "pending" && parsed.stage !== "done") ||
    typeof parsed.at !== "number"
  ) {
    return undefined;
  }
  if (Date.now() - parsed.at > maxAgeMs) {
    clearReloadNotice();
    return undefined;
  }
  return parsed;
}
