# Guia de comandos

Cada comando com o que faz, como se usa, exemplos e notas. O menu de `/help`
no Telegram oferece esses mesmos comandos — toque num e recebe sua seção.

## Sessões

### /new

**O que faz**: Cria uma sessão nova no projeto que você escolher, com o tópico do Telegram aberto na hora.

**Uso**: `/new <título?>`

**Exemplos**:
- `/new Análise de vendas` → mostra o picker de projeto; ao tocar num, cria a sessão "Análise de vendas" lá
- `/new` → pede o título no chat e, depois de dado, mostra o picker

**Notas**:
- O projeto da conversa atual vem primeiro no picker (✅) — é o padrão: um toque e pronto.
- "➕ Novo projeto…" pede um nome e cria essa pasta ao lado do projeto atual; a sessão abre dentro dela.
- O tópico abre no momento de criar (antes nascia com a primeira mensagem): escreva nele e a sessão já está ouvindo.
- Você escolhe provedor e modelo no tópico novo: abre no provedor do modelo padrão do projeto, com esse modelo marcado ✅ — um toque mantém, ou navegue pra outro. O mesmo depois com `/models`.
- Se `/new` for mandado sem título, a próxima mensagem escrita naquele tópico dentro de 10 minutos é o nome.

### /use

**O que faz**: Define pra qual sessão vão as mensagens da raiz do chat.

**Uso**: `/use <ses_id>`

**Exemplos**:
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → a raiz aponta pra essa sessão
- `/use` → mostra a sessão atual

**Notas**: As mensagens num tópico sempre vão pra sessão daquele tópico, não importa o `/use`.

### /fork

**O que faz**: Bifurca uma sessão até sua última mensagem — teste ideias sem sujar a original.

**Uso**: `/fork` (no tópico) ou `/fork <ses_id>`

**Exemplos**:
- `/fork` no tópico de uma sessão → cria um fork e avisa
- `/fork ses_xxx` → idem de qualquer lugar

**Notas**: O fork é uma sessão nova com seu próprio tópico. A original fica intacta.

### /rename

**O que faz**: Renomeia uma sessão — o tópico do Telegram e o desktop seguem a mudança.

**Uso**: `/rename <título>` ou `/rename <ses_id> <título>`

**Exemplos**:
- `/rename Análise Q4` → renomeia a sessão do tópico
- `/rename` (sem título) → sugere 3 títulos a partir do transcript e você escolhe com um toque

**Notas**: O título é capado em 128 caracteres (o limite de nome de tópico do Telegram).

### /detach

**O que faz**: Desacopla a raiz do chat de sua sessão — o que você escrever lá não vai mais pra nenhuma sessão.

**Uso**: `/detach`

**Exemplos**:
- `/detach` → a raiz fica livre
- `/use <ses_id>` → acopla de novo

**Notas**: Os tópicos de sessão não são afetados.

### /archive

**O que faz**: Arquiva a sessão do tópico — em chat privado remove o tópico e silencia a sessão.

**Uso**: `/archive` ou `/archive <ses_id>`

**Exemplos**:
- `/archive` num tópico → o tópico some do chat
- `/archive ses_xxx` → idem de qualquer lugar (o id aceita prefixo único)

**Notas**: `/unarchive` traz de volta — a seco abre o picker das arquivadas, então não precisa do id.

### /unarchive

**O que faz**: Acorda uma sessão arquivada — sem id abre o picker; com texto busca por projeto, título ou id.

**Uso**: `/unarchive`, `/unarchive <texto>` ou `/unarchive <ses_id>`

**Exemplos**:
- `/unarchive` na raiz → abre o picker com as sessões arquivadas, a mais recente primeiro
- `/unarchive faturas` → o picker com as que combinam (título, projeto ou id)
- `/unarchive ses_ed2c` → resolve o id por prefixo e a acorda direto
- `/unarchive` num tópico vivo → avisa que essa sessão não está arquivada

**Notas**:
- Sem id não precisa adivinhar nada: o picker lista as arquivadas com botões (título · projeto · atividade), em páginas de 8.
- O `<texto>` serve como busca por **projeto** (o nome da pasta), por título ou por prefixo de id.
- Um id é aceito completo ou por prefixo único, sem distinguir maiúsculas.
- Se o tópico foi apagado, cria-se um novo com o título atual.
- Em chat privado `/archive` apaga o tópico, então `/unarchive` o recria; a sessão no PC nunca é tocada.

