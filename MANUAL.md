# Manual del usuario — Bot de Telegram para OpenCode

> **Español** | Read this in [English](MANUAL.en.md)

Tu asistente de código, en el teléfono. El bot espeja tus sesiones de
OpenCode en un foro de Telegram: **cada sesión tiene su propio hilo**, lo
que escribís en el hilo le llega al agente, y lo que el agente responde o
produce vuelve al hilo.

---

## Lo básico

| Querés… | Hacé esto |
| --- | --- |
| Hablar con una sesión | Escribí en el hilo de esa sesión. Cada texto es un prompt. |
| Empezar de cero | `/new` crea una sesión nueva (con hilo propio). |
| Ver qué hay | `/sessions` lista todas las sesiones con su estado. |
| Cambiar de contexto | `/use <id>` fija la sesión con la que hablás desde el hilo General. |

Mientras el agente trabaja, el hilo muestra *"escribiendo…"* — es la señal
de vida del bot. No hace falta esperar para escribir: **lo que mandás
mientras trabaja se agrupa por ráfaga** (los seguimientos rápidos van
juntos) y entra a la cola del servidor en segundos — la ves con `/queue`
y podés adelantarla al turno en curso con ▶.

---

## Mensajes: qué le llega al agente

| Mandás | Le llega al agente como |
| --- | --- |
| Texto en el hilo | Prompt directo |
| Reply a un mensaje anterior | Prompt con la cita: el mensaje citado viaja arriba, entre `<<<…>>>` |
| Varias líneas seguidas | Se unifican: ventana de 2 seg (agente libre) o 8 seg (agente trabajando) |
| Foto (con o sin caption) | Imagen visible para el agente (caption = texto del prompt) |
| Documento de texto (.md, .txt, código) | Contenido inline en el prompt (hasta 100.000 caracteres) |
| Binario o video | Se guarda en disco y le llega la ruta |
| Nota de voz | **Transcripción con tu proveedor** (whisper.cpp local o cloud): el texto entra como prompt; una pregunta abierta la responde |

**Tip**: respondé con reply al mensaje que querés comentar — el agente ve
exactamente a qué te referís, sin que tengas que repetir contexto.

---

## Archivos que el agente te manda al hilo

Cuando el agente genera archivos durante un turno, el bot te los envía solo:

| Tipo de archivo | Cómo llega |
| --- | --- |
| Imágenes (.png, .jpg, .webp) | **Foto** en el hilo — se ve directo |
| Textos chicos (.md, .txt hasta 12 KB) | **Mensaje legible** en el chat, con título y contenido |
| El resto (.md grande, .pdf, .zip, .csv, .xlsx…) | **Documento** descargable |

La entrega llega ~30 segundos después de que el agente crea el archivo — no
espera a que termine el turno.

---

## Subagentes

Cuando el agente delega en un subagente (la tool `task`), su hilo aparece en
el foro con la marca **🤖** y el nombre de la tarea. Son **solo lectura**:
su trabajo lo maneja la sesión padre — si les escribís, el bot te avisa y no
se envía (igual que el desktop). Al terminar, el hilo **se archiva solo**.
`/sessions` los marca como "🤖 sub". En `config.json`, `"subagents": "off"`
los oculta por completo.

## Preguntas y permisos: respondé desde el teléfono

- **Preguntas de una sola opción**: **botones inline** en el hilo. Tocás la opción
  y el turno sigue. Las de texto libre van con su número, o `/txt <tu respuesta>`.
- Si una pregunta o permiso llega mientras estás viendo otro hilo, **el General
  recibe un aviso corto** apuntando a él.
- **Permisos**: si el agente necesita aprobación para algo, llega un mensaje
  con **[✅ Aprobar] [✖ Rechazar]**. Tocás y el turno continúa sin abrir la PC.

## Cuando el modelo no responde

La falla más silenciosa de todas: el proveedor muere **antes** de que el turno
arranque — créditos agotados, rate limit, un modelo que dejó de existir. El
server cancela el drenaje del inbox, lo anota como error interno **y no emite
ningún evento**: el hilo se queda con la confirmación de tu mensaje y nada más.
Dos mecanismos evitan que tengas que abrir la PC a ver qué pasó:

