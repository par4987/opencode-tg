/**
 * Speech-to-text for Telegram voice notes — provider-based, opt-in.
 *
 * Every user picks their own trade-off in config.json:
 *
 *   "stt": { "provider": "local" }
 *     whisper.cpp on the same machine (no cloud, no keys). Binaries under
 *     ~/.opencode/tg/stt (Release/whisper-cli.exe + models/ggml-small.bin),
 *     paths configurable. Telegram voices are OGG/Opus and whisper.cpp's
 *     bundled miniaudio decodes them directly — no ffmpeg step.
 *
 *   "stt": { "provider": "openai-compatible", "baseUrl": "https://api.groq.com/openai/v1", "model": "whisper-large-v3-turbo" }
 *     Any server speaking OpenAI's /audio/transcriptions dialect: Groq,
 *     OpenAI itself, or a self-hosted one. The key lives in the user's
 *     ~/.opencode/tg/.env as STT_API_KEY — never in the repo.
 *
 * No "stt" at all: the voice handler shows a pointer to the README instead
 * of transcribing — the feature is opt-in by construction.
 *
 * Pure stdlib: child_process for the local binary, fetch for the cloud.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { freemem, homedir } from "node:os";
import { basename, join } from "node:path";
import { t } from "./locale.js";

export interface SttConfig {
  /** "local" (whisper.cpp) or "openai-compatible" (Groq, OpenAI, self-hosted). */
  provider?: "local" | "openai-compatible";
  /** local: whisper-cli.exe path. */
  whisper?: string;
  /** local: ggml model path | cloud: model name (whisper-large-v3-turbo…). */
  model?: string;
  /** local: ffmpeg binary — decodes Telegram's OGG/Opus (default: from PATH). */
  ffmpeg?: string;
  /** cloud: base URL, e.g. https://api.groq.com/openai/v1. */
  baseUrl?: string;
  /** cloud: the STT_API_KEY from the .env — resolved by config.ts, never logged. */
  apiKey?: string;
  /** Language hint for both paths; empty = Spanish default. */
  language?: string;
}

/** Where the local binaries are dropped by the setup — the default paths. */
export function sttDefaults(): { whisper: string; model: string } {
  const root = join(homedir(), ".opencode", "tg", "stt");
  return {
    whisper: join(root, "Release", "whisper-cli.exe"),
    model: join(root, "models", "ggml-small.bin"),
  };
}

/**
 * True when the chosen provider is ready. No provider given: the local
 * binaries decide — an existing whisper.cpp install keeps working without
 * touching config.json.
 */
export function sttAvailable(cfg: SttConfig): boolean {
  if (cfg.provider === "openai-compatible") {
    return typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0 && typeof cfg.apiKey === "string" && cfg.apiKey.length > 0;
  }
  const d = sttDefaults();
  return existsSync(cfg.whisper ?? d.whisper) && existsSync(cfg.model ?? d.model);
}

/**
 * Clean whisper-cli's stdout: with `-nt` it prints the plain transcription
 * (verified live: system logs go to stderr, text to stdout), one segment
 * per line — joined here into one flowing paragraph.
 */
export function parseTranscription(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
}

