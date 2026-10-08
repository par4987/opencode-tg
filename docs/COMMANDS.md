# Guía de comandos

Cada comando con qué hace, cómo se usa, ejemplos y notas. El menú de `/help`
en Telegram ofrece estos mismos comandos — tocás uno y recibís su sección.

## Sesiones

### /new

**Qué hace**: Crea una sesión nueva en el proyecto actual.

**Uso**: `/new <título>`

**Ejemplos**:
- `/new Análisis de ventas` → crea una sesión titulada "Análisis de ventas"
- `/new` → crea una sesión con el título por defecto

**Notas**: El hilo de Telegram se crea con el primer mensaje. Para crear en otro proyecto: `/projects`.

### /use

**Qué hace**: Define a qué sesión van los mensajes de la raíz del chat.

**Uso**: `/use <ses_id>`

**Ejemplos**:
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → la raíz apunta a esa sesión
- `/use` → muestra la sesión actual

**Notas**: Los mensajes en un hilo siempre van a la sesión de ese hilo, sin importar `/use`.

### /fork

**Qué hace**: Bifurca una sesión hasta su último mensaje — probá ideas sin ensuciar la original.

**Uso**: `/fork` (en el hilo) o `/fork <ses_id>`

**Ejemplos**:
- `/fork` en el hilo de una sesión → crea un fork y te avisa
- `/fork ses_xxx` → idem desde cualquier lugar

**Notas**: El fork es una sesión nueva con su propio hilo. La original queda intacta.

### /rename

**Qué hace**: Renombra una sesión — el hilo de Telegram y el desktop siguen el cambio.

**Uso**: `/rename <título>` o `/rename <ses_id> <título>`

**Ejemplos**:
- `/rename Análisis Q4` → renombra la sesión del hilo
- `/rename` (sin título) → sugiere 3 títulos desde el transcript y elegís con un tap

**Notas**: El título se capa a 128 caracteres (el límite de nombre de tópico de Telegram).

### /detach

**Qué hace**: Desacopla la raíz del chat de su sesión — lo que escribas ahí ya no va a ninguna sesión.

**Uso**: `/detach`

**Ejemplos**:
- `/detach` → la raíz queda libre
- `/use <ses_id>` → vuelve a acoplar

**Notas**: Los hilos de sesión no se ven afectados.

### /archive

**Qué hace**: Archiva la sesión del hilo — en chat privado elimina el hilo y silencia la sesión.

**Uso**: `/archive` o `/archive <ses_id>`

**Ejemplos**:
- `/archive` en un hilo → el hilo desaparece del chat
- `/archive ses_xxx` → idem desde cualquier lugar

**Notas**: `/unarchive` lo trae de vuelta (recrea el hilo en chat privado).

### /unarchive

**Qué hace**: Despierta una sesión archivada — recrea su hilo y reactiva el espejo.

**Uso**: `/unarchive` o `/unarchive <ses_id>`

**Ejemplos**:
- `/unarchive` en la raíz → recrea el hilo de la sesión archivada

**Notas**: Si el hilo fue borrado, se crea uno nuevo con el título actual.

### /delthread

**Qué hace**: Borra el hilo del foro sin tocar la sesión.

**Uso**: `/delthread` o `/delthread <ses_id>`

**Ejemplos**:
- `/delthread` en un hilo → el hilo desaparece

**Notas**: La sesión sigue existiendo — su próximo evento recrea el hilo. Para silenciarla: `/archive`.

### /rebuild

**Qué hace**: Borra TODOS los hilos de sesiones y reconstruye el foro limpio.

**Uso**: `/rebuild` (con confirmación inline)

**Ejemplos**:
- `/rebuild` → borra los hilos mapeados (uno por uno, confirmado) y recrea los de las sesiones que usaste últimamente (hasta 12, la más reciente arriba)

**Notas**: Los mensajes viejos no se re-importan — `/export` baja el transcript de cada sesión. Solo recrea hilos para sesiones que usaste dentro de `rebuildIdleHours` (default 24h): el server pisa el campo `updated` de todas las sesiones al reiniciar, así que ordenar por él resucitaba sesiones que nadie tocaba hacía días; `idle` es la última actividad real. Cada borrado se confirma antes de olvidar el mapeo — si Telegram rechaza uno (rate limit, corte), el hilo queda mapeado y el próximo `/rebuild` reintenta; una sesión cuyo hilo sobrevivió no se duplica. Los hilos que quedaron **huérfanos** (sin mapeo) no se pueden limpiar solos: la Bot API no tiene "listar tópicos", así que hay que borrarlos a mano una sola vez.