- **Watchdog de prompts muertos** (cada 30s): si un mensaje entregado no arrancó
  su turno en `deadPromptMs` (90s por defecto; `0` lo apaga), el bot lee la cola
  del log del server, clasifica la falla y avisa **con las palabras del
  proveedor**:

  > ❌ **Mi proyecto** — tu mensaje no llegó a ejecutarse: créditos/cupo agotados del proveedor
  > `AI.Error: Your monthly allowance is used up. Buy a usage top-up…`
  > 💳 Recargá el crédito o cambiá de proveedor: `/models`.

  Si no encuentra la causa, igual avisa: "lleva 2 min sin respuesta: el turno
  nunca arrancó".
- **Fallas a mitad del turno**: si el proveedor cae con el turno corriendo, el
  server reprograma el intento y el bot muestra la tarjeta de reintento (qué
  intento es y en cuántos segundos). Si el turno muere del todo, llega una
  tarjeta de error final clasificada — créditos, rate limit, clave, conexión o
  modelo — con una pista distinta para cada caso. Las interrupciones
  (cancelaste en la PC, se apagó el server, llegó un mensaje más nuevo) también
  avisan cuál fue el motivo.

Todo eso llega **al hilo de la sesión**, donde ya estás mirando.

---

## Comandos

### Sesiones

| Comando | Qué hace |
| --- | --- |
| `/sessions` | Lista las sesiones: título, id, estado (trabajando / libre) |
| `/use <id>` | Fija la sesión con la que hablás desde el General |
| `/watch <id>` / `/watch off` | Vigila (o deja de vigilar) una sesión |
| `/running` | Solo las sesiones trabajando ahora |
| `/history` | Historial de la sesión del hilo (o `/history <id>`) — lee del server mientras la sesión está activa, del transcript en disco si no |
| `/kill` | Interrumpe el turno en curso de la sesión |
| `/new` | Sesión nueva con hilo propio — `/new <título>` la crea ya bautizada; el hilo sigue el nombre si la sesión se renombra |
| `/send <id> <texto>` | Manda un prompt a una sesión sin cambiar de hilo |
| `/menu` | Menú principal con botones |
| `/usage` | Uso actual del modelo (tokens y costo del proyecto) |
| `/ls` | Navegar los archivos del proyecto desde el teléfono — carpeta para entrar, archivo para descargarlo, 📎 para adjuntarlo al próximo mensaje |
| `/find <texto>` | Buscar archivos por nombre en el proyecto — tocá un resultado para descargarlo |
| `/git` | Qué tocó el agente en el proyecto: status con +/− por archivo, y el diff completo descargable |
| `/revert` | Deshacer el último turno de una sesión — con confirmación inline, no hay vuelta atrás |
| `/config` | Ver el config del proyecto (modelo default, agents, MCP, permisos) — `/config model <proveedor/modelo>` cambia el default para sesiones nuevas |

### Configuración del agente

| Comando | Qué hace |
| --- | --- |
| `/models` | Cambiar de modelo — **espejo exacto del selector del desktop** (dos niveles: proveedor → modelo, con búsqueda) |
| `/agents` | Lista los agentes disponibles |
| `/mcp` | Servidores MCP conectados |
| `/skills` | Skills instaladas, con botones para invocar |
| `/skill <id> <texto>` | Invoca una skill con tu texto como prompt |
| `/compact` | Compacta el contexto de la sesión (la sesión resume con menos memoria) |
| `/locale` | Cambia el idioma del bot desde el teléfono: `/locale` (toca uno) o `/locale <es\|en>`. La elección persiste en `~/.opencode/tg/locale.txt`; `TG_LOCALE` en `.env` queda como valor inicial |

### Cola de mensajes (inbox)

Mientras el agente trabaja, tus mensajes quedan en la cola del servidor —
sobrevive reinicios y se entrega sola:

| Comando | Qué hace |
| --- | --- |
| `/queue` | Ver la cola: reordená con ↑↓, steer con ▶, cancelá con ✖, editá con ✏️, o "Enviar en este orden" |
| `/flush` | Adelanta todo lo encolado YA. Con texto (`/flush <texto>`) lo inyecta directo al turno en curso |

### Estadísticas

| Comando | Qué hace |
| --- | --- |
| `/usagestats [días]` | Tokens, costo, sesiones, prompts, steps, cache y racha de los últimos días (default 7, hasta 90) |

### Tareas programadas

| Comando | Qué hace |
| --- | --- |
| `/newtask` | Asistente de 6 pasos: proyecto → sesión de referencia → prompt → modelo → intervalo → confirmar. El borrador se guarda: si te quedás a mitad, `/newtask` retoma donde estaba |
| `/tasks` | Lista tus tareas: pausar, ejecutar ya, **editar el prompt (✏️)** o borrar |