### /delthread

**O que faz**: Apaga o tópico do fórum sem tocar a sessão.

**Uso**: `/delthread` ou `/delthread <ses_id>`

**Exemplos**:
- `/delthread` num tópico → o tópico some

**Notas**: A sessão continua existindo — seu próximo evento recriia o tópico. Pra silenciá-la: `/archive`. O id aceita prefixo único, sem distinguir maiúsculas.

### /rebuild

**O que faz**: Apaga TODOS os tópicos de sessões e reconstrói o fórum limpo.

**Uso**: `/rebuild` (com confirmação inline)

**Exemplos**:
- `/rebuild` → apaga os tópicos mapeados (um por um, confirmados) e recria os das sessões que você usou ultimamente (até 12, a mais recente no topo)

**Notas**: As mensagens velhas não são re-importadas — `/export` baixa o transcript de cada sessão. Só recriia tópicos pra sessões que você usou dentro de `rebuildIdleHours` (padrão 24h): o server pisa o campo `updated` de todas as sessões ao reiniciar, então ordenar por ele ressuscitava sessões que ninguém tocava há dias; `idle` é a última atividade real. Cada apagado é confirmado antes de esquecer o mapeamento — se o Telegram rejeita um (rate limit, corte), o tópico fica mapeado e o próximo `/rebuild` tenta de novo; uma sessão cujo tópico sobreviveu não é duplicada. Os tópicos que ficaram **órfãos** (sem mapeamento) não podem ser limpos sozinhos: a Bot API não tem "listar tópicos", então é preciso apagá-los à mão uma única vez.

## Arquivos e código

### /ls

**O que faz**: Navega os arquivos do projeto da sessão.

**Uso**: `/ls [pasta]`

**Exemplos**:
- `/ls` → lista o diretório raiz do projeto
- `/ls src` → entra na pasta src
- Toque num arquivo → baixa ele
- 📎 num arquivo de texto → anexa ele na próxima mensagem

**Notas**: Os índices dos botões expiram — se um toque disser "listing velho", reabra `/ls`.

### /find

**O que faz**: Busca difusa de arquivos por nome.

**Uso**: `/find <texto>`

**Exemplos**:
- `/find navbar` → arquivos cujo nome contém "navbar"
- `/find .test.` → arquivos com ".test." no nome

**Notas**: Busca em todo o projeto da sessão.

### /git

**O que faz**: O que o agente tocou no projeto — status com `+/−` e diff baixável.

**Uso**: `/git`

**Exemplos**:
- `/git` → status do projeto
- "Ver o diff" → preview + `.patch` baixável

**Notas**: É o diff do projeto, não da sessão — vários agentes podem compartilhar ele.

### /revert

**O que faz**: Desfaz o último turno de uma sessão (com confirmação).

**Uso**: `/revert` ou `/revert <ses_id>`

**Exemplos**:
- `/revert` num tópico → propõe desfazer o último turno
- Você confirma com o botão → o turno é desfeito

**Notas**: Só desfaz o último turno. Pra vários: `/revert` repetido.

### /export

**O que faz**: Baixa o transcript completo de uma sessão como JSON.

**Uso**: `/export` ou `/export <ses_id>`

**Exemplos**:
- `/export` num tópico → chega o JSON do transcript
- `/export ses_xxx` → idem de qualquer lugar

**Notas**: Com a sessão aberta no PC, o export é completo. Fechada, pode não haver transcript no disco (bug de persistência do server).

### /sh

**O que faz**: Roda um comando shell DENTRO da sessão — em segundo plano, sem acordar o agente.

**Uso**: `/sh <comando>`

**Exemplos**:
- `/sh node -v` → `v24.21.0`
- `/sh git status` → o status do repo
- `/sh ls` → o conteúdo do diretório

**Notas**: O shell da sessão é PowerShell — `&&` não funciona, use `;`. O output chega no tópico.

**Comandos protegidos**: o comando é **parseado** (não buscado por regex: os nomes reais, com os alias resolvidos) e cai num de três níveis:

