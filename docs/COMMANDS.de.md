# Befehlsreferenz

Jeder Befehl mit dem, was er tut, wie man ihn nutzt, Beispielen und Hinweisen.
Das `/help`-Menü in Telegram bietet dieselben Befehle — tippe einen und erhalte
seinen Abschnitt.

## Sessions

### /new

**Was es tut**: Erzeugt eine neue Session im Projekt deiner Wahl, mit sofort geöffnetem Telegram-Thread.

**Verwendung**: `/new <titel?>`

**Beispiele**:
- `/new Verkaufsanalyse` → zeigt den Projekt-Picker; beim Tippen eines Projekts wird dort die Session „Verkaufsanalyse“ erstellt
- `/new` → fragt den Titel im Chat und zeigt danach den Picker

**Hinweise**:
- Das Projekt der aktuellen Konversation steht im Picker ganz oben (✅) — es ist das Default: ein Tipper genügt.
- „➕ Neues Projekt…“ fragt einen Namen und erstellt diesen Ordner neben dem aktuellen Projekt; die Session öffnet darin.
- Der Thread öffnet im Moment der Erstellung (früher entstand er mit der ersten Nachricht): schreib hinein und die Session hört bereits zu.
- Provider und Modell wählst du im neuen Thread: er öffnet beim Provider des Projekt-Defaults, mit diesem Modell markiert ✅ — ein Tipper behält es, oder navigiere zu einem anderen. Dasselbe danach mit `/models`.
- Wenn `/new` ohne Titel gesendet wird, ist die nächste Nachricht in diesem Thread innerhalb von 10 Minuten der Name.

### /use

**Was es tut**: Legt fest, in welche Session die Nachrichten der Chat-Wurzel gehen.

**Verwendung**: `/use <ses_id>`

**Beispiele**:
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → die Wurzel zeigt auf diese Session
- `/use` → zeigt die aktuelle Session

**Hinweise**: Nachrichten in einem Thread gehen immer an die Session dieses Threads, unabhängig von `/use`.

### /fork

**Was es tut**: Gabelt eine Session bis zu ihrer letzten Nachricht — teste Ideen, ohne die originalen zu verunstalten.

**Verwendung**: `/fork` (im Thread) oder `/fork <ses_id>`

**Beispiele**:
- `/fork` im Thread einer Session → erstellt einen Fork und benachrichtigt dich
- `/fork ses_xxx` → dasselbe von überall

**Hinweise**: Der Fork ist eine neue Session mit ihrem eigenen Thread. Das Original bleibt unversehrt.

### /rename

**Was es tut**: Benennt eine Session um — der Telegram-Thread und das Desktop folgen der Änderung.

**Verwendung**: `/rename <titel>` oder `/rename <ses_id> <titel>`

**Beispiele**:
- `/rename Analyse Q4` → benennt die Session des Threads um
- `/rename` (ohne Titel) → schlägt 3 Titel aus dem Transcript vor, du wählst mit einem Tipper

**Hinweise**: Der Titel wird auf 128 Zeichen begrenzt ( Telegrams Themenname-Limit).

### /detach

**Was es tut**: Entkoppelt die Chat-Wurzel von ihrer Session — was du dort schreibst, geht an keine Session mehr.

**Verwendung**: `/detach`

**Beispiele**:
- `/detach` → die Wurzel wird frei
- `/use <ses_id>` → koppelt wieder an

**Hinweise**: Session-Threads sind davon nicht betroffen.

### /archive

**Was es tut**: Archiviert die Session des Threads — im privaten Chat wird der Thread entfernt und die Session stumm geschaltet.

**Verwendung**: `/archive` oder `/archive <ses_id>`

**Beispiele**:
- `/archive` in einem Thread → der Thread verschwindet aus dem Chat
- `/archive ses_xxx` → dasselbe von überall (die ID akzeptiert ein eindeutiges Präfix)

**Hinweise**: `/unarchive` holt sie zurück — ohne Argument öffnet es den Picker der Archivierten, die ID wird also nicht benötigt.

### /unarchive

**Was es tut**: Weckt eine archivierte Session — ohne ID öffnet es den Picker; mit Text wird nach Projekt, Titel oder ID gesucht.

**Verwendung**: `/unarchive`, `/unarchive <text>` oder `/unarchive <ses_id>`