Cada corrida arranca una **sesión nueva** con el modelo que elegiste, corre
el prompt y el resultado llega al hilo de esa tarea.

### Hilos del foro

| Comando | Qué hace |
| --- | --- |
| `/archive` | Archiva el hilo de la sesión (queda visible pero cerrado) |
| `/unarchive` | Lo reabre |
| `/delthread` | Borra el hilo del foro (la sesión sigue en OpenCode) |
| `/rebuild` | Borra TODOS los hilos y reconstruye el foro limpio: hilos nuevos para las sesiones que usaste últimamente (`rebuildIdleHours`, la más reciente arriba), el resto vuelve solo con su próxima actividad |
| `/rename` | Renombra la sesión del hilo (o `/rename <ses_id> <título>`) — el hilo y el desktop siguen el cambio |
| `/sh <cmd>` | Corre un comando shell DENTRO de la sesión (fondo, sin despertar al agente). Ojo: el shell es PowerShell — `;` en vez de `&&`. El comando se parsea (alias resueltos): la lectura y la toolchain pasan directo; lo que puede cortar el servicio o salir de la máquina pide confirmación con una tarjeta que explica qué hace; lo irreversible (formateo, registro, secretos, apagar la máquina, evasión con `iex`/`.NET`/`-EncodedCommand`) se bloquea sin excepción. El borrado se permite dentro de la carpeta del proyecto |
| `/note <texto>` | Deja una nota en el transcript — el agente la lee en su próximo turno |
| `/instructions` | Instrucciones persistentes de la sesión: lista, `<clave> <texto>` agrega, `del <clave>` borra |
| `/perms` | Los permisos «siempre» guardados; `del <id>` revoca uno |
| `/turns` | Qué cambiaron los turnos de la sesión |
| `/log` | Una muestra del log server-side de la sesión |
| `/terminal` | La terminal de la sesión, solo lectura |
| `/detach` | Desacopla la raíz del chat de su sesión (los hilos siguen igual) |
| `/move` | Mueve la sesi?n del hilo a otro proyecto |
| `/commands` | Lista los comandos custom del config o corre uno |

Los hilos se archivan solos tras días de inactividad (`archiveAfterDays`)
y se reabren solos si la sesión revive.

### Proyectos

| Comando | Qué hace |
| --- | --- |
| `/projects` | Elegís en qué proyecto vive una sesión nueva (solo muestra proyectos que existen en disco) |

---

## Multi-bot: un bot por proyecto o por sesión

Con un solo bot, todas las sesiones de todos los proyectos comparten un foro.
Los bots extra separan el ruido: cada uno abre su propio chat con vos (mismo
`ALLOWED_USERS`) y muestra sólo su parte.

**Dar de alta un bot extra**:

