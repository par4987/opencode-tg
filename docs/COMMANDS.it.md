# Guida ai comandi

Ogni comando con cosa fa, come si usa, esempi e note. Il menu `/help` su
Telegram offre gli stessi comandi — toccane uno e ricevi la sua sezione.

## Sessioni

### /new

**Cosa fa**: Crea una sessione nuova nel progetto che scegli, con il suo thread di Telegram aperto subito.

**Utilizzo**: `/new <titolo?>`

**Esempi**:
- `/new Analisi delle vendite` → mostra il selettore di progetto; toccandone uno crea la sessione "Analisi delle vendite" lì
- `/new` → chiede il titolo in chat e, una volta dato, mostra il selettore

**Note**:
- Il progetto della conversazione attuale arriva per primo nel selettore (✅) — è il default: un tocco ed è fatto.
- "➕ Nuovo progetto…" chiede un nome e crea quella cartella a fianco del progetto attuale; la sessione ci si apre dentro.
- Il thread si apre al momento della creazione (prima nasceva con il primo messaggio): scrivici e la sessione sta già ascoltando.
- Scegli provider e modello nel thread nuovo: si apre sul provider del modello di default del progetto, con quel modello segnato ✅ — un tocco lo mantiene, oppure esplora gli altri. Lo stesso dopo con `/models`.
- Se `/new` viene mandato senza titolo, il prossimo messaggio scritto in quel thread entro 10 minuti è il nome.

### /use

**Cosa fa**: Definisce in quale sessione vanno i messaggi della radice della chat.

**Utilizzo**: `/use <ses_id>`

**Esempi**:
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → la radice punta a quella sessione
- `/use` → mostra la sessione attuale

**Note**: I messaggi in un thread vanno sempre alla sessione di quel thread, a prescindere da `/use`.

### /fork

**Cosa fa**: Biforca una sessione fino al suo ultimo messaggio — prova idee senza sporcare l'originale.

**Utilizzo**: `/fork` (nel thread) o `/fork <ses_id>`

**Esempi**:
- `/fork` nel thread di una sessione → crea un fork e te lo comunica
- `/fork ses_xxx` → idem da qualsiasi punto

**Note**: Il fork è una sessione nuova con il suo thread. L'originale resta intatto.

### /rename

**Cosa fa**: Rinomina una sessione — il thread di Telegram e il desktop seguono il cambiamento.

**Utilizzo**: `/rename <titolo>` o `/rename <ses_id> <titolo>`

**Esempi**:
- `/rename Analisi Q4` → rinomina la sessione del thread
- `/rename` (senza titolo) → suggerisce 3 titoli dal transcript e scegli con un tocco

**Note**: Il titolo viene capato a 128 caratteri (il limite di Telegram per il nome dei topic).

### /detach

**Cosa fa**: Scollega la radice della chat dalla sua sessione — quello che scrivi lì non va più a nessuna sessione.

**Utilizzo**: `/detach`

**Esempi**:
- `/detach` → la radice resta libera
- `/use <ses_id>` → ricollega

**Note**: I thread di sessione non vengono toccati.

### /archive

**Cosa fa**: Archivia la sessione del thread — in chat privata elimina il thread e silenzia la sessione.

**Utilizzo**: `/archive` o `/archive <ses_id>`