**Beispiele**:
- `/unarchive` in der Wurzel → öffnet den Picker mit den archivierten Sessions, die jüngste zuerst
- `/unarchive rechnungen` → der Picker mit den Treffern (Titel, Projekt oder ID)
- `/unarchive ses_ed2c` → löst die ID per Präfix und weckt sie direkt
- `/unarchive` in einem lebenden Thread → meldet, dass diese Session nicht archiviert ist

**Hinweise**:
- Ohne ID musst du nichts erraten: der Picker listet die Archivierten mit Buttons (Titel · Projekt · Aktivität), in 8er-Seiten.
- Der `<text>` dient der Suche nach **Projekt** (dem Ordnernamen), Titel oder ID-Präfix.
- Eine ID wird vollständig oder als eindeutiges Präfix akzeptiert, ohne Groß-/Kleinschreibung zu unterscheiden.
- Falls der Thread gelöscht wurde, wird ein neuer mit dem aktuellen Titel erstellt.
- Im privaten Chat löscht `/archive` den Thread, daher erstellt `/unarchive` ihn neu; die Session auf dem PC wird nie angerührt.

### /delthread

**Was es tut**: Löscht den Foren-Thread, ohne die Session zu berühren.

**Verwendung**: `/delthread` oder `/delthread <ses_id>`

**Beispiele**:
- `/delthread` in einem Thread → der Thread verschwindet

**Hinweise**: Die Session existiert weiter — ihr nächstes Ereignis erstellt den Thread neu. Um sie stumm zu schalten: `/archive`. Die ID akzeptiert ein eindeutiges Präfix, ohne Groß-/Kleinschreibung.

### /rebuild

**Was es tut**: Löscht ALLE Session-Threads und baut das Forum sauber wieder auf.

**Verwendung**: `/rebuild` (mit Inline-Bestätigung)

**Beispiele**:
- `/rebuild` → löscht die gemappten Threads (einzeln, bestätigt) und erstellt die der Sessions neu, die du zuletzt genutzt hast (bis 12, die jüngste oben)

**Hinweise**: Alte Nachrichten werden nicht re-importiert — `/export` lädt das Transcript jeder Session herunter. Threads werden nur für Sessions erstellt, die du innerhalb von `rebuildIdleHours` (Standard 24 h) genutzt hast: der Server überschreibt beim Neustart das `updated`-Feld aller Sessions, sodass eine Sortierung danach Sessions auferstehen ließ, die niemand seit Tagen angerührt hat; `idle` ist die echte letzte Aktivität. Jede Löschung wird bestätigt, bevor das Mapping vergessen wird — lehnt Telegram eines ab (Rate-Limit, Abbruch), bleibt der Thread gemappt und der nächste `/rebuild` versucht es erneut; eine Session, deren Thread überlebte, wird nicht dupliziert. **Verwaiste** Threads (ohne Mapping) können nicht von allein weg: die Bot-API hat kein „Themen auflisten“, daher muss man sie einmal per Hand löschen.

## Dateien und Code

### /ls

**Was es tut**: Navigiert die Dateien des Projekts der Session.

**Verwendung**: `/ls [ordner]`

**Beispiele**:
- `/ls` → listet das Wurzelverzeichnis des Projekts
- `/ls src` → betritt den Ordner src
- Tippe eine Datei → lädt sie herunter
- 📎 bei einer Textdatei → hängt sie an die nächste Nachricht an

**Hinweise**: Die Indizes der Buttons verfallen — wenn ein Tipper „Listing veraltet“ sagt, öffne `/ls` erneut.

### /find

**Was es tut**: Fuzzy-Suche nach Dateinamen.

**Verwendung**: `/find <text>`

**Beispiele**:
- `/find navbar` → Dateien, deren Name „navbar“ enthält
- `/find .test.` → Dateien mit „.test.“ im Namen

**Hinweise**: Sucht im gesamten Projekt der Session.

### /git

**Was es tut**: Was der Agent im Projekt angerührt hat — Status mit `+/−` und herunterladbarer Diff.

**Verwendung**: `/git`

**Beispiele**:
- `/git` → Status des Projekts
- „Diff ansehen“ → Vorschau + herunterladbares `.patch`

**Hinweise**: Es ist der Diff des Projekts, nicht der Session — mehrere Agenten können es sich teilen.

### /revert

**Was es tut**: Macht den letzten Turn einer Session rückgängig (mit Bestätigung).