## Archivos y código

### /ls

**Qué hace**: Navega los archivos del proyecto de la sesión.

**Uso**: `/ls [carpeta]`

**Ejemplos**:
- `/ls` → lista el directorio raíz del proyecto
- `/ls src` → entra a la carpeta src
- Tocá un archivo → lo descarga
- 📎 en un archivo de texto → lo adjunta al próximo mensaje

**Notas**: Los índices de los botones expiran — si un tap dice "listing viejo", reabrí `/ls`.

### /find

**Qué hace**: Búsqueda difusa de archivos por nombre.

**Uso**: `/find <texto>`

**Ejemplos**:
- `/find navbar` → archivos cuyo nombre contiene "navbar"
- `/find .test.` → archivos con ".test." en el nombre

**Notas**: Busca en todo el proyecto de la sesión.

### /git

**Qué hace**: Qué tocó el agente en el proyecto — status con `+/−` y diff descargable.

**Uso**: `/git`

**Ejemplos**:
- `/git` → status del proyecto
- "Ver el diff" → preview + `.patch` descargable

**Notas**: Es el diff del proyecto, no de la sesión — varios agentes pueden compartirlo.

### /revert

**Qué hace**: Deshace el último turno de una sesión (con confirmación).

**Uso**: `/revert` o `/revert <ses_id>`

**Ejemplos**:
- `/revert` en un hilo → propone deshacer el último turno
- Confirmás con el botón → el turno se deshace

**Notas**: Solo deshace el último turno. Para varios: `/revert` repetido.

### /export

**Qué hace**: Descarga el transcript completo de una sesión como JSON.

**Uso**: `/export` o `/export <ses_id>`

**Ejemplos**:
- `/export` en un hilo → te llega el JSON del transcript
- `/export ses_xxx` → idem desde cualquier lugar

**Notas**: Con la sesión abierta en la PC, el export es completo. Cerrada, puede no haber transcript en disco (bug de persistencia del server).

### /sh

**Qué hace**: Corre un comando shell DENTRO de la sesión — en segundo plano, sin despertar al agente.

**Uso**: `/sh <comando>`

**Ejemplos**:
- `/sh node -v` → `v24.21.0`
- `/sh git status` → el status del repo
- `/sh ls` → el contenido del directorio

**Notas**: El shell de la sesión es PowerShell — `&&` no funciona, usá `;`. El output llega al hilo.

**Comandos protegidos**: el comando se **parsea** (no se busca por regex: los nombres reales, con los alias resueltos) y cae en uno de tres niveles:

- **Pasa derecho**: lectura pura (`Get-*`, `Test-*`, `ls`, `cat`) y la toolchain de desarrollo (`git`, `node`, `npm`, `cargo`, `python`...). Un falso positivo acá haría que el bot pidiera confirmación antes de cada `git status`.
- **Pide confirmación**: lo recuperable pero que puede cortar el servicio o salir de la máquina — reiniciar el server, matar procesos, instalar software, llamadas a la red, ejecución remota, tareas programadas. La tarjeta **explica qué hace cada comando** (qué va a pasar, no solo el texto) y hay que tocar "Confirmar y ejecutar". El pendiente se borra **antes** de ejecutar, así que un crash no lo redispara.
- **Bloqueado, sin excepción**: lo que no tiene vuelta atrás — formateo y borrado de discos, arranque y recuperación del sistema, registro, usuarios y credenciales, secretos (`.env`, `.ssh`, perfiles de navegador, el drive `Env:`), defensas (antivirus, firewall, BitLocker), borrado de logs, y todos los vectores de evasión (`iex`, `Invoke-Command`, `powershell`/`cmd` anidados, `-EncodedCommand`, `Add-Type`, acceso directo a .NET/COM, definición de funciones y alias). Ni confirmándolo se ejecuta: para eso está la consola de la PC.

El borrado está **acotado por ruta**: `Remove-Item` (y `rm`, `del`, `rmdir`...) se permite dentro de la carpeta del proyecto — un agente de código tiene que poder borrar `node_modules` — y se bloquea afuera. Borrar el proyecto entero (`.`) o el `.git` pide confirmación.

**Por qué** (incidente 2026-10-07): `/sh opencode service restart` mató al proceso que hostea el plugin; como el offset del poll estaba solo en memoria, Telegram reenviaba la update en cada reinicio y el servidor entró en un bucle de ~10s hasta desactivar el plugin a mano. El offset persistente es la cura; este guard es la prevención.

### /note

**Qué hace**: Deja una nota en el transcript — el agente la lee en su próximo turno, sin despertarse ahora.

