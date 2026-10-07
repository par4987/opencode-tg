# opencode-tg

[![CI](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml/badge.svg)](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml)

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

## Compatibilidad de servidores

- **Permisos**: los servidores 2.0.19+ traen el agent build con `{"*", "*", "allow"}` como primera regla, y las reglas `ask` del `permissions` del config (raíz o `agents.*`) quedan tapadas — los permisos solo llegan cuando el *server* decide preguntar (por ejemplo `external_directory` o lecturas de `.env`). Cuando uno llega, el bot muestra los tres botones (✅ una vez · 🔁 siempre · ✖ rechazar) y responde por la API local.
- **Sesiones no activas**: el server solo sirve por id las sesiones que tiene en memoria — tras un reinicio (o al cerrarlas en la PC), todo endpoint por id responde 404 hasta reabrirlas (verificado en vivo: GET, prompt, inbox, fork y context). El plugin lo absorbe donde puede: `/ls`, `/git`, `/find`, `/config`, `/worktree` y `/new` resuelven el directorio desde los registros propios del plugin (sesión tracked + `<id>.json` en disco), y `/export` cae al `<id>.jsonl` de disco, así que siguen funcionando. Lo que exige al server (prompts, `/usage`, `/context`, `/compact`, `/fork`, `/revert`, `/kill`, `/queue`) responde con el aviso honesto "no está activa — abrila en la PC" en vez de un 404 críptico.
- **Watchdog del poll**: cada instancia del plugin corre un vigilante del asiento de líder — propio o de otra instancia — y las instancias en espera reintentan la elección cada 5s. Antes de esto, un líder instalado por traspaso no tenía vigilante: su poll colgó, el heartbeat del lock se congeló, y ninguna instancia sana volvió a disputar — el bot quedó sordo hasta reiniciar a mano (medido el 2026-10-05). Un proceso vivo con el heartbeat congelado más de 60s pierde el lock (incautación por "wedged", ver `_leadercheck`).
- **Tópicos borrados desde el teléfono**: borrar un hilo con el "eliminar" nativo de Telegram dejaba un mapeo huérfano — el espejo le hablaba a un muerto para siempre. Ahora el transporte detecta el "message thread not found", suelta el mapeo (conservando el estado de archivada) y reintenta en la raíz; el próximo evento reconstruye el hilo. Igual de solo: `/archive` en chat privado elimina el hilo (Telegram no permite cerrar tópicos ahí) y `/unarchive` lo recrea nuevo.
- El plugin se probó contra 2.0.15–2.0.22; el tipocheck usa `@opencode/plugin` de la generación actual.

## Tests y verificación

```sh
npm install
npm run typecheck   # tsc con el tsconfig del proyecto — 0 errores
npm test            # las 15 suites (~205 checks) con el runner propio
```

GitHub Actions corre ambos en cada push (`.github/workflows/ci.yml`).

Quince suites (`_setupcheck` … `_extracheck`, ~205 checks) cubren el pump
de eventos, render, tópicos, formularios, configuración, tareas, ingesta,
elección de líder, tarjetas por mensaje, helpers de la API y el pipeline
de archivos salientes. Typecheck: `tsc --noEmit index.ts`.

## Mantenimiento

El flujo [`deps-audit`](.github/workflows/deps-audit.yml) corre lunes y
jueves 09:00 UTC: actualiza dependencias, sella vulnerabilidades, corre
typecheck y las suites, y empuja solo si todo quedó verde — si no, abre un
issue con el log. Corre en la nube: no necesita tu PC encendida.

## Docker

`docker/` trae el `Dockerfile`, el `compose.yaml` y el config que montan
OpenCode + el plugin en un contenedor — ver `docs/DOCKER.md` para el
recorrido completo.

## Idioma

Español por defecto, inglés con `TG_LOCALE=en` en el `.env`. Los catálogos
están en `src/locale.ts`: un idioma nuevo es un objeto nuevo.

## Estructura

```
index.ts          plugin completo: comandos, handlers, pump de eventos
src/              transporte (telegram), topics, renderer, coalescing,
                  ingesta, media-out, tasks, config, forms, desktop-models
scripts/          suite de tests + generadores de ejemplo (_gen_*)
MANUAL.md         manual de usuario final
```
