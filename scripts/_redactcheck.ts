/**
 * Redacción de secretos en la salida (src/redact.ts).
 *
 * Cubre las dos capas y, sobre todo, los falsos positivos: una redacción
 * demasiado ansiosa rompe mensajes legítimos (diffs con hashes, textos que
 * hablan de "password"). También prueba el enganche real en el transporte:
 * el cuerpo que sale hacia el Bot API no puede llevar el token.
 *
 * IMPORTANTE: ningún literal con patrón de secreto se grava en este archivo.
 * Los valores de prueba se construyen en tiempo de ejecución para que el
 * escáner de secretos del repositorio no los confunda con credenciales reales.
 */
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Telegram } from "../src/telegram.js";
import { redactSecrets, setRedactionSecrets, containsSecret } from "../src/redact.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

// Construidos en tiempo de ejecución: ningún literal con patrón de secreto
// viaja en el fuente de este test.
const BOT_TOKEN = "123456789:" + "x".repeat(40); // token de Telegram (patrón, falso)
const SERVICE_PASSWORD = "s3rvice-p4ssword-opencode-tg-fake"; // password de servicio (falsa)

function bodyOf(): Promise<{ server: Server; port: number; seen: string[] }> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, seen });
    });
  });
}

async function main(): Promise<void> {
  // ── capa 1: valores conocidos ────────────────────────────────────────────
  setRedactionSecrets([BOT_TOKEN, SERVICE_PASSWORD]);
  check("token de Telegram conocido", !redactSecrets(`token: ${BOT_TOKEN}`).includes(BOT_TOKEN));
  check("password de servicio conocida", !redactSecrets(`pass=${SERVICE_PASSWORD}`).includes(SERVICE_PASSWORD));
  check(
    "forma URL-encoded del secreto",
    !redactSecrets(`x=${encodeURIComponent(SERVICE_PASSWORD)}`).includes(encodeURIComponent(SERVICE_PASSWORD)),
  );
  check("sigue leyéndose el contexto", redactSecrets(`token: ${BOT_TOKEN}`).startsWith("token: "));

  // ── capa 2: patrones de alta confianza (construidos en runtime) ──────────
  const ghClassic = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz";
  const ghFineGrained = "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
  const openai = "sk-proj-" + "0123456789abcdefghijklmnopqrstuvwxyz";
  const anthropic = "sk-ant-api03-" + "0123456789abcdefghijklmnop";
  const aws = "AKIA" + "IOSFODNN7EXAMPLE";
  const google = "AIza" + "SyA0123456789abcdefghijklmnopqrstuv";
  const slack = "xoxb-" + "123456789012-abcdefghijklmnop";
  const jwt =
    "eyJ" + "hbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const bearer = "Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz0123456789";
  const basic = "Authorization: Basic " + "b3BlbmNvZGU6czNydmljZS1wNHNzd29yZA==";

  const cases: Array<[string, string]> = [
    ["token de bot en una URL", "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage"],
    ["GitHub clásico", ghClassic],
    ["GitHub fine-grained", ghFineGrained],
    ["OpenAI", openai],
    ["Anthropic", anthropic],
    ["AWS", aws],
    ["Google", google],
    ["Slack", slack],
    ["JWT", jwt],
    ["Bearer", bearer],
    ["Basic", basic],
    ["JSON token", '{"token":"' + ghClassic + '","ok":true}'],
    ["JSON password", '{"password":"' + SERVICE_PASSWORD + '","user":"pablo"}'],
  ];
  for (const [name, secret] of cases) {
    const out = redactSecrets(secret);
    check(`patrón: ${name}`, out.includes("[redacted]") && !out.includes(secret), out.slice(0, 90));
  }
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  check("bloque PEM completo", redactSecrets(pem) === "[redacted private key]");

  // ── falsos positivos ─────────────────────────────────────────────────────
  const clean: string[] = [
    "El password del usuario se cambió ayer en la reunión.",
    "hash 9f358fb1c2bb387e (16 hex, no es token)",
    "uuid 123e4567-e89b-12d3-a456-426614174000",
    "ip 192.168.1.10 y puerto 28894",
    "sk- corto no es clave",
    "const password = process.env.PASSWORD;",
    "<code>src/redact.ts</code> redacta secretos",
    "El comando /reload recarga la config",
  ];
  for (const text of clean) check(`sin falso positivo: ${text.slice(0, 38)}`, !containsSecret(text));

  // ── idempotencia y HTML ──────────────────────────────────────────────────
  const once = redactSecrets("<b>token</b> " + BOT_TOKEN);
  check("idempotente", redactSecrets(once) === once);
  check("conserva el HTML", once.startsWith("<b>token</b> "));

  // ── enganche en el transporte ────────────────────────────────────────────
  const { server, port, seen } = await bodyOf();
  const tg = new Telegram({ token: "0:dummynotoken", baseUrl: `http://127.0.0.1:${port}`, pollTimeout: 1 });
  await tg.sendMessage(1, "mira: " + BOT_TOKEN);
  await tg.editMessageText(1, 1, "editado: " + BOT_TOKEN);
  await tg.sendDocument(1, fileURLToPath(new URL("../package.json", import.meta.url)), {
    caption: "archivo " + BOT_TOKEN,
  });
  check("sendMessage redacta en el cuerpo", seen[0] !== undefined && !seen[0].includes(BOT_TOKEN));
  check("editMessageText redacta en el cuerpo", seen[1] !== undefined && !seen[1].includes(BOT_TOKEN));
  check("caption de documento redacta", seen[2] !== undefined && !seen[2].includes(BOT_TOKEN));

  await tg.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log(failures === 0 ? "\nTODO OK" : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
