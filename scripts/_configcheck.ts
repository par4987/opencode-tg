/** config-models checks: JSONC parsing and the config→catalogue mapping. */
import { stripJsonc, parseConfigModels, configProviders, type ConfigProvider } from "../src/config-models.js";
import { loadConfig } from "../src/config.js";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean): void {
  total += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`);
  }
}

// ── stripJsonc ────────────────────────────────────────────────────────────────

check("stripJsonc quita comentarios de linea", JSON.stringify(JSON.parse(stripJsonc('{ // hola\n"a": 1 }'))) === '{"a":1}');
check("stripJsonc quita comentarios de bloque", JSON.stringify(JSON.parse(stripJsonc('{ /* a\nb */ "a": 1 }'))) === '{"a":1}');
check(
  "stripJsonc respiesa strings con // dentro",
  stripJsonc('{"a": "http://x"}') === '{"a": "http://x"}',
);
check(
  "stripJsonc respiesa escapes en strings",
  stripJsonc('{"a": "\\" // no es comentario"}') === '{"a": "\\" // no es comentario"}',
);
check("stripJsonc quita coma colgante de objeto", stripJsonc('{"a": 1,}') === '{"a": 1}');
check("stripJsonc quita coma colgante de array", stripJsonc('{"a": [1, 2,]}') === '{"a": [1, 2]}');
check("stripJsonc quita comas anidadas", stripJsonc('{"a": {"b": [1,],},}') === '{"a": {"b": [1]}}');

// ── parseConfigModels ───────────────────────────────────────────────────────

const sample = `
// Mi config
{
  "providers": {
    "zai": {
      "env": ["ZAI_API_KEY"],
      "models": {
        "glm-5.3": { "name": "GLM-5.3", "limit": { "context": 1000000 } },
        "glm-5.3-flash": { "capabilities": { "tools": true } },
        "apagado": { "disabled": true }
      }
    },
    "sin-modelos": { "env": ["X"] },
    "solo-nombre": "no es un objeto"
  },
  "otra-cosa": { "providers": { "falsa": { "models": { "x": {} } } } }
}
`;
const parsed = parseConfigModels(sample);
check("parseConfigModels encuentra 1 provider con models", parsed.length === 1);
check(
  "parseConfigModels marca el disabled",
  parsed[0]?.models.find((m) => m.key === "apagado")?.disabled === true,
);
check(
  "parseConfigModels lee el name",
  parsed[0]?.models.find((m) => m.key === "glm-5.3")?.name === "GLM-5.3",
);
check(
  "parseConfigModels: modelo sin name queda undefined",
  parsed[0]?.models.find((m) => m.key === "glm-5.3-flash")?.name === undefined,
);
check("parseConfigModels ignora texto roto", parseConfigModels("{ no json").length === 0);

// ── configProviders merge (con archivos reales del usuario) ───────────────────

const real = configProviders();
const zai = real.find((p: ConfigProvider) => p.id === "zai");
console.log(`  -- config real: ${real.length} providers con models`);
if (zai) {
  const enabled = zai.models.filter((m) => !m.disabled).map((m) => m.key);
  console.log(`  -- zai habilitados (${enabled.length}): ${enabled.join(", ")}`);
  check("config real: zai tiene modelos", zai.models.length > 0);
  check(
    "config real: los glm-5.3 del usuario estan",
    enabled.includes("glm-5.3") && enabled.includes("glm-5.3-flash"),
  );
}
check("configProviders no lanza con directorios inventados", configProviders(["C:\\no\\existe"]).length >= 0);

// ── desktopVisibleModels (el espejo real: drafts.sqlite del desktop) ───────

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { desktopVisibleModels } from "../src/desktop-models.js";

const dir = mkdtempSync(joinPath(tmpdir(), "tgcheck-"));
const dbFile = joinPath(dir, "drafts.sqlite");
{
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE state (name TEXT, key TEXT, value TEXT)");
  db.prepare("INSERT INTO state VALUES (?, ?, ?)").run(
    "opencode.global.dat",
    "model",
    JSON.stringify({
      user: [
        { providerID: "zai", modelID: "glm-4.7-flash", visibility: "show" },
        { providerID: "zai", modelID: "glm-5.3", visibility: "hide" },
        { providerID: "nvidia", modelID: "z-ai/glm-5.3", visibility: "show" },
      ],
    }),
  );
  db.close();
}
const toggles = await desktopVisibleModels(dbFile);
check("desktopVisibleModels lee show/hide", toggles.length === 3 && toggles.filter((t) => t.visible).length === 2);
check(
  "desktopVisibleModels: el show de zai es el correcto",
  toggles.find((t) => t.providerID === "zai" && t.visible)?.modelID === "glm-4.7-flash",
);
check(
  "desktopVisibleModels con path inexistente → []",
  (await desktopVisibleModels(joinPath(dir, "no-existe.db"))).length === 0,
);
const realToggles = await desktopVisibleModels();
const zaiShow = realToggles.filter((t) => t.providerID === "zai" && t.visible).map((t) => t.modelID);
console.log(`  -- desktop real: ${realToggles.length} toggles; zai show (${zaiShow.length}): ${zaiShow.join(", ")}`);
check("desktop real: zai tiene exactamente 3 show", zaiShow.length === 3);
rmSync(dir, { recursive: true, force: true });

// ── loadConfig: coalesceMs (src/config.ts) ───────────────────────────────────

process.env.TG_COALESCE_MS = "3500";
check("coalesceMs: TG_COALESCE_MS=3500", loadConfig().coalesceMs === 3500);
process.env.TG_COALESCE_MS = "50";
check("coalesceMs: clamp inferior a 200", loadConfig().coalesceMs === 200);
process.env.TG_COALESCE_MS = "99999";
check("coalesceMs: clamp superior a 10000", loadConfig().coalesceMs === 10000);
process.env.TG_COALESCE_MS = "abc";
check("coalesceMs: no numerico usa default 2000", loadConfig().coalesceMs === 2000);
delete process.env.TG_COALESCE_MS;

process.env.TG_COALESCE_BUSY_MS = "20000";
check("coalesceBusyMs: TG_COALESCE_BUSY_MS=20000", loadConfig().coalesceBusyMs === 20000);
process.env.TG_COALESCE_BUSY_MS = "1000";
check("coalesceBusyMs: clamp inferior a 2000", loadConfig().coalesceBusyMs === 2000);
process.env.TG_COALESCE_BUSY_MS = "abc";
check("coalesceBusyMs: no numerico usa default 8000", loadConfig().coalesceBusyMs === 8000);
delete process.env.TG_COALESCE_BUSY_MS;

console.log(failures === 0 ? `\nCONFIGCHECK OK (${total})` : `\nCONFIGCHECK ${failures} FALLOS de ${total}`);
process.exit(failures === 0 ? 0 : 1);