**Verwendung**: `/revert` oder `/revert <ses_id>`

**Beispiele**:
- `/revert` in einem Thread → schlägt vor, den letzten Turn rückgängig zu machen
- Du bestätigst mit dem Button → der Turn wird rückgängig gemacht

**Hinweise**: Macht nur den letzten Turn rückgängig. Für mehrere: `/revert` wiederholt.

### /export

**Was es tut**: Lädt das vollständige Transcript einer Session als JSON herunter.

**Verwendung**: `/export` oder `/export <ses_id>`

**Beispiele**:
- `/export` in einem Thread → das JSON des Transcripts kommt zu dir
- `/export ses_xxx` → dasselbe von überall

**Hinweise**: Mit auf dem PC geöffneter Session ist der Export vollständig. Geschlossen kann ein Transcript auf der Festplatte fehlen (Persistenz-Bug des Servers).

### /sh

**Was es tut**: Führt einen Shell-Befehl INNERHALB der Session aus — im Hintergrund, ohne den Agenten zu wecken.

**Verwendung**: `/sh <befehl>`

**Beispiele**:
- `/sh node -v` → `v24.21.0`
- `/sh git status` → der Status des Repos
- `/sh ls` → der Inhalt des Verzeichnisses

**Hinweise**: Der Shell der Session ist PowerShell — `&&` funktioniert nicht, nutze `;`. Die Ausgabe kommt in den Thread.

**Geschützte Befehle**: der Befehl wird **geparst** (nicht per Regex gesucht: die echten Namen, mit aufgelösten Aliasen) und fällt in eine von drei Stufen:

- **Geht direkt durch**: reine Lesezugriffe (`Get-*`, `Test-*`, `ls`, `cat`) und die Entwicklungs-Toolchain (`git`, `node`, `npm`, `cargo`, `python`...). Ein Fehltreffer hier ließe den Bot vor jedem `git status` nachfragen.
- **Verlangt Bestätigung**: das Wiederherstellbare, das aber den Dienst unterbrechen oder die Maschine verlassen kann — Server-Neustart, Prozesse beenden, Software installieren, Netzwerkaufrufe, Remote-Ausführung, geplante Aufgaben. Die Karte **erklärt, was jeder Befehl tut** (was passieren wird, nicht nur den Text) und „Bestätigen und ausführen“ muss getippt werden. Das Pendente wird **vor** der Ausführung gelöscht, sodass ein Absturz es nicht erneut auslöst.
- **Blockiert, ohne Ausnahme**: das Unumkehrbare — Formatieren und Löschen von Laufwerken, Boot und Systemwiederherstellung, Registry, Benutzer und Credentials, Secrets (`.env`, `.ssh`, Browser-Profile, das Laufwerk `Env:`), Verteidigungen (Antivirus, Firewall, BitLocker), Löschen von Logs und alle Evasionsvektoren (`iex`, `Invoke-Command`, verschachteltes `powershell`/`cmd`, `-EncodedCommand`, `Add-Type`, direkter .NET/COM-Zugriff, Definition von Funktionen und Aliasen). Auch bei Bestätigung wird es nicht ausgeführt: dafür gibt es die Konsole des PCs.

Das Löschen ist **pfadbegrenzt**: `Remove-Item` (und `rm`, `del`, `rmdir`...) ist innerhalb des Projektordners erlaubt — ein Code-Agent muss `node_modules` löschen können — und außerhalb blockiert. Das gesamte Projekt (`.`) oder das `.git` zu löschen, verlangt Bestätigung.

**Warum** (Vorfall 2026-10-07): `/sh opencode service restart` tötete den Prozess, der das Plugin beherbergt; da der Poll-Offset nur im Speicher lag, lieferte Telegram das Update bei jedem Neustart erneut und der Server geriet in eine ~10-Sekunden-Schleife, bis das Plugin per Hand deaktiviert wurde. Der persistente Offset ist die Heilung; dieser Guard die Vorbeugung.

### /note

**Was es tut**: Hinterlässt eine Notiz im Transcript — der Agent liest sie in seinem nächsten Turn, ohne jetzt aufzuwachen.

**Verwendung**: `/note <text>`

**Beispiele**:
- `/note Verkaufsmodul priorisieren` → der Agent sieht es als Kontext

**Hinweise**: Es ist eine synthetische Nachricht — sie startet den Agenten nicht.

### /turns

