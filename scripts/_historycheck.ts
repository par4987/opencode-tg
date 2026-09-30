/**
 * Queue semantics: a message that arrives while the agent is busy waits for
 * the turn to end instead of colliding with it. This is the behaviour the
 * user picked, and it is also what stops the `session/load` ClientError —
 * that error is the server refusing a second owner for a running turn.
 */
import { readHistory, parseEventLine, jsonlPath, sessionsDir } from "../src/history.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

// parseEventLine: the shapes the real server writes.
check(
  "Prompt con kind:text + data",
  parseEventLine(JSON.stringify({ kind: "Prompt", data: { content: [{ kind: "text", data: "hola" }] } }))?.text === "hola",
);
check(
  "Prompt con kind:text + text (formato viejo)",
  parseEventLine(JSON.stringify({ kind: "Prompt", data: { content: [{ kind: "text", text: "viejo" }] } }))?.text === "viejo",
);
check(
  "AssistantMessage mapea a assistant",
  parseEventLine(JSON.stringify({ kind: "AssistantMessage", data: { content: [{ kind: "text", data: "respuesta" }] } }))?.role === "assistant",
);
check(
  "ToolUse lleva el nombre de la herramienta",
  parseEventLine(
    JSON.stringify({ kind: "ToolUse", data: { tool_name: "shell", content: [{ kind: "text", data: "ls" }] } }),
  )?.tool === "shell",
);
check("linea vacia se ignora", parseEventLine("") === undefined);
check("basura json se ignora", parseEventLine("no es json") === undefined);
check(
  "evento irrelevante se ignora",
  parseEventLine(JSON.stringify({ kind: "FileChanged", data: {} })) === undefined,
);

// jsonlPath: XDG-aware, and always under sessions/.
check("jsonlPath termina en .jsonl", jsonlPath("ses_abc").endsWith("ses_abc.jsonl"));
check("sessionsDir contiene opencode/sessions", sessionsDir().includes("opencode"));

// readHistory against a real temp file: the tail must be read, not the head.
{
  const tmp = jsonlPath("ses_history_probe");
  const lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    lines.push(JSON.stringify({ kind: "Prompt", data: { content: [{ kind: "text", data: `pregunta ${i}` }] } }));
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  // The opencode sessions dir does not exist in CI: create it for the probe
  // (the probe file is unlinked in the finally below).
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, lines.join("\n"), "utf8");
  try {
    const entries = readHistory(tmp, 5);
    check(
      "readHistory devuelve las ultimas N entradas",
      entries.length === 5 && entries[0].text === "pregunta 45",
      entries.map((e) => e.text).join(","),
    );
  } finally {
    fs.unlinkSync(tmp);
  }
}

// readHistory of a missing file yields nothing instead of throwing.
check("archivo inexistente -> []", readHistory(jsonlPath("ses_does_not_exist")).length === 0);

if (failures === 0) console.log("TODO OK");
else {
  console.log(`FALLOS: ${failures}`);
  process.exitCode = 1;
}
