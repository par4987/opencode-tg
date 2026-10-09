/**
 * Multi-bot topology: specs, claims and routing.
 *
 * What must hold: extra tokens become bots in order, per-project claims
 * follow explicit assignments first and only then the free pool (never the
 * primary), a claim is taken only when a turn is really happening, a
 * subagent routes to its parent's bot, per-session claims release on demand,
 * pool exhaustion falls to the hub, and — the regression that would orphan
 * threads forever — two TopicStores sharing one file must not clobber each
 * other's mappings.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { BotRegistry, buildSpecs, normDir, offsetPathFor, slugify, type BotSpec, type RegistryLookup } from "../src/bots.js";
import { TopicStore } from "../src/topics.js";
import type { Config } from "../src/config.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

// Scratch dir: claims and offsets must never touch the real bridge state.
const DIR = mkdtempSync(join(tmpdir(), "tg-botcheck-"));
const CLAIMS = join(DIR, "bots.json");

/** A minimal Config — only the fields buildSpecs reads. */
function fakeConfig(extraBots: Array<{ name: string; token: string; chatId?: number }>): Config {
  return {
    mode: "dry",
    token: "111:primary",
    allowedUsers: [42],
    render: {
      editIntervalMs: 1400,
      showDiffs: true,
      diffMaxLines: 40,
      showReasoning: true,
      reasoningChars: 1400,
    },
    mirror: "all",
    archiveAfterDays: 0,
    rebuildIdleHours: 24,
    coalesceMs: 2000,
    coalesceBusyMs: 8000,
    debugEvents: false,
    stt: {},
    subagents: "mirror",
    bots: { topology: "single", assign: [] },
    extraBots,
  } as Config;
}

/** Sessions the registry may look up, keyed by id. */
function lookupOf(sessions: Record<string, { parentID?: string; directory?: string }>): RegistryLookup {
  return { session: (id) => sessions[id] };
}

const MAIN: BotSpec = { name: "main", slug: "main", token: "t", offsetPath: "o", primary: true };
const SAP: BotSpec = { name: "sap", slug: "sap", token: "t2", offsetPath: "o2", primary: false };
const WEB: BotSpec = { name: "web", slug: "web", token: "t3", offsetPath: "o3", primary: false };