**Was es tut**: Was sich in den Turns der Session geändert hat — feiner als `/git`.

**Verwendung**: `/turns` oder `/turns <ses_id>`

**Beispiele**:
- `/turns` in einem Thread → die Änderungen der Turns

**Hinweise**: Kann leer sein, wenn der Server keine Turn-Wechsel aufgezeichnet hat.

## Projekt und Konfiguration

### /config

**Was es tut**: Liest und bearbeitet die `opencode.jsonc` des Projekts — das Modell-Default neuer Sessions.

**Verwendung**: `/config` oder `/config model <provider/modell>`

**Beispiele**:
- `/config` → zeigt die aktuelle Konfiguration
- `/config model nvidia/z-ai/glm-5.3` → ändert das Default (lädt live neu)

**Hinweise**: Die Änderung gilt für NEUE Sessions — ein Neustart des Servers ist nicht nötig.

### /worktree

**Was es tut**: Listet die Worktrees des Projekts oder erstellt einen neuen.

**Verwendung**: `/worktree` oder `/worktree new <name>`

**Beispiele**:
- `/worktree` → Liste mit Buttons, die Sessions in jedem Worktree öffnen
- `/worktree new feature-x` → erstellt das Worktree

**Hinweise**: Tippe ein Worktree, um dort eine Session zu öffnen.

### /move

**Was es tut**: Verschiebt eine Session in ein anderes Projekt.

**Verwendung**: `/move <verzeichnis>`

**Beispiele**:
- `/move E:\Projects\Anderes` → die Session des Threads wird in dieses Projekt verschoben

**Hinweise**: Der Telegram-Thread bleibt derselbe — nur das Arbeitsverzeichnis ändert sich.

### /mcp

**Was es tut**: Listet die MCP-Server oder verbindet/trennt einen.

**Verwendung**: `/mcp` oder `/mcp connect|disconnect <server>`

**Beispiele**:
- `/mcp` → Liste mit Status (🟢 verbunden / 🔴 nicht)
- `/mcp disconnect abap-docs` → trennt ihn
- `/mcp connect abap-docs` → verbindet ihn wieder

**Hinweise**: Einen neuen Server hinzuzufügen (PUT) bleibt dem PC überlassen.

### /commands

**Was es tut**: Listet die Custom-Kommandos der Konfiguration oder führt eines aus.

**Verwendung**: `/commands` oder `/commands run <text>`

**Beispiele**:
- `/commands` → Liste (init, review, etc.)
- `/commands run init` → führt den Befehl „init“ in der Session des Threads aus

**Hinweise**: Custom-Kommandos werden in der `opencode.jsonc` des Projekts definiert.

## Info und Debug

### /locale

**Was es tut**: Wechselt die Sprache des Bots — das `/help`-Menü, die Karten und alle Nachrichten folgen sofort.

**Verwendung**: `/locale` (mit Buttons) oder `/locale <es|en|pt|de|fr|it|id|ru|tr|zh|ko|ar>`

**Beispiele**:
- `/locale` → Karte mit einem Button pro Sprache (die aktuelle mit ✓)
- `/locale de` → wechselt direkt; die Bestätigung kommt IN der gewählten Sprache

**Hinweise**: Die Wahl persists in `~/.opencode/tg/locale.txt` — ein Neustart verliert sie nicht. `TG_LOCALE` in `.env` ist nur der Anfangswert. Eine neue Sprache ist ein neues Objekt in `CATALOGS` (src/locale.ts) plus ihr `COMMANDS.<sprache>.md` — kein zusätzlicher Code.

### /bots

**Was es tut**: Zeigt die Multi-Bot-Verteilung: welcher Bot welches Projekt oder welche Session spiegelt, wer frei ist und der Hauptbot (Hub), der alles andere abdeckt.

**Verwendung**: `/bots`

**Beispiele**:
- `/bots` → eine Zeile pro Bot mit seinem Claim (Projekt, Session oder „frei“) und der aktiven Topologie

**Hinweise**: Extra-Bots werden als `TELEGRAM_BOT_TOKEN_<NAME>` in `~/.opencode/tg/.env` deklariert — nie im Repo. Die Topologie (`single` / `per-project` / `per-session`) und das explizite Mapping (`assign`) leben im Block `"bots"` von `config.json`. Mit nur einem Bot erklärt die Karte, wie man einen weiteren hinzufügt. Jeder extra Bot benötigt im Bot Father aktivierte Topics, genauso wie der Hauptbot.

