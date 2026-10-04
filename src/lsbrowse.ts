/**
 * Project file browsing for /ls — see what the agent sees, download what it
 * produced, attach a file to the next prompt. The resolution is pure so the
 * traversal guard is testable without a filesystem.
 */
import { join } from "node:path";

/**
 * Resolve a relative path inside a project root, or undefined when it tries
 * to escape. Backslashes normalize to forward slashes; ".." is rejected
 * outright (navigate with the keyboard, not with dot-dot).
 */
export function safeResolve(root: string, rel: string): string | undefined {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean === "" || clean === ".") return root;
  const parts = clean.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === "..")) return undefined;
  const full = join(root, ...parts);
  // Windows join() answers with backslashes; the root may come with forward
  // ones. Normalize both before the containment check.
  const norm = (p: string): string => p.replace(/\\/g, "/");
  return norm(full) === norm(root) || norm(full).startsWith(norm(root) + "/") ? full : undefined;
}

/** Hidden/system entries that only clutter the phone's screen. */
export const LS_HIDDEN = new Set([".git", "node_modules", ".opencode", ".venv", "__pycache__"]);

/** Human size for the button label. */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
