/**
 * Pure helpers for `/new`'s title and project flow. Kept out of index.ts so
 * the rules — what counts as a title, what a new folder may be named, which
 * row the picker draws first — are testable without a live server or a
 * Telegram account.
 *
 * A project in OpenCode is a directory, and the API has no "create project"
 * endpoint (verified against the running server: a session opened in a fresh
 * directory is what registers it). So "create a new project" means making a
 * folder next to the current one and opening a session in it.
 */

/**
 * A session title: one line, 1..60 characters (the API's own cap, which the
 * caller also slices to). Returns the title trimmed, or `undefined` when the
 * text cannot be one.
 */
export function normalizeTitle(raw: string): string | undefined {
  const text = unquote(raw.split(/\r?\n/, 1)[0]?.trim() ?? "");
  if (!text || text.length > 60) return undefined;
  return text;
}

/**
 * The name of a new project folder: a NAME, never a path. It lands directly
 * beside the current project, so anything that could escape that parent is
 * refused — separators, traversal, drive letters, and Windows' illegal set.
 */
export function normalizeProjectName(raw: string): string | undefined {
  const text = unquote(raw.split(/\r?\n/, 1)[0]?.trim() ?? "");
  if (!text || text.length > 60) return undefined;
  if (/[\\/]/.test(text)) return undefined;
  if (/^[.]+$/.test(text)) return undefined;
  if (/[<>:"|?*\u0000-\u001F]/.test(text)) return undefined;
  return text;
}

export interface ProjectChoice {
  directory: string;
  name: string;
  /** The project the conversation already lives in — the picker draws it first. */
  current?: boolean;
}

/**
 * The picker rows: the current project first (the default, one tap away), then
 * every other known project freshest first, deduped case-insensitively — the
 * same order `/projects` and the wizard use, with the current one promoted.
 */
export function projectChoices(
  currentDir: string,
  known: Array<{ directory: string; name: string; updated?: number }>,
  limit = 10,
): ProjectChoice[] {
  const lower = currentDir.toLowerCase();
  const others = known
    .filter((p) => p.directory.toLowerCase() !== lower)
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, Math.max(0, limit - 1));
  return [
    { directory: currentDir, name: baseName(currentDir), current: true },
    ...others.map((p) => ({ directory: p.directory, name: p.name })),
  ];
}

/**
 * The provider the /new model picker opens on: the project default's — but
 * only while it still has visible models, since a provider page that offers
 * nothing but the back button is a dead end.
 */
export function defaultProviderOf(
  items: Array<{ providerID: string }>,
  def: { id?: string; providerID?: string } | undefined,
): string | undefined {
  if (!def?.providerID) return undefined;
  return items.some((m) => m.providerID === def.providerID) ? def.providerID : undefined;
}

function baseName(directory: string): string {
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory;
}

/**
 * Drop one pair of surrounding quotes. The docs show titles as
 * `/new "nombre"`, and a literal pair in the name would ride into the topic's
 * name and the folder's.
 */
function unquote(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if (first !== last || (first !== '"' && first !== "'")) return text;
  return text.slice(1, -1).trim();
}
