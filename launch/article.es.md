# No le pongas un segundo proceso a tu agente

### Un bridge de Telegram que vive *dentro* del server de OpenCode — y las dos decisiones de diseño que lo hicieron funcionar

<!-- Portada: el mismo GIF de 15–20 s que la versión en inglés. -->

Mi agente corre tareas largas. Diez, veinte, cuarenta minutos. Mientras estoy en
el escritorio, no hay problema. El problema empieza cuando me voy: el agente
llega a un pedido de permiso, se detiene, y espera. A veces vuelvo una hora
después y sigue ahí, esperando.

Así que construí lo obvio primero. Y estaba mal.

## Intento #1: un bot al lado del agente

La primera versión era un bot de Telegram normal: un proceso aparte, hablando
Agent Client Protocol por stdio con una instancia headless de OpenCode.
Arquitectura limpia en el papel. En la práctica, solo veía las sesiones **que él
mismo creaba**.

Todo lo demás — las sesiones abiertas en el desktop, las que arrancaba la TUI,
cualquier cosa que sobreviviera a un reinicio — era invisible. Para simular
paridad terminé con un espejo en SQLite, un heurístico de "¿esta sesión sigue
activa?" cada 15 minutos, y un tail del log. Tres capas de aproximación para
adivinar lo que la computadora ya sabía.

Eso es la señal: cuando un bridge necesita una copia del estado, no es un
bridge.

## Intento #2: vivir dentro del server

OpenCode corre los plugins in-process. Un plugin recibe el mismo flujo de
eventos que renderiza la TUI, para todas las sesiones, en el momento en que
pasan. Sin polling, sin espejo, sin heurístico.

Una vez que el bridge es un plugin, `ctx.event` *es* la verdad. Arranca una
sesión → hay un evento. El modelo manda un token → hay un evento. Se pide un
permiso → hay un evento, con el id que necesitás para responderlo.

Ese único cambio borró una base de datos, un timer, y una clase entera de bugs
donde el espejo decía una cosa y la realidad otra.

### Qué te compra un hilo por sesión

Los grupos de Telegram con **Topics** habilitados te dan hilos de foro. El mapeo
es casi demasiado prolijo: **una sesión, un hilo** — más hilos de solo lectura
para los subagentes, así los mirás sin poder promptearlos.

- Escribir en el hilo es promptear esa sesión. Sin prefijo `/send <id> <texto>`.
- El hilo se vuelve la consola de la sesión: texto, razonamiento, diffs de
  edición, salida de tools — en el mismo mensaje, en vivo, en vez de una pared
  de notificaciones.
- El indicador de "escribiendo…" es la señal de vida. Lo que mandás a mitad de
  un turno se agrupa y se encola; podés ver la cola (`/queue`) y adelantarla.
- `/delthread` borra el hilo y la sesión sigue corriendo: el chat es una vista,
  no la cosa en sí. `/rebuild` reconstruye el foro entero con las sesiones que
  usaste hace poco.

El modelo mental deja de ser "un bot que me cuenta qué hace mi agente" y pasa a
ser "mi agente, con interfaz de chat".

## La parte que vale la pena copiar: un guard que parsea en vez de usar regex

Este es el diseño que me quedaría si tirara todo lo demás.

El 2026-10-07 corrí `/sh opencode service restart` desde el teléfono. Se ejecutó
dentro del server que hosteaba el plugin, mató el proceso — y como el offset de
polling de Telegram vivía solo en memoria, la actualización se re-entrego en
cada reinicio. Un loop infinito, más o menos cada diez segundos, hasta que
deshabilité el plugin a mano.

Persistir el offset es la cura. El guard es la prevención, y una lista negra de
"comandos malos" no lo habría evitado: el comando era verosímil, parecía útil y
no era obviamente destructivo.

Cuatro principios, en orden de importancia:

**1. Parsear, no usar regex.** Partir por `;`, `|`, `&&` y saltos de línea
respetando comillas, tomar el nombre del comando del primer token, resolver
alias al cmdlet canónico. Así un `--format=` dentro de un comando de `git` no
puede volver a parecer `Format-Volume`.

**2. Invertir el default.** Una allowlist corta de solo lectura (`Get-*`,
`Test-*`, la toolchain de desarrollo) pasa directo. Todo lo desconocido pide
confirmación — porque un nombre que el guard no reconoce es un nombre que no
puede avalar. Desconocido no es "probablemente esté bien".

**3. Acotar por path, no prohibir en bloque.** Un agente de código *tiene* que
borrar archivos. `Remove-Item` está permitido dentro de la carpeta del proyecto
y prohibido en cualquier otro lado. La destrucción solo se habilita donde el
daño sería nuestro.

**4. Mostrar lo que se parseó.** La tarjeta de confirmación lista cada comando
con los alias resueltos, así aprobás lo que va a correr de verdad, no lo que
tipeaste.

Tres niveles, porque el daño no es simétrico:

```ts
export type DangerLevel = "ok" | "confirm" | "forbidden";
```

- `ok` — solo lectura: pasa.
- `confirm` — recuperable, a veces necesario: un toque, con una explicación en
  lenguaje llano de qué va a hacer.
