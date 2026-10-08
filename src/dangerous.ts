/**
 * Guard for shell commands that run inside the session.
 *
 * Measured incident (2026-10-07): `/sh opencode service restart` ran inside
 * the server, killed the process hosting the plugin, and because the poll
 * offset lived only in memory the update was re-delivered on every restart —
 * an infinite loop of ~10s until the plugin was disabled by hand. The offset
 * persistence is the cure; this is the prevention.
 *
 * Design (the four principles that make a blocklist actually protect):
 *
 *  1. Parse, don't regex. The command is split on `;` `|` `&&` newlines with
 *     quote awareness, the command name is taken from the first token, and
 *     aliases are resolved to the canonical cmdlet. `--format=` in a git
 *     command can never look like `Format-Volume` again.
 *  2. Invert where possible. A short read-only allowlist (Get-*, Test-*... plus
 *     the dev toolchain) passes straight through; everything unknown goes to
 *     confirmation, because a name we do not recognise is a name we cannot
 *     vouch for.
 *  3. Scope by path, not by blanket ban. A coding agent has to delete files:
 *     `Remove-Item` is fine inside the project folder and forbidden anywhere
 *     else. Destruction is only ever allowed where the damage is ours.
 *  4. Show what was parsed. The confirm card lists the commands with aliases
 *     resolved, so the person approves what is actually running.
 *
 * Tiers, because the damage is not symmetric:
 *  - "forbidden" never runs, not even after a tap: no recovery from a
 *    formatted disk, a wiped shadow copy or an exfiltrated key file.
 *  - "confirm" waits for an explicit tap: recoverable, sometimes necessary.
 */
export type DangerLevel = "ok" | "confirm" | "forbidden";

export interface ParsedCommand {
  /** The segment as written. */
  raw: string;
  /** Command name as typed. */
  asWritten?: string;
  /** Canonical name after alias resolution. */
  resolved?: string;
  /** Arguments after the name (for path scoping and the approval card). */
  args: string[];
  /** True when the name is not a literal (a variable or a bracketed type). */
  dynamic?: boolean;
}

export interface DangerMatch {
  level: DangerLevel;
  /** What is at stake, in plain words, for the card. */
  reason: string;
  /** Every command the line would run, parsed and alias-resolved. */
  commands: ParsedCommand[];
}

// ── aliases → canonical cmdlet ──────────────────────────────────────────────
/** PowerShell's built-in aliases plus the short forms that actually get used. */
const ALIASES: Record<string, string> = {
  rm: "remove-item", del: "remove-item", erase: "remove-item", rd: "remove-item",
  rmdir: "remove-item", ri: "remove-item", rni: "rename-item", ren: "rename-item",
  kill: "stop-process", spps: "stop-process", gps: "get-process",
  iex: "invoke-expression", icm: "invoke-command", ii: "invoke-item",
  iwr: "invoke-webrequest", irm: "invoke-restmethod",
  saps: "start-process", start: "start-process", spps2: "stop-process",
  sc: "set-service", gsv: "get-service", spsv: "stop-service",
  ls: "get-childitem", dir: "get-childitem", cat: "get-content", type: "get-content",
  gc: "get-content", pwd: "get-location", cd: "set-location", chdir: "set-location",
  sl: "set-location", pushd: "push-location", popd: "pop-location",
  ps: "get-process", tasklist: "get-process", curl: "invoke-webrequest",
  wget: "invoke-webrequest", ftp: "ftp", echo: "write-output",
  clc: "clear-content", cli: "clear-item", clhy: "clear-history",
  csn: "new-pssession", etsn: "enter-pssession",
};