/** Cloud replies are `{"text": "..."}` — anything else reads as empty. */
export function parseCloudResponse(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

/** Spawn a binary and collect its output, with a hard timeout. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(t("stt_timeout", { s: Math.round(timeoutMs / 1000) })));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Bytes as a compact human size — "465 MB", "72 MB", "1.2 GB". */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * The failure patterns whisper.cpp prints when the model cannot be loaded
 * into RAM (measured live on a box with 0.9 GB free against ggml-small):
 *
 *   ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 487005696
 *   whisper_model_load: WARN no tensors loaded from model file - assuming empty model
 *   whisper_init_state: whisper_kv_cache_init() failed
 *
 * The raw stderr the old card dumped starts with "load_backend: loaded BLAS
 * backend from …", which tells the user nothing. This says what happened and
 * what to do — but only when the free RAM actually could not hold the model,
 * so an allocation failure with plenty of RAM stays a plain error.
 */
const MEMORY_FAILURE = /failed to allocate|no tensors loaded|out of memory|not enough memory/i;

export function whisperFailureMessage(opts: {
  stderr: string;
  code: number;
  modelPath: string;
  freeBytes: number;
}): string {
  const { stderr, code, modelPath, freeBytes } = opts;
  let modelSize = 0;
  try {
    modelSize = statSync(modelPath).size;
  } catch {
    modelSize = 0;
  }
  // An allocation failure IS the diagnosis, even when the free bytes look
  // generous: whisper asks for the model plus its buffers contiguously, and
  // the OS will not hand a single process everything that is left (measured:
  // 487 MB refused with ~900 MB free). The card states the refusal and how
  // much room there was; the hint stands in every case.
  if (MEMORY_FAILURE.test(stderr)) {
    return (
      t("stt_memory_fail", {
        model: escapeHtmlLocal(basename(modelPath)),
        need: modelSize > 0 ? fmtBytes(modelSize) : "?",
        free: fmtBytes(freeBytes),
      }) +
      "\n" +
      t("stt_memory_hint")
    );
  }
  // Anything else: the useful line is at the END of whisper's stderr ("error:
  // failed to initialize whisper context"), not in the backend-loading header.
  return `whisper-cli exit ${code}: ${stderr.slice(-320)}`;
}

/** Minimal HTML escaping for the model name — kept local to avoid a render.js cycle. */
function escapeHtmlLocal(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}

async function transcribeLocal(oggPath: string, cfg: SttConfig, timeoutMs: number): Promise<string> {
  const d = sttDefaults();
  const whisper = cfg.whisper ?? d.whisper;
  const model = cfg.model ?? d.model;
  if (!existsSync(whisper)) throw new Error(t("stt_whisper_missing", { path: whisper }));
  if (!existsSync(model)) throw new Error(t("stt_model_missing", { path: model }));
  // whisper.cpp's bundled miniaudio does not read Telegram's OGG/Opus on this
  // build (verified live: jfk.wav transcribes, the same audio as .ogg comes
  // back empty) — so ffmpeg (system PATH or stt.ffmpeg) decodes to 16 kHz
  // mono WAV first. A WAV input skips the step.
  let audioPath = oggPath;
  if (!oggPath.toLowerCase().endsWith(".wav")) {
    const ffmpeg = cfg.ffmpeg ?? "ffmpeg";
    const wavPath = `${oggPath.replace(/\.[^.]+$/, "")}-${Date.now()}.wav`;
    const conv = await run(
      ffmpeg,
      ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", wavPath],
      Math.min(timeoutMs, 120_000),
    );
    if (conv.code !== 0 || !existsSync(wavPath)) {
      throw new Error(t("stt_ffmpeg_fail", { detail: conv.stderr.slice(0, 200) }));
    }
    audioPath = wavPath;
  }
  const language = cfg.language && cfg.language.length > 0 ? cfg.language : "es";
  try {
    const { code, stdout, stderr } = await run(
      whisper,
      ["-m", model, "-f", audioPath, "-l", language, "-nt"],
      timeoutMs,
    );
    if (code !== 0) {
      throw new Error(
        whisperFailureMessage({
          stderr,
          code,
          modelPath: model,
          freeBytes: freemem(),
        }),
      );
    }
    return parseTranscription(stdout);
  } finally {
    // The temporary WAV never outlives the transcription.
    if (audioPath !== oggPath) rmSync(audioPath, { force: true });
  }
}

/**
 * Any /audio/transcriptions dialect: multipart with file+model+language and
 * a Bearer key, resolving `{"text": "..."}`. Built with plain fetch — the
 * same multipart discipline as the plugin's sendPhoto.
 */
async function transcribeCloud(oggPath: string, cfg: SttConfig, timeoutMs: number): Promise<string> {
  if (!cfg.baseUrl) throw new Error(t("stt_no_baseurl"));
  if (!cfg.apiKey) throw new Error(t("stt_no_key"));
  if (!cfg.model) throw new Error(t("stt_no_model"));
  const fs = await import("node:fs");
  const buffer = fs.readFileSync(oggPath);
  const boundary = "----opencode-tg-" + Date.now();
  const parts: Buffer[] = [];
  const push = (name: string, value: string): void => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  push("model", cfg.model);
  const language = cfg.language && cfg.language.length > 0 ? cfg.language : "es";
  push("language", language);
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voz.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
  );
  parts.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  const response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return parseCloudResponse(await response.text());
}

/**
 * Transcribe one voice note (OGG/Opus path) to text with the configured
 * provider. Resolves "" when the audio carries no speech. Throws when the
 * provider is not ready — the caller says so plainly.
 */
export async function transcribeFile(oggPath: string, cfg: SttConfig = {}, timeoutMs = 300_000): Promise<string> {
  if (cfg.provider === "openai-compatible") return transcribeCloud(oggPath, cfg, timeoutMs);
  // "local", or no provider given: the local binaries decide.
  return transcribeLocal(oggPath, cfg, timeoutMs);
}
