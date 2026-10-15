# Référence des commandes

Chaque commande avec ce qu'elle fait, comment l'utiliser, des exemples et des
notes. Le menu `/help` de Telegram propose ces mêmes commandes — touche-en une
et tu reçois sa section.

## Sessions

### /new

**Ce que ça fait**: Crée une nouvelle session dans le projet de ton choix, avec son sujet Telegram ouvert aussitôt.

**Utilisation**: `/new <titre?>`

**Exemples** :
- `/new Analyse des ventes` → affiche le sélecteur de projet ; en toucher un crée la session « Analyse des ventes » là-bas
- `/new` → demande le titre dans le chat puis, une fois donné, affiche le sélecteur

**Notes** :
- Le projet de la conversation actuelle arrive en premier dans le sélecteur (✅) — c'est le défaut : une touche suffit.
- « ➕ Nouveau projet… » demande un nom et crée ce dossier à côté du projet actuel ; la session s'ouvre dedans.
- Le sujet s'ouvre dès la création (avant il naissait avec le premier message) : écris dedans et la session écoute déjà.
- Tu choisis le fournisseur et le modèle dans le nouveau sujet : il s'ouvre sur le fournisseur du modèle par défaut du projet, avec ce modèle marqué ✅ — une touche le garde, ou navigue vers un autre. Pareil ensuite avec `/models`.
- Si `/new` est envoyé sans titre, le prochain message écrit dans ce sujet dans les 10 minutes est le nom.

### /use

**Ce que ça fait**: Définit vers quelle session vont les messages de la racine du chat.

**Utilisation**: `/use <ses_id>`

**Exemples** :
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → la racine pointe vers cette session
- `/use` → affiche la session actuelle

**Notes**: Les messages dans un sujet vont toujours à la session de ce sujet, peu importe `/use`.

### /fork

**Ce que ça fait**: Bifurque une session jusqu'à son dernier message — teste des idées sans salir l'originale.

**Utilisation**: `/fork` (dans le sujet) ou `/fork <ses_id>`

**Exemples** :
- `/fork` dans le sujet d'une session → crée un fork et t'avertit
- `/fork ses_xxx` → idem depuis n'importe où

**Notes**: Le fork est une nouvelle session avec son propre sujet. L'original reste intact.

### /rename

**Ce que ça fait**: Renomme une session — le sujet Telegram et le desktop suivent le changement.

**Utilisation**: `/rename <titre>` ou `/rename <ses_id> <titre>`

**Exemples** :
- `/rename Analyse Q4` → renomme la session du sujet
- `/rename` (sans titre) → propose 3 titres issus du transcript, tu choisis d'une touche

**Notes**: Le titre est plafonné à 128 caractères (la limite de nom de sujet de Telegram).

### /detach

**Ce que ça fait**: Détache la racine du chat de sa session — ce que tu y écris ne va plus à aucune session.

**Utilisation**: `/detach`

**Exemples** :
- `/detach` → la racine devient libre
- `/use <ses_id>` → rattache

**Notes**: Les sujets de session ne sont pas affectés.

### /archive

**Ce que ça fait**: Archive la session du sujet — en chat privé, cela supprime le sujet et met la session en sourdine.

**Utilisation**: `/archive` ou `/archive <ses_id>`

**Exemples** :
- `/archive` dans un sujet → le sujet disparaît du chat
- `/archive ses_xxx` → idem depuis n'importe où (l'identifiant accepte un préfixe unique)

**Notes**: `/unarchive` la ramène — sans argument il ouvre le sélecteur des archivées, l'identifiant n'est donc pas nécessaire.

### /unarchive

**Ce que ça fait** :Réveille une session archivée — sans identifiant ouvre le sélecteur ; avec du texte cherche par projet, titre ou identifiant.

**Utilisation**: `/unarchive`, `/unarchive <texte>` ou `/unarchive <ses_id>`

