/**
 * Local speech-to-text for Telegram voice notes — whisper.cpp running on the
 * same machine: no cloud, no keys, no audio leaving the computer.
 *
 * Telegram voices arrive as OGG/Opus, and whisper.cpp decodes them directly
 * with its bundled miniaudio (verified: `-f nota.ogg` just works), so there
 * is no ffmpeg step. Binaries live OUTSIDE the repo under ~/.opencode/tg/stt
 * (Release/whisper-cli.exe from the whisper-blas-bin-x64 build, and
 * models/ggml-small.bin), paths configurable via config.json.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SttConfig {
  /** whisper-cli.exe path (a whisper.cpp build). */
  whisper?: string;
  /** ggml model path. */
  model?: string;
  /** Language hint; empty = Spanish default. */
  language?: string;
}

/** Where the binaries are dropped by the setup — also the default paths. */
export function sttDefaults(): { whisper: string; model: string } {
  const root = join(homedir(), ".opencode", "tg", "stt");
  return {
    whisper: join(root, "Release", "whisper-cli.exe"),
    model: join(root, "models", "ggml-small.bin"),
  };
}

/** True when the binaries exist — the voice handler falls back to a notice. */
export function sttAvailable(cfg: SttConfig): boolean {
  const d = sttDefaults();
  return existsSync(cfg.whisper ?? d.whisper) && existsSync(cfg.model ?? d.model);
}

/**
 * Clean whisper-cli's stdout: with `-nt` it prints the plain transcription
 * (verified live: system logs go to stderr, text to stdout), one segment per
 * line — joined here into one flowing paragraph.
 */
export function parseTranscription(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
}

/** Spawn a binary and collect its output, with a hard timeout. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout tras ${Math.round(timeoutMs / 1000)}s`));
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

/**
 * Transcribe one voice note (OGG/Opus path) to text. Resolves "" when the
 * audio carries no speech. Throws when the binaries are missing or the run
 * fails — the caller says so plainly.
 */
export async function transcribeFile(oggPath: string, cfg: SttConfig = {}, timeoutMs = 300_000): Promise<string> {
  const d = sttDefaults();
  const whisper = cfg.whisper ?? d.whisper;
  const model = cfg.model ?? d.model;
  if (!existsSync(whisper)) throw new Error(`whisper-cli no existe: ${whisper}`);
  if (!existsSync(model)) throw new Error(`modelo no existe: ${model}`);
  const language = cfg.language && cfg.language.length > 0 ? cfg.language : "es";
  const { code, stdout, stderr } = await run(
    whisper,
    ["-m", model, "-f", oggPath, "-l", language, "-nt"],
    timeoutMs,
  );
  if (code !== 0) throw new Error(`whisper-cli exit ${code}: ${stderr.slice(0, 300)}`);
  return parseTranscription(stdout);
}
