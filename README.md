# opencode-tg

[![CI](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml/badge.svg)](https://github.com/par4987/opencode-tg/actions/workflows/ci.yml)

> **Español** | Read this in [English](README.en.md)

Controlá [OpenCode](https://opencode.ai) desde el teléfono: cada sesión del
server obtiene su propio hilo en Telegram, y escribir en el hilo es mandarle
un prompt al agente.

Corre **dentro del server de OpenCode**, como plugin. No hay proceso aparte
que iniciar, binario que mantener ni estado duplicado: ve exactamente las
mismas sesiones y eventos que el desktop, porque es parte del mismo server.
`@opencode/plugin` solo como tipos — **cero dependencias runtime**.

## Desde el teléfono

- **El hilo es una consola del agente**: escribí y es un prompt; la respuesta
  llega en vivo al mismo hilo (texto, razonamiento, diffs de edición, salida
  de tools).
- **Señales de vida**: "escribiendo…" mientras el turno corre. Lo que mandás
  a mitad de un turno se unifica y se entrega cuando termina.
- **Preguntas y permisos con botones**: el agente pregunta o pide permiso y
  respondés con un toque, sin abrir la PC.
- **Multimedia entra al agente**: fotos, documentos de texto inline, binarios
  al disco con su ruta. Las **notas de voz se transcriben en tu máquina**
  (whisper.cpp local, sin nube ni claves) o con una API compatible con
  OpenAI.
- **Los archivos que el agente produce te llegan solos**: foto si es imagen,
  texto legible si es chico (`.md`/`.txt` en partes numeradas), documento
  adjunto en el resto.
- **Todo el control**: `/models` espeja el selector del desktop (con el modelo
  del proyecto marcado ✅), `/usagestats` con tokens, costo y racha, tareas
  programadas (`/newtask`, `/tasks`) y la cola del server con reordenamiento
  y steering (`/queue`, `/flush`).
- **Si el proveedor falla, te enterás**: cuando el modelo nunca arranca el
  turno (créditos agotados, rate limit, modelo dado de baja), un watchdog te
  dice la causa real a los 90 s — no un timeout mudo que no explica nada.
- **Multi-bot opcional**: bots extra (`TELEGRAM_BOT_TOKEN_<NOMBRE>` en el
  `.env`) con topología un-bot-por-proyecto o un-bot-por-sesión. `/bots`
  muestra el reparto; ver el MANUAL.

El manual completo de uso está en [`MANUAL.md`](MANUAL.md) (Español) /
[`MANUAL.en.md`](MANUAL.en.md) (English), y la lista de comandos en
[`docs/COMMANDS.md`](docs/COMMANDS.md) — que es también lo que alimenta
`/help` desde el bot.

## Instalación

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
   `mirror` (`all`/`watched`), `bots` (topología multi-bot), `coalesceMs`,
   `coalesceBusyMs`, `archiveAfterDays`, `render.*`. Arrancar en `dry` para
   validar sin tocar Telegram.

Probado contra OpenCode 2.0.15–2.0.22; los detalles finos de cada versión
(permisos, sesiones tras reinicio, watchdogs de líder) están en el
[`MANUAL.md`](MANUAL.md), sección *Detalles del server*.

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
a `~/.opencode/tg/stt/models/` — esos son los paths default. Ojo con la RAM:
whisper carga el modelo **más** sus buffers, así que small (465 MB) necesita
cerca de 600 MB libres; si la PC está apretada, un modelo más chico sigue
andando —
[ggml-base.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin)
(~140 MB) o
[ggml-tiny.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin)
(~75 MB), apuntando `stt.model` al archivo.

**Cloud — cualquier API compatible con OpenAI** (Groq, OpenAI, self-hosted):

```jsonc
"stt": {
  "provider": "openai-compatible",
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "whisper-large-v3-turbo"
}
```

Opciones comunes de `stt`: `whisper` y `model` (paths locales), `baseUrl` +
`model` + `STT_API_KEY` (cloud, la key va en el `.env`), `language` (default
`es`).

## Docker

`docker/` trae el `Dockerfile`, el `compose.yaml` y el config que montan
OpenCode + el plugin en un contenedor — ver [`docs/DOCKER.md`](docs/DOCKER.md)
para el recorrido completo.

## Idiomas

Español por defecto; hoy **español, English, Português, Deutsch, Français, Italiano e Bahasa Indonesia**. Desde el bot,
`/locale` cambia el idioma y lo recuerda; desde el `.env`,
`TG_LOCALE=<código>`. Los catálogos viven en `src/locale.ts` — un idioma
nuevo es un objeto nuevo, nada más.

## Para quien lo quiera extender

```sh
npm install
npm run typecheck   # tsc con el tsconfig del proyecto — 0 errores
npm test            # las 24 suites (646 checks) con el runner propio
```

GitHub Actions corre ambos en cada push (`.github/workflows/ci.yml`). El
flujo [`deps-audit`](.github/workflows/deps-audit.yml) actualiza
dependencias y sella vulneraciones lunes y jueves, y solo empuja si todo
quedó verde — desde el teléfono, `/ci` muestra las últimas runs.

```
index.ts          plugin completo: comandos, handlers, pump de eventos
src/              transporte (telegram), topics, renderer, coalescing,
                  ingesta, media-out, tasks, config, forms, desktop-models
scripts/          suite de tests + generadores de ejemplo (_gen_*)
MANUAL.md         manual de usuario final
```

## Licencia

[MIT](LICENSE) © 2026 par4987