1. Crealo con [@BotFather](https://t.me/BotFather) (`/newbot`) y habilitale
   los topics (`/topics` → *Enable*), igual que al principal.
2. Sumá su token a `~/.opencode/tg/.env`: `TELEGRAM_BOT_TOKEN_SAP=…` — el
   nombre es el sufijo de la clave.
3. Elegí la topología en el bloque `"bots"` de `config.json` y reiniciá el
   server de OpenCode (el plugin se carga al arrancar).

**Topologías**:

- `"single"` — como siempre: un bot, un foro, un hilo por sesión.
- `"per-project"` — un bot por proyecto. `"assign"` fija el mapeo a mano
  (`{ "project": "E:/ruta", "bot": "SAP" }`); los proyectos sin entrada toman
  el primer bot libre en su primer turno real, y lo que queda sin bot cae al
  bot principal (el hub). Cada sesión del proyecto es un hilo del foro de su
  bot, igual que siempre.
- `"per-session"` — un bot por sesión: la conversación vive en la **raíz**
  del chat del bot y **los hilos son sus subagentes**. Una sesión reclama su
  bot en su primer turno; `/archive` de esa sesión (o `/release` en su chat)
  lo devuelve al pool. Si el pool se agota, la sesión nueva cae al hub con un
  aviso — nada queda sin espejo.

**En la práctica**:

- `/bots` (en cualquier chat) muestra el reparto actual.
- Los claims persisten en `~/.opencode/tg/bots.json`: reiniciar no mueve
  sesiones de bot.
- Los listados (`/sessions`, `/running`, `/rebuild`) muestran sólo las
  sesiones del bot de ese chat; `/send` sigue alcanzando cualquier sesión.
- Preguntas, permisos y notas de voz de una sesión llegan al chat del bot
  que la espeja.
- Un token, un solo poller: la elección de líder y el cursor de updates se
  comparten por huella del token (`leader-<huella>.lock`,
  `offset-<huella>.txt`), así que una instancia de prueba con el mismo
  token en otro directorio queda de espera en vez de robar mensajes.

---

## Configuración (opcional)

Todo vive en `config.json` junto al plugin; el token y la lista de chats
autorizados en `~/.opencode/tg/.env`.

| Clave | Default | Qué controla |
| --- | --- | --- |
| `mode` | `"dry"` | `"off"` apagado · `"dry"` solo loguea · `"live"` activo |
| `mirror` | `"all"` | `"all"` espeja todas las sesiones · `"watched"` solo las vigiladas |
| `coalesceMs` | `2000` | Ventana (ms) para unir mensajes en ráfaga cuando la sesión está libre |
| `coalesceBusyMs` | `8000` | Ventana de ráfaga (ms) mientras el agente trabaja; luego entra a la cola |
| `archiveAfterDays` | `0` (off) | Días de inactividad para auto-archivar hilos |
| `rebuildIdleHours` | `24` | `/rebuild` solo recrea hilos de sesiones usadas en estas horas; `0` quita el límite |
| `deadPromptMs` | `90000` | Ventana (ms) del watchdog de prompts muertos; `0` lo apaga |
| `render.showReasoning` | `true` | Mostrar el razonamiento del agente en el hilo |
| `render.showDiffs` | `true` | Mostrar diffs al editar archivos |
| `render.editIntervalMs` | `1400` | Cada cuánto actualiza el mensaje en vivo |

---

## Estado conocido

- **Notas de voz**: transcripción opt-in por usuario — whisper.cpp local (default) o cualquier API compatible con OpenAI; ver la sección Voz del README.
- **Archivar en chat privado**: Telegram no permite que un bot cierre tópicos en un chat privado — así que `/archive` elimina el hilo del chat y silencia la sesión (sin espejo ni avisos); `/unarchive` lo recrea nuevo y despierta la sesión. `/delthread` borra el hilo sin silenciar: una sesión activa lo recrea con su próximo evento (para sacártela de encima de verdad: `/archive`).
- **Borrar un hilo con el eliminar nativo de Telegram**: el bot lo nota solo — el próximo mensaje del agente cae en General una única vez y el hilo se reconstruye solo. No hace falta hacer nada.
- **Sesiones tras un reinicio del server**: el server solo tiene en memoria las sesiones abiertas en la PC — después de un reinicio, mandarle un mensaje a un hilo cuyo session ya no está abierto responde «🚫 esa sesión no está activa en el server». No es un error del bot: abrila en la PC y sigue andando, o creá otra con `/new`. Los comandos de proyecto (`/ls`, `/git`, `/find`, `/config`, `/worktree`) y `/export` siguen funcionando igual porque leen del disco.
- **Transcripts de sesiones nuevas**: los servers 2.0.19+ no siempre persisten la conversación a disco (su propio log registra fallos de «Failed to drain Session»). Para esas sesiones, `/history` y `/export` funcionan con la sesión abierta en la PC; cerrada, responden con el aviso honesto en lugar de inventar un historial vacío. Esos mismos fallos de drenaje son los que el watchdog de prompts muertos ahora te cuenta en el hilo.
- **Idioma**: la interfaz es español por defecto; `TG_LOCALE=en` en el `.env` la cambia a inglés. Los catálogos viven en `src/locale.ts` — un idioma nuevo es un objeto nuevo, nada más.
- **Mantenimiento automático**: el flujo `deps-audit` de GitHub Actions corre lunes y jueves 09:00 UTC — actualiza dependencias, sella vulnerabilidades, corre typecheck y las suites, y solo entonces empuja. Si algo falla, abre un issue con el log. No depende de que tu PC esté encendida.
- **El nombre del hilo sigue al título de la sesión**: si el desktop la renombra, el hilo se renombra solo — y si el renombrado se pierde (un reinicio de por medio), un chequeo de deriva lo alcanza dentro de los 5 minutos de la próxima actividad.
- Los textos inline viajan completos en partes numeradas; los mayores de 12 KB como documento.

*Generado el 2026-09-30 por el agente de la sesión «Problemas al activar el
bot de Telegram».*
