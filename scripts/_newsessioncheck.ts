/**
 * /new's title and project rules.
 *
 * What must hold: only a usable text can be a title or a folder name (a title
 * is one line; a project name is a NAME, never a path), and the picker draws
 * the current project first — that is the default the whole design promises.
 */
import {
  archivedCandidates,
  defaultProviderOf,
  normalizeProjectName,
  normalizeTitle,
  projectChoices,
  resolveSessionPrefix,
  safeSlice,
} from "../src/new-session.js";

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

  // 8. An id argument resolves exactly, by UNIQUE prefix, or not at all —
  //    ambiguity is the caller's business: /unarchive falls back to the
  //    search picker rather than guessing which session you meant.
  const ids = ["ses_aaa11111111111111111111", "ses_bbb22222222222222222222", "ses_bbb33333333333333333333"];
  check("id exacto resuelve", resolveSessionPrefix(ids, ids[1] as string) === ids[1]);
  check("prefijo unico resuelve", resolveSessionPrefix(ids, "ses_aaa") === ids[0]);
  check("prefijo ambiguo no resuelve", resolveSessionPrefix(ids, "ses_bbb") === undefined);
  check("prefijo inexistente no resuelve", resolveSessionPrefix(ids, "ses_zzz") === undefined);
  check("argumento vacio no resuelve", resolveSessionPrefix(ids, "") === undefined);
  check("la resolucion es case insensible", resolveSessionPrefix(ids, "SES_AAA") === ids[0]);

  // 9. The /unarchive recovery picker: archived sessions freshest first,
  //    subagent threads out (you resume a conversation, not a child task),
  //    and an id archived before this process started still draws from what
  //    the server knows about it. A query narrows by title, project or id.
  const tracked = [
    { id: "ses_aaa11111111111111111111", title: "Bug del login", directory: "C:\\repo\\web", lastSeen: 1000 },
    { id: "ses_bbb22222222222222222222", title: "Deploy", directory: "C:\\repo\\api", lastSeen: 3000, parentID: "ses_parent" },
    { id: "ses_ccc33333333333333333333", title: "No archivada", directory: "C:\\repo\\web", lastSeen: 2000 },
  ];
  const archivedIds = [
    "ses_aaa11111111111111111111",
    "ses_bbb22222222222222222222",
    "ses_ddd44444444444444444444",
    "ses_eee55555555555555555555",
  ];
  // Lo que el server sabe de las que el plugin no tiene en memoria — incluso
  // una archivada antes de arrancar, cuyo timestamp la puede poner primera.
  const known = (id: string): { title?: string; directory?: string; updated?: number } | undefined => {
    if (id === "ses_ddd44444444444444444444") return { title: "Vieja", directory: "C:\\repo\\legacy", updated: 500 };
    if (id === "ses_eee55555555555555555555") return { title: "Facturas Q3", directory: "C:\\repo\\contable", updated: 9000 };
    return undefined;
  };
  const rowsOf = (query: string) => archivedCandidates(tracked, archivedIds, known, query);
  check(
    "frescas primero, subagentes y vivas fuera",
    rowsOf("").map((r) => r.id).join(",") ===
      ["ses_eee55555555555555555555", "ses_aaa11111111111111111111", "ses_ddd44444444444444444444"].join(","),
  );
  check("el proyecto viene del basename", rowsOf("")[1]?.project === "web");
  check("busqueda por titulo", rowsOf("facturas").map((r) => r.id).join() === "ses_eee55555555555555555555");
  check("busqueda por proyecto", rowsOf("legacy").map((r) => r.id).join() === "ses_ddd44444444444444444444");
  check("busqueda por prefijo de id", rowsOf("ses_ddd").map((r) => r.id).join() === "ses_ddd44444444444444444444");
  check("busqueda que no acierta", rowsOf("inexistente").length === 0);
  check("la sin titulo usa no_title", archivedCandidates([{ id: "ses_zzz", title: "", directory: "C:\\p", lastSeen: 1 }], ["ses_zzz"], () => undefined, "")[0]?.title === "");

  // 10. A button label never splits a surrogate pair — a title with an emoji
  //     would otherwise render a replacement character at the seam.
  check("corta lo que sobra", safeSlice("hola mundo", 4) === "hola");
  check("no corta lo que no necesita", safeSlice("hola", 10) === "hola");
  check("no parte un par suplente al final", safeSlice("a\ud83d\ude00", 2) === "a");
  check("no parte un par suplente al medio", safeSlice("\ud83d\ude00x", 1) === "");

  console.log(failures === 0 ? "new-session: OK" : `new-session: ${failures} FALLAS`);
  if (failures > 0) process.exitCode = 1;
}

main();
