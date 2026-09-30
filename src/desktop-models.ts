/**
 * The desktop app's own model toggles. The "Modelos" screen writes each
 * model's visibility into its SQLite state, and the desktop's selector only
 * shows `visibility: "show"` entries — which is exactly the mirror the
 * Telegram picker must reproduce: a model the user switched off is a door
 * that does not open, whatever the gateway catalogue says.
 *
 * `node:sqlite` is loaded dynamically so a runtime without it degrades to an
 * empty list instead of taking the whole plugin down at import time.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface DesktopModelToggle {
  providerID: string;
  modelID: string;
  visible: boolean;
}

/** Where the desktop app (ai.opencode.desktop) keeps its UI state. */
export function desktopStatePath(): string {
  return join(homedir(), "AppData", "Roaming", "ai.opencode.desktop", "drafts.sqlite");
}

/**
 * The models the desktop switched on, straight from its own state. One row in
 * `state` (`key = 'model'`) carries `{user: [{providerID, modelID,
 * visibility}, …]}`; `show` is on, anything else is off. Resolves [] — never
 * throws — when the database or `node:sqlite` is unavailable, so the caller
 * can fall back to the config file.
 */
export async function desktopVisibleModels(dbPath: string = desktopStatePath()): Promise<DesktopModelToggle[]> {
  let DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(): unknown[] };
    close(): void;
  };
  try {
    // The module shape differs across runtimes; only the constructor matters.
    const mod = (await import("node:sqlite")) as { DatabaseSync?: unknown };
    DatabaseSync = mod.DatabaseSync as typeof DatabaseSync;
  } catch {
    return [];
  }
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare("SELECT value FROM state WHERE key = 'model'").all() as Array<{
      value?: string;
    }>;
    const out: DesktopModelToggle[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value ?? "{}") as unknown;
      } catch {
        continue;
      }
      const user = (parsed as { user?: unknown } | null)?.user;
      if (!Array.isArray(user)) continue;
      for (const entry of user) {
        const e = entry as Record<string, unknown>;
        if (typeof e.providerID === "string" && typeof e.modelID === "string") {
          out.push({ providerID: e.providerID, modelID: e.modelID, visible: e.visibility === "show" });
        }
      }
    }
    return out;
  } finally {
    db.close();
  }
}
