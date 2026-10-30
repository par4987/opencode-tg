/**
 * The desktop app's own model toggles. The "Modelos" screen writes each
 * model's visibility into its SQLite state, and the desktop's selector only
 * shows `visibility: "show"` entries — which is exactly the mirror the
 * Telegram picker must reproduce: a model the user switched off is a door
 * that does not open, whatever the gateway catalogue says.
 *
 * The database lives in a different place on every OS (Electron's
 * `app.getPath("userData")`): `%APPDATA%\ai.opencode.desktop` on Windows,
 * `~/Library/Application Support/ai.opencode.desktop` on macOS and
 * `$XDG_CONFIG_HOME/ai.opencode.desktop` (default `~/.config/…`) on Linux.
 * Only the Windows path used to be honoured, so on Linux the lookup found
 * nothing and `/models` fell back to a config that declares no providers:
 * the picker answered "nothing enabled" while the desktop showed its models.
 *
 * `node:sqlite` is loaded dynamically so a runtime without it degrades to an
 * empty list instead of taking the whole plugin down at import time. Bun
 * ships the same API under `bun:sqlite`; both are tried before giving up.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DesktopModelToggle {
  providerID: string;
  modelID: string;
  visible: boolean;
}

const APP_DIR = "ai.opencode.desktop";
const DB_FILE = "drafts.sqlite";

/**
 * Every place the desktop state may live, most likely first. The Windows-style
 * tree under `$HOME` stays as a last resort so a state copied from another
 * machine (or an app built with a fixed userData path) still resolves.
 */
export function desktopStatePaths(): string[] {
  const home = homedir();
  const paths: string[] = [];
  const push = (path: string): void => {
    if (!paths.includes(path)) paths.push(path);
  };
  if (process.platform === "win32") {
    push(join(process.env.APPDATA || join(home, "AppData", "Roaming"), APP_DIR, DB_FILE));
  } else if (process.platform === "darwin") {
    push(join(home, "Library", "Application Support", APP_DIR, DB_FILE));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) push(join(xdg, APP_DIR, DB_FILE));
    push(join(home, ".config", APP_DIR, DB_FILE));
  }
  push(join(home, "AppData", "Roaming", APP_DIR, DB_FILE));
  return paths;
}

/** Where the desktop app (ai.opencode.desktop) keeps its UI state. */
export function desktopStatePath(): string {
  return desktopStatePaths()[0] ?? join(homedir(), ".config", APP_DIR, DB_FILE);
}

interface DesktopDb {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

/**
 * Open the state database read-only, with whichever SQLite binding the
 * runtime offers. Returns undefined — never throws — when neither exists.
 */
async function openReadOnly(path: string): Promise<DesktopDb | undefined> {
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => DesktopDb;
    };
    if (typeof mod.DatabaseSync === "function") {
      try {
        return new mod.DatabaseSync(path, { readOnly: true });
      } catch {
        // Some runtimes reject the open options; a plain handle still works
        // and the queries below are read-only anyway.
        try {
          return new mod.DatabaseSync(path);
        } catch {
          return undefined;
        }
      }
    }
  } catch {
    // Older Node, or a runtime without the experimental module.
  }
  try {
    // The specifier is held in a variable so TypeScript does not try to
    // resolve a Bun-only module under Node.
    const specifier = "bun:sqlite";
    const mod = (await import(specifier)) as {
      Database?: new (path: string, options?: { readonly?: boolean }) => DesktopDb;
    };
    if (typeof mod.Database === "function") {
      try {
        return new mod.Database(path, { readonly: true });
      } catch {
        try {
          return new mod.Database(path);
        } catch {
          return undefined;
        }
      }
    }
  } catch {
    // Running under Node: node:sqlite above was the only chance.
  }
  return undefined;
}

/** The toggles stored in one database file, or [] when unreadable. */
async function readToggles(path: string): Promise<DesktopModelToggle[]> {
  const db = await openReadOnly(path);
  if (!db) return [];
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
  } catch {
    // A locked or mid-migration database is not fatal: the caller falls back.
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // Closing a handle we could not use is not worth reporting.
    }
  }
}

/**
 * The models the desktop switched on, straight from its own state. One row in
 * `state` (`key = 'model'`) carries `{user: [{providerID, modelID,
 * visibility}, …]}`; `show` is on, anything else is off. Resolves [] — never
 * throws — when the database or the SQLite binding is unavailable, so the
 * caller can fall back to the config file.
 */
export async function desktopVisibleModels(dbPath?: string): Promise<DesktopModelToggle[]> {
  for (const candidate of dbPath ? [dbPath] : desktopStatePaths()) {
    if (!existsSync(candidate)) continue;
    const toggles = await readToggles(candidate);
    if (toggles.length > 0) return toggles;
  }
  return [];
}
