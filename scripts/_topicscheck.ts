/**
 * Topic mapping and the forum-mode fallback.
 *
 * What must hold: two concurrent events open only one thread, the mapping is
 * reusable once resolved, and a bot without topic mode degrades to the single
 * chat instead of throwing per event.
 */
import { RebuildSession, TopicResolver, TopicStore, rebuildCandidates } from "../src/topics.js";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

// Scratch file: the store must never touch the real mapping during a test.
const FILE = join(tmpdir(), "opencode-tg-topics-test.json");
try {
  unlinkSync(FILE);
} catch {
  /* not there */
}

async function main(): Promise<void> {
  // 1. set/get round trip, plus the inverse lookup inbound replies need.
  const store = new TopicStore(111, FILE);
  store.set("ses_a", 4242);
  check("get devuelve el hilo guardado", store.get("ses_a") === 4242);
  check("sessionOf resuelve el hilo a su sesion", store.sessionOf(4242) === "ses_a");
  check("sessionOf desconocido es undefined", store.sessionOf(9999) === undefined);
  store.set("ses_b", 5151);
  check("dos sesiones mapeadas", store.get("ses_a") === 4242 && store.get("ses_b") === 5151);

  // 2. Persistence: a new store over the same file recovers the mapping,
  //    which is what keeps threads alive across a service restart.
  const reloaded = new TopicStore(111, FILE);
  check("un store nuevo recupera los hilos", reloaded.get("ses_a") === 4242 && reloaded.get("ses_b") === 5151);
  // A different chat must not see another chat's threads.
  check("otro chat no hereda los hilos", new TopicStore(999, FILE).get("ses_a") === undefined);

  store.clear();
  check("clear borra el mapeo", store.get("ses_a") === undefined);

  // 2. Resolver: an unknown session schedules one creation, not one per event.
  const calls: Array<{ chatId: number; name: string }> = [];
  const stub = {
    async createForumTopic(chatId: number, name: string): Promise<number | undefined> {
      calls.push({ chatId, name });
      // Simulate the async round trip to Telegram.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 777;
    },
  };
  const store2 = new TopicStore(222, FILE);
  const resolver = new TopicResolver(store2, 222, stub, () => "Mi sesion", () => undefined);
  const first = resolver.get("ses_x");
  const second = resolver.get("ses_x");
  check("mientras se crea, get devuelve undefined", first === undefined && second === undefined);
  await new Promise((resolve) => setTimeout(resolve, 80));
  check("una sola llamada a createForumTopic", calls.length === 1, `${calls.length} llamadas`);
  check("tras crear, get devuelve el hilo", store2.get("ses_x") === 777);
  check("el topico se nombra con el titulo", calls[0]?.name === "Mi sesion");
  check("una segunda sesion no se mezcla", resolver.get("ses_y") === undefined);

  // 3. Fallback: Telegram rejects topic creation -> the run degrades to the
  //    single chat and no later event throws or retries.
  const broken = {
    async createForumTopic(): Promise<number | undefined> {
      throw new Error("Bad Request: can't create forum topics in a non-forum chat");
    },
  };
  const store3 = new TopicStore(333, FILE);
  let downgraded = 0;
  const resolver3 = new TopicResolver(store3, 333, broken, () => "Otra", () => {
    downgraded++;
  });
  resolver3.get("ses_z");
  resolver3.get("ses_z");
  await new Promise((resolve) => setTimeout(resolve, 30));
  check("se notifica la baja (una vez)", downgraded === 1, `${downgraded} bajas`);
  check("sin hilo tras la baja", resolver3.get("ses_z") === undefined);

  // 4. Async titleOf: a topic (re)born must await the LIVE title — the
  //    server's current name, not a cached copy (the drift incident: a
  //    recreated thread wore its September name while the desktop said
  //    "Bot Telegram").
  const calls4: Array<{ chatId: number; name: string }> = [];
  const stub4 = {
    async createForumTopic(chatId: number, name: string): Promise<number | undefined> {
      calls4.push({ chatId, name });
      return 888;
    },
  };
  const store4 = new TopicStore(444, FILE);
  const resolver4 = new TopicResolver(
    store4,
    444,
    stub4,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "Titulo vivo del server";
    },
    () => undefined,
  );
  resolver4.get("ses_w");
  await new Promise((resolve) => setTimeout(resolve, 100));
  check("titleOf async: el topico nace con el titulo resuelto", calls4[0]?.name === "Titulo vivo del server", calls4[0]?.name ?? "sin llamadas");
  check("y el mapeo quedo", store4.get("ses_w") === 888);

  // 5. /rebuild selection: the forum should show sessions a HUMAN used
  //    recently, not sessions the server's housekeeping touched. The bug
  //    this guards: after a service restart every session shares one
  //    `updated` minute, so ordering by it resurrected sessions idle for
  //    days as if they were live.
  const H = 3_600_000;
  const NOW = 10_000_000_000_000;
  const ghost = {
    // usado hace 2 dias, pero el server le piso `updated` al reiniciar
    id: "ses_ghost",
    title: "Fantasma",
    time: { idle: NOW - 48 * H },
  } as const;
  const live = { id: "ses_live", title: "Viva", time: { idle: NOW - 10 * 60_000 } } as const;
  const used1h = { id: "ses_1h", title: "Hace una hora", time: { idle: NOW - H } } as const;
  const noIdle = { id: "ses_noidle", title: "Sin idle", time: {} } as const;

  const within24 = rebuildCandidates([ghost, live, used1h, noIdle], NOW, 24);
  check("excluye la sesion idle hace 2d (ventana 24h)", !within24.some((s) => s.id === "ses_ghost"));
  check("excluye la sesion sin timestamp de idle", !within24.some((s) => s.id === "ses_noidle"));
  check("incluye la usada hace 1h", within24.some((s) => s.id === "ses_1h"));
  check("incluye la usada hace 10min", within24.some((s) => s.id === "ses_live"));
  check("ordena vieja->nueva (la mas reciente al final, arriba del foro)", within24.map((s) => s.id).join(",") === "ses_1h,ses_live");

  // Ventana 0: sin limite, pero sigue sin inventar idle donde no lo hay.
  const noWindow = rebuildCandidates([ghost, noIdle], NOW, 0);
  check("ventana 0 mantiene la sesion stale", noWindow.some((s) => s.id === "ses_ghost"));
  check("ventana 0 sigue excluyendo sin idle", !noWindow.some((s) => s.id === "ses_noidle"));

  // tope de 12: las 12 mas recientes, no las 20 que llegaron.
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `ses_${i}`,
    time: { idle: NOW - i * 60_000 },
  }));
  const capped = rebuildCandidates(many, NOW, 24);
  check("tope en 12 sesiones", capped.length === 12, `${capped.length}`);
  check("se queda con las 12 mas recientes", capped[0]?.id === "ses_11" && capped[11]?.id === "ses_0");
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