**Exemples** :
- `/unarchive` à la racine → ouvre le sélecteur avec les sessions archivées, la plus récente d'abord
- `/unarchive factures` → le sélecteur avec celles qui correspondent (titre, projet ou identifiant)
- `/unarchive ses_ed2c` → résout l'identifiant par préfixe et la réveille directement
- `/unarchive` dans un sujet vivant → indique que cette session n'est pas archivée

**Notes** :
- Sans identifiant, rien à deviner : le sélecteur liste les archivées avec des boutons (titre · projet · activité), par pages de 8.
- Le `<texte>` sert de recherche par **projet** (le nom du dossier), par titre ou par préfixe d'identifiant.
- Un identifiant est accepté en entier ou en préfixe unique, sans distinguer les majuscules.
- Si le sujet a été supprimé, un nouveau est créé avec le titre actuel.
- En chat privé `/archive` supprime le sujet, donc `/unarchive` le recrée ; la session sur le PC n'est jamais touchée.

### /delthread

**Ce que ça fait**: Supprime le sujet du forum sans toucher la session.

**Utilisation**: `/delthread` ou `/delthread <ses_id>`

**Exemples** :
- `/delthread` dans un sujet → le sujet disparaît

**Notes**: La session continue d'exister — son prochain événement recrée le sujet. Pour la mettre en sourdine : `/archive`. L'identifiant accepte un préfixe unique, sans distinguer les majuscules.

### /rebuild

**Ce que ça fait**: Supprime TOUS les sujets de sessions et reconstruit le forum à propre.

**Utilisation**: `/rebuild` (avec confirmation inline)

