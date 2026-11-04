# Guion del GIF de portada

Objetivo único: que alguien que nunca oyó hablar de OpenCode entienda en 15
segundos **que el agente corre en la compu y el teléfono es el control remoto**.
No es un tour de features. Si el GIF intenta mostrar diez cosas, no muestra
ninguna.

Duración: **15–18 s**. Ancho final: **900 px**. Peso: **≤ 4 MB** (por encima de
5 MB el README tarda y la gente no lo ve).

---

## Preparación (30 min, y se nota)

**Proyecto de demo, no el real.** Creá `C:\demo\tg-demo` con 3–4 archivos
inventados (`parser.ts`, `parser.test.ts`, `README.md`) y un error obvio para
que el agente tenga algo que arreglar. Nunca grabes tu proyecto real: aparecen
rutas, nombres de clientes y tokens.

**Pantalla limpia.** 1920×1080, zoom 100 %, tema oscuro en OpenCode y en
Telegram (consistencia visual). Cerrá todo lo demás. Notificaciones de Windows en
*No molestar*: un toast de WhatsApp en el medio arruina la toma.

**Datos falsos pero creíbles.** Chat llamado "OpenCode", un solo usuario. Si
grabás con tu nombre real, se ve en internet para siempre.

**Verificá que no se filtre nada.** Antes de exportar, mirá el GIF cuadro por
cuadro buscando: tokens, IPs, rutas con tu usuario de Windows, nombres de
proyectos privados, badges de mensajes sin leer con nombres.

**Layout de una sola toma.** No compongas nada en post: abrí OpenCode a la
izquierda y Telegram Desktop a la derecha, angosto (~420 px). Una sola
grabación, sin costuras. Telegram Desktop con el tema oscuro y la fuente un poco
más grande de lo normal — en un GIF de 900 px, el texto chico es ilegible.

**Grabá a 30 fps y después bajá.** ScreenToGif (Windows, gratis) o OBS. Guardá el
crudo en `.mp4`/`.mov`: el GIF se deriva, no se graba.

---

## Plano por plano

| Tiempo | En pantalla | Acción | Qué tiene que entender el que mira |
|---|---|---|---|
| 0.0–2.5 s | OpenCode corriendo una tarea | El agente escribe código; en el hilo de Telegram el mensaje se actualiza en vivo | "Esto es un agente real trabajando, y lo estoy viendo desde el teléfono" |
| 2.5–6.5 s | Aparece la tarjeta de permiso en Telegram | Tocar **Permitir una vez**; en el desktop la tarea sigue sola | "Puedo destrabar al agente sin estar en la compu" |
| 6.5–10.5 s | Hilo de la sesión | Mantener el micrófono y mandar una nota de voz corta ("agregá tests para el parser") | "Puedo hablarle, no solo tipear" |
| 10.5–13.0 s | El mismo hilo | La transcripción aparece como texto y el agente arranca el turno | "La voz se convierte en prompt, y funciona" |
| 13.0–16.0 s | El hilo | Llega el archivo que produjo el agente (imagen o `.patch`), se ve la miniatura | "Los resultados también vuelven" |
| 16.0–18.0 s | `/dashboard on` en el hilo | Aparece el panel con modelo, tokens y estado; congelar 1 s | "Hay profundidad detrás; no es un juguete" |

Si no tenés la voz configurada (whisper.cpp + ffmpeg + modelo), **cambiá el
plano 3–4 por una foto**: mandar la captura de un error y que el agente la lea.
No finjas la voz: se nota y el que la prueba se decepciona.

**Texto en pantalla.** Tres carteles como máximo, tipografía grande, 4 palabras:
`Agent running` → `Approve from your phone` → `Voice in, files out`. Sin sonido,
el GIF tiene que explicarse solo. Si tu audiencia es hispanohablante, los
carteles en español; si va al Discord de OpenCode, en inglés.

**Ritmo.** Acelerá las esperas reales (el agente tarda) a 1.5×–2×. Un GIF donde
no pasa nada durante tres segundos se percibe como roto. Nunca aceleres el toque
del permiso ni la llegada del archivo: son los momentos que venden.

**Loop.** Empezá y terminá en un estado parecido (hilo abierto, sin diálogos
colgando). Un loop que salta se ve amateur.

---

## Exportar

Grabá el crudo, recortá a la zona útil y generá el GIF con la paleta óptima — no
con el exportador por defecto, que produce 20 MB:

```powershell
# 1) recorte + 12 fps + paleta adaptativa (900 px de ancho)
ffmpeg -i demo.mov -vf "crop=1500:900:380:120,fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 demo.gif

# 2) si supera 4 MB: bajá a 10 fps y 800 px
ffmpeg -i demo.mov -vf "crop=1500:900:380:120,fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 demo.gif

# 3) el MP4 para X / HN / dev.to (mejor calidad, mismo contenido)
ffmpeg -i demo.mov -vf "scale=1280:-2" -c:v libx264 -crf 20 -pix_fmt yuv420p demo.mp4
```

`crop=1500:900:380:120` es un ejemplo: ajustá los cuatro números a tu layout
(ancho, alto, x, y). Verificá el resultado mirándolo **en el celular**, no en el
monitor: si en el teléfono no se lee, no sirve.

---

## Dónde va

1. Copiá `demo.gif` a `docs/assets/demo.gif` (esa carpeta no viaja al paquete
   npm: `files` solo publica `docs/**/*.md`, y está bien — el GIF pesa más de lo
   que debería pesar un paquete).
2. Insertalo con **URL absoluta**, no relativa. npm renderiza el README en su
   sitio, donde `docs/assets/demo.gif` no existe; la URL cruda funciona en
   GitHub y en npm.

En `README.md`, después del párrafo de "cero dependencias runtime" (línea 14) y
antes de `## Desde el teléfono`:

```md
![opencode-tg: el agente en la compu, el control en el teléfono](https://raw.githubusercontent.com/par4987/opencode-tg/main/docs/assets/demo.gif)
```

En `README.en.md`, en el mismo lugar (después de la línea 14, antes de
`## From your phone`):

```md
![opencode-tg: the agent on your PC, the remote in your pocket](https://raw.githubusercontent.com/par4987/opencode-tg/main/docs/assets/demo.gif)
```

3. **Social preview** (Settings → Social preview): 1280×640 PNG. Sacá un cuadro
   del GIF donde se vean las dos mitades, agregale el nombre y una línea. Se usa
   cuando alguien pega el link en Discord, X o Slack — es la primera impresión
   antes de que exista el clic.

---

## Errores que arruinan un GIF de proyecto

- **Grabar el proyecto real.** Tarde o temprano se filtra una ruta o un token.
- **Mostrar todo.** Diez features en 20 s = ninguna recordada.
- **Texto ilegible.** Si el que mira tiene que hacer zoom, perdiste.
- **Cursor temblando o búsquedas de menús.** Ensayá la toma dos veces; el GIF se
  graba en la tercera.
- **GIF de 15 MB.** No carga en el celular con datos.
- **Prometer algo que el repo no hace.** El GIF es la promesa; el README es la
  letra chica. Que coincidan.