**Esempi**:
- `/archive` in un thread → il thread sparisce dalla chat
- `/archive ses_xxx` → idem da qualsiasi punto (l'id accetta un prefisso univoco)

**Note**: `/unarchive` la riporta indietro — da solo apre il selettore delle archiviate, quindi non serve l'id.

### /unarchive

**Cosa fa**: Risveglia una sessione archiviata — senza id apre il selettore; con del testo cerca per progetto, titolo o id.

**Utilizzo**: `/unarchive`, `/unarchive <testo>` o `/unarchive <ses_id>`

**Esempi**:
- `/unarchive` nella radice → apre il selettore con le sessioni archiviate, la più recente prima
- `/unarchive fatture` → il selettore con quelle che corrispondono (titolo, progetto o id)
- `/unarchive ses_ed2c` → risolve l'id per prefisso e la risveglia direttamente
- `/unarchive` in un thread vivo → avvisa che quella sessione non è archiviata

**Note**:
- Senza id non serve indovinare: il selettore elenca le archiviate con dei pulsanti (titolo · progetto · attività), in pagine da 8.
- Il `<testo>` serve come ricerca per **progetto** (il nome della cartella), per titolo o per prefisso di id.
- Un id è accettato per intero o per prefisso univoco, senza distinguere le maiuscole.
- Se il thread è stato cancellato, se ne crea uno nuovo con il titolo attuale.
- In chat privata `/archive` elimina il thread, quindi `/unarchive` lo ricrea; la sessione sul PC non viene mai toccata.

### /delthread

**Cosa fa**: Cancella il thread del forum senza toccare la sessione.

**Utilizzo**: `/delthread` o `/delthread <ses_id>`

**Esempi**:
- `/delthread` in un thread → il thread sparisce

**Note**: La sessione continua a esistere — il suo prossimo evento ricrea il thread. Per silenziarla: `/archive`. L'id accetta un prefisso univoco, senza distinguere le maiuscole.

### /rebuild

**Cosa fa**: Cancella TUTTI i thread di sessione e ricostruisce il forum pulito.

**Utilizzo**: `/rebuild` (con conferma inline)

**Esempi**:
- `/rebuild` → cancella i thread mappati (uno per uno, confermati) e ricrea quelli delle sessioni che hai usato di recente (fino a 12, la più recente in cima)

**Note**: I messaggi vecchi non vengono re-importati — `/export` scarica il transcript di ogni sessione. Ricrea thread solo per le sessioni usate dentro le ultime `rebuildIdleHours` (24 h di default): il server riscrive il campo `updated` di tutte le sessioni al riavvio, quindi ordinarci su resuscitava sessioni che nessuno toccava da giorni; `idle` è l'ultima attività reale. Ogni cancellazione viene confermata prima di dimenticare il mapping — se Telegram ne rifiuta una (rate limit, interruzione), il thread resta mappato e il prossimo `/rebuild` ritenta; una sessione il cui thread è sopravvissuto non viene duplicata. I thread **orfani** (senza mapping) non si possono pulire da soli: la Bot API non ha "elenca i topic", quindi vanno cancellati a mano una sola volta.

## File e codice

### /ls

**Cosa fa**: Naviga i file del progetto della sessione.

**Utilizzo**: `/ls [cartella]`

**Esempi**:
- `/ls` → elenca la cartella radice del progetto
- `/ls src` → entra nella cartella src
- Tocca un file → lo scarica
- 📎 su un file di testo → lo allega al prossimo messaggio

**Note**: Gli indici dei pulsanti scadono — se un tocco dice "listing vecchio", riapri `/ls`.

### /find

**Cosa fa**: Ricerca fuzzy di file per nome.

**Utilizzo**: `/find <testo>`

**Esempi**:
- `/find navbar` → file il cui nome contiene "navbar"
- `/find .test.` → file con ".test." nel nome

**Note**: Cerca in tutto il progetto della sessione.

### /git

**Cosa fa**: Cosa ha toccato l'agente nel progetto — stato con `+/−` e diff scaricabile.

**Utilizzo**: `/git`

**Esempi**:
- `/git` → stato del progetto
- "Vedi il diff" → anteprima + `.patch` scaricabile

**Note**: È il diff del progetto, non della sessione — più agenti possono condividerlo.

### /revert

**Cosa fa**: Annulla l'ultimo turno di una sessione (con conferma).

**Utilizzo**: `/revert` o `/revert <ses_id>`

**Esempi**:
- `/revert` in un thread → propone di annullare l'ultimo turno
- Confermi con il pulsante → il turno viene annullato

**Note**: Annulla solo l'ultimo turno. Per più di uno: `/revert` ripetuto.

### /export

**Cosa fa**: Scarica il transcript completo di una sessione in JSON.

**Utilizzo**: `/export` o `/export <ses_id>`

**Esempi**:
- `/export` in un thread → ti arriva il JSON del transcript
- `/export ses_xxx` → idem da qualsiasi punto

**Note**: Con la sessione aperta sul PC, l'export è completo. Chiusa, può non esserci transcript su disco (bug di persistenza del server).

### /sh

**Cosa fa**: Esegue un comando shell DENTRO la sessione — in background, senza svegliare l'agente.

**Utilizzo**: `/sh <comando>`

**Esempi**:
- `/sh node -v` → `v24.21.0`
- `/sh git status` → lo stato del repo
- `/sh ls` → il contenuto della cartella

**Note**: La shell della sessione è PowerShell — `&&` non funziona, usa `;`. L'output arriva nel thread.

**Comandi protetti**: il comando viene **parserizzato** (non cercato per regex: i nomi veri, con gli alias risolti) e cade in uno di tre livelli:

- **Passa diretto**: pura lettura (`Get-*`, `Test-*`, `ls`, `cat`) e la toolchain di sviluppo (`git`, `node`, `npm`, `cargo`, `python`...). Un falso positivo qui farebbe sì che il bot chiedesse conferma prima di ogni `git status`.
- **Chiede conferma**: il recuperabile ma che può tagliare il servizio o uscire dalla macchina — riavviare il server, uccidere processi, installare software, chiamate di rete, esecuzione remota, attività pianificate. La scheda **spiega cosa fa ogni comando** (cosa succederà, non solo il testo) e bisogna toccare "Conferma ed esegui". Il pendente viene cancellato **prima** dell'esecuzione, quindi un crash non lo riattiva.
- **Bloccato, senza eccezione**: quello che non ha ritorno — formattazione e cancellazione di dischi, boot e ripristino del sistema, registro, utenti e credenziali, segreti (`.env`, `.ssh`, profili dei browser, il drive `Env:`), difese (antivirus, firewall, BitLocker), cancellazione di log e tutti i vettori di evasione (`iex`, `Invoke-Command`, `powershell`/`cmd` annidati, `-EncodedCommand`, `Add-Type`, accesso diretto a .NET/COM, definizione di funzioni e alias). Nemmeno confermandolo viene eseguito: per quello c'è la console del PC.

La cancellazione è **limitata per percorso**: `Remove-Item` (e `rm`, `del`, `rmdir`...) è consentito dentro la cartella del progetto — un agente che scrive codice deve poter cancellare `node_modules` — e bloccato fuori. Cancellare il progetto intero (`.`) o il `.git` chiede conferma.

**Perché** (incidente 2026-10-07): `/sh opencode service restart` uccise il processo che ospita il plugin; siccome l'offset del poll stava solo in memoria, Telegram reinviava l'update a ogni riavvio e il server è entrato in un loop di ~10 s finché il plugin non è stato disattivato a mano. L'offset persistente è la cura; questo guard è la prevenzione.

### /note

**Cosa fa**: Lascia una nota nel transcript — l'agente la vedrà nel suo prossimo turno, senza svegliarsi ora.

**Utilizzo**: `/note <testo>`

**Esempi**:
- `/note Dare priorità al modulo vendite` → l'agente lo vede come contesto

**Note**: È un messaggio sintetico — non fa girare l'agente.

### /turns

**Cosa fa**: Cosa hanno cambiato i turni della sessione — più fine di `/git`.

**Utilizzo**: `/turns` o `/turns <ses_id>`

**Esempi**:
- `/turns` in un thread → i cambiamenti dei turni

**Note**: Può essere vuoto se il server non ha registrato cambi di turno.

## Progetto e config

### /config

**Cosa fa**: Legge e modifica l'`opencode.jsonc` del progetto — il modello di default delle sessioni nuove.

**Utilizzo**: `/config` o `/config model <provider/modello>`

**Esempi**:
- `/config` → mostra la config attuale
- `/config model nvidia/z-ai/glm-5.3` → cambia il default (ricarica dal vivo)

**Note**: Il cambio vale per le sessioni NUOVE — non serve riavviare il server.

### /worktree

**Cosa fa**: Elenca i worktree del progetto o ne crea uno nuovo.

**Utilizzo**: `/worktree` o `/worktree new <nome>`

**Esempi**:
- `/worktree` → elenco con pulsanti che aprono sessioni in ogni worktree
- `/worktree new feature-x` → crea il worktree

**Note**: Tocca un worktree per aprirci una sessione.

### /move

**Cosa fa**: Sposta una sessione in un altro progetto.

**Utilizzo**: `/move <cartella>`

**Esempi**:
- `/move E:\Projects\Altro` → la sessione del thread si sposta in quel progetto

**Note**: Il thread di Telegram resta uguale — cambia solo la cartella di lavoro.

### /mcp

**Cosa fa**: Elenca i server MCP oppure ne connette/disconnette uno.

**Utilizzo**: `/mcp` o `/mcp connect|disconnect <server>`

**Esempi**:
- `/mcp` → elenco con stato (🟢 connesso / 🔴 no)
- `/mcp disconnect abap-docs` → lo disconnette
- `/mcp connect abap-docs` → lo riconnette

**Note**: Aggiungere un server nuovo (PUT) resta al PC.

### /commands

**Cosa fa**: Elenca i comandi custom della config oppure ne esegue uno.

**Utilizzo**: `/commands` o `/commands run <testo>`

**Esempi**:
- `/commands` → elenco (init, review, ecc.)
- `/commands run init` → esegue il comando "init" nella sessione del thread

**Note**: I comandi custom si definiscono nell'`opencode.jsonc` del progetto.

## Info e debug

### /locale

**Cosa fa**: Cambia la lingua del bot — il menu `/help`, le schede e tutti i messaggi seguono all'istante.

**Utilizzo**: `/locale` (con pulsanti) o `/locale <es|en|pt|de|fr|it|id|ru|tr|zh|ko>`

**Esempi**:
- `/locale` → scheda con un pulsante per lingua (quella attiva con ✓)
- `/locale it` → cambia direttamente; la conferma arriva NELLA lingua scelta

**Note**: La scelta persists in `~/.opencode/tg/locale.txt` — un riavvio non la perde. `TG_LOCALE` in `.env` è solo il valore iniziale. Una lingua nuova è un oggetto nuovo in `CATALOGS` (src/locale.ts) più il suo `COMMANDS.<lingua>.md` — nessun codice extra.

### /bots

**Cosa fa**: Mostra la distribuzione multi-bot: quale bot specchia quale progetto o sessione, chi è libero e il bot principale (hub) che copre tutto il resto.

**Utilizzo**: `/bots`

**Esempi**:
- `/bots` → una riga per bot con il suo claim (progetto, sessione o "libero") e la topologia attiva

**Note**: I bot extra si dichiarano come `TELEGRAM_BOT_TOKEN_<NOME>` in `~/.opencode/tg/.env` — mai nel repo. La topologia (`single` / `per-project` / `per-session`) e il mapping esplicito (`assign`) vivono nel blocco `"bots"` di `config.json`. Con un solo bot, la scheda spiega come aggiungerne un altro. Ogni bot extra ha bisogno dei topics abilitati su BotFather, come il principale.

### /release

**Cosa fa**: Rende QUESTO bot al pool — solo in topologia `per-session`. La sua sessione passa all'hub finché un'altra non la reclama.

**Utilizzo**: `/release` (dalla chat del bot che vuoi liberare)

**Esempi**:
- `/release` → "🧹 liberato — la sua sessione torna all'hub"

**Note**: Il bot torna anche da solo quando archivi (`/archive`) la sessione che lo aveva reclamato. In `single` e `per-project` il comando risponde che non si applica. Alla riattivazione della sessione, il suo prossimo turno reclama un bot libero automaticamente.

### /context

**Cosa fa**: Token, costo, limite del modello e compressioni di una sessione.

**Utilizzo**: `/context` o `/context <ses_id>`

**Esempi**:
- `/context` in un thread → l'uso di contesto di quella sessione

**Note**: Il modello si recupera dal transcript se il payload del server non lo traccia.

### /usage

**Cosa fa**: Token e costo di una sessione, con provider e modello.

**Utilizzo**: `/usage` o `/usage <ses_id>`

**Esempi**:
- `/usage` in un thread → `🧪 nvidia · z-ai/glm-5.3 · agente build` + token

**Note**: Modello e agente si recuperano dal transcript quando il payload li dimentica.

### /history

**Cosa fa**: La fine della conversazione di una sessione.

**Utilizzo**: `/history` o `/history <ses_id>`

**Esempi**:
- `/history` in un thread → gli ultimi 16 messaggi

**Note**: Legge dal server (sessione attiva) o dal transcript su disco.

### /log

**Cosa fa**: Un campione del log lato server della sessione.

**Utilizzo**: `/log` o `/log <ses_id>`

**Esempi**:
- `/log` in un thread → gli ultimi 10 eventi del log

**Note**: È una finestra di lettura — non è il log completo.

### /ci

**Cosa fa**: Mostra le ultime esecuzioni GitHub Actions del repo — quale workflow, su quale commit e verde o rosso. Quello che prova che un push è arrivato intero: typecheck, suite e, due volte a settimana, il sigillo delle dipendenze.

**Utilizzo**: `/ci`, `/ci <n>` o `/ci <workflow>`

**Esempi**:
- `/ci` → le ultime 6 esecuzioni con il loro stato e un link allo sha
- `/ci 12` → le ultime 12
- `/ci deps` → solo le esecuzioni del workflow `deps-audit`

**Note**: Legge l'API REST di GitHub senza dipendenze. Il repo è pubblico, quindi funziona senza token (60 richieste/ora per IP); un `GITHUB_TOKEN` in `~/.opencode/tg/.env` alza il limite e raggiunge repo privati. Il repo di default è `par4987/opencode-tg` — un fork lo cambia con `"ci": { "repo": "owner/repo" }` in `config.json` o `TG_CI_REPO`.

### /terminal

**Cosa fa**: Il terminale della sessione, in sola lettura.

**Utilizzo**: `/terminal` o `/terminal <ses_id>`

**Esempi**:
- `/terminal` in un thread → le ultime righe del terminale

**Note**: Compare quando l'agente esegue qualcosa di interattivo. Il controllo resta sul PC.

### /perms

**Cosa fa**: Elenca i permessi "sempre" salvati oppure ne revoca uno.

**Utilizzo**: `/perms` o `/perms del <id>`

**Esempi**:
- `/perms` → i "🔁 Sempre" accumulati
- `/perms del psv_xxx` → ne revoca uno

**Note**: Revocare fa sì che il server torni a chiedere.

### /sessions

**Cosa fa**: Le sessioni che il server conosce.

**Utilizzo**: `/sessions`

**Esempi**:
- `/sessions` → elenco con stato (🎯 attiva, 📡 specchio, 💤 idle)

### /running

**Cosa fa**: Le sessioni con un turno in corso in questo momento.

**Utilizzo**: `/running`

**Esempi**:
- `/running` → cosa sta lavorando

### /models

**Cosa fa**: Cambia il modello della sessione — con selettore paginato.

**Utilizzo**: `/models` o `/models <testo>`

**Esempi**:
- `/models` → selettore con provider e modelli
- `/models glm` → filtra per "glm"

**Note**: Solo i modelli che il desktop abilita o che la config dichiara.

### /agents

**Cosa fa**: Cambia l'agente della sessione.

**Utilizzo**: `/agents` o `/agent`

**Esempi**:
- `/agents` → selettore degli agenti

### /projects

**Cosa fa**: Elenca i progetti per aprire una sessione nuova.

**Utilizzo**: `/projects`

**Esempi**:
- `/projects` → selettore dei progetti

### /tasks

**Cosa fa**: Elenca le attività pianificate del bot.

**Utilizzo**: `/tasks`

**Esempi**:
- `/tasks` → le attività con la loro prossima esecuzione

### /newtask

**Cosa fa**: Crea un'attività pianificata con un wizard di 6 passaggi.

**Utilizzo**: `/newtask`

**Esempi**:
- `/newtask` → wizard: nome, prompt, progetto, modello, pianificazione, dettaglio

### /skills

**Cosa fa**: Elenca le skill installate e ne arma una per il prossimo messaggio.

**Utilizzo**: `/skills` o `/skill <id> <testo>`

**Esempi**:
- `/skills` → selettore delle skill
- Toccane una → scrivi il prompt

## Chat e coda

### /queue

**Cosa fa**: I messaggi in sospeso della posta in arrivo della sessione.

**Utilizzo**: `/queue` o `/queue <ses_id>`

**Esempi**:
- `/queue` → elenco con riordina (↑↓), anticipa (▶), cancella (✖), sostituisci (✏️)

**Note**: Le voci di compressioni e spostamenti sono già etichettate.

### /flush

**Cosa fa**: Porta nel turno in corso tutto quello che la posta in arrivo trattiene.

**Utilizzo**: `/flush` o `/flush <testo>`

**Esempi**:
- `/flush` → svuota la posta in arrivo nel turno
- `/flush fai X` → inietta il testo nel turno ADESSO

**Note**: Con del testo è steering diretto — entra nel turno in corso.

### /clearqueue

**Cosa fa**: Cancella tutti i messaggi in sospeso della posta in arrivo.

**Utilizzo**: `/clearqueue` o `/clearqueue <ses_id>`

**Esempi**:
- `/clearqueue` → cancella tutto

### /send

**Cosa fa**: Manda un prompt a una sessione da qualsiasi punto.

**Utilizzo**: `/send <testo>` o `/send <ses_id> <testo>`

**Esempi**:
- `/send fai un riassunto` → va alla sessione del thread
- `/send ses_xxx fai X` → va a quella sessione

### /txt

**Cosa fa**: Risposta libera a una domanda aperta dell'agente.

**Utilizzo**: `/txt <risposta>`

**Esempi**:
- `/txt L'opzione B` → risponde alla domanda attiva

### /menu

**Cosa fa**: Menu dei comandi con pulsanti.

**Utilizzo**: `/menu`

**Esempi**:
- `/menu` → tastiera con i comandi principali

### /help

**Cosa fa**: Elenca i comandi con un menu per vedere il dettaglio di ciascuno.

**Utilizzo**: `/help`

**Esempi**:
- `/help` → elenco breve + tastiera
- Tocca un comando → la sua sezione dettagliata (cosa fa, utilizzo, esempi, note)

### /watch

**Cosa fa**: Controlla quali sessioni vengono monitorate nella chat.

**Utilizzo**: `/watch <id|all|off>`

**Esempi**:
- `/watch all` → monitora tutto
- `/watch ses_xxx` → monitora solo quella
- `/watch off` → non monitorare niente

**Note**: Con `mirror: all` nella config, `/watch <id>` silenzia le altre.
