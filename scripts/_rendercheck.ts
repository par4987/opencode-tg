/**
 * Tool-card renderer: a card has to carry enough for the reader to act on it.
 * The one that failed silently was `question` — it printed the header and cut
 * the question and every option, so a prompt that arrived on the phone could
 * not be answered from the phone.
 */
import { formatToolCard } from "../src/render.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

const card = formatToolCard({
  name: "question",
  input: {
    questions: [
      {
        header: "Comportamiento al enviar ocupado",
        question: "Cuando enviás un prompt desde Telegram y el agente de ESA sesión ya está trabajando, ¿qué querés que pase por defecto?",
        options: [
          { label: "Encolar y esperar (Recomendado)" },
          { label: "Interrumpir siempre" },
          { label: "Ambas: encola por defecto y /btw interrumpe" },
        ],
      },
    ],
  },
  status: "completed",
});

check("muestra el header", /Comportamiento al enviar ocupado/.test(card));
check(
  "muestra la pregunta completa, no solo el header",
  /enviás un prompt desde Telegram/.test(card) && /qué querés que pase/.test(card),
);
check("muestra todas las opciones, no ninguna truncada", /1\. Encolar y esperar/.test(card) && /2\. Interrumpir siempre/.test(card) && /3\. Ambas: encola por defecto/.test(card));
check("numera las opciones en orden", /1\..*\n2\..*\n3\./s.test(card));
check("mantiene los saltos de linea", card.includes("\n"));

// A question with options but no question text still names them; the header
// alone was the whole old card.
const onlyOpts = formatToolCard({
  name: "question",
  input: { questions: [{ header: "Modelo", options: [{ label: "A" }, { label: "B" }] }] },
  status: "completed",
});
check("sin texto, lista las opciones igual", /1\. A/.test(onlyOpts) && /2\. B/.test(onlyOpts));

// An empty payload degrades to an empty-ish line instead of throwing.
const empty = formatToolCard({ name: "question", input: {}, status: "completed" });
check("payload vacio no rompe", typeof empty === "string");

// A long multi-question payload is capped, not unbounded.
const long = formatToolCard({
  name: "question",
  input: { questions: [{ header: "h", question: "q".repeat(5000) }] },
  status: "completed",
});
check("recorta payloads enormes", long.length < 1200, `largo ${long.length}`);

if (failures === 0) console.log("TODO OK");
else {
  console.log(`FALLOS: ${failures}`);
  process.exitCode = 1;
}