**Uso**: `/note <texto>`

**Ejemplos**:
- `/note Priorizar el módulo de ventas` → el agente lo ve como contexto

**Notas**: Es un mensaje sintético — no corre el agente.

### /turns

**Qué hace**: Qué cambiaron los turnos de la sesión — más fino que `/git`.

**Uso**: `/turns` o `/turns <ses_id>`

**Ejemplos**:
- `/turns` en un hilo → los cambios de los turnos

**Notas**: Puede estar vacío si el server no registró cambios de turno.

## Proyecto y config

### /config

**Qué hace**: Lee y edita el `opencode.jsonc` del proyecto — el default de modelo de las sesiones nuevas.

**Uso**: `/config` o `/config model <proveedor/modelo>`

**Ejemplos**:
- `/config` → muestra el config actual
- `/config model nvidia/z-ai/glm-5.3` → cambia el default (recarga en vivo)

**Notas**: El cambio aplica a las sesiones NUEVAS — no requiere reiniciar el server.

### /worktree

**Qué hace**: Lista los worktrees del proyecto o crea uno nuevo.

**Uso**: `/worktree` o `/worktree new <nombre>`

**Ejemplos**:
- `/worktree` → lista con botones que abren sesiones en cada worktree
- `/worktree new feature-x` → crea el worktree

**Notas**: Tocá un worktree para abrir una sesión ahí.

### /move

**Qué hace**: Mueve una sesión a otro proyecto.

**Uso**: `/move <directorio>`

**Ejemplos**:
- `/move E:\Projects\Otro` → la sesión del hilo se mueve a ese proyecto

**Notas**: El hilo de Telegram sigue igual — solo cambia el directorio de trabajo.

### /mcp

**Qué hace**: Lista los servidores MCP o conecta/desconecta uno.

**Uso**: `/mcp` o `/mcp connect|disconnect <server>`

**Ejemplos**:
- `/mcp` → lista con estado (🟢 conectado / 🔴 no)
- `/mcp disconnect abap-docs` → lo desconecta
- `/mcp connect abap-docs` → lo reconecta

**Notas**: Agregar un server nuevo (PUT) queda para la PC.

### /commands

**Qué hace**: Lista los comandos custom del config o corre uno.

**Uso**: `/commands` o `/commands run <texto>`

**Ejemplos**:
- `/commands` → lista (init, review, etc.)
- `/commands run init` → corre el comando "init" en la sesión del hilo

**Notas**: Los comandos custom se definen en el `opencode.jsonc` del proyecto.

## Info y debug

### /locale

**Qué hace**: Cambia el idioma del bot — el menú de `/help`, las tarjetas y todos los mensajes siguen al instante.

**Uso**: `/locale` (con botones) o `/locale <es|en>`

**Ejemplos**:
- `/locale` → tarjeta con un botón por idioma (el actual con ✓)
- `/locale en` → cambia directo; la confirmación llega EN el idioma elegido

**Notas**: La elección persiste en `~/.opencode/tg/locale.txt` — un reinicio no la pierde. `TG_LOCALE` en `.env` queda como valor inicial. Un idioma nuevo es un objeto nuevo en `CATALOGS` (src/locale.ts) más su `COMMANDS.<idioma>.md` — nada de código adicional.

### /context

**Qué hace**: Tokens, costo, límite del modelo y compactaciones de una sesión.

**Uso**: `/context` o `/context <ses_id>`

**Ejemplos**:
- `/context` en un hilo → el uso de contexto de esa sesión

**Notas**: El modelo se recupera del transcript si el payload del server no lo trackea.

### /usage

**Qué hace**: Tokens y costo de una sesión, con proveedor y modelo.

**Uso**: `/usage` o `/usage <ses_id>`

**Ejemplos**:
- `/usage` en un hilo → `🧪 nvidia · z-ai/glm-5.3 · agente build` + tokens

**Notas**: El modelo y agente se recuperan del transcript cuando el payload los olvida.

### /history

**Qué hace**: El final de la conversación de una sesión.

**Uso**: `/history` o `/history <ses_id>`

**Ejemplos**:
- `/history` en un hilo → los últimos 16 mensajes

**Notas**: Lee del server (sesión activa) o del transcript en disco.

### /log

**Qué hace**: Una muestra del log server-side de la sesión.

**Uso**: `/log` o `/log <ses_id>`

**Ejemplos**:
- `/log` en un hilo → los últimos 10 eventos del log

**Notas**: Es una ventana de lectura — no es el log completo.

### /terminal

**Qué hace**: La terminal de la sesión, solo lectura.