**Exemples** :
- `/rebuild` → supprime les sujets mappés (un par un, confirmés) et recrée ceux des sessions que tu as utilisées récemment (jusqu'à 12, la plus récente en haut)

**Notes**: Les anciens messages ne sont pas ré-importés — `/export` télécharge le transcript de chaque session. Il ne recrée des sujets que pour les sessions utilisées dans les derniers `rebuildIdleHours` (24 h par défaut) : le serveur écrase le champ `updated` de toutes les sessions au redémarrage, donc trier par lui ressuscitait des sessions que personne n'avait touchées depuis des jours ; `idle` est la dernière activité réelle. Chaque suppression est confirmée avant d'oublier le mappage — si Telegram en rejette une (limite de débit, coupure), le sujet reste mappé et le prochain `/rebuild` réessaie ; une session dont le sujet a survécu n'est pas dupliquée. Les sujets **orphelins** (sans mappage) ne peuvent pas être nettoyés tout seuls : la Bot API n'a pas de « lister les sujets », il faut donc les supprimer à la main une seule fois.

## Fichiers et code

### /ls

**Ce que ça fait**: Navigue les fichiers du projet de la session.

**Utilisation**: `/ls [dossier]`

**Exemples** :
- `/ls` → liste le répertoire racine du projet
- `/ls src` → entre dans le dossier src
- Touche un fichier → le télécharge
- 📎 sur un fichier texte → le joint au prochain message

**Notes**: Les index des boutons expirent — si une touche dit « listing périmé », rouvre `/ls`.

### /find

**Ce que ça fait**: Recherche floue de fichiers par nom.

**Utilisation**: `/find <texte>`

**Exemples** :
- `/find navbar` → les fichiers dont le nom contient « navbar »
- `/find .test.` → les fichiers avec « .test. » dans le nom

**Notes**: Cherche dans tout le projet de la session.

### /git

**Ce que ça fait**: Ce que l'agent a touché dans le projet — statut avec `+/−` et diff téléchargeable.

**Utilisation**: `/git`

**Exemples** :
- `/git` → statut du projet
- « Voir le diff » → aperçu + `.patch` téléchargeable

**Notes**: C'est le diff du projet, pas de la session — plusieurs agents peuvent se le partager.

### /revert

**Ce que ça fait**: Annule le dernier tour d'une session (avec confirmation).

**Utilisation**: `/revert` ou `/revert <ses_id>`

**Exemples** :
- `/revert` dans un sujet → propose d'annuler le dernier tour
- Tu confirmes avec le bouton → le tour est défait

**Notes**: N'annule que le dernier tour. Pour plusieurs : `/revert` répété.

### /export

**Ce que ça fait**: Télécharge le transcript complet d'une session en JSON.

**Utilisation**: `/export` ou `/export <ses_id>`

**Exemples** :
- `/export` dans un sujet → le JSON du transcript t'arrive
- `/export ses_xxx` → idem depuis n'importe où

**Notes**: Avec la session ouverte sur le PC, l'export est complet. Fermée, il peut ne pas y avoir de transcript sur le disque (bug de persistance du serveur).

### /sh

**Ce que ça fait**: Lance une commande shell DANS la session — en arrière-plan, sans réveiller l'agent.

**Utilisation**: `/sh <commande>`

**Exemples** :
- `/sh node -v` → `v24.21.0`
- `/sh git status` → le statut du dépôt
- `/sh ls` → le contenu du répertoire

**Notes**: Le shell de la session est PowerShell — `&&` ne fonctionne pas, utilise `;`. La sortie arrive dans le sujet.

**Commandes protégées**: la commande est **parsée** (pas cherchée par regex : les vrais noms, avec les alias résolus) et tombe dans un de trois niveaux :

- **Passe droit**: la lecture pure (`Get-*`, `Test-*`, `ls`, `cat`) et la chaîne de développement (`git`, `node`, `npm`, `cargo`, `python`...). Un faux positif ici ferait que le bot demande confirmation avant chaque `git status`.
- **Demande confirmation**: le récupérable mais qui peut couper le service ou quitter la machine — redémarrer le serveur, tuer des processus, installer des logiciels, des appels réseau, l'exécution à distance, les tâches planifiées. La carte **explique ce que fait chaque commande** (ce qui va se passer, pas juste le texte) et il faut toucher « Confirmer et exécuter ». Le pendant est effacé **avant** l'exécution, donc un crash ne le redéclenche pas.
- **Bloqué, sans exception**: ce qui est sans retour possible — formatage et effacement de disques, démarrage et récupération du système, registre, utilisateurs et identifiants, secrets (`.env`, `.ssh`, profils de navigateur, le lecteur `Env:`), défenses (antivirus, pare-feu, BitLocker), effacement de journaux, et tous les vecteurs d'évasion (`iex`, `Invoke-Command`, `powershell`/`cmd` imbriqués, `-EncodedCommand`, `Add-Type`, accès direct à .NET/COM, définition de fonctions et d'alias). Même confirmé, il ne s'exécute pas : pour ça il y a la console du PC.

L'effacement est **limité par chemin**: `Remove-Item` (et `rm`, `del`, `rmdir`...) est autorisé dans le dossier du projet — un agent de code doit pouvoir effacer `node_modules` — et bloqué au-dehors. Effacer le projet entier (`.`) ou le `.git` demande confirmation.

**Pourquoi** (incident 2026-10-07) : `/sh opencode service restart` a tué le processus qui héberge le plugin ; comme l'offset du poll n'était qu'en mémoire, Telegram renvoyait l'update à chaque redémarrage et le serveur est entré dans une boucle de ~10 s jusqu'à la désactivation manuelle du plugin. L'offset persistant est le remède ; ce garde est la prévention.

### /note

**Ce que ça fait**: Laisse une note dans le transcript — l'agent la lira à son prochain tour, sans se réveiller maintenant.

**Utilisation**: `/note <texte>`

**Exemples** :
- `/note Prioriser le module ventes` → l'agent le voit comme contexte

**Notes**: C'est un message synthétique — il ne lance pas l'agent.

### /turns

**Ce que ça fait**: Ce que les tours de la session ont changé — plus fin que `/git`.

**Utilisation**: `/turns` ou `/turns <ses_id>`

**Exemples** :
- `/turns` dans un sujet → les changements des tours

