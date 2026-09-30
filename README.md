# opencode-tg

Bridge bidireccional entre [OpenCode](https://opencode.ai) y Telegram: cada
sesión del servidor obtiene su propio hilo en un foro de Telegram, y el hilo
es una consola completa del agente — prompts, respuestas, preguntas con
botones, permisos, archivos generados y tareas programadas.

Corre **dentro** del server de OpenCode como plugin (`@opencode/plugin` solo
como tipos, **cero dependencias runtime**), así que ve las mismas sesiones y
eventos que el desktop — sin un proceso aparte ni un bot que duplica estado.

## Qué hace

- **Un hilo por sesión**: escribir en el hilo es un prompt; la respuesta se
  renderiza en vivo (texto, razonamiento, diffs de edición, salida de tools).
- **Señales de vida**: "escribiendo…" mientras el turno corre; los mensajes
  que mandás mientras trabaja se unifican y se entregan al terminar.
- **Reply-context**: responder con reply a un mensaje del hilo inyecta la
  cita en el prompt (con filtrado del eco del foro de Telegram).
- **Multimedia**: fotos → el agente las ve; documentos de texto → inline al
  prompt; binarios → disco con ruta.
- **Archivos generados**: el agente produce un archivo durante un turno y el
  bot lo entrega solo — foto si es imagen, mensaje legible si es texto
  chico (`.md`/`.txt` en partes numeradas), documento adjunto en el resto.
- **Preguntas y permisos** con botones inline — respondibles desde el
  teléfono, sin abrir la PC.
- **Cola (inbox) del server** con reordenamiento, steering y `/flush`.
- **Tareas programadas** con wizard persistido (`/newtask`, `/tasks`).
- **`/models`** espeja el selector del desktop; **`/usagestats`** con tokens,
  costo y racha.

El manual completo de uso está en [`MANUAL.md`](MANUAL.md).

## Configuración

1. Copiar el directorio donde OpenCode cargue los plugins.
2. Crear `~/.opencode/tg/.env` (nunca se sube al repo):

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   ALLOWED_USERS=123456789
   ```

3. Ajustar `config.json` junto al plugin: `mode` (`off`/`dry`/`live`),
   `mirror` (`all`/`watched`), `coalesceMs`, `coalesceBusyMs`,
   `archiveAfterDays`, `render.*`. Arrancar en `dry` para validar sin tocar
   Telegram.

## Tests

```sh
npx tsx scripts/_setupcheck.ts    # y el resto de scripts/_*check.ts
```

Once suites (`_setupcheck` … `_mediaoutcheck`, ~140 checks) cubren el pump
de eventos, render, tópicos, formularios, configuración, tareas, ingesta y
el pipeline de archivos salientes. Typecheck: `tsc --noEmit index.ts`.

## Estructura

```
index.ts          plugin completo: comandos, handlers, pump de eventos
src/              transporte (telegram), topics, renderer, coalescing,
                  ingesta, media-out, tasks, config, forms, desktop-models
scripts/          suite de tests + generadores de ejemplo (_gen_*)
MANUAL.md         manual de usuario final
```