// ── the blocklist, by category ──────────────────────────────────────────────
/** Never runs, confirmation or not. Each entry: [names, reason]. */
const FORBIDDEN: Array<[string[], string]> = [
  // Deletion and destruction of data.
  [["remove-item", "clear-content", "clear-item", "clear-recyclebin",
    "format-volume", "clear-disk", "initialize-disk", "remove-partition",
    "set-partition", "resize-partition", "format", "diskpart", "cipher",
    "fsutil", "sdelete", "mkfs", "dd", "shred", "wipefs"],
   "borra o destruye datos sin recuperación"],
  // Boot, backups and recovery — the machine may not come back.
  [["bcdedit", "bcdboot", "bootsect", "reagentc", "vssadmin", "wbadmin",
    "disable-computerrestore"],
   "toca el arranque, los respaldos o la recuperación del sistema"],
  // Machine state and installed software.
  [["stop-computer", "restart-computer", "shutdown", "logoff", "reboot",
    "halt", "poweroff", "remove-computer", "add-computer", "rename-computer",
    "reset-computermachinepassword", "disable-windowsoptionalfeature",
    "remove-windowscapability", "remove-appxpackage", "dism"],
   "apaga, reinicia o reconfigura la máquina"],
  // The registry.
  [["reg", "regedit", "regini"],
   "edita el registro del sistema"],
  // Users, permissions and credentials.
  [["new-localuser", "remove-localuser", "set-localuser",
    "add-localgroupmember", "remove-localgroupmember", "set-acl", "icacls",
    "takeown", "cmdkey", "vaultcmd", "ntdsutil", "convertfrom-securestring",
    "set-ad", "new-ad", "remove-ad", "add-ad"],
   "crea o destruye usuarios, permisos o credenciales"],
  // Defenses: antivirus, firewall, execution policy, BitLocker.
  [["set-mppreference", "add-mppreference", "set-executionpolicy",
    "set-netfirewallprofile", "new-netfirewallrule", "remove-netfirewallrule",
    "disable-netfirewallrule", "netsh", "auditpol", "disable-bitlocker",
    "enable-bitlocker", "manage-bde"],
   "desactiva las defensas del sistema (antivirus, firewall, BitLocker)"],
  // Trace clearing — the footprint of something that already happened.
  [["clear-eventlog", "remove-eventlog", "limit-eventlog", "wevtutil",
    "clear-history", "set-psreadlineoption"],
   "borra rastros o registros del sistema"],
  // Evasion vectors — always blocked, per the incident post-mortem.
  // Indirect or hidden execution is how a payload slips past every other rule.
  [["invoke-expression", "invoke-command", "invoke-item",
    "powershell", "pwsh", "cmd", "wscript", "cscript", "mshta", "rundll32",
    "regsvr32", "msbuild", "installutil", "wsl", "bash", "forfiles",
    "add-type", "start-process", "start-job", "start-threadjob",
    "set-alias", "new-alias"],
   "es un vector de evasión: ejecución indirecta, oculta o de otro intérprete"],
];

/** Recoverable but able to interrupt the service or reach outside the box. */
const CONFIRM: Array<[string[], string]> = [
  // The OpenCode service itself — the incident command. Restarting or
  // stopping it kills the process this plugin lives in.
  [["opencode"],
   "afecta al servicio de OpenCode (puede cortar este bot y todas las sesiones)"],
  // Processes and services the bridge depends on.
  [["stop-process", "taskkill", "pkill", "debug-process", "stop-service",
    "set-service", "new-service", "remove-service", "suspend-service"],
   "mata procesos o servicios (puede cortar el servicio y este bot)"],
  // Software installation.
  [["install-module", "install-package", "install-script", "save-module",
    "winget", "choco", "scoop", "msiexec", "add-appxpackage", "uninstall-package"],
   "instala o desinstala software"],
  // Network, download and exfiltration.
  [["invoke-webrequest", "invoke-restmethod", "start-bitstransfer",
    "bitsadmin", "certutil", "curl.exe", "ftp", "tftp", "scp", "sftp", "ssh",
    "send-mailmessage", "net", "new-smbshare", "grant-smbshareaccess",
    "enable-psremoting", "winrm", "set-netipaddress", "disable-netadapter",
    "set-dnsclientserveraddress", "route"],
   "sale a la red o transfiere datos hacia afuera"],
  // Remote execution.
  [["enter-pssession", "new-pssession", "invoke-wmimethod",
    "invoke-cimmethod", "wmic", "psexec", "winrs"],
   "ejecuta comandos en otra máquina"],
  // Persistence.
  [["register-scheduledtask", "set-scheduledtask", "unregister-scheduledtask",
    "register-scheduledjob", "schtasks", "at", "register-wmievent",
    "set-wmiinstance", "new-ciminstance"],
   "crea tareas o persistencia que sobrevive al reinicio"],
  // Runtime name resolution — the prelude to calling something by another name.
  [["get-command", "get-alias"],
   "resuelve nombres de comandos en tiempo de ejecución"],
];

