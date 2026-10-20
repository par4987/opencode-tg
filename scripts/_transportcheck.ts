/**
 * Transporte del Bot API: socket fresco por request (node:https, agent: false).
 *
 * Regresiones cubiertas — todo lo que el fetch compartido rompía:
 *  1. roundtrip normal sobre HTTP local;
 *  2. un endpoint que NUNCA responde (socket abierto) cae por timeout en
 *     tiempo acotado — antes el request se quedaba colgado para siempre,
 *     envenenaba el pool de undici y arrastraba a todo el proceso;
 *  3. stop() corta un request en vuelo de inmediato ("aborted"), sin
 *     esperar al timeout;
 *  4. sockets no retenidos: tras los requests, el servidor no guarda
 *     conexiones abiertas hacia el cliente (agent: false cierra cada socket
 *     al settle) — la diferencia con un pool keep-alive que acumula
 *     zombies.
 */
import { createServer, type Server } from "node:http";
import { Telegram, TelegramError } from "../src/telegram.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // El path real es /bot<token>/<method>: el token forma parte de la URL.
      const url = req.url ?? "";
      if (url.includes("/hang")) {
        // Socket abierto, sin respuesta: el caso que colgaba el puente.
        return;
      }
      if (url.includes("/slow")) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result: {} }));
        }, 30_000);
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { seen: body.slice(0, 40) } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

async function main(): Promise<void> {
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const tg = new Telegram({ token: "0:dummynotoken", baseUrl: base, pollTimeout: 1 });

  // 1. Roundtrip normal.
  const t0 = Date.now();
  const seen = await tg.call<{ seen: string }>("roundtrip", { marker: "x" }).catch((e: unknown) => `ERR ${String((e as Error).message)}`);
  check("roundtrip por HTTP local", typeof seen === "object" && seen?.seen === '{"marker":"x"}', `${Date.now() - t0}ms`);

  // 2. Endpoint colgado: debe caer por timeout en tiempo acotado.
  const t1 = Date.now();
  let timed = false;
  await tg.call("hang", {}).catch(() => (timed = true));
  const elapsed = Date.now() - t1;
  check("endpoint colgado cae por timeout (3 reintentos)", timed, `${elapsed}ms`);
  check("timeout acotado (< 80s)", elapsed < 80_000, "");

  // 3. stop() corta un request en vuelo sin esperar al timeout de 30s.
  const t2 = Date.now();
  let aborted = false;
  const slow = tg.call("slow", {}).catch((e: unknown) => {
    aborted = e instanceof TelegramError && /aborted/i.test(e.message);
    return e;
  });
  await tg.stop();
  await slow;
  check("stop() aborta el request en vuelo", aborted, `${Date.now() - t2}ms`);

  // 4. Sockets no retenidos: tras asentarse todo, el server no debe guardar
  // conexiones hacia el cliente.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const open = await new Promise<number>((resolve) => server.getConnections((_e, count) => resolve(count)));
  check("sin sockets retenidos contra el server", open === 0, `abiertas: ${open}`);

  server.close();
  console.log(`\n${failures === 0 ? "TRANSPORTCHECK OK" : `${failures} FALLOS`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
