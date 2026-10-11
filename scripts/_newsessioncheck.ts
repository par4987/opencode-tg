/**
 * /new's title and project rules.
 *
 * What must hold: only a usable text can be a title or a folder name (a title
 * is one line; a project name is a NAME, never a path), and the picker draws
 * the current project first — that is the default the whole design promises.
 */
import { defaultProviderOf, normalizeProjectName, normalizeTitle, projectChoices } from "../src/new-session.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

function main(): void {
  // 1. Titles: one line, 1..60 chars. Anything else is refused — the picker
  //    names a topic with it and a multi-line title breaks that name.
  check("titulo simple", normalizeTitle("Análisis de ventas") === "Análisis de ventas");
  check("titulo recorta espacios", normalizeTitle("   tapete   ") === "tapete");
  check("titulo vacio rechazado", normalizeTitle("   ") === undefined);
  check("titulo muy largo rechazado", normalizeTitle("x".repeat(61)) === undefined);
  check("titulo de 60 aceptado", normalizeTitle("x".repeat(60)) === "x".repeat(60));
  const multiline = normalizeTitle("primera línea\nsegunda línea");
  check("titulo multilinea queda en la primera linea", multiline === "primera línea");
  check("titulo solo salto de linea rechazado", normalizeTitle("\n\n") === undefined);
  // The docs show the title quoted; a literal pair would ride into the topic name.
  check("titulo entre comillas se limpia", normalizeTitle('"Análisis de ventas"') === "Análisis de ventas");
  check("titulo entre comillas simples se limpia", normalizeTitle("'tapete'") === "tapete");
  check("comillas desparejas no se tocan", normalizeTitle('"medio final') === '"medio final');
  check("comillas solas rechazadas", normalizeTitle('""') === undefined);

  // 2. Project names: a NAME, never a path. It lands beside the current
  //    project, so anything that could escape that parent is refused.
  check("nombre simple", normalizeProjectName("prueba") === "prueba");
  check("nombre con espacios", normalizeProjectName("Mi Proyecto") === "Mi Proyecto");
  check("nombre vacio rechazado", normalizeProjectName("") === undefined);
  check("barra normal rechazada", normalizeProjectName("a/b") === undefined);
  check("barra invertida rechazada", normalizeProjectName("a\\b") === undefined);
  check("traversal .. rechazado", normalizeProjectName("..") === undefined);
  check("traversal punto-punto-barra rechazado", normalizeProjectName("../x") === undefined);
  check("unidad de windows rechazada", normalizeProjectName("C:x") === undefined);
  check("caracteres ilegales de windows rechazados", normalizeProjectName("a<b>c:d?e*f|g\"h") === undefined);
  check("control chars rechazados", normalizeProjectName("a\u0000b") === undefined);
  check("nombre muy largo rechazado", normalizeProjectName("y".repeat(61)) === undefined);
  check("nombre de 60 aceptado", normalizeProjectName("y".repeat(60)) === "y".repeat(60));
  check("nombre multilinea queda en la primera linea", normalizeProjectName("beta\ngamma") === "beta");

  // 3. The picker rows: the current project first (the default), the rest
  //    freshest first, the current one never repeated.
  const items = projectChoices("E:\\Projects\\Default Project", [
    { directory: "E:\\Projects\\opencode-tg", name: "opencode-tg", updated: 30 },
    { directory: "E:\\Projects\\alpha", name: "alpha", updated: 10 },
    { directory: "E:\\Projects\\beta", name: "beta", updated: 20 },
  ]);
  check("el proyecto actual va primero", items[0]?.directory === "E:\\Projects\\Default Project" && items[0]?.current === true);
  check("el actual se nombra con su carpeta", items[0]?.name === "Default Project");
  check("los demas van por mas reciente primero", items[1]?.name === "opencode-tg" && items[2]?.name === "beta" && items[3]?.name === "alpha");
  check("no repite el proyecto actual", items.filter((i) => i.name === "Default Project").length === 1);

  // 4. The dedupe is case-insensitive: on Windows the same folder arrives
  //    upper or lower cased from different sources.
  const itemsCi = projectChoices("E:\\Projects\\DEFAULT PROJECT", [
    { directory: "e:\\projects\\default project", name: "Default Project" },
    { directory: "E:\\Projects\\gamma", name: "gamma" },
  ]);
  check("dedupe case-insensitive del actual", itemsCi.length === 2 && itemsCi[0]?.current === true);
  check("el otro sobrevive al dedupe", itemsCi[1]?.name === "gamma");

  // 5. The limit caps the keyboard — a picker with 40 rows is not a picker.
  const many = projectChoices(
    "C:\\current",
    Array.from({ length: 30 }, (_, i) => ({ directory: `D:\\p${i}`, name: `p${i}`, updated: i })),
  );
  check("el picker se limita a 10 filas", many.length === 10, `${many.length} filas`);
  check("el limite cuenta el actual dentro", many[0]?.directory === "C:\\current" && many[0]?.current === true);
  check("un limite a medida se respeta", projectChoices("C:\\current", Array.from({ length: 5 }, (_, i) => ({ directory: `D:\\p${i}`, name: `p${i}`, updated: i })), 3).length === 3);
  check("el actual solo no duplica filas", projectChoices("C:\\current", [{ directory: "C:\\current", name: "current", updated: 1 }]).length === 1);

  // 6. A project the server listed but whose folder died still draws: the
  //    current one is always offered, so /new never answers with an empty
  //    picker.
  check("sin proyectos conocidos, el actual igual se ofrece", projectChoices("C:\\solo", [])[0]?.directory === "C:\\solo");

  // 7. The model picker opens on the project default's provider — but only
  //    while that provider still has visible models: a page that offers
  //    nothing but the back button is a dead end.
  const modelItems = [
    { providerID: "openrouter" },
    { providerID: "nvidia" },
    { providerID: "nvidia" },
  ];
  check("default con modelos visibles abre su proveedor", defaultProviderOf(modelItems, { id: "z-ai/glm-5.3", providerID: "nvidia" }) === "nvidia");
  check("default sin provider cae a la lista de proveedores", defaultProviderOf(modelItems, { id: "x" }) === undefined);
  check("default sin modelos visibles cae a la lista", defaultProviderOf(modelItems, { id: "y", providerID: "gateway" }) === undefined);
  check("default en null cae a la lista", defaultProviderOf(modelItems, undefined) === undefined);

  console.log(failures === 0 ? "new-session: OK" : `new-session: ${failures} FALLAS`);
  if (failures > 0) process.exitCode = 1;
}

main();
