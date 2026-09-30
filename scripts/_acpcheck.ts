/**
 * Exercises the ACP client's wire handling with a fake child process: framing,
 * request/reply correlation, and the permission-request round trip. Touches no
 * network, no token, no real `opencode` binary.
 */
import { AcpClient, type PermissionOutcome } from "../src/acp.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

/** The client subscribes with `on("data", ...)` and we push with `emit`. */
class FakeEmitter {
  private listeners: Array<(data: string) => void> = [];
  on(_event: string, fn: (data: string) => void): this {
    this.listeners.push(fn);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  emit(_event: string, data: string): boolean {
    for (const fn of this.listeners) fn(data);
    return true;
  }
}

/** A stand-in for `spawn()`'s child: stdin sink plus stdout/stderr emitters. */
class FakeProc extends FakeEmitter {
  readonly stdin = {
    writable: true,
    end: () => undefined,
    write: (_s: string): void => {
      void _s;
    },
  };
  readonly stdout = new FakeEmitter();
  readonly stderr = new FakeEmitter();
  kill(): void {}
}

const fake = new FakeProc();
const sent: object[] = [];
// Start past the client's own request ids so a `find` by id never matches the
// initialize handshake by accident.
let replyId = 1000;

const client = new AcpClient();
// Swap the real spawn for the fake so nothing touches a binary or the network.
client.spawner = () => fake;
(fake.stdin as unknown as { write: (s: string) => void }).write = (s: string) => {
  sent.push(JSON.parse(s));
  const msg = JSON.parse(s) as { id?: number; method?: string };
  if (msg.id !== undefined && msg.method) {
    // Echo a reply so the request resolves.
    fake.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n");
  }
};

async function main(): Promise<void> {
  await client.start().catch((error) => {
    console.log("  start fallo (mock):", String(error).slice(0, 120));
  });
  check("start() serializa initialize", sent.some((m) => (m as { method?: string }).method === "initialize"));

  // Permission request round trip: the server asks, the handler answers.
  const permParams = {
    sessionId: "ses_demo",
    toolCall: { title: "edit file.ts", kind: "edit" },
    options: [
      { optionId: "allow", name: "Allow" },
      { optionId: "deny", name: "Deny" },
    ],
  };
  client.permissionHandler = async (): Promise<PermissionOutcome> => {
    // The plugin resolves through a Telegram button; here we simulate tapping
    // "Allow".
    return { outcome: { outcome: "selected", optionId: "allow" } };
  };
  const reqId = ++replyId;
  fake.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "session/request_permission", params: permParams }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const permReply = sent.find((m) => (m as { id?: number }).id === reqId);
  check(
    "permiso respondido con el optionId elegido",
    permReply !== undefined && JSON.stringify(permReply).includes('"optionId":"allow"'),
    permReply === undefined ? "sin reply" : JSON.stringify(permReply).slice(0, 160),
  );