/** Prefixes of the read-only surface: answers without side effects. */
const READONLY_PREFIXES = [
  "get-", "test-", "measure-", "select-", "where-", "sort-", "group-",
  "compare-", "format-", "convertto-", "out-", "write-", "tee-", "show-",
  "read-", "find-", "watch-", "resolve-", "trace-", "assert-",
];

/** The local dev toolchain — the reason this bot exists. */
const DEV_TOOLS = new Set([
  "git", "node", "npm", "npx", "pnpm", "yarn", "tsc", "tsx", "esbuild",
  "vite", "webpack", "rollup", "python", "py", "python3", "pip", "pip3",
  "uv", "poetry", "cargo", "rustc", "go", "make", "cmake", "gcc", "g++",
  "clang", "java", "javac", "mvn", "gradle", "dotnet", "docker",
  "ls", "dir", "cat", "type", "pwd", "cd", "set-location", "push-location",
  "pop-location", "echo", "printf", "head", "tail", "more", "less", "tree",
  "findstr", "grep", "jq", "wc", "sort", "uniq", "diff", "stat", "file",
  "du", "df", "free", "ps", "whoami", "hostname", "ipconfig", "ping",
  "tracert", "tasklist", "exit", "clear", "cls", "help", "man",
]);

/** Read-only commands that are nonetheless on the confirm list by name. */
function inList(list: Array<[string[], string]>, name: string): string | undefined {  for (const [names, reason] of list) {
    if (names.includes(name)) return reason;
  }
  return undefined;
}

// ── secret paths — never readable, whatever the command ─────────────────────
/**
 * The bot token and the API keys live here. The lookbehind keeps a single
 * `$env:PATH` read legal while the `Env:` drive — which dumps every secret at
 * once — stays blocked.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(?<![\w$])env:/i, "lista variables de entorno (incluye claves y tokens)"],
  [/(?:^|[\\/.])\.ssh(?:[\\/]|$)/i, "lee claves SSH privadas"],
  [/\bid_(?:rsa|ed25519|ecdsa)(?:\.pub)?\b/i, "lee una clave privada SSH"],
  [/(?:^|[\\/\s])\.env(?:[\\/]|$|\.\w)/i, "lee un archivo de entorno con claves"],
  [/\bcredentials\b|\bkey4\.db\b|\blogin data\b|\bplaces\.sqlite\b/i,
   "lee credenciales o perfiles de navegadores"],
  [/[\\/](?:mozilla|google[\\/]chrome|microsoft[\\/]edge)[\\/]/i,
   "entra a perfiles de navegadores (cookies, sesiones, contraseñas)"],
];

/** Registry hives — the paths, not just the tools. Unanchored on purpose: it
 * has to catch `-Path HKLM:\...` wherever the argument sits. */
const REGISTRY_PATH = /(?:registry::|hklm:|hkcu:|hkcr:|hku:|hkcc:)/i;

/** Flags that hide or encode what a command really does. */
const FORBIDDEN_FLAGS: Array<[RegExp, string]> = [
  [/-encodedcommand\b|(?<=\s)-enc\b/i, "usa un comando codificado en base64 (evasión)"],
  [/-executionpolicy\s+(?:bypass|unrestricted|remotesigned)/i,
   "pide bypass de la política de ejecución"],
  [/-windowstyle\s+hidden/i, "se ejecuta en una ventana oculta"],
  [/-comobject\b/i, "instancia un objeto COM (ejecución indirecta)"],
  [/\s\/mir\b/i, "robocopy /MIR: refleja y borra el destino"],
];