async function main(): Promise<void> {
  // ── 1. pure helpers ────────────────────────────────────────────────────────
  check("normDir: case, slashes y barra final", normDir("C:\\Projects\\App/") === "c:/projects/app");
  check("normDir: vacia queda vacia", normDir("") === "");
  check("slugify: espacios y signos", slugify("SAP Research!") === "sap-research");
  check("slugify: solo basura cae a 'bot'", slugify("!!!") === "bot");
  process.env.TG_STATE_DIR = DIR;
  check(
    "offsets: uno por bot, el principal conserva offset.txt",
    offsetPathFor("main").endsWith("offset.txt") && offsetPathFor("sap").endsWith("offset-sap.txt") && offsetPathFor("sap") !== offsetPathFor("main"),
  );
  delete process.env.TG_STATE_DIR;

  // ── 2. buildSpecs: tokens -> bots ─────────────────────────────────────────
  const specs = buildSpecs(fakeConfig([{ name: "sap", token: "222:x" }, { name: "Web App", token: "333:y", chatId: -100 }]));
  check("specs: principal + extras en orden", specs.length === 3 && specs[0].name === "main" && specs[1].name === "sap" && specs[2].name === "Web App");
  check("specs: chat default y override", specs[1].chatId === 42 && specs[2].chatId === -100);
  check("specs: slug saneado", specs[2].slug === "web-app");
  check(
    "specs: un offset por bot",
    specs[0].offsetPath !== specs[1].offsetPath && specs[1].offsetPath !== specs[2].offsetPath,
  );
  const dupSpecs = buildSpecs(fakeConfig([{ name: "sap", token: "a" }, { name: "SAP!", token: "b" }]));
  check("specs: slug duplicado se ignora", dupSpecs.length === 2, `${dupSpecs.length} specs`);

  // ── 3. per-project: explicit assign beats the pool ────────────────────────
  {
    const reg = new BotRegistry(
      [MAIN, SAP, WEB],
      "per-project",
      [{ project: "E:\\Code\\sap", bot: "web" }],
      join(DIR, "p1.json"),
      lookupOf({ s1: { directory: "E:\\Code\\sap" }, s2: { directory: "e:/code/web" } }),
    );
    check("assign explicito gana", reg.of("s1").name === "web");
    check("assign no reclama al principal", reg.of("s1").name === "web");
    // s2 has no assignment: a bare lookup must NOT claim (listings must not
    // drain the pool), a turn trigger must. WEB is already claimed by the
    // explicit assign — the free candidate here is SAP.
    check("mirar sin turno no reclama", reg.of("s2").name === "main" && reg.claimedBy(SAP) === undefined);
    check("el turno reclama el primer libre", reg.of("s2", true).name === "sap");
    check("y queda persistido", reg.of("s2").name === "sap");
    check("sesiones de otro proyecto caen al hub", reg.of("s3").name === "main");
    check("isMine: solo el dueno", reg.isMine(SAP, "s2") && reg.isMine(WEB, "s1") && !reg.isMine(SAP, "s1") && !reg.isMine(WEB, "s2"));
  }

  // ── 4. per-project: claims survive a restart (file round-trip) ────────────
  {
    const file = join(DIR, "p2.json");
    const reg1 = new BotRegistry([MAIN, SAP], "per-project", [], file, lookupOf({ s1: { directory: "c:/a" } }));
    reg1.of("s1", true);
    const reg2 = new BotRegistry([MAIN, SAP], "per-project", [], file, lookupOf({ s1: { directory: "c:/a" } }));
    check("claim sobrevive a la recarga", reg2.of("s1").name === "sap");
  }

  // ── 5. per-session: claim on trigger, parent walk, exhaustion, release ────
  {
    const reg = new BotRegistry(
      [MAIN, SAP, WEB],
      "per-session",
      [],
      join(DIR, "s1.json"),
      lookupOf({
        parent: { directory: "c:/x" },
        sub: { parentID: "parent" },
        grandsub: { parentID: "sub" },
      }),
    );
    check("sin claim va al hub", reg.of("parent").name === "main");
    check("sin turno no reclama", reg.of("parent", false).name === "main" && reg.claimedBy(SAP) === undefined);
    check("con turno reclama", reg.of("parent", true).name === "sap");
    check("subagente va al bot del padre", reg.of("sub", true).name === "sap" && reg.of("sub").name === "sap");
    check("nieto tambien (cadena)", reg.of("grandsub").name === "sap");
    check("ownedSession refleja el claim", reg.ownedSession(SAP) === "parent");
    // Second live session claims the last free bot; the third finds the pool
    // empty and falls to the hub with exhausted() saying so.
    check("segunda sesion reclama el ultimo libre", reg.of("other", true).name === "web");
    check("pool agotado -> hub", reg.of("third", true).name === "main");
    check("exhausted marca la sesion sin bot", reg.exhausted("third") === true && reg.exhausted("parent") === false && reg.exhausted("sub") === false);
    // Release: the bot returns to the pool and the next live session takes it.
    check("release devuelve el bot", reg.release(WEB) === true && reg.of("third", true).name === "web");
    check("release de un bot ya libre es false", reg.release(SAP) === true && reg.release(SAP) === false);
  }

  // ── 6. single: everything routes to the primary, no claims ────────────────
  {
    const reg = new BotRegistry([MAIN, SAP], "single", [], join(DIR, "s2.json"), lookupOf({ s1: { directory: "c:/a" } }));
    check("single: todo al principal", reg.of("s1", true).name === "main");
    check("single: nada se reclama", reg.allClaims() !== undefined && Object.keys(reg.allClaims()).length === 0);
  }

  // ── 7. TopicStore merge: two chats, one file, nobody clobbers ─────────────
  {
    const file = join(DIR, "topics.json");
    try {
      unlinkSync(file);
    } catch {
      /* not there */
    }
    const chatA = new TopicStore(111, file);
    const chatB = new TopicStore(222, file);
    chatA.set("ses_a", 10);
    chatB.set("ses_b", 20);
    chatA.setArchived("ses_old", true);
    // Each store only sees its own slice…
    check("A ve su hilo", chatA.get("ses_a") === 10 && chatA.get("ses_b") === undefined);
    check("B ve su hilo", chatB.get("ses_b") === 20 && chatB.get("ses_a") === undefined);
    check("B no hereda el archivado de A", chatB.isArchived("ses_old") === false);
    // …and a reloaded store over the shared file recovers BOTH chats' state,
    // which is what keeps extra bots' threads alive across restarts.
    const raw = JSON.parse(readFileSync(file, "utf8")) as { chats: Record<string, Record<string, number>>; archived: Record<string, string[]> };
    check("el archivo conserva ambos chats", raw.chats["111"].ses_a === 10 && raw.chats["222"].ses_b === 20);
    check("archivados por chat", raw.archived["111"].includes("ses_old") && !(raw.archived["222"] ?? []).includes("ses_old"));
    const reA = new TopicStore(111, file);
    const reB = new TopicStore(222, file);
    check("recarga: A sigue mapeando", reA.get("ses_a") === 10);
    check("recarga: B sobrevivio a una escritura de A", reB.get("ses_b") === 20);
  }
}

void main()
  .catch((error) => {
    console.log("  el test mismo fallo:", String(error).slice(0, 300));
    failures++;
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
