/**
 * Secret redaction at the wire boundary.
 *
 * The bridge already refuses to READ secret files (src/dangerous.ts), but an
 * agent can still print a token it found in a config, an env dump or a log,
 * and that text would travel to Telegram verbatim. Telegram is a third party:
 * a bot token posted there is a leaked token, even in a private chat.
 *
 * Two layers, both conservative:
 *   - Known values: the bot token(s), the local OpenCode password and the CI
 *     token this process already holds. Exact substrings only.
 *   - High-confidence shapes: Telegram bot tokens, GitHub/OpenAI/Slack/AWS/
 *     Google keys, JWTs, Basic/Bearer credentials and PEM private keys.
 *
 * Deliberately NOT redacted: anything that merely *looks* like a password
 * (`password: hunter2` in prose, IPs, hashes, UUIDs). False positives here
 * break legitimate messages — a diff full of hashes would become unreadable.
 */

const PLACEHOLDER = "[redacted]";

/** Long enough not to swallow a common word by accident. */
const MIN_KNOWN_LENGTH = 10;

let knownSecrets: string[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Register the secrets this process knows verbatim. Safe to call more than
 * once (a reload re-registers). The list stores the raw value, its
 * URL-encoded form and — for `opencode:<password>` — the Basic credential,
 * because those are the shapes that actually leak in logs and error bodies.
 */
export function setRedactionSecrets(values: Array<string | undefined | null>): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_KNOWN_LENGTH) continue;
    seen.add(value);
    try {
      const encoded = encodeURIComponent(value);
      if (encoded !== value) seen.add(encoded);
    } catch {
      /* a value that cannot be encoded is still usable raw */
    }
  }
  // Longest first: a secret that contains another must be replaced whole.
  knownSecrets = [...seen].sort((a, b) => b.length - a.length);
}

/** True when redaction would change this text (used by tests and callers). */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * The patterns, in order. Each replacement keeps the surrounding syntax
 * (`Bearer `, the JSON key) so the message still reads as what it was.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // PEM blocks first: the body is multi-line and would otherwise be mangled
  // by the token patterns line by line.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted private key]"],
  // Telegram bot token: 6-12 digits, colon, 30+ base64url chars.
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, PLACEHOLDER],
  // GitHub: classic and fine-grained.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, PLACEHOLDER],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, PLACEHOLDER],
  // OpenAI / Anthropic style.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, PLACEHOLDER],
  // AWS access key id.
  [/\bAKIA[0-9A-Z]{16}\b/g, PLACEHOLDER],
  // Google API key.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, PLACEHOLDER],
  // Slack.
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, PLACEHOLDER],
  // JWT (header.payload.signature), all three parts long enough to be real.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, PLACEHOLDER],
  // Authorization headers in logs and error bodies.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, `Bearer ${PLACEHOLDER}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{20,}/gi, `Basic ${PLACEHOLDER}`],
  // JSON-ish key/value pairs where the key itself names the secret.
  [
    /("(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|access[_-]?token)"\s*:\s*")([^"\\]{6,})(")/gi,
    `$1${PLACEHOLDER}$3`,
  ],
];

/**
 * Redact every known secret and high-confidence shape. Pure and idempotent:
 * running it twice changes nothing, so the transport can apply it without
 * knowing whether an earlier layer already did.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(PLACEHOLDER);
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