- **Passa direto**: leitura pura (`Get-*`, `Test-*`, `ls`, `cat`) e a toolchain de desenvolvimento (`git`, `node`, `npm`, `cargo`, `python`...). Um falso positivo aqui faria o bot pedir confirmação antes de cada `git status`.
- **Pede confirmação**: o recuperável mas que pode cortar o serviço ou sair da máquina — reiniciar o server, matar processos, instalar software, chamadas à rede, execução remota, tarefas agendadas. O cartão **explica o que cada comando faz** (o que vai acontecer, não só o texto) e é preciso tocar "Confirmar e executar". O pendente é apagado **antes** de executar, então um crash não o redispara.
- **Bloqueado, sem exceção**: o que não tem volta — formatação e apagamento de discos, boot e recuperação do sistema, registro, usuários e credenciais, segredos (`.env`, `.ssh`, perfis de navegador, o drive `Env:`), defesas (antivírus, firewall, BitLocker), apagamento de logs, e todos os vetores de evasão (`iex`, `Invoke-Command`, `powershell`/`cmd` aninhados, `-EncodedCommand`, `Add-Type`, acesso direto a .NET/COM, definição de funções e alias). Nem confirmando executa: pra isso está o console do PC.

O apagamento é **delimitado por caminho**: `Remove-Item` (e `rm`, `del`, `rmdir`...) é permitido dentro da pasta do projeto — um agente de código tem que poder apagar `node_modules` — e bloqueado fora. Apagar o projeto inteiro (`.`) ou o `.git` pede confirmação.

**Por que** (incidente 2026-10-07): `/sh opencode service restart` matou o processo que hospeda o plugin; como o offset do poll estava só em memória, o Telegram reenviava o update a cada reinício e o servidor entrou num loop de ~10s até desativar o plugin à mão. O offset persistente é a cura; este guard é a prevenção.

### /note

**O que faz**: Deixa uma nota no transcript — o agente a lê no próximo turno, sem acordar agora.

**Uso**: `/note <texto>`

**Exemplos**:
- `/note Priorizar o módulo de vendas` → o agente vê como contexto

**Notas**: É uma mensagem sintética — não roda o agente.

### /turns

**O que faz**: O que os turnos da sessão mudaram — mais fino que `/git`.

**Uso**: `/turns` ou `/turns <ses_id>`

**Exemplos**:
- `/turns` num tópico → as mudanças dos turnos

**Notas**: Pode estar vazio se o server não registrou mudanças de turno.

## Projeto e config

### /config

**O que faz**: Lê e edita o `opencode.jsonc` do projeto — o padrão de modelo das sessões novas.

**Uso**: `/config` ou `/config model <provedor/modelo>`

**Exemplos**:
- `/config` → mostra a config atual
- `/config model nvidia/z-ai/glm-5.3` → muda o padrão (recarrega em vivo)

**Notas**: A mudança vale pras sessões NOVAS — não precisa reiniciar o server.

### /worktree

**O que faz**: Lista os worktrees do projeto ou cria um novo.

**Uso**: `/worktree` ou `/worktree new <nome>`

**Exemplos**:
- `/worktree` → lista com botões que abrem sessões em cada worktree
- `/worktree new feature-x` → cria o worktree

**Notas**: Toque num worktree pra abrir uma sessão nele.

### /move

**O que faz**: Move uma sessão pra outro projeto.

**Uso**: `/move <diretório>`

**Exemplos**:
- `/move E:\Projects\Outro` → a sessão do tópico se move pra esse projeto

**Notas**: O tópico do Telegram segue igual — só muda o diretório de trabalho.

### /mcp

**O que faz**: Lista os servidores MCP ou conecta/desconecta um.

**Uso**: `/mcp` ou `/mcp connect|disconnect <server>`

**Exemplos**:
- `/mcp` → lista com estado (🟢 conectado / 🔴 não)
- `/mcp disconnect abap-docs` → desconecta
- `/mcp connect abap-docs` → reconecta

**Notas**: Adicionar um server novo (PUT) fica pro PC.

### /commands

**O que faz**: Lista os comandos custom da config ou roda um.

**Uso**: `/commands` ou `/commands run <texto>`

**Exemplos**:
- `/commands` → lista (init, review, etc.)
- `/commands run init` → roda o comando "init" na sessão do tópico

**Notas**: Os comandos custom são definidos no `opencode.jsonc` do projeto.

## Info e debug

### /locale

**O que faz**: Muda o idioma do bot — o menu de `/help`, os cartões e todas as mensagens seguem na hora.