**Uso**: `/terminal` o `/terminal <ses_id>`

**Ejemplos**:
- `/terminal` en un hilo → las últimas líneas del terminal

**Notas**: Aparece cuando el agente corre algo interactivo. El control queda en la PC.

### /perms

**Qué hace**: Lista los permisos "siempre" guardados o revoca uno.

**Uso**: `/perms` o `/perms del <id>`

**Ejemplos**:
- `/perms` → los "🔁 Siempre" acumulados
- `/perms del psv_xxx` → revoca uno

**Notas**: Revocar hace que el server vuelva a preguntar.

### /sessions

**Qué hace**: Las sesiones que el server conoce.

**Uso**: `/sessions`

**Ejemplos**:
- `/sessions` → lista con estado (🎯 activa, 📡 espejo, 💤 idle)

### /running

**Qué hace**: Las sesiones con un turno corriendo ahora.

**Uso**: `/running`

**Ejemplos**:
- `/running` → qué está trabajando

### /models

**Qué hace**: Cambia el modelo de la sesión — con picker paginado.

**Uso**: `/models` o `/models <texto>`

**Ejemplos**:
- `/models` → picker con proveedores y modelos
- `/models glm` → filtra por "glm"

**Notas**: Solo modelos que el desktop habilita o el config declara.

### /agents

**Qué hace**: Cambia el agente de la sesión.

**Uso**: `/agents` o `/agent`

**Ejemplos**:
- `/agents` → picker de agentes

### /projects

**Qué hace**: Lista los proyectos para abrir una sesión nueva.

**Uso**: `/projects`

**Ejemplos**:
- `/projects` → picker de proyectos

### /tasks

**Qué hace**: Lista las tareas programadas del bot.

**Uso**: `/tasks`

**Ejemplos**:
- `/tasks` → las tareas con su próxima ejecución

### /newtask

**Qué hace**: Crea una tarea programada con wizard de 6 pasos.

**Uso**: `/newtask`

**Ejemplos**:
- `/newtask` → wizard: nombre, prompt, proyecto, modelo, schedule, detalle

### /skills

**Qué hace**: Lista las skills instaladas y arma una para el próximo mensaje.

**Uso**: `/skills` o `/skill <id> <texto>`

**Ejemplos**:
- `/skills` → picker de skills
- Tocá una → escribí el prompt

## Chat y cola

### /queue

**Qué hace**: Los mensajes pendientes del inbox de la sesión.

**Uso**: `/queue` o `/queue <ses_id>`

**Ejemplos**:
- `/queue` → lista con reordenar (↑↓), adelantar (▶), cancelar (✖), reemplazar (✏️)

**Notas**: Los ítems de compactación y movimiento se etiquetan ya.

### /flush

**Qué hace**: Adelanta todo lo que el inbox retiene al turno en curso.

**Uso**: `/flush` o `/flush <texto>`

**Ejemplos**:
- `/flush` → vacía el inbox al turno
- `/flush hacé X` → inyecta el texto al turno YA

**Notas**: Con texto es steering directo — entra al turno en curso.

### /clearqueue

**Qué hace**: Cancela todos los mensajes pendientes del inbox.

**Uso**: `/clearqueue` o `/clearqueue <ses_id>`

**Ejemplos**:
- `/clearqueue` → cancela todo

### /send

**Qué hace**: Manda un prompt a una sesión desde cualquier lugar.

**Uso**: `/send <texto>` o `/send <ses_id> <texto>`

**Ejemplos**:
- `/send hacé un resumen` → va a la sesión del hilo
- `/send ses_xxx hacé X` → va a esa sesión

### /txt

**Qué hace**: Respuesta libre a una pregunta abierta del agente.

**Uso**: `/txt <respuesta>`

**Ejemplos**:
- `/txt La opción B` → responde a la pregunta activa

### /menu

**Qué hace**: Menú de comandos con botones.

**Uso**: `/menu`

**Ejemplos**:
- `/menu` → teclado con los comandos principales

### /help

**Qué hace**: Lista los comandos con menú para ver el detalle de cada uno.

**Uso**: `/help`

**Ejemplos**:
- `/help` → lista breve + teclado
- Tocá un comando → su sección detallada (qué hace, uso, ejemplos, notas)

### /watch

**Qué hace**: Controla qué sesiones se miran en el chat.

**Uso**: `/watch <id|all|off>`

**Ejemplos**:
- `/watch all` → mirá todo
- `/watch ses_xxx` → mirá solo esa
- `/watch off` → no mires nada

**Notas**: Con `mirror: all` en el config, `/watch <id>` silencia al resto.
