/**
 * The detailed command reference, parsed from docs/COMMANDS.md.
 *
 * The .md is the single source of truth: one `## /command` section per
 * command, grouped under `### Category` headers. The /help menu offers
 * every command; a tap answers with that command's section, converted to
 * Telegram HTML.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandSection {
  name: string;
  category: string;
  /** One-line description — the brief the menu shows. */
  brief: string;
  /** The full section, as Telegram HTML. */
  body: string;
}

function commandsFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "docs", "COMMANDS.md"), // src/help.ts -> repo/docs
    join(process.cwd(), "docs", "COMMANDS.md"), // fallback: server cwd
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/**
 * Minimal markdown -> Telegram HTML for the subset the reference uses:
 * **bold**, `code`, lists, headers and paragraphs. Everything else passes
 * through — the document is plain prose between the markers.
 */
export function mdToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("### ")) {
      if (inList) {
        inList = false;
      }
      out.push(`<b>${inline(line.slice(4))}</b>`);
    } else if (line.startsWith("## ")) {
      if (inList) {
        inList = false;
      }
      out.push(`<b>${inline(line.slice(3))}</b>`);
    } else if (line.startsWith("- ")) {
      inList = true;
      out.push(`• ${inline(line.slice(2))}`);
    } else if (line.trim() === "") {
      if (inList) {
        inList = false;
      }
      out.push("");
    } else {
      if (inList) {
        inList = false;
      }
      out.push(inline(line));
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Inline markers: **bold** and `code` — the only ones the reference uses. */
function inline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Parse the reference into sections. The brief is the first non-empty
 * line after the header (the **Qué hace** line, stripped of its bold
 * marker); the body is the whole section as HTML.
 */
export function commandSections(): CommandSection[] {
  let raw: string;
  try {
    raw = readFileSync(commandsFile(), "utf8");
  } catch {
    return [];
  }
  const sections: CommandSection[] = [];
  let category = "";
  let current: { name: string; lines: string[] } | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("### /")) {
      if (current) sections.push(buildSection(current, category));
      current = { name: line.slice(5).trim(), lines: [] };
    } else if (line.startsWith("### ")) {
      category = line.slice(4).trim();
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(buildSection(current, category));
  return sections;
}

function buildSection(section: { name: string; lines: string[] }, category: string): CommandSection {
  const body = mdToHtml(section.lines.join("\n"));
  // The brief: the first **Qué hace** line, bold marker stripped.
  const briefLine = section.lines.find((l) => l.trim().startsWith("**Qué hace**")) ?? "";
  const brief = briefLine.replace(/\*\*/g, "").replace(/^Qué hace:\s*/, "").trim();
  return { name: section.name, category, brief, body };
}