  // Without a handler the request is denied, not left dangling.
  client.permissionHandler = undefined;
  const reqId2 = ++replyId;
  fake.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: reqId2, method: "session/request_permission", params: permParams }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const denyReply = sent.find((m) => (m as { id?: number }).id === reqId2);
  check("sin handler el permiso se cancela", denyReply !== undefined && JSON.stringify(denyReply).includes('"cancelled"'));

  // Unknown server requests get an empty success so the handshake continues.
  const reqId3 = ++replyId;
  fake.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: reqId3, method: "session/unknown", params: {} }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const unknownReply = sent.find((m) => (m as { id?: number }).id === reqId3);
  check("metodo desconocido recibe success vacio", unknownReply !== undefined && JSON.stringify(unknownReply).includes('"result":{}'));

  // A prompt must be preceded by `session/load`: the ids come from the
  // OpenCode server's namespace, and the ACP process only answers prompts for
  // sessions it has been told about. Sending the prompt alone fails instantly.
  const methods: string[] = [];
  const previousWrite = (fake.stdin as unknown as { write: (s: string) => void }).write;
  (fake.stdin as unknown as { write: (s: string) => void }).write = (s: string) => {
    const msg = JSON.parse(s) as { method?: string };
    if (msg.method) methods.push(msg.method);
    return previousWrite(s);
  };
  await client.loadSession("ses_demo", "C:/proj");
  await client.prompt("ses_demo", "hola");
  const loadIdx = methods.indexOf("session/load");
  const promptIdx = methods.indexOf("session/prompt");
  check("session/load viaja antes que session/prompt", loadIdx !== -1 && promptIdx !== -1 && loadIdx < promptIdx);
  const loadCall = sent.find((m) => (m as { method?: string }).method === "session/load");
  check(
    "session/load lleva el id y el cwd",
    loadCall !== undefined &&
      JSON.stringify(loadCall).includes('"sessionId":"ses_demo"') &&
      JSON.stringify(loadCall).includes('"cwd":"C:/proj"'),
  );
  // `session/prompt` validates the body: the blocks go under `prompt`, and any
  // other key (the natural choice is `content`) is rejected as Invalid params.
  const promptCall = sent.find((m) => (m as { method?: string }).method === "session/prompt");
  check(
    "session/prompt usa la clave 'prompt'",
    promptCall !== undefined &&
      JSON.stringify(promptCall).includes('"prompt":[') &&
      !JSON.stringify(promptCall).includes('"content":'),
  );

  // A wrong directory is retried from disk rather than failing the turn: a
  // session tracked before its `.json` existed has an empty `directory`, and
  // the fallback (the server's cwd) is a guess the server rejects.
  {
    const loads: string[] = [];
    const failingWrite = (fake.stdin as unknown as { write: (s: string) => void }).write;
    (fake.stdin as unknown as { write: (s: string) => void }).write = (s: string) => {
      const msg = JSON.parse(s) as { id?: number; method?: string; params?: { cwd?: string } };
      if (msg.method === "session/load") loads.push(msg.params?.cwd ?? "");
      // Reject the first cwd, accept the second.
      if (msg.method === "session/load" && msg.params?.cwd === "C:/wrong") {
        fake.stdout.emit(
          "data",
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: "Invalid params: session ses_retry does not belong to cwd: C:/wrong" },
          }) + "\n",
        );
        return;
      }
      return failingWrite(s);
    };
    // Point the meta reader at a directory the test controls.
    process.env.XDG_DATA_HOME = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
    const sessionsDir = `${process.env.XDG_DATA_HOME}/opencode/sessions`;
    const fs = await import("node:fs");
    fs.mkdirSync(sessionsDir.replace(/\//g, "\\"), { recursive: true });
    fs.writeFileSync(
      `${sessionsDir}/ses_retry.json`.replace(/\//g, "\\"),
      JSON.stringify({ directory: "C:/correct", title: "Retry" }),
    );
    try {
      await client.loadSession("ses_retry", "C:/wrong");
      check("loadSession reintenta con el cwd del .json", loads.includes("C:/correct"), JSON.stringify(loads));
    } finally {
      try {
        fs.unlinkSync(`${sessionsDir}/ses_retry.json`);
      } catch {
        /* already gone */
      }
      delete process.env.XDG_DATA_HOME;
    }
  }

  // A server error now names the method and code, which is the difference
  // between a blind fix and a informed one: `-32602 Invalid params` arrives
  // with no data, so the method is the only context the caller gets.
  {
    const failingWrite = (fake.stdin as unknown as { write: (s: string) => void }).write;
    (fake.stdin as unknown as { write: (s: string) => void }).write = (s: string) => {
      const msg = JSON.parse(s) as { id?: number; method?: string };
      if (msg.method === "session/load" && msg.id !== undefined) {
        fake.stdout.emit(
          "data",
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } }) + "\n",
        );
        return;
      }
      return failingWrite(s);
    };
    const caught = await client.loadSession("ses_err", "C:/proj").catch((error) => error as Error);
    check(
      "el error nombra el metodo y el codigo",
      caught instanceof Error && /Invalid params \[-32602\]/.test(caught.message) && /en session\/load/.test(caught.message),
      caught instanceof Error ? caught.message.slice(0, 120) : "no se lanzo",
    );
  }

  // A turn the client gave up on leaves the session marked busy server-side, so
  // the next prompt answers "already has an active ACP prompt". The recovery is
  // a cancel and one retry — otherwise the bridge stays wedged and every later
  // message from Telegram is rejected.
  {
    let attempts = 0;
    const failingWrite = (fake.stdin as unknown as { write: (s: string) => void }).write;
    (fake.stdin as unknown as { write: (s: string) => void }).write = (s: string) => {
      const msg = JSON.parse(s) as { id?: number; method?: string; params?: { sessionId?: string } };
      if (msg.method === "session/prompt" && msg.params?.sessionId === "ses_busy") {
        attempts++;
        if (attempts === 1) {
          fake.stdout.emit(
            "data",
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "Session already has an active ACP prompt: ses_busy" },
            }) + "\n",
          );
          return;
        }
        fake.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
        return;
      }
      return failingWrite(s);
    };
    await client.prompt("ses_busy", "hola").catch(() => undefined);
    check(
      "prompt ocupado: reintenta tras cancelar",
      attempts === 2,
      `intentos de session/prompt: ${attempts}`,
    );
    const cancelled = sent.some(
      (m) =>
        (m as { method?: string }).method === "session/cancel" &&
        JSON.stringify(m).includes('"sessionId":"ses_busy"'),
    );
    check("prompt ocupado: manda session/cancel", cancelled);
  }

  await client.stop();
  check("stop() sin errores", true);
}

void main().finally(() => {
  console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
  process.exit(failures === 0 ? 0 : 1);
});