### /release

**Was es tut**: Gibt DIESEN Bot an den Pool zurück — nur in der Topologie `per-session`. Ihre Session geht an den Hub, bis eine andere sie beansprucht.

**Verwendung**: `/release` (aus dem Chat des Bots, den du freigeben willst)

**Beispiele**:
- `/release` → „🧹 freigegeben — ihre Session kehrt zum Hub zurück“

**Hinweise**: Der Bot kehrt auch von selbst zurück, wenn die Session, die ihn beansprucht hatte, archiviert wird (`/archive`). In `single` und `per-project` antwortet der Befehl, dass er nicht zutrifft. Wenn die Session wieder aktiv wird, beansprucht ihr nächster Turn automatisch einen freien Bot.

### /context

**Was es tut**: Tokens, Kosten, Modell-Limit und Kompaktierungen einer Session.

**Verwendung**: `/context` oder `/context <ses_id>`

**Beispiele**:
- `/context` in einem Thread → die Kontextnutzung dieser Session

**Hinweise**: Das Modell wird aus dem Transcript gewonnen, wenn der Server-Payload es nicht führt.

### /usage

**Was es tut**: Tokens und Kosten einer Session, mit Provider und Modell.

**Verwendung**: `/usage` oder `/usage <ses_id>`

**Beispiele**:
- `/usage` in einem Thread → `🧪 nvidia · z-ai/glm-5.3 · Agent build` + Tokens

**Hinweise**: Modell und Agent werden aus dem Transcript gewonnen, wenn der Payload sie vergisst.

### /history

**Was es tut**: Das Ende der Konversation einer Session.

**Verwendung**: `/history` oder `/history <ses_id>`

**Beispiele**:
- `/history` in einem Thread → die letzten 16 Nachrichten

**Hinweise**: Liest vom Server (aktive Session) oder vom Transcript auf der Festplatte.

### /log

**Was es tut**: Eine Probe aus dem serverseitigen Log der Session.

**Verwendung**: `/log` oder `/log <ses_id>`

**Beispiele**:
- `/log` in einem Thread → die letzten 10 Ereignisse des Logs

**Hinweise**: Es ist ein Lesezeitfenster — nicht das vollständige Log.

### /ci

**Was es tut**: Zeigt die letzten GitHub-Actions-Runs des Repos — welcher Workflow, über welchem Commit, und grün oder rot. Der Beweis, dass ein Push unversehrt ankam: Typecheck, Suites und zweimal pro Woche das Abhängigkeits-Siegel.

**Verwendung**: `/ci`, `/ci <n>` oder `/ci <workflow>`

**Beispiele**:
- `/ci` → die letzten 6 Runs mit Status und einem Link zum Sha
- `/ci 12` → die letzten 12
- `/ci deps` → nur die Runs des Workflows `deps-audit`

**Hinweise**: Liest die GitHub-REST-API ohne Abhängigkeiten. Das Repo ist öffentlich, daher funktioniert es ohne Token (60 Abfragen/Stunde pro IP); ein `GITHUB_TOKEN` in `~/.opencode/tg/.env` hebt das Limit und erreicht private Repos. Das Standard-Repo ist `par4987/opencode-tg` — ein Fork ändert es über `"ci": { "repo": "owner/repo" }` in `config.json` oder `TG_CI_REPO`.

### /terminal

**Was es tut**: Das Terminal der Session, nur lesend.

**Verwendung**: `/terminal` oder `/terminal <ses_id>`

**Beispiele**:
- `/terminal` in einem Thread → die letzten Zeilen des Terminals

**Hinweise**: Erscheint, wenn der Agent etwas Interaktives ausführt. Die Kontrolle bleibt beim PC.

### /perms

**Was es tut**: Listet die gespeicherten „immer“-Berechtigungen oder widerruft eine.

**Verwendung**: `/perms` oder `/perms del <id>`

**Beispiele**:
- `/perms` → die angesammelten „🔁 Immer“
- `/perms del psv_xxx` → widerruft eine

**Hinweise**: Widerrufen lassen den Server wieder fragen.

### /sessions

**Was es tut**: Die Sessions, die der Server kennt.

**Verwendung**: `/sessions`

**Beispiele**:
- `/sessions` → Liste mit Status (🎯 aktiv, 📡 Spiegel, 💤 idle)

