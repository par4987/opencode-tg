/**
 * /ci — GitHub Actions runs from the phone.
 *
 * The repo's own automation (the `CI` and `deps-audit` workflows) is what
 * proves a change is real: typecheck, suites, and — twice a week — the
 * dependency seal. But its verdicts live on github.com, so from the phone a
 * push looked finished until you opened the browser. This asks the REST API
 * directly and answers with the last runs: which workflow, which commit, and
 * green or red.
 *
 * Plain fetch, no dependencies. The repo is public, so an anonymous call
 * works (60/hour per IP — plenty for a command used a few times a day); a
 * token from ~/.opencode/tg/.env (GITHUB_TOKEN) lifts the limit and reads
 * private repos too. The token is never logged.
 */
import { t } from "./locale.js";

export interface CiRun {
  name: string;
  /** queued | in_progress | completed — what GitHub is doing right now. */
  status: string;
  /** success | failure | cancelled | … — null while it still runs. */
  conclusion: string | null;
  sha: string;
  title: string;
  url: string;
  /** Epoch ms from GitHub's ISO timestamp. */
  at: number;
}

/** The repo this bridge lives in — overridable for a fork. */
export const DEFAULT_REPO = "par4987/opencode-tg";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0].trim();
}

/** GitHub's "2026-10-10T04:42:36Z" -> epoch ms; garbage -> 0. */
function parseIso(value: string): number {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

/**
 * Pull the runs out of the API's JSON, defensively: the endpoint shape is
 * stable but a proxy, a rate-limit page or a private-repo 404 hands back
 * anything, and a crash here would eat the whole command.
 */
export function parseRuns(json: unknown): CiRun[] {
  const root = (json ?? {}) as { workflow_runs?: unknown };
  const arr = Array.isArray(root.workflow_runs) ? (root.workflow_runs as Array<Record<string, unknown>>) : [];
  return arr.map((raw) => {
    const commit = (raw.head_commit ?? {}) as Record<string, unknown>;
    const conclusion = raw.conclusion;
    return {
      name: firstLine(str(raw.name)) || t("ci_unknown"),
      status: str(raw.status) || "?",
      conclusion: conclusion === null || conclusion === undefined ? null : str(conclusion),
      sha: str(raw.head_sha) || "",
      title: firstLine(str(commit.message)) || t("ci_unknown"),
      url: str(raw.html_url) || "",
      at: parseIso(str(raw.created_at)),
    };
  });
}

/**
 * One line per run: state glyph, workflow name, commit title, age, and the
 * short sha linking to the run.
 */
export function formatRuns(runs: CiRun[], repo: string): string {
  if (runs.length === 0) return t("ci_none", { repo: escape(repo) });
  const header = t("ci_header", { repo: escape(repo) });
  return header + "\n" + runs.map((run) => t("ci_run", {
    state: stateGlyph(run),
    name: escape(run.name),
    title: escape(run.title.slice(0, 72)),
    age: ageText(run.at),
    sha: run.sha.slice(0, 7) || "?",
    url: run.url,
  })).join("\n");
}

/** The glyph that reads at a glance — green/red/in-flight/everything else. */
export function stateGlyph(run: CiRun): string {
  if (run.status === "in_progress" || run.status === "queued") return t("ci_state_running");
  if (run.conclusion === "success") return t("ci_state_ok");
  if (run.conclusion === "failure") return t("ci_state_fail");
  if (run.conclusion === "cancelled" || run.conclusion === "skipped" || run.conclusion === "neutral") return t("ci_state_meh");
  if (run.conclusion === "timed_out") return t("ci_state_timeout");
  return t("ci_state_unknown");
}

/** "hace 3h" / "3h ago" — minutes only under an hour, days over 24h. */
export function ageText(at: number): string {
  if (at <= 0) return t("ci_age_unknown");
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return t("ci_age_mins", { n: String(Math.max(1, minutes)) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("ci_age_hours", { n: String(hours) });
  return t("ci_age_days", { n: String(Math.round(hours / 24)) });
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}

/** The endpoint the command reads. */
export function runsUrl(repo: string, limit: number): string {
  return `https://api.github.com/repos/${repo}/actions/runs?per_page=${limit}`;
}

/**
 * Ask GitHub for the last runs. Anonymous for a public repo; the optional
 * token lifts the rate limit and reaches private ones. Throws with the
 * status so the command can say "404" instead of "algo pasó".
 */
export async function fetchRuns(repo: string, limit: number, token?: string): Promise<CiRun[]> {
  const response = await fetch(runsUrl(repo, limit), {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub HTTP ${response.status}${body ? `: ${firstLine(body).slice(0, 120)}` : ""}`);
  }
  return parseRuns(await response.json());
}