**Uso**: `/locale` (com botões) ou `/locale <es|en|pt|de|fr|it|id|ru|tr>`

**Exemplos**:
- `/locale` → cartão com um botão por idioma (o atual com ✓)
- `/locale pt` → muda direto; a confirmação chega NO idioma escolhido

**Notas**: A escolha persiste em `~/.opencode/tg/locale.txt` — um reinício não a perde. `TG_LOCALE` no `.env` fica como valor inicial. Um idioma novo é um objeto novo em `CATALOGS` (src/locale.ts) mais seu `COMMANDS.<idioma>.md` — nada de código adicional.

### /bots

**O que faz**: Mostra a distribuição multi-bot: qual bot espelha qual projeto ou sessão, quem está livre, e o bot principal (hub) que cobre todo o resto.

**Uso**: `/bots`

**Exemplos**:
- `/bots` → uma linha por bot com seu claim (projeto, sessão ou "livre") e a topologia ativa

**Notas**: Os bots extras são declarados como `TELEGRAM_BOT_TOKEN_<NOME>` em `~/.opencode/tg/.env` — nunca no repo. A topologia (`single` / `per-project` / `per-session`) e o mapeamento explícito (`assign`) vivem no bloco `"bots"` de `config.json`. Com um só bot, o cartão explica como somar outro. Cada bot extra precisa de topics habilitados no BotFather, igual ao principal.

### /release

**O que faz**: Devolve ESTE bot ao pool — só em topologia `per-session`. Sua sessão passa pro hub até que outra a reclame.

**Uso**: `/release` (do chat do bot que você quer liberar)

**Exemplos**:
- `/release` → "🧹 liberado — sua sessão volta pro hub"

**Notas**: O bot também volta sozinho ao arquivar (`/archive`) a sessão que o tinha reclamado. Em `single` e `per-project` o comando responde que não aplica. Ao reativar a sessão, seu próximo turno reclama um bot livre automaticamente.

### /context

**O que faz**: Tokens, custo, limite do modelo e compactações de uma sessão.

**Uso**: `/context` ou `/context <ses_id>`

**Exemplos**:
- `/context` num tópico → o uso de contexto daquela sessão

**Notas**: O modelo é recuperado do transcript se o payload do server não o rastreia.

### /usage

**O que faz**: Tokens e custo de uma sessão, com provedor e modelo.

**Uso**: `/usage` ou `/usage <ses_id>`

**Exemplos**:
- `/usage` num tópico → `🧪 nvidia · z-ai/glm-5.3 · agente build` + tokens

**Notas**: O modelo e o agente são recuperados do transcript quando o payload os esquece.

### /history

**O que faz**: O final da conversa de uma sessão.

**Uso**: `/history` ou `/history <ses_id>`

**Exemplos**:
- `/history` num tópico → as últimas 16 mensagens

**Notas**: Lê do server (sessão ativa) ou do transcript no disco.

### /log

**O que faz**: Uma amostra do log server-side da sessão.

**Uso**: `/log` ou `/log <ses_id>`

**Exemplos**:
- `/log` num tópico → os últimos 10 eventos do log

**Notas**: É uma janela de leitura — não é o log completo.

### /ci

**O que faz**: Mostra as últimas runs do GitHub Actions do repo — qual workflow, sobre qual commit, e verde ou vermelho. O que prova que um push chegou inteiro: typecheck, suites e, duas vezes por semana, o selo de dependências.

**Uso**: `/ci`, `/ci <n>` ou `/ci <workflow>`

**Exemplos**:
- `/ci` → as últimas 6 runs com seu estado e um link pro sha
- `/ci 12` → as últimas 12
- `/ci deps` → só as runs do workflow `deps-audit`

**Notas**: Lê a API REST do GitHub sem dependências. O repo é público, então funciona sem token (60 consultas/hora por IP); um `GITHUB_TOKEN` em `~/.opencode/tg/.env` sobe o limite e alcança repos privados. O repo padrão é `par4987/opencode-tg` — um fork o muda com `"ci": { "repo": "owner/repo" }` em `config.json` ou `TG_CI_REPO`.

### /terminal

**O que faz**: O terminal da sessão, só leitura.

**Uso**: `/terminal` ou `/terminal <ses_id>`

**Exemplos**:
- `/terminal` num tópico → as últimas linhas do terminal