### /running

**Was es tut**: Die Sessions mit einem aktuell laufenden Turn.

**Verwendung**: `/running`

**Beispiele**:
- `/running` → was gerade arbeitet

### /models

**Was es tut**: Wechselt das Modell der Session — mit seitenweisem Picker.

**Verwendung**: `/models` oder `/models <text>`

**Beispiele**:
- `/models` → Picker mit Providern und Modellen
- `/models glm` → filtert nach „glm“

**Hinweise**: Nur Modelle, die das Desktop aktiviert oder die Konfiguration deklariert.

### /agents

**Was es tut**: Wechselt den Agenten der Session.

**Verwendung**: `/agents` oder `/agent`

**Beispiele**:
- `/agents` → Agenten-Picker

### /projects

**Was es tut**: Listet die Projekte, um eine neue Session zu öffnen.

**Verwendung**: `/projects`

**Beispiele**:
- `/projects` → Projekt-Picker

### /tasks

**Was es tut**: Listet die geplanten Aufgaben des Bots.

**Verwendung**: `/tasks`

**Beispiele**:
- `/tasks` → die Aufgaben mit ihrer nächsten Ausführung

### /newtask

**Was es tut**: Erstellt eine geplante Aufgabe mit einem 6-Schritte-Wizard.

**Verwendung**: `/newtask`

**Beispiele**:
- `/newtask` → Wizard: Name, Prompt, Projekt, Modell, Zeitplan, Detail

### /skills

**Was es tut**: Listet die installierten Skills und bestückt eine für die nächste Nachricht.

**Verwendung**: `/skills` oder `/skill <id> <text>`

**Beispiele**:
- `/skills` → Skill-Picker
- Tippe eine → schreib den Prompt

## Chat und Warteschlange

### /queue

**Was es tut**: Die ausstehenden Nachrichten im Posteingang der Session.

**Verwendung**: `/queue` oder `/queue <ses_id>`

**Beispiele**:
- `/queue` → Liste mit Neuordnen (↑↓), Vorziehen (▶), Abbrechen (✖), Ersetzen (✏️)

**Hinweise**: Kompaktierungs- und Verschiebungseinträge sind bereits markiert.

### /flush

**Was es tut**: Holt alles, was der Posteingang zurückhält, in den laufenden Turn.

**Verwendung**: `/flush` oder `/flush <text>`

**Beispiele**:
- `/flush` → leert den Posteingang in den Turn
- `/flush mach X` → injiziert den Text JETZT in den Turn

**Hinweise**: Mit Text ist es direktes Steering — es fließt in den laufenden Turn.

### /clearqueue

**Was es tut**: Bricht alle ausstehenden Nachrichten des Posteingangs ab.

**Verwendung**: `/clearqueue` oder `/clearqueue <ses_id>`

**Beispiele**:
- `/clearqueue` → bricht alles ab

### /send

**Was es tut**: Sendet einen Prompt an eine Session von überall.

**Verwendung**: `/send <text>` oder `/send <ses_id> <text>`

**Beispiele**:
- `/send fass zusammen` → geht an die Session des Threads
- `/send ses_xxx mach X` → geht an diese Session

### /txt

**Was es tut**: Freie Antwort auf eine offene Frage des Agenten.

**Verwendung**: `/txt <antwort>`

**Beispiele**:
- `/txt Option B` → beantwortet die aktive Frage

### /menu

**Was es tut**: Befehlsmenü mit Buttons.

**Verwendung**: `/menu`

**Beispiele**:
- `/menu` → Tastatur mit den Hauptbefehlen

### /help

**Was es tut**: Listet die Befehle mit einem Menü, um das Detail jedes einzelnen zu sehen.

**Verwendung**: `/help`

**Beispiele**:
- `/help` → kurze Liste + Tastatur
- Tippe einen Befehl → seinen detaillierten Abschnitt (was er tut, Verwendung, Beispiele, Hinweise)

### /watch

**Was es tut**: Steuert, welche Sessions im Chat beobachtet werden.

**Verwendung**: `/watch <id|all|off>`

**Beispiele**:
- `/watch all` → beobachte alles
- `/watch ses_xxx` → beobachte nur diese
- `/watch off` → beobachte nichts

**Hinweise**: Mit `mirror: all` in der Konfiguration stellt `/watch <id>` die anderen stumm.
