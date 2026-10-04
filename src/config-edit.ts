/**
 * Project-config editing — the Telegram-side answer to "manage OpenCode's
 * active models from the phone".
 *
 * The v2 API exposes no config writes, so the plugin edits the project's
 * `opencode.jsonc` directly. Everything here is pure and file-bound:
 * the JSONC round-trip (strip comments → parse → validate) is proven
 * BEFORE the write, so a broken edit can never leave a corrupt config.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The project config file, JSONC first (the richer form), plain JSON second. */
export function projectConfigFile(directory: string): string | undefined {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = join(directory, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Replace (or insert) the project's default `model` in raw JSONC text.
 * Returns the new raw text, or undefined when nothing sensible changed.
 * The caller validates the result with its own strip+parse before writing.
 */
export function withDefaultModel(raw: string, model: string): string | undefined {
  const value = model.trim();
  if (!/^[A-Za-z0-9_\-./]+$/.test(value)) return undefined;
  const line = new RegExp(`^(\\s*)"model"\\s*:\\s*"[^"]*"`, "m");
  if (line.test(raw)) {
    return raw.replace(line, `$1"model": "${value}"`);
  }
  // No model key: insert right after the opening brace, above any comments.
  const opened = /^(\s*\{)/.exec(raw);
  if (!opened) return undefined;
  return raw.replace(opened[1], `${opened[1]}\n  "model": "${value}",`);
}
