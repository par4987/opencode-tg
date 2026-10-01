# opencode-tg

> **Español** | Read this in [English](README.en.md)

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
  prompt; binarios → disco con ruta; **notas de voz → transcripción local**
  (whisper.cpp en `~/.opencode/tg/stt`, sin nube ni claves).
- **Archivos generados**: el agente produce un archivo durante un turno y el
  bot lo entrega solo — foto si es imagen, mensaje legible si es texto
  chico (`.md`/`.txt` en partes numeradas), documento adjunto en el resto.
- **Preguntas y permisos** con botones inline — respondibles desde el
  teléfono, sin abrir la PC.
- **Cola (inbox) del server** con reordenamiento, steering y `/flush`.
- **Tareas programadas** con wizard persistido (`/newtask`, `/tasks`).
- **`/models`** espeja el selector del desktop; **`/usagestats`** con tokens,
  costo y racha.

El manual completo de uso está en [`MANUAL.md`](MANUAL.md) (Español) /
[`MANUAL.en.md`](MANUAL.en.md) (English).

## Configuración

1. Registrar el plugin en la config de OpenCode (`opencode.jsonc` global o
   del proyecto) apuntando al directorio:

   ```jsonc
   "plugins": [
     { "package": "C:/ruta/al/opencode-tg" }
   ]
   ```

2. Crear `~/.opencode/tg/.env` (nunca se sube al repo):

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   ALLOWED_USERS=123456789
   ```

3. Ajustar `config.json` junto al plugin: `mode` (`off`/`dry`/`live`),
   `mirror` (`all`/`watched`), `coalesceMs`, `coalesceBusyMs`,
   `archiveAfterDays`, `render.*`. Arrancar en `dry` para validar sin tocar
   Telegram.

## Voz (opcional — cada usuario elige)

Las notas de voz se transcriben antes de entrar al agente. Sin la clave
`stt`, el bot avisa cómo activarla — la feature es opt-in por diseño.

**Local — whisper.cpp (gratis, privado):**

```jsonc
"stt": { "provider": "local" }
```

Requisitos: [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) en el PATH
(Windows: `winget install ffmpeg`) — decodifica el OGG/Opus de Telegram a
WAV, que es lo que whisper.cpp lee — y bajar
`whisper-blas-bin-x64.zip` de las
[releases de whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases)
a `~/.opencode/tg/stt/Release/` más un modelo ggml (p. ej.
[ggml-small.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin))
a `~/.opencode/tg/stt/models/` — esos son los paths default.

**Cloud — cualquier API compatible con OpenAI** (Groq, OpenAI, self-hosted):

```jsonc
"stt": {
  "provider": "openai-compatible",
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "whisper-large-v3-turbo"
}
```

Con `baseUrl` de Groq o `https://api.openai.com/v1` y `model` `whisper-1`.
La key va en `~/.opencode/tg/.env`:

```
STT_API_KEY=...
```

Opciones comunes de `stt`: `whisper` y `model` (paths locales),
`baseUrl` + `model` + `STT_API_KEY` (cloud), `language` (default `es`).

## Tests y verificación

```sh
npm install
npm run typecheck   # tsc con el tsconfig del proyecto — 0 errores
npm test            # las 11 suites (~150 checks) con el runner propio
```

GitHub Actions corre ambos en cada push (`.github/workflows/ci.yml`).

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