/** Flags that change the reach of a command rather than hiding it. */
const CONFIRM_FLAGS: Array<[RegExp, string]> = [
  [/-computername\b/i, "se ejecuta contra otra máquina"],
];

/** Bracketed types that touch the filesystem, the process list, the network or
 *  reflection — the .NET escape hatch out of every cmdlet rule above. A cast
 *  (`[int]"5"`) is harmless; these never are. */
const DANGEROUS_TYPES = [
  "system.io", "system.diagnostics", "system.net", "system.reflection",
  "system.management.automation", "microsoft.win32", "system.security",
  "scriptblock", "system.activator", "system.runtime.interopservices",
];

// ── the parser ──────────────────────────────────────────────────────────────
/**
 * Split a line into the commands it would run. PowerShell separates with
 * `;`, `|`, `&&` and newlines; quoting must be respected or a `"; shutdown"`
 * inside a string looks like two commands.
 */
function splitSegments(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (ch === ";" || ch === "|" || ch === "\n" || pair === "&&" || pair === "||") {
      out.push(current);
      current = "";
      if (pair === "&&" || pair === "||") i += 1;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Take the last path component and drop the extension: `C:\x\y.exe` -> `y`.
 *  Also strips odd extensions like `mkfs.ext4` — a command name never has a
 *  dotted tail, so whatever follows the last dot is not part of the name. */
function baseName(name: string): string {
  const stripped = name.replace(/\\/g, "/");
  const slash = stripped.lastIndexOf("/");
  const file = slash >= 0 ? stripped.slice(slash + 1) : stripped;
  return file.replace(/\.[a-z0-9]{1,5}$/i, "").toLowerCase();
}

/** Read one command token (bare word or quoted string) from the start. */
function readToken(text: string): { value: string; quoted: boolean; rest: string } {
  const first = text[0];
  if (first === '"' || first === "'") {
    const end = text.indexOf(first, 1);
    if (end === -1) return { value: text.slice(1), quoted: true, rest: "" };
    return { value: text.slice(1, end), quoted: true, rest: text.slice(end + 1).trim() };
  }
  const match = text.match(/^[\w.:/\\\-]+/);
  if (!match) return { value: "", quoted: false, rest: text };
  return { value: match[0], quoted: false, rest: text.slice(match[0].length).trim() };
}

function parseSegment(raw: string): ParsedCommand {
  let rest = raw.replace(/^[\s(]+/, "");
  const cmd: ParsedCommand = { raw, args: [] };
  // A leading `&` or `.` is the call operator: the "command" is whatever the
  // next token evaluates to.
  const callOp = rest.match(/^[&.]\s*/);
  if (callOp) rest = rest.slice(callOp[0].length).trim();

  if (rest.startsWith("[")) {
    // Bracketed type access — .NET, COM or a type literal. Never a cmdlet.
    const close = rest.indexOf("]");
    cmd.resolved = close === -1 ? rest : rest.slice(1, close);
    cmd.asWritten = "[" + cmd.resolved + "]";
    cmd.dynamic = true;
    cmd.args = rest.slice(close + 1).split(/\s+/).filter(Boolean);
    return cmd;
  }
  if (rest.startsWith("$")) {
    // A variable as the command: unresolvable without running it.
    cmd.asWritten = rest.split(/\s+/)[0];
    cmd.dynamic = true;
    cmd.args = rest.split(/\s+/).slice(1).filter(Boolean);
    return cmd;
  }
  if (/^function\s+/i.test(rest)) {
    cmd.asWritten = "function";
    cmd.resolved = "function";
    cmd.args = rest.split(/\s+/).slice(1).filter(Boolean);
    return cmd;
  }
  const token = readToken(rest);
  cmd.asWritten = token.value;
  // A quoted command name is a literal string invoked dynamically — resolve
  // it (we can read it), but flag it so the card says how it was called.
  cmd.dynamic = callOp !== null && token.quoted;
  const canonical = (ALIASES[token.value.toLowerCase()] ?? token.value.toLowerCase());
  cmd.resolved = baseName(canonical);
  cmd.args = token.rest.length > 0 ? token.rest.split(/\s+/).filter(Boolean) : [];
  return cmd;
}

/** First argument that is not a flag — the path a destructive command hits.
 * A flag is `-x`, `--x` or `/x` (Windows style), but not a path like
 * `/tmp/x` — the trailing slash is what separates them. */
function firstPathArg(args: string[]): string | undefined {
  for (const a of args) {
    if (/^[-/][\w.]*$/.test(a)) continue;
    return a.replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

/** True when a path stays inside the project folder. */
function insideProject(path: string, projectDir: string): boolean {
  if (!path) return false;
  if (path.includes("..")) return false;
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("/") || path.startsWith("\\")) {
    const p = path.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const base = projectDir.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return p === base || p.startsWith(base + "/");
  }
  // Relative: resolved against the session's working directory.
  return true;
}

// ── the classifier ──────────────────────────────────────────────────────────
/**
 * Classify a command line. `projectDir` is the session's directory — the one
 * place destructive commands may operate.
 */
export function dangerousCommand(text: string, projectDir = ""): DangerMatch {
  const commands = splitSegments(text).map(parseSegment);
  if (commands.length === 0) return { level: "ok", reason: "", commands };

  // 1. Secret paths are unreadable by any command, read-only or not.
  for (const [pattern, reason] of SECRET_PATTERNS) {
    if (pattern.test(text)) return { level: "forbidden", reason, commands };
  }
  // 2. Flags that hide or redirect what runs.
  for (const [pattern, reason] of FORBIDDEN_FLAGS) {
    if (pattern.test(text)) return { level: "forbidden", reason, commands };
  }
  for (const [pattern, reason] of CONFIRM_FLAGS) {
    if (pattern.test(text)) return { level: "confirm", reason, commands };
  }

  for (const cmd of commands) {
    // 3. Anything but a literal name needs a human: we cannot know what it
    //    would run, so it never runs unsupervised. A bracketed type is the
    //    .NET/COM surface — a static call or a filesystem type is evasion,
    //    while `[int]"5"` is just a cast and passes.
    if (cmd.dynamic) {
      if (cmd.asWritten?.startsWith("[")) {
        const body = (cmd.resolved ?? "").toLowerCase();
        const callsStatic = cmd.args.some((a) => a.startsWith("::"));
        if (callsStatic || DANGEROUS_TYPES.some((prefix) => body.startsWith(prefix))) {
          return {
            level: "forbidden",
            reason: "accede a .NET o COM directamente (evasión)",
            commands,
          };
        }
        continue;
      }
      return {
        level: "confirm",
        reason: "el comando no es un nombre literal (una variable o un tipo .NET) — no sé qué ejecutaría",
        commands,
      };
    }
    const name = cmd.resolved ?? "";
    if (!name) continue;

    // 4. A function definition hides whatever it will later be asked to do.
    if (name === "function") {
      return { level: "forbidden", reason: "define una función (evasión: esconde lo que ejecuta)", commands };
    }
    // 5. Registry paths — anywhere in the arguments.
    if (cmd.args.some((a) => REGISTRY_PATH.test(a)) || REGISTRY_PATH.test(cmd.raw)) {
      return { level: "forbidden", reason: "opera sobre el registro del sistema", commands };
    }
    // 6. `net` is only dangerous with its user/group subcommands.
    if (name === "net") {
      const sub = (cmd.args[0] ?? "").toLowerCase();
      if (sub === "user" || sub === "localgroup" || sub === "accounts") {
        return { level: "forbidden", reason: "crea o destruye usuarios o grupos locales", commands };
      }
      if (sub === "use" || sub === "share" || sub === "start") {
        return { level: "confirm", reason: "sale a la red o monta recursos compartidos", commands };
      }
    }

    // 7. Destruction is only allowed inside the project folder — but the
    //    folder itself and its history are not ours to throw away.
    if (name === "remove-item") {
      const target = firstPathArg(cmd.args);
      if (target === undefined) {
        return { level: "confirm", reason: "borra archivos sin decir cuál", commands };
      }
      if (target === "." || /^\.git\b/i.test(target)) {
        return {
          level: "confirm",
          reason:
            target === "."
              ? "borra la carpeta completa del proyecto (incluye .git)"
              : "borra el historial de git del proyecto",
          commands,
        };
      }
      if (!insideProject(target, projectDir)) {
        return {
          level: "forbidden",
          reason: `borra fuera de la carpeta del proyecto: ${target}`,
          commands,
        };
      }
      continue; // In scope: it is ours to delete.
    }

    // 8. The explicit blocklists win over every allowlist below.
    const forbiddenReason = inList(FORBIDDEN, name);
    if (forbiddenReason) return { level: "forbidden", reason: forbiddenReason, commands };
    const confirmReason = inList(CONFIRM, name);
    if (confirmReason) return { level: "confirm", reason: confirmReason, commands };

    // 9. The read-only allowlist and the toolchain pass through.
    if (READONLY_PREFIXES.some((p) => name.startsWith(p)) || DEV_TOOLS.has(name)) {
      continue;
    }
    // 10. Everything else is unknown — confirm rather than guess.
    return {
      level: "confirm",
      reason: `no reconozco el comando \`${cmd.asWritten ?? name}\` — lo reviso antes de ejecutar`,
      commands,
    };
  }

  return { level: "ok", reason: "", commands };
}

// ── the explainer — what the command actually does, in plain words ──────────
/**
 * Every command that reaches a card gets a line of its own: the command as it
 * will run (aliases resolved) and, underneath, what it does. The blocklist says
 * *whether* it may run; this says *why* the person is being asked.
 */
const EXPLAINS: Record<string, string> = {
  // The OpenCode service.
  "opencode": "Administra el servicio de OpenCode. Si lo reinicia o lo detiene, este bot y todas las sesiones activas se caen hasta que el servicio vuelva a levantar.",
  // Processes and services.
  "stop-process": "Cierra uno o más procesos por la fuerza. Si el proceso es el servicio de OpenCode o el bot, la comunicación se corta.",
  "taskkill": "Mata procesos desde la línea de comandos. Puede terminar el servicio de OpenCode o el bot.",
  "debug-process": "Adjunta un depurador a un proceso en ejecución.",
  "stop-service": "Detiene un servicio de Windows. Si es el servicio de OpenCode, el bot se cae.",
  "set-service": "Cambia el arranque o el estado de un servicio de Windows.",
  "new-service": "Registra un servicio nuevo en Windows.",
  "remove-service": "Elimina un servicio registrado de Windows.",
  "suspend-service": "Pausa un servicio en ejecución.",
  // Software.
  "install-module": "Descarga e instala un módulo de PowerShell desde internet.",
  "install-package": "Instala un paquete de software desde internet.",
  "install-script": "Descarga e instala un script de PowerShell desde internet.",
  "save-module": "Descarga un módulo de PowerShell al disco (sin instalarlo).",
  "winget": "Instala o desinstala programas del catálogo de Windows Package Manager.",
  "choco": "Instala o desinstala paquetes con Chocolatey.",
  "scoop": "Instala o desinstala paquetes con Scoop.",
  "msiexec": "Ejecuta un instalador MSI de Windows.",
  "add-appxpackage": "Instala una aplicación empaquetada de Windows.",
  "uninstall-package": "Desinstala un paquete de software del sistema.",
  // Network.
  "invoke-webrequest": "Hace una petición HTTP a una URL: descarga o envía datos a internet.",
  "invoke-restmethod": "Llama a una API remota y recibe su respuesta.",
  "start-bitstransfer": "Transfiere archivos en segundo plano con el servicio BITS.",
  "bitsadmin": "Administra transferencias BITS de archivos hacia o desde internet.",
  "certutil": "Herramienta de certificados de Windows: también puede descargar y decodificar archivos.",
  "curl.exe": "Descarga o sube datos por HTTP/FTP a una URL.",
  "ftp": "Transfiere archivos por FTP a un servidor remoto.",
  "tftp": "Transfiere archivos por TFTP a un servidor remoto.",
  "scp": "Copia archivos hacia o desde otra máquina por SSH.",
  "sftp": "Transfiere archivos hacia o desde otra máquina por SSH.",
  "ssh": "Abre una sesión en otra máquina por SSH.",
  "send-mailmessage": "Envía un correo electrónico con los datos que se le pasen.",
  "net": "Comando de red de Windows (con subcomandos: usuarios, recursos compartidos, conexiones).",
  "new-smbshare": "Comparte una carpeta de esta máquina en la red.",
  "grant-smbshareaccess": "Da permiso a alguien sobre un recurso compartido.",
  "enable-psremoting": "Activa PowerShell Remoting: permite ejecutar comandos en esta máquina desde afuera.",
  "winrm": "Administra Windows Remote Management (acceso remoto a la máquina).",
  "set-netipaddress": "Cambia la configuración IP de un adaptador de red.",
  "disable-netadapter": "Desactiva un adaptador de red (corta la conexión).",
  "set-dnsclientserveraddress": "Cambia los servidores DNS de la máquina.",
  "route": "Modifica la tabla de rutas de red de la máquina.",
  // Remote execution.
  "enter-pssession": "Abre una sesión interactiva en otra máquina.",
  "new-pssession": "Establece una conexión persistente con otra máquina.",
  "invoke-wmimethod": "Llama a un método WMI en esta o en otra máquina.",
  "invoke-cimmethod": "Llama a un método CIM en esta o en otra máquina.",
  "wmic": "Ejecuta consultas o comandos WMI (incluido el apagado remoto).",
  "psexec": "Ejecuta procesos en otra máquina de la red.",
  "winrs": "Ejecuta un comando en otra máquina con WinRM.",
  // Persistence.
  "register-scheduledtask": "Crea una tarea programada que se ejecutará sola, ahora o más tarde.",
  "set-scheduledtask": "Modifica una tarea programada existente.",
  "unregister-scheduledtask": "Elimina una tarea programada.",
  "register-scheduledjob": "Crea un trabajo programado de PowerShell que se repite solo.",
  "schtasks": "Crea, modifica o elimina tareas programadas de Windows.",
  "at": "Programa la ejecución de un comando a una hora (mecanismo viejo de tareas).",
  "register-wmievent": "Registra un evento WMI que dispara código automáticamente.",
  "set-wmiinstance": "Modifica una instancia WMI del sistema.",
  "new-ciminstance": "Crea una instancia CIM nueva en el sistema.",
  // Name resolution.
  "get-command": "Lista o resuelve comandos: sirve para descubrir qué hay disponible antes de invocarlo de otra forma.",
  "get-alias": "Lista los alias definidos: sirve para resolver nombres en tiempo de ejecución.",
};

/**
 * Plain-language description of one parsed command, for the approval card.
 * Falls back to the raw command when nothing specific is known — never to
 * silence, and never to a guess.
 */
export function explainCommand(cmd: ParsedCommand): string {
  const name = cmd.resolved ?? cmd.asWritten ?? "";
  const known = EXPLAINS[name];
  if (known) return known;
  if (cmd.dynamic) {
    return `El nombre del comando no es un literal (es una variable o un tipo .NET), así que no se puede saber qué va a ejecutar hasta que corra. Hay que revisarlo a mano.`;
  }
  if (!name) return cmd.raw;
  return `Comando \`${cmd.asWritten ?? name}\`${cmd.args.length ? ` con argumentos ${cmd.args.join(" ")}` : ""}: no tengo una descripción específica, revisá qué hace antes de aprobarlo.`;
}

/** True only when the command may run after an explicit confirmation. */
export function needsConfirm(text: string, projectDir = ""): boolean {
  return dangerousCommand(text, projectDir).level === "confirm";
}

/** True when the command must never run, confirmation or not. */
export function isForbidden(text: string, projectDir = ""): boolean {
  return dangerousCommand(text, projectDir).level === "forbidden";
}