**Notes**: Peut être vide si le serveur n'a pas enregistré de changement de tour.

## Projet et configuration

### /config

**Ce que ça fait**: Lit et édite le `opencode.jsonc` du projet — le modèle par défaut des nouvelles sessions.

**Utilisation**: `/config` ou `/config model <fournisseur/modèle>`

**Exemples** :
- `/config` → affiche la configuration actuelle
- `/config model nvidia/z-ai/glm-5.3` → change le défaut (recharge en direct)

**Notes**: Le changement s'applique aux sessions NOUVELLES — pas besoin de redémarrer le serveur.

### /worktree

**Ce que ça fait**: Liste les worktrees du projet ou en crée un nouveau.

**Utilisation**: `/worktree` ou `/worktree new <nom>`

**Exemples** :
- `/worktree` → liste avec des boutons qui ouvrent des sessions dans chaque worktree
- `/worktree new feature-x` → crée le worktree

**Notes**: Touche un worktree pour y ouvrir une session.

### /move

**Ce que ça fait**: Déplace une session vers un autre projet.

**Utilisation**: `/move <répertoire>`

**Exemples** :
- `/move E:\Projects\Autre` → la session du sujet est déplacée vers ce projet

**Notes**: Le sujet Telegram reste le même — seul le répertoire de travail change.

### /mcp

**Ce que ça fait**: Liste les serveurs MCP ou en connecte/déconnecte un.

**Utilisation**: `/mcp` ou `/mcp connect|disconnect <server>`

**Exemples** :
- `/mcp` → liste avec l'état (🟢 connecté / 🔴 non)
- `/mcp disconnect abap-docs` → le déconnecte
- `/mcp connect abap-docs` → le reconnecte

**Notes**: Ajouter un nouveau serveur (PUT) reste l'affaire du PC.

### /commands

**Ce que ça fait**: Liste les commandes custom de la configuration ou en lance une.

**Utilisation**: `/commands` ou `/commands run <texte>`

**Exemples** :
- `/commands` → liste (init, review, etc.)
- `/commands run init` → lance la commande « init » dans la session du sujet

**Notes**: Les commandes custom sont définies dans le `opencode.jsonc` du projet.

## Info et debug

### /locale

**Ce que ça fait**: Change la langue du bot — le menu `/help`, les cartes et tous les messages suivent instantanément.

**Utilisation**: `/locale` (avec boutons) ou `/locale <es|en|pt|de|fr|it|id|ru|tr|zh|ko>`

