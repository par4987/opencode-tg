/**
 * Small pure helpers for the newer API surfaces.
 */
/**
 * Parse the `data:` lines out of a server-sent-events body. The session
 * log endpoint (verified live) answers SSE: `data: {json}` per event —
 * a sample window is read and this turns it into event strings.
 */
export function parseSseData(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) out.push(trimmed.slice(5).trim());
  }
  return out;
}

/**
 * Extract the generated text from a `/experimental/generate` response.
 * The one-shot endpoint cold-starts past every probe timeout, so its
 * exact shape was never captured — this reads the common envelopes
 * (`{data:{text}}`, `{text}`, `{output}`, `{completion}`) and falls back
 * to the raw body, so a shape drift degrades instead of breaking.
 */
export function generateTextOf(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.trim();
  }
  const holders: Array<Record<string, unknown> | undefined> = [
    parsed as Record<string, unknown>,
    (parsed as { data?: Record<string, unknown> })?.data,
  ];
  for (const holder of holders) {
    if (!holder) continue;
    for (const key of ["text", "output", "completion", "content"]) {
      const value = holder[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return body.trim();
}

/**
 * The candidate titles out of a raw generation: one per line, cleaned of
 * numbering, quotes and markdown, capped in count and length — whatever
 * the model produced becomes tappable options.
 */
export function titleOptionsFrom(text: string, max = 3): string[] {
  const options: string[] = [];
  for (const raw of text.split("\n")) {
    const clean = raw
      .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "")
      .replace(/^["'«»]|["'«»]$/g, "")
      .replace(/\*\*/g, "")
      .trim();
    if (clean.length < 2 || clean.length > 64) continue;
    if (!options.some((o) => o.toLowerCase() === clean.toLowerCase())) options.push(clean);
    if (options.length >= max) break;
  }
  return options;
}
