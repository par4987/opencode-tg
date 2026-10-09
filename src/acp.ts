/**
 * Minimal in-process ACP client.
 *
 * The plugin needs to *act*, not just mirror: reply to permission prompts and
 * push a prompt into a session. OpenCode exposes those over the Agent Client
 * Protocol — newline-delimited JSON-RPC over an `opencode acp` child process —
 * which is exactly how the standalone bots did it.
 *
 * This is deliberately small: `initialize`, `session/new`, `session/prompt` and
 * the `session/request_permission` handler. The mirror already renders sessions
 * from `ctx.event`, so the client only exists for the write side.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { log, safe } from "./log.js";
import { t } from "./locale.js";
import { readSessionMeta } from "./session-meta.js";

export interface ContentBlock {
  type: "text";
  text: string;
}

export interface PromptResult {
  stopReason?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: Record<string, unknown> };
  options: PermissionOption[];
}

export type PermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** The method this pending call is for, so an error names what failed. */
  method?: string;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Where to look for the `opencode` executable, in preference order.
 *
 * The plugin's process (the OpenCode server) inherits a minimal environment:
 * the npm global bin is not on a Windows service's PATH, so a bare
 * `opencode.exe` fails with "not recognized". Resolve the absolute path from
 * the known install location before falling back to PATH.
 */
function opencodeBinary(): string {
  const env = process.env.OPENCODE_PATH;
  if (env && env.length > 0) return env;
  if (process.env.APPDATA) {
    const cli = join(process.env.APPDATA, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
    if (exists(cli)) return cli;
  }
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function exists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private started = false;

  /** Permission handler the plugin installs; returning a Promise resolves a
   *  pending `session/request_permission`. */
  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;

  /** Test seam: a fake `spawn` keeps the wire format without touching a real
   *  `opencode` binary or the network. */
  // The real type is `ChildProcessWithoutNullStreams`; it is spelled loosely
  // here so tests can substitute a duck-typed fake without pulling in node's
  // typings (this project has no node_modules at runtime).
  spawner: (bin: string, args: string[], opts: { shell: boolean }) => unknown = (bin, args, opts) =>
    spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: opts.shell,
      // Without this a console window flashes open on every prompt on Windows,
      // which is what "se abre un PowerShell que no hace nada" looks like.
      windowsHide: true,
    });

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const bin = opencodeBinary();
    // Windows resolves bare names on PATH through a shell; an absolute exe does
    // not need one.
    const useShell = process.platform === "win32" && !bin.includes("\\") && !bin.includes("/");
    log("INFO", `acp: spawning ${bin} acp`);

    const proc = this.spawner(bin, ["acp"], { shell: useShell }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      log("WARN", `acp: proceso cerrado (code ${code})`);
      this.failAll(new Error(`opencode acp exited (code ${code})`));
      this.started = false;
    });
    proc.on("error", (error) => {
      if (this.proc !== proc) return;
      log("ERROR", "acp: no se pudo arrancar", safe(error));
      this.failAll(error);
      this.started = false;
    });

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) log("INFO", `acp stderr: ${text.slice(0, 300)}`);
    });

    try {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "opencode-tg", version: "1.0.0" },
      });
    } catch (error) {
      log("ERROR", "acp: initialize fallo", safe(error));
      throw error;
    }
  }

  /**
   * Attach to a session that another process (the OpenCode server) is running.
   *
   * `session/prompt` only works on a session this ACP process knows about.
   * Without this the prompt fails instantly with "session not found": the ids
   * we see on the event stream belong to the server, and a freshly spawned
   * `opencode acp` has its own namespace. Loading the session by id imports its
   * messages and tool state so prompts land in the same conversation.
   *
   * The server checks the session's directory against the cwd we pass and
   * rejects a mismatch ("session X does not belong to cwd: Y"). A brand-new
   * session has no `.json` when it is first tracked, so the cached directory
   * can be empty and the caller's fallback is the server's own cwd — wrong.
   * Rather than fail the turn, reload the metadata from disk, which by
   * prompt-time has always been written, and try once more.
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.request("session/load", { sessionId, cwd, mcpServers: [] }, 120_000);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/does not belong to cwd/i.test(error.message)) throw error;
    }
    const meta = readSessionMeta(sessionId);
    const correct = meta?.directory;
    if (!correct || correct === cwd) throw new Error(t("acp_no_cwd", { id: sessionId }));
    await this.request("session/load", { sessionId, cwd: correct, mcpServers: [] }, 120_000);
    log("INFO", `acp: cwd corregido a ${correct}`);
  }

  /**
   * Push a prompt into an existing session; resolves when the turn ends.
   *
   * The parameter is `prompt`, not `content`: `session/prompt` validates the
   * request body and answers `Invalid params` for any other shape, which was
   * silent to debug because the error carries no data.
   *
   * A turn can legitimately run for many minutes, so the request waits an hour
   * rather than the two minutes used by control calls. When the client does
   * give up, the server keeps the prompt marked active and every following
   * attempt answers `already has an active ACP prompt`; a cancel clears it and
   * one retry goes through.
   */
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    const prompt: ContentBlock[] = [{ type: "text", text }];
    try {
      return (await this.request("session/prompt", { sessionId, prompt }, 60 * 60_000)) as PromptResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already has an active/i.test(message)) throw error;
      log("INFO", "acp", `prompt ocupado; cancelando y reintentando ${sessionId.slice(0, 18)}`);
      this.cancel(sessionId);
      return (await this.request("session/prompt", { sessionId, prompt }, 60 * 60_000)) as PromptResult;
    }
  }

  /** Cancel any in-flight turn for a session. A notification, so no reply. */
  cancel(sessionId: string): void {
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  /** Answer a permission request the server asked about. */
  resolvePermission(requestId: string, outcome: PermissionOutcome): void {
    this.send({ jsonrpc: "2.0", id: requestId, result: outcome });
  }

  async stop(): Promise<void> {
    this.started = false;
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    this.failAll(new Error("acp stopped"));
    try {
      proc.stdin.end();
    } catch {
      /* already gone */
    }
    proc.kill();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: object): void {
    if (!this.proc?.stdin.writable) throw new Error(t("acp_stdin"));
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.onMessage(parsed);
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    // A server request (not a reply): permission prompts arrive this way and
    // must be answered on the same id.
    if (message.method && message.id !== undefined && message.id !== null) {
      if (message.method === "session/request_permission") {
        const params = message.params as RequestPermissionParams;
        if (this.permissionHandler) {
          void this.permissionHandler(params)
            .then((outcome) => this.send({ jsonrpc: "2.0", id: message.id, result: outcome }))
            .catch((error) => {
              log("ERROR", "acp: permission handler fallo", safe(error));
              this.send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
            });
          return;
        }
        // Nobody is listening: deny rather than block the session forever.
        this.send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      // Anything else the client does not implement gets an empty success so
      // the protocol handshake does not stall.
      this.send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    if (message.error) {
      // `-32602 Invalid params` arrives with an empty `data` field, so the
      // method and code are all the diagnosis we get. Carry them both, and any
      // data the server did send, so the next failure names itself.
      const code = message.error.code;
      pending.reject(
        new Error(
          `acp: ${message.error.message}${code !== undefined ? ` [${code}]` : ""}` +
            (pending.method ? ` en ${pending.method}` : "") +
            (message.error.data ? ` — ${JSON.stringify(message.error.data)}` : ""),
        ),
      );
    } else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