**Exemples** :
- `/locale` → carte avec un bouton par langue (l'actuelle avec ✓)
- `/locale fr` → change directement ; la confirmation arrive DANS la langue choisie

**Notes**: Le choix est persisté dans `~/.opencode/tg/locale.txt` — un redémarrage ne le perd pas. `TG_LOCALE` dans `.env` n'est que la valeur initiale. Une nouvelle langue est un nouvel objet dans `CATALOGS` (src/locale.ts) plus son `COMMANDS.<langue>.md` — aucun code supplémentaire.

### /bots

**Ce que ça fait**: Affiche la répartition multi-bot : quel bot reflète quel projet ou quelle session, qui est libre, et le bot principal (hub) qui couvre tout le reste.

**Utilisation**: `/bots`

**Exemples** :
- `/bots` → une ligne par bot avec sa revendication (projet, session ou « libre ») et la topologie active

**Notes**: Les bots supplémentaires se déclarent en `TELEGRAM_BOT_TOKEN_<NOM>` dans `~/.opencode/tg/.env` — jamais dans le dépôt. La topologie (`single` / `per-project` / `per-session`) et le mappage explicite (`assign`) vivent dans le bloc `"bots"` de `config.json`. Avec un seul bot, la carte explique comment en ajouter un autre. Chaque bot supplémentaire a besoin des topics activés chez BotFather, comme le principal.

### /release

**Ce que ça fait**: Rend CE bot au pool — seulement en topologie `per-session`. Sa session passe au hub jusqu'à ce qu'une autre la réclame.

**Utilisation**: `/release` (depuis le chat du bot que tu veux libérer)

**Exemples** :
- `/release` → « 🧹 libéré — sa session retourne au hub »

**Notes**: Le bot revient aussi tout seul quand tu archives (`/archive`) la session qui l'avait réclamé. En `single` et `per-project`, la commande répond que cela ne s'applique pas. À la réactivation de la session, son prochain tour réclame un bot libre automatiquement.

### /context

**Ce que ça fait**: Tokens, coût, limite du modèle et compactages d'une session.

**Utilisation**: `/context` ou `/context <ses_id>`

**Exemples** :
- `/context` dans un sujet → l'usage de contexte de cette session

**Notes**: Le modèle est récupéré du transcript si la charge utile du serveur ne le porte pas.

### /usage

**Ce que ça fait**: Tokens et coût d'une session, avec fournisseur et modèle.

**Utilisation**: `/usage` ou `/usage <ses_id>`

**Exemples** :
- `/usage` dans un sujet → `🧪 nvidia · z-ai/glm-5.3 · agent build` + tokens

**Notes**: Le modèle et l'agent sont récupérés du transcript quand la charge utile les oublie.

### /history

**Ce que ça fait**: La fin de la conversation d'une session.

**Utilisation**: `/history` ou `/history <ses_id>`

**Exemples** :
- `/history` dans un sujet → les 16 derniers messages

**Notes**: Lit depuis le serveur (session active) ou le transcript sur le disque.

### /log

**Ce que ça fait**: Un échantillon du journal côté serveur de la session.

**Utilisation**: `/log` ou `/log <ses_id>`

**Exemples** :
- `/log` dans un sujet → les 10 derniers événements du journal

**Notes**: C'est une fenêtre de lecture — ce n'est pas le journal complet.

### /ci

**Ce que ça fait**: Affiche les dernières exécutions GitHub Actions du dépôt — quel workflow, sur quel commit, et au vert ou au rouge. Ce qui prouve qu'un push est arrivé entier : typecheck, suites et, deux fois par semaine, le sceau des dépendances.

**Utilisation**: `/ci`, `/ci <n>` ou `/ci <workflow>`

**Exemples** :
- `/ci` → les 6 dernières exécutions avec leur état et un lien vers le sha
- `/ci 12` → les 12 dernières
- `/ci deps` → seulement les exécutions du workflow `deps-audit`

**Notes**: Lit l'API REST de GitHub sans dépendances. Le dépôt est public, donc ça fonctionne sans token (60 requêtes/heure par IP) ; un `GITHUB_TOKEN` dans `~/.opencode/tg/.env` hausse la limite et atteint les dépôts privés. Le dépôt par défaut est `par4987/opencode-tg` — un fork le change avec `"ci": { "repo": "owner/repo" }` dans `config.json` ou `TG_CI_REPO`.

### /terminal

**Ce que ça fait**: Le terminal de la session, en lecture seule.

**Utilisation**: `/terminal` ou `/terminal <ses_id>`

**Exemples** :
- `/terminal` dans un sujet → les dernières lignes du terminal

**Notes**: Apparaît quand l'agent lance quelque chose d'interactif. Le contrôle reste au PC.

### /perms

**Ce que ça fait**: Liste les autorisations « toujours » enregistrées ou en révoque une.

**Utilisation**: `/perms` ou `/perms del <id>`

**Exemples** :
- `/perms` → les « 🔁 Toujours » accumulées
- `/perms del psv_xxx` → en révoque une

**Notes**: Révoquer fait que le serveur redemande.

### /sessions

**Ce que ça fait**: Les sessions que le serveur connaît.

**Utilisation**: `/sessions`

**Exemples** :
- `/sessions` → liste avec l'état (🎯 active, 📡 miroir, 💤 idle)

### /running

**Ce que ça fait**: Les sessions avec un tour en cours en ce moment.

**Utilisation**: `/running`

**Exemples** :
- `/running` → ce qui travaille

### /models

**Ce que ça fait**: Change le modèle de la session — avec sélecteur paginé.

**Utilisation**: `/models` ou `/models <texte>`

**Exemples** :
- `/models` → sélecteur avec fournisseurs et modèles
- `/models glm` → filtre sur « glm »

**Notes**: Seulement les modèles que le desktop active ou que la configuration déclare.

### /agents

**Ce que ça fait**: Change l'agent de la session.

**Utilisation**: `/agents` ou `/agent`

**Exemples** :
- `/agents` → sélecteur d'agents

### /projects

**Ce que ça fait**: Liste les projets pour ouvrir une nouvelle session.

**Utilisation**: `/projects`

**Exemples** :
- `/projects` → sélecteur de projets

### /tasks

**Ce que ça fait**: Liste les tâches planifiées du bot.

**Utilisation**: `/tasks`

**Exemples** :
- `/tasks` → les tâches avec leur prochaine exécution

### /newtask

**Ce que ça fait**: Crée une tâche planifiée avec un assistant de 6 étapes.

**Utilisation**: `/newtask`

**Exemples** :
- `/newtask` → assistant : nom, prompt, projet, modèle, planification, détail

### /skills

**Ce que ça fait**: Liste les skills installées et en arme une pour le prochain message.

**Utilisation**: `/skills` ou `/skill <id> <texte>`

**Exemples** :
- `/skills` → sélecteur de skills
- Touche-en une → écris le prompt

## Chat et file d'attente

### /queue

**Ce que ça fait**: Les messages en attente dans la boîte de réception de la session.

**Utilisation**: `/queue` ou `/queue <ses_id>`

**Exemples** :
- `/queue` → liste avec réordonner (↑↓), devancer (▶), annuler (✖), remplacer (✏️)

**Notes**: Les entrées de compactage et de déplacement sont déjà étiquetées.

### /flush

**Ce que ça fait**: Fait entrer tout ce que la boîte de réception retient dans le tour en cours.

**Utilisation**: `/flush` ou `/flush <texte>`

**Exemples** :
- `/flush` → vide la boîte de réception dans le tour
- `/flush fais X` → injecte le texte dans le tour MAINTENANT

**Notes**: Avec du texte, c'est du steering direct — il entre dans le tour en cours.

### /clearqueue

**Ce que ça fait**: Annule tous les messages en attente de la boîte de réception.

**Utilisation**: `/clearqueue` ou `/clearqueue <ses_id>`

**Exemples** :
- `/clearqueue` → annule tout

### /send

**Ce que ça fait**: Envoie un prompt à une session depuis n'importe où.

**Utilisation**: `/send <texte>` ou `/send <ses_id> <texte>`

**Exemples** :
- `/send fais un résumé` → va à la session du sujet
- `/send ses_xxx fais X` → va à cette session

### /txt

**Ce que ça fait**: Réponse libre à une question ouverte de l'agent.

**Utilisation**: `/txt <réponse>`

**Exemples** :
- `/txt L'option B` → répond à la question active

### /menu

**Ce que ça fait**: Menu de commandes avec boutons.

**Utilisation**: `/menu`

**Exemples** :
- `/menu` → clavier avec les commandes principales

### /help

**Ce que ça fait**: Liste les commandes avec un menu pour voir le détail de chacune.

**Utilisation**: `/help`

**Exemples** :
- `/help` → liste courte + clavier
- Touche une commande → sa section détaillée (ce qu'elle fait, utilisation, exemples, notes)

### /watch

**Ce que ça fait**: Contrôle quelles sessions sont surveillées dans le chat.

**Utilisation**: `/watch <id|all|off>`

**Exemples** :
- `/watch all` → surveille tout
- `/watch ses_xxx` → surveille seulement celle-là
- `/watch off` → ne surveille rien

**Notes**: Avec `mirror: all` dans la configuration, `/watch <id>` met les autres en sourdine.
