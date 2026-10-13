/**
 * Pure helpers for `/new`'s title and project flow, and for `/unarchive`'s
 * recovery picker. Kept out of index.ts so the rules — what counts as a
 * title, what a new folder may be named, which row the picker draws first,
 * which archived session a partial id resolves to — are testable without a
 * live server or a Telegram account.
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

/**
 * Resolve a command argument to one session id. Exact first, then a
 * case-insensitive PREFIX — the ids are `ses_` plus ~22 random characters, so
 * the 18-character stub `/sessions` displays already names one session, and a
 * hand-typed id with wrong case still lands (the store dedups
 * case-insensitively too). Ambiguous prefixes stay unresolved: the caller
 * falls back to the search picker rather than guessing.
 */
export function resolveSessionPrefix(known: string[], arg: string): string | undefined {
  const text = arg.trim();
  if (!text) return undefined;
  const exact = known.find((id) => id === text);
  if (exact !== undefined) return exact;
  const lower = text.toLowerCase();
  const matches = known.filter((id) => id.toLowerCase().startsWith(lower));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A row of /unarchive's recovery picker. */
export interface ArchivedCandidate {
  id: string;
  title: string;
  /** The project's folder name — what a search by project matches against. */
  project: string;
  /** When the session was last active; 0 when only disk metadata knows it. */
  lastSeen: number;
}

/**
 * The sessions worth offering `/unarchive` — everything the chat archived,
 * freshest first, subagent threads excluded (you resume a conversation, not a
 * child task). Tracked sessions carry a real `lastSeen`; an id that only the
 * persisted archive knows still draws, from whatever `known` has on it,
 * sorting by that timestamp. A query narrows by title, project folder or id
 * prefix; empty means all.
 *
 * `known` is the server's own session list in production — it is the source
 * of truth for titles and projects of sessions archived long ago, whose
 * transcripts are gone from disk (measured: 2 of 57 mapped ids still have a
 * metadata file, the server lists 28 of them).
 */
export function archivedCandidates(
  tracked: Array<{ id: string; title: string; directory: string; lastSeen: number; parentID?: string }>,
  archivedIds: string[],
  known: (id: string) => { title?: string; directory?: string; updated?: number } | undefined,
  query: string,
): ArchivedCandidate[] {
  const seen = new Set<string>();
  const rows: ArchivedCandidate[] = [];
  for (const s of tracked) {
    // Mark it seen BEFORE the filters: a subagent in the archive must not
    // fall through to the metadata loop and draw anyway.
    seen.add(s.id);
    if (s.parentID) continue;
    if (!archivedIds.includes(s.id)) continue;
    rows.push({ id: s.id, title: s.title, project: baseName(s.directory), lastSeen: s.lastSeen });
  }
  for (const id of archivedIds) {
    if (seen.has(id)) continue;
    const info = known(id);
    rows.push({
      id,
      title: info?.title ?? "",
      project: info?.directory ? baseName(info.directory) : "",
      lastSeen: info?.updated ?? 0,
    });
  }
  const q = query.trim().toLowerCase();
  const rows2 = q
    ? rows.filter((r) => r.title.toLowerCase().includes(q) || r.project.toLowerCase().includes(q) || r.id.toLowerCase().startsWith(q))
    : rows;
  return rows2.sort((a, b) => b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
}

/**
 * Slice a button label without splitting a surrogate pair — a title carrying
 * an emoji would otherwise render a replacement character at the seam.
 */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  while (end > 0 && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1;
  return text.slice(0, end);
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