- `forbidden` — no corre nunca, ni siquiera después de tocar: formateo de disco,
  borrado de copias de sombra, exfiltración de claves. No existe "aprobar" para
  lo irrecuperable.

La asimetría es el punto. Un sistema que te pide la misma confirmación para `ls`
y para `rm -rf /` te entrena a tocar diálogos sin leer, que es lo mismo que no
tener guard.

<!-- Captura: la tarjeta de confirmación en Telegram, con el comando ya resuelto. -->

## Los watchdogs le ganan a los timeouts mudos

El segundo modo de falla es más silencioso: el prompt se entrega, el turno nunca
arranca, y no pasa nada. Antes el bridge se quedaba ahí hasta que saltaba un
timeout genérico, que no te dice nada.

Ahora un watchdog (90 s por defecto) lee el log del server y reporta la causa
real: créditos agotados, rate limit, modelo dado de baja. Es la diferencia entre
"el agente está pensando" y "el agente está muerto y deberías dejar de esperar".

El mismo principio aplica al liderazgo: cuando corrés más de una instancia de
OpenCode, solo una puede hacer polling de Telegram sin pelear por un HTTP 409.
Un lock de líder con watchdog deja que el líder depuesto se corra limpio, en vez
de dos procesos peleando por `getUpdates`.

## La voz se queda en tu máquina

Las notas de voz se transcriben antes de llegar al agente, y el default es
**local**: whisper.cpp en `~/.opencode/tg/stt`, sin nube, sin clave, sin audio
saliendo de la máquina.

```jsonc
"stt": { "provider": "local" }
```

Si preferís una API, apuntalo a cualquier endpoint compatible con OpenAI y
dejá la clave en `.env`, nunca en el archivo de config. El trade-off es tuyo,
pero la opción privada debería ser la que funciona out of the box.

## Cero dependencias runtime (en serio)

`@opencode/plugin` se importa **solo como tipo**, así que se borra al compilar:

```ts
import type { Plugin } from "@opencode/plugin";
```

El paquete publicado no tiene `dependencies`. Nada que auditar, nada que se
rompa con una actualización transitiva, ningún `node_modules` viajando al lado
del plugin. Para un componente que vive dentro del server de otro, eso no es
minimalismo por deporte: es la diferencia entre "se instala" y "se instala y
sigue funcionando después de la próxima actualización".

## Instalación

OpenCode instala los plugins de npm con Bun al arrancar, así que es una línea:

```jsonc
// opencode.jsonc
{
  "plugin": ["opencode-tg"]
}
```

Después las credenciales, en `~/.opencode/tg/.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC...
ALLOWED_USERS=123456789
```

Creá el bot con [@BotFather](https://t.me/BotFather), habilitá los topics
(`/topics` → *Enable*) y sumá el bot a un grupo como administrador para que
pueda crear y manejar los hilos. Reiniciá OpenCode y aparecen los hilos.

Arranca en `"mode": "dry"`: escribe en el log lo que *enviaría* sin tocar
Telegram. Podés validar el token, el grupo y el ruteo antes de que nada salga
de verdad:

```jsonc
// ~/.opencode/tg/config.json  (fuera del paquete: sobrevive a las actualizaciones)
{ "mode": "live", "mirror": "all" }
```

`mirror: "watched"` espeja solo las sesiones que marcás con `/watch`, que es lo
que usaría en una máquina compartida o de trabajo.

## Qué haría distinto

**Empezar por el flujo de eventos, no por el protocolo.** La versión ACP era
arquitectónicamente respetable y funcionalmente ciega. La versión in-process
tiene menos piezas *y* más información.

**Escribir el guard después del incidente, no en lugar del incidente.** Cada
regla de `dangerous.ts` mapea a algo que pasó de verdad. Los modelos de amenaza
inventados producen reglas que no se disparan; los medidos producen reglas que
sí.

**Hacer que el modo seguro sea el default.** `dry` primero, `live` a propósito.
Una herramienta que puede mandar mensajes como vos debería requerir un acto
explícito para empezar a hacerlo.

**Tratar el offset del polling como estado.** Todo lo que vive solo en memoria
se convierte en bug la primera vez que el proceso muere en el momento
equivocado.

---

El proyecto es MIT y vive acá: **https://github.com/par4987/opencode-tg**

Pasa 32 suites de tests (809 checks) y un typecheck en cada push, más una
auditoría de dependencias dos veces por semana que solo empuja una actualización
cuando toda la suite sigue en verde.

Si corrés sesiones largas y querés el teléfono como control remoto, me interesa
de verdad saber qué te haría confiarle un comando destructivo — esa es la
pregunta que el guard existe para responder, y la que menos seguro estoy de
haber acertado.

<!--
Notas para publicar:
- Es una adaptación, no una traducción literal: las secciones y los ejemplos son
  los mismos, pero el texto está escrito para leerse en español.
- Canonical: si publicás las dos versiones, la inglesa en dev.to y esta en tu
  blog o en Medium, con `canonical` apuntando a la inglesa.
-->