**Notas**: Aparece quando o agente roda algo interativo. O controle fica no PC.

### /perms

**O que faz**: Lista as permissões "sempre" guardadas ou revoga uma.

**Uso**: `/perms` ou `/perms del <id>`

**Exemplos**:
- `/perms` → os "🔁 Sempre" acumulados
- `/perms del psv_xxx` → revoga uma

**Notas**: Revogar faz o server perguntar de novo.

### /sessions

**O que faz**: As sessões que o server conhece.

**Uso**: `/sessions`

**Exemplos**:
- `/sessions` → lista com estado (🎯 ativa, 📡 espelho, 💤 idle)

### /running

**O que faz**: As sessões com um turno rodando agora.

**Uso**: `/running`

**Exemplos**:
- `/running` → o que está trabalhando

### /models

**O que faz**: Muda o modelo da sessão — com picker paginado.

**Uso**: `/models` ou `/models <texto>`

**Exemplos**:
- `/models` → picker com provedores e modelos
- `/models glm` → filtra por "glm"

**Notas**: Só modelos que o desktop habilita ou a config declara.

### /agents

**O que faz**: Muda o agente da sessão.

**Uso**: `/agents` ou `/agent`

**Exemplos**:
- `/agents` → picker de agentes

### /projects

**O que faz**: Lista os projetos pra abrir uma sessão nova.

**Uso**: `/projects`

**Exemplos**:
- `/projects` → picker de projetos

### /tasks

**O que faz**: Lista as tarefas agendadas do bot.

**Uso**: `/tasks`

**Exemplos**:
- `/tasks` → as tarefas com sua próxima execução

### /newtask

**O que faz**: Cria uma tarefa agendada com um wizard de 6 passos.

**Uso**: `/newtask`

**Exemplos**:
- `/newtask` → wizard: nome, prompt, projeto, modelo, agendamento, detalhe

### /skills

**O que faz**: Lista as skills instaladas e arma uma pra próxima mensagem.

**Uso**: `/skills` ou `/skill <id> <texto>`

**Exemplos**:
- `/skills` → picker de skills
- Toque numa → escreva o prompt

## Chat e fila

### /queue

**O que faz**: As mensagens pendentes do inbox da sessão.

**Uso**: `/queue` ou `/queue <ses_id>`

**Exemplos**:
- `/queue` → lista com reordenar (↑↓), adiantar (▶), cancelar (✖), substituir (✏️)

**Notas**: Os itens de compactação e movimento são etiquetados já.

### /flush

**O que faz**: Adianta tudo que o inbox retém pro turno em curso.

**Uso**: `/flush` ou `/flush <texto>`

**Exemplos**:
- `/flush` → esvazia o inbox pro turno
- `/flush faça X` → injeta o texto no turno AGORA

**Notas**: Com texto é steering direto — entra no turno em curso.

### /clearqueue

**O que faz**: Cancela todas as mensagens pendentes do inbox.

**Uso**: `/clearqueue` ou `/clearqueue <ses_id>`

**Exemplos**:
- `/clearqueue` → cancela tudo

### /send

**O que faz**: Manda um prompt pra uma sessão de qualquer lugar.

**Uso**: `/send <texto>` ou `/send <ses_id> <texto>`

**Exemplos**:
- `/send faça um resumo` → vai pra sessão do tópico
- `/send ses_xxx faça X` → vai pra essa sessão

### /txt

**O que faz**: Resposta livre a uma pergunta aberta do agente.

**Uso**: `/txt <resposta>`

**Exemplos**:
- `/txt A opção B` → responde à pergunta ativa

### /menu

**O que faz**: Menu de comandos com botões.

**Uso**: `/menu`

**Exemplos**:
- `/menu` → teclado com os comandos principais

### /help

**O que faz**: Lista os comandos com menu pra ver o detalhe de cada um.

**Uso**: `/help`

**Exemplos**:
- `/help` → lista breve + teclado
- Toque num comando → sua seção detalhada (o que faz, uso, exemplos, notas)

### /watch

**O que faz**: Controla quais sessões são observadas no chat.

**Uso**: `/watch <id|all|off>`

**Exemplos**:
- `/watch all` → observa tudo
- `/watch ses_xxx` → observa só essa
- `/watch off` → não observa nada

**Notas**: Com `mirror: all` na config, `/watch <id>` silencia o resto.
