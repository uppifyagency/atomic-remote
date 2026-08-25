# Valutazione evolutiva `atomic-remote` — Report finale

Sintesi di 30 proposte, filtrate contro la verifica API (doc ufficiale Atomic) e la verifica valore. Molte proposte erano la stessa cosa scritta sei volte: l'attribuzione dei run (item 1/7/20/25) e l'identità/liveness (3/11/17/21/27) ricorrono ciascuna 4-6 volte. Sotto, la forma fusa e minima di ognuna.

---

## 1. TOP 5 — roadmap prioritizzata

### 1. Liveness per heartbeat e stop al `rm -rf` del controller
**Effort: M** — fonde item 17 (base), 3 (ramo ephemeral), 27 (`hostPid`), 21/11 (scartati come duplicati).

**Problema.** `meta.pid` (`atomic-remote-bridge.ts:168`) è `process.pid` letto *dentro l'engine child*. `extensions.md` §Interactive callback isolation documenta esplicitamente che quel child viene terminato e sostituito (watchdog: `Interactive engine is not responding; restarting.`; crash: `Interactive engine stopped unexpectedly; restarting.`). Conseguenza: `listSessions()` (`atomic-ctl.mjs:41-65`) decide la vita con `process.kill(meta.pid, 0)` e, se il pid è morto, esegue `fs.rmSync(dir, {recursive:true, force:true})` **dentro un semplice `list`**. Il primo `list` dopo una sostituzione dell'engine cancella la directory di una sessione viva. Fallimento opposto e simmetrico: un pid riciclato dall'OS fa giudicare "vivo" un bridge morto → il comando finisce in un inbox che nessuno legge, il controller stampa `Sent…` e `--wait` resta appeso 300 s.

**Design.**
- Identità = `ctx.sessionManager.getSessionId()` (UUID stabile, persistito, sopravvive a `/reload` e alla sostituzione del child). Directory `remote-bridge/<sessionId>/`. Se `isPersisted() === false` → `eph-<random>` con `meta.ephemeral = true`.
- `meta.json`: `{ id, sessionId, sessionFile: getSessionFile(), cwd, name, enginePid: process.pid, hostPid: process.ppid, bridgeVersion, protocol, startedAt, status }`. `enginePid` resta **solo** diagnostico.
- Heartbeat: `setInterval(...).unref()` ogni 5 s che scrive `heartbeat.json` `{ts, enginePid, busy}` con `{mode: 0o600}`; `clearInterval` in `teardown` (`extensions.md` §Long-lived resources and shutdown legittima esattamente questo pattern: avvio in `session_start`, teardown idempotente in `session_shutdown`). Costanti nominate: `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_STALE_MS = 4 × interval`.
- Controller: `isAlive(session)` = heartbeat fresco. Tre stati `live` / `stale` / `closed`, **nessuna cancellazione**. Il prune diventa un comando esplicito `prune [--older-than <days>]`, con guardia `fs.realpathSync` + `path.relative(bridgeRoot, real).startsWith("..")` → rifiuto.
- `writeCommand` rilegge l'heartbeat **immediatamente prima** del rename atomico e rifiuta se stale: elimina la classe "comando consegnato a un morto". Tmp file in `inbox/.tmp/` con `{mode: 0o600}`.
- `session_start` con `reason: "reload"` **riusa** la directory dello stesso `sessionId` invece di ricrearne una con id diverso (oggi ogni `/reload` invalida il target salvato e gli script dell'utente).

**File:** `atomic-remote-bridge.ts`, `atomic-ctl.mjs`.

**Perché ora.** È l'unica primitiva distruttiva del plugin e sta nel posto sbagliato. Ogni altro item costruisce sopra questa directory: se `list` la cancella, tutto il resto è inutile. Il fatto che questo fix ricorra sei volte nella lista è il segnale.

---

### 2. Attribuzione run→comando via evento `input` + terminale su `agent_settled`
**Effort: M** — item 7 (forma minima, da tenere); scartate le varianti pesanti 1 (`owners[]`, `run_joined`) e 25 (custom message).

**Problema.** `atomic-ctl.mjs:150` accetta il **primo** `agent_end` dopo il proprio `accepted`, e il bridge (`:190`) emette `agent_end` senza alcun identificatore di proprietà. Due bug distinti: (a) `agent_end` non è terminale — `extensions.md` dice verbatim che «Atomic may still retry, compact and retry, or deliver queued follow-ups. Use `agent_settled` when a status integration needs to know Atomic has no automatic continuation left»; (b) se l'utente digita nella TUI in parallelo, il primo `agent_end` è la risposta al *suo* prompt e il controller la spaccia per la propria.

**Design.**
- Bridge: `Map<string, string>` testo normalizzato → `commandId`, popolata in `handleCommand` **prima** dell'iniezione.
- `pi.on("input")`: `event.source === "extension"` + match sul testo → emette `{type:"turn_bound", id}` e imposta `activeOwner`. `event.source === "interactive"` → emette `{type:"foreign_input", preview}` e azzera `activeOwner`. (`event.source` con i tre valori `"interactive" | "rpc" | "extension"` è documentato, con la nota «Route by source: skip processing for extension-injected messages».)
- Ogni `agent_start`/`agent_end` porta il campo `owner`. Nuovo `pi.on("agent_settled")` → `{type:"agent_settled", owner, text}`, dove `text` è l'ultimo testo assistant **accumulato in `agent_end`** (il payload di `agent_settled` non è documentato: l'accumulo è obbligatorio, non opzionale).
- Controller: `--wait` attende `agent_settled` con `owner === payload.id`. `agent_end` diventa anticipazione informativa su stderr con `-v`, non condizione di uscita. `foreign_input` prima del proprio `turn_bound` → errore esplicito «attribuzione abbandonata: input utente concorrente, usa tail», mai una risposta potenzialmente altrui.
- `--mode interrupt` usa `pi.sendMessage` (custom message), che non passa da `input`: binding sull'`agent_start` immediatamente successivo all'`accepted`, deterministico perché `deliverAs:"interrupt"` + `triggerTurn:true` «aborts an active streaming turn and immediately starts a new turn».
- `--accept-partial` opt-in mantiene il vecchio comportamento su `agent_end`.

**File:** `atomic-remote-bridge.ts`, `atomic-ctl.mjs`, `SKILL.md`.

**Riserva annotata.** Il match sul testo normalizzato è fragile in teoria: sbaglia solo se l'utente digita alla TUI *esattamente* lo stesso testo. Per un utente singolo è sufficiente, e il caso ambiguo viene gestito rifiutando l'attribuzione anziché indovinando. La doc non specifica se/quando `input` fira per una consegna `steer`/`followUp`: trattare quel binding come best-effort.

**Perché ora.** È il bug che rende `--wait` — la feature centrale — non affidabile. Tutto il resto della UX dipende dal fatto che la risposta stampata sia davvero la risposta al comando inviato.

---

### 3. Workflow async: `--wait` deve aspettare il run, non il primo turno
**Effort: M** — item 8 (meccanismo scelto); item 2 e 26 fusi/ridotti.

**Problema.** Difetto osservato in produzione: «crea un gioco snake con un workflow» → Atomic lancia un run nominato, il turno finisce subito con «Workflow avviato: `<id>`», e `--wait` stampa quel testo come se fosse il risultato. `workflows.md`: «Named launches wait only for **startup admission**, not for workflow completion … returns `status: "running"`». Il bridge non osserva nulla del ciclo di vita: completamento, fallimento e attesa di input umano sono strutturalmente invisibili.

**Design.**
- `pi.on("tool_execution_end")`: `toolName === "workflow"`, `isError` falso → estrarre il run id (UUID **pieno a 36 caratteri**; i prefissi sono rifiutati da Atomic) → `{type:"workflow_started", runId, owner}`. Il `run_settled` che segue porta `provisional: true, pendingWork:[{kind:"workflow", runId}]`, così il controller sa che il terminale non è finale.
- Ciclo di vita: Atomic appende «one `display: true`, `excludeFromContext: true` lifecycle card to agent state and `SessionManager`», e «the visible card preserves the lifecycle custom type, raw notice text, exact details payload». Emettere `{type:"workflow_lifecycle", runId, kind, text, details}` per ogni card il cui `details` contiene un run id noto.
- Controller: se durante il turno posseduto arriva `workflow_started`, `--wait` **non esce** su `agent_settled` ma continua fino al notice terminale di quel `runId` (`completed`/`failed`/`blocked`), con exit code dedicato per il lavoro asincrono staccato.
- `--then-status` opzionale: dopo il notice terminale, follow-up che ordina all'agente di chiamare `workflow({action:"status", runId})` e riportare `detail.status`, `detail.error`, `detail.result` — perché la doc avverte che «Lifecycle notices carry terminal status/error, not declared workflow outputs».

**Due correzioni obbligatorie rispetto alla proposta originale** (verifica API: `weak`):
1. **Non usare `pi.on("entry_appended")` come canale.** `entry_appended` è documentato in un solo punto, §`pi.appendEntry`: «Appending emits `entry_appended` with the durable entry» — cioè per le append fatte *dall'estensione*. Che le lifecycle card appese da Atomic emettano quell'evento verso le estensioni non è documentato. Il percorso documentato è **`ctx.sessionManager.getEntries()`** con un cursore ai confini `before_agent_start` / `agent_settled`. Verificare `entry_appended` sul codice prima di dipenderne; altrimenti scansione a cursore.
2. **Niente exit code su `awaiting_input`.** `workflows.md`: «Awaiting-input workflow states are tracked for dedupe/restore, but they do not enqueue main-chat connect cards». Non c'è card da mirrorare: va letto da `workflow({action:"status"})`. Le notice reali in main chat sono `started`/`completed`/`failed`/`blocked`/`paused`/`quit`/`resumed`.

**Scartato dagli altri due item:** il probe `workflow({action:"status"})` iniettato via `followUp` (item 2, punto C) consuma token dell'utente e sporca la sua history per un dato ottenibile gratis dalle card; il fallback su `~/.atomic/workflows/runs/<runId>/transcripts/` (item 26, punto 4) accoppia il plugin al layout su disco interno di Atomic — la cosa più fragile da cui dipendere. Nota per l'item 2: il default Intercom `control-and-result` vale per **run diretti `parallel`/`chain` async**, *non* per i lanci nominati — quindi quel rilevatore era agganciato al canale sbagliato per lo scenario della demo, e il suo `workflow_delivery_warning` sarebbe scattato su ogni lancio nominato.

**File:** `atomic-remote-bridge.ts`, `atomic-ctl.mjs`, `SKILL.md`.

**Perché ora.** È l'unico difetto che ha prodotto un risultato *sbagliato ma plausibile* in demo. Un `--wait` che mente è peggio di un `--wait` che va in timeout.

---

### 4. Inbox: validazione a schema, ingestione fail-closed, coda seriale, at-least-once
**Effort: M** — fonde item 14 (schema), 5 (trasporto), 13 (fail-closed, ridotto).

**Problema.** Quattro difetti nello stesso percorso (`atomic-remote-bridge.ts:121-151, 176-179`):
- `JSON.parse(raw) as BridgeCommand` (`:144`) è un **cast, non una validazione**. `{"message":{}}` supera tutti e quattro i check `if (!cmd.message)` (`:82/94/99/104`) perché un oggetto è truthy, e arriva malformato al provider. E poiché `pi.sendUserMessage` accetta per doc anche `[{type:"text"},{type:"image", source:{type:"base64", mediaType, data}}]`, un campo che il codice tratta come testo può **iniettare un'immagine arbitraria nel contesto del modello**. Un `id` assente diventa la stringa `"no-id"` (`:75`): due comandi senza id si accavallano nell'outbox e `--wait` conclude sulla risposta sbagliata.
- `void handleCommand(cmd)` dentro il `for` (`:149`) lancia N iniezioni **concorrenti**: due prompt scritti in ordine arrivano invertiti, e il fallback prompt→steer del `catch` (`:83-90`) compete con l'iniezione successiva.
- Read-then-delete: `rmSync` (`:137`) **prima** dell'iniezione. Qualunque errore dopo perde il comando senza traccia, l'`accepted` non arriva mai, e il controller aspetta 300 s per nulla.
- `fs.watch` senza handler `error` (`:177`): l'errore risale nell'engine child e il bridge diventa sordo per sempre.
- `readFileSync(file)` su qualunque `*.json`, senza check di tipo né cap di dimensione: una FIFO nell'inbox blocca il callback, e §Interactive callback isolation documenta heartbeat a 50 ms, callback attivo identificato a 250 ms, engine unresponsive dopo 1 s → self-DoS osservabile.

**Design.**
- `parseCommand(raw: string): BridgeCommand | {reason}` che valida invece di castare. `BridgeCommand` diventa una **union discriminata su `action`** (`{action:"ping", id}` senza message; le altre con `message: string` obbligatorio) — spariscono i quattro `throw` sparsi e la garanzia passa al compilatore, in linea con la regola no-`any`/no-`unknown` di AGENTS.md. Regole: oggetto non-array; `action ∈ ACTIONS`; `id` match `/^[A-Za-z0-9_-]{1,64}$/` (assente → **rifiuto**, non `"no-id"`); `message` `typeof "string"`, non vuoto dopo trim, `≤ MAX_MESSAGE_CHARS`, privo di caratteri di controllo diversi da `\n`/`\t`; chiavi ignote elencate in `unknownKeys` del record `rejected`.
- Ingestione: `fs.openSync(file, O_RDONLY | O_NOFOLLOW)`, `fstatSync` → scartare se `!isFile()` (chiude FIFO/dir/device) o `size > MAX_COMMAND_BYTES` (64 KiB), leggere **dal fd** (elimina il TOCTOU stat→read). Cap sul batch per tick (32 file). *Il check `uid` va guardato su Windows: `process.getuid()` è POSIX-only.*
- Coda seriale: `chain = chain.then(() => handleCommand(cmd))`. Un comando alla volta, ordine preservato, errori confinati.
- At-least-once: `rename(inbox/<f>.json → <f>.processing)` → parse → `accepted`/`error` → iniezione → `rm`. I `.processing` residui all'avvio diventano `{type:"error", id, error:"command interrupted by engine restart", recoverable:true}` — un terminale invece di un timeout.
- Ack **sempre**, anche sui casi degeneri (JSON invalido, azione sconosciuta, id mancante), includendo l'id.
- Watcher: `watcher.on("error")` → chiude, emette `{type:"watch_restarted"}`, ricrea con backoff; più `setInterval(consumeInbox, 1000).unref()` come rete di sicurezza (idempotente grazie al rename-marker).
- `delivered: "immediate" | "steer-fallback"` nell'`accepted`, con `--strict-mode` che fallisce invece di degradare silenziosamente un `prompt` in `steer`. Usare `await Promise.resolve(pi.sendUserMessage(...))` — prudente, ma nota che la formula «admission receipt» è documentata per `sendMessage`/`sendMessages`, non per `sendUserMessage`.
- Nomi file ordinabili a larghezza fissa lato controller (oggi due comandi nello stesso millisecondo si ordinano per UUID, cioè casualmente). Marginale ma gratuito.

**File:** `atomic-remote-bridge.ts`, `atomic-ctl.mjs`.

**Perché ora.** Sono correzioni piccole e localizzate in un unico punto del flusso, e chiudono la classe di fallimenti «il comando è sparito e nessuno lo sa». Il fix dello schema e quello del fstat sono due righe nello stesso posto: farli separatamente è spreco.

---

### 5. Storia durevole + `readNewRecords` robusto + doppio timeout + exit code
**Effort: M** — fonde item 4 (bridge + lettore) e item 20 (controller: timeout + tassonomia), con il `mode 0o600` recuperato dall'item 16.

**Problema.** Tre bug che si sommano:
- `session_shutdown` → `teardown(true)` → `rmSync` ricorsivo (`:203-206`), ma `event.reason` include `reload|new|resume|fork`: un semplice `/reload` cancella **tutta** la storia delle risposte. `ctx.reload()` è documentato come «emits `session_shutdown` … then reloads … emits `session_start` with reason `"reload"`», quindi il caso è quotidiano, non eccezionale.
- `readNewRecords` (`atomic-ctl.mjs:97-114`) è irrimediabilmente rotto ai riavvolgimenti: la guardia `buffer.length <= offset` (`:100`) su un file ricreato o troncato restituisce **zero record per sempre, in silenzio**, e la guardia `isAlive(target.pid)` (`:155`) non scatta perché il pid del child può essere ancora vivo → `--wait` appeso fino a 300 s invece di dire «sessione chiusa». Inoltre fa un `readFileSync` integrale ogni 250 ms.
- `--timeout` è un wall clock cieco di 300 s (`:166`): uccide i task legittimi lunghi e attende cinque minuti su una sessione muta. E tutti gli exit code sono `1` tranne il timeout, quindi il modello che invoca lo script non distingue «ancora al lavoro» da «bridge rotto» da «lavoro asincrono staccato» — precisamente l'informazione su cui ha sbagliato in demo.

**Design.**
- Il bridge **non cancella mai** la propria directory su `session_shutdown`. Emette `{type:"bridge_closed", reason, targetSessionFile}`, aggiorna `meta.json` a `status:"closed"`, chiude watcher e heartbeat. Cancella **solo `inbox/`** (i comandi pendenti non devono sopravvivere a una sessione morta: è il vettore di replay). `teardown` perde il ramo `removeDir: true`.
- `emit` apre l'outbox con `{mode: 0o600}` + un `chmodSync` una volta per sessione sui file preesistenti: oggi nasce 0644 e **contiene il testo finale dell'assistente**, cioè codice del progetto ed eventuali segreti, protetto solo dai 0700 del padre — quindi esposto da qualunque backup, sync cloud o `tar` di `~/.atomic`. Non toccare `process.umask()` (effetto globale sull'agente).
- GC del bridge su `session_start`: rimuove solo directory `status:"closed"` oltre `BRIDGE_RETENTION_MS` (7 giorni), tenendo le 50 più recenti. Le `live` non si toccano mai.
- Rotazione outbox a `OUTBOX_MAX_BYTES` (8 MiB) → `outbox.1.jsonl`, una sola generazione, con `{type:"outbox_rotated"}` come ultima riga del vecchio file. Senza questo, "history durevole" diventa "perdita illimitata".
- `readNewRecords` stateful su `{ino, size, offset}` via `statSync`: se `ino` cambia o `size < offset` → `offset = 0` e riscansione con dedup su `id+type+ts`. `openSync` + `readSync` posizionale sul solo delta, al posto del `readFileSync` integrale.
- `bridge_closed` è **terminale** per `--wait`, con messaggio che distingue `reload`/`resume` («la sessione è stata ricaricata, il comando può essere andato perso; ricontrolla con `tail <id>`») da `quit`. Con l'id stabile dell'item 1, `--wait` può anche ri-agganciarsi: attesa fino a `--reattach-window` (20 s) di un nuovo `bridge_ready` con lo stesso id.
- **Doppio timeout**: `--idle-timeout` (default 120 s, misurato dall'ultimo record ricevuto — i record di progresso del backlog lo alimentano) diventa il default; `--timeout` resta come tetto assoluto opzionale. Un agente che lavora non va mai in timeout; uno muto viene diagnosticato in due minuti con «nessuna attività da 120 s, ultimo tool: bash».
- Campo `contended` nell'`accepted`, derivato da `ctx.isIdle()`/`hasPendingMessages()`: il modo economico di dire «non fidarti dell'attribuzione».
- **Tassonomia exit code**, documentata in un posto solo (`--help` + SKILL + README): `0` completato, `2` idle-timeout, `3` nessuna sessione live, `4` target ambiguo, `5` errore bridge, `6` attribuzione incerta, `7` lavoro asincrono staccato.

**File:** `atomic-remote-bridge.ts`, `atomic-ctl.mjs`, `SKILL.md`, `README`.

**Perché ora.** Il bug di `readNewRecords` è silenzioso: non produce un errore, produce zero record per sempre. È il tipo di difetto che si scopre dopo aver perso mezz'ora a debuggare la cosa sbagliata.

---

## 2. BACKLOG (confermate, una riga ciascuna)

- **Azioni `status` e `abort`** [S] — Il miglior rapporto valore/effort del lotto, e l'unico item che *aggiunge* una capacità invece di correggerne una: oggi il bridge inferisce "occupato" da un throw catturato (`:83-90`) e `interrupt` richiede obbligatoriamente un `message` (`:104`), quindi non c'è modo di fermare un turno senza iniettare testo. Nuove azioni inbox `{action:"status"}` (con `ctx.isIdle()`, `ctx.getContextUsage()`, `ctx.model`, `pi.getSessionName()`, `getLeafId()`, contatore di generazione aggiornato a ogni handler — la sostituzione del child è documentata, non è paranoia) e `{action:"abort"}` → `ctx.abort()`. `send` fa un preflight e **scegle** la modalità di consegna invece di scoprirla da un'eccezione. **Riserve:** `hasPendingMessages()` è un predicato, non un conteggio — il `pendingMessageCount` esiste solo in `rpc.md` §`get_state`, quindi la promessa «ci sono già 2 messaggi accodati» nella SKILL non è ottenibile da questa API; e la semantica di `ctx.abort()` è classificata come «control flow helper» senza firma né descrizione, va verificata sul codice prima di esporla come azione remota distruttiva.
- **Progress stream bounded** [S/M] — Delle quattro proposte sullo streaming (6/9/19/30) è la sola da implementare, perché è l'unica che decide cosa **non** scrivere: file `progress.jsonl` separato (l'outbox resta il canale a bassa cardinalità di `--wait`), `tool_start`/`tool_end` con `argsPreview`/`resultPreview` troncati a 500 caratteri + flag `truncated`, `turn`, e un `text_progress` throttlato a 1/s con `tail` di 200 caratteri — mai i delta grezzi token per token. Motivazione tecnica corretta e citata: gli handler girano nell'engine child con heartbeat a 50 ms, un handler costoso è un self-DoS. Alimenta l'idle-timeout della TOP 5. `atomic-ctl watch` una riga per evento; `status` in una riga: run corrente, tool attivo, secondi dall'ultimo evento — esattamente il segnale che oggi manca per decidere se steerare o aspettare.
- **Targeting a precedenza dichiarata** [S] — `resolveTarget` (`:86-91`) mette in OR nome esatto, `id.startsWith` e `cwd.toLowerCase().endsWith()`: un token come `src` matcha più sessioni e produce "ambiguo" su input ragionevoli, e non esiste alcun bonus per la sessione nella stessa cwd del controller — il caso più frequente, e quello per cui `auto` oggi fallisce con due sessioni aperte. Precedenza a livelli (nome esatto → sessionName → prefisso id → cwd identica → cwd contenuta/contenente su path split, non `endsWith` su stringa → basename), ambiguità risolta solo *entro* lo stesso livello. Default `name = pi.getSessionName() ?? basename(cwd)` al posto di `null` (`:170`) elimina il `/remote-name` manuale che nessuno si ricorda, e `session_info_changed` (`event.name`) tiene allineato il nome quando l'utente usa `/name` — che è anche il nome che serve al selettore TUI e al targeting Intercom. `--target` esplicito chiude un errore di parsing oggi silenzioso: `send "testo"` senza target interpreta il messaggio come target.
- **Superficie comandi/skill + allegati immagine** [M] — Sblocca un caso oggi impossibile: da Claude Code non si può dire ad Atomic «esegui la tua skill X» né sapere cosa quella sessione sa fare. `pi.getCommands()` è definito dalla doc esattamente come «the slash commands available for invocation via `prompt`», quindi validare il nome e iniettare `/<name> <args>` è il percorso documentato, non un trucco (§`ctx.reload()` mostra `pi.sendUserMessage("/reload-runtime", {deliverAs:"followUp"})` come pattern ufficiale). Rifiuto esplicito dei built-in interattivi (`/model`, `/settings`), che la doc dichiara assenti da `getCommands()` e non eseguibili via `prompt`. Parte immagini (`--image <path>` → content block base64, tetto 5 MB, allowlist di media type) marginale: se serve tagliare, si taglia quella e resta il valore.
- **`--message-file` / `--message-stdin` + validazione di `atomicBin`** [S] — Da fare per due motivi *funzionali*, non per la riservatezza con cui è presentato (argv visibile a `ps` su macchina personale è un rischio tenue). Primo: `messageParts.join(" ")` (`:206`) collassa gli spazi consecutivi e perde i newline — **ogni prompt multi-riga arriva ad Atomic già danneggiato**, bug reale e oggi invisibile; l'RPC trasmette comunque il prompt su stdin, quindi cambia solo l'acquisizione. Secondo: validare `atomicBin` (`rpc-run.mjs:38`) con check della major di Node trasforma il difetto 5 osservato (Node 20 vs 22) da `TypeError` di undici in «atomic richiede Node ≥ 22; trovato v20 — usa `nvm use 22`». **Riserva:** l'allowlist di env è la parte debole — rischia di togliere credenziali provider che oggi funzionano; introdurla solo con `--env-passthrough` documentato e testato.
- **`confirm` solo su `interrupt`** [S] — Dell'item 15 sopravvive un pezzo: `interrupt` oggi aborta il turno in corso dell'utente (`deliverAs:"interrupt"` + `triggerTurn`) senza che chi è davanti alla TUI possa opporsi. Un `ctx.ui.confirm(..., {timeout: 30_000})` su quella sola azione costa dieci righe ed è fail-closed per costruzione (la doc: «`confirm()` returns `false`» al timeout; i dialog sono proxati all'host, quindi funzionano nell'engine child). **Buttare la policy a quattro modalità, il ramo `isProjectTrusted()` e il fail-closed su `hasUI`** — quest'ultimo è anche tecnicamente sbagliato: `ctx.hasUI` è `true` **anche in RPC**, la guardia corretta è `ctx.mode === "tui"`.
- **Rifiuto dei flag sconosciuti** [XS] — `parseFlags` fa `rest.push(arg)` per qualunque token non riconosciuto (`:173`): un `--timout` scritto male non è un errore, **finisce dentro il prompt inviato ad Atomic**. Tre righe, da fare insieme a qualsiasi altro item. (Il resto dell'item 23 — unificazione dei due CLI in nove sottocomandi con tre moduli estratti — è un rifacimento estetico su due script che servono percorsi diversi e non condividono utenti; rinviato.)
- **`protocol` + `bridgeVersion` nel `bridge_ready`** [XS] — Dell'item 28 sopravvive l'osso: dopo un aggiornamento del plugin l'estensione installata resta vecchia e le azioni nuove diventano `unknown action` (`:114`) senza che nessuno capisca perché. Il controller legge l'ultimo `bridge_ready`, e se il protocol non combacia stampa «aggiorna il bridge con `/atomic-remote:setup`» invece di degradare in silenzio. **Buttare** manifest con `sourceHash`, auto-copia in staging, `/remote-update` e `doctor`: è un aggiornatore automatico per un'estensione che una persona reinstalla con un comando già esistente, e un'estensione che riscrive i propri file su disco è una superficie di rischio nuova a costo zero risparmiato. (Nota: `atomicMode: ctx.hasUI ? "tui" : "headless"` etichetta male l'RPC — usare `ctx.mode`.)
- **Riuso di `readNewRecords` per `follow`** [XS] — Dall'item 19 si prende solo l'osservazione (corretta) che `readNewRecords` è già un lettore incrementale a byte-offset con gestione della riga parziale ed è usato solo dentro `--wait`: il sottocomando `follow` è quasi gratis riusandolo, più il campo `v: 1` sui record. **Si scarta la destinazione**: mettere delta e tool call *dentro* `outbox.jsonl` è la scelta sbagliata — è il canale che `--wait` rilegge in polling; vanno nel file separato del progress stream.
- **SKILL.md riscritta come albero decisionale** [S] — **Da fare per ultimo**, perché documenta ciò che gli altri item avranno costruito, ma è il posto dove un difetto costa più caro: in demo il modello ha presentato «Workflow avviato: `<id>`» come risultato finale perché nessuna regola gli diceva di non farlo. Tre blocchi: (1) tabella di scelta bridge/RPC; (2) protocollo di attribuzione come **regole imperative** («prima di `send --wait` esegui `status`; se `idle:false` o l'`accepted` riporta `contended`, NON attribuire la risposta al tuo comando»); (3) tabella exit code → azione (`2` = ancora al lavoro, ricontrolla, non ripetere il prompt; `7` = workflow async, riporta il run id e non spacciare il testo dell'`agent_end` per risultato; `6` = non riportare nulla come risposta di Atomic). Senza quella tabella gli exit code nuovi restano invisibili. Aggiungere `/atomic-remote:status`, `/atomic-remote:follow`, `/atomic-remote:interrupt` come comando **separato** con la conferma nel frontmatter — che toglie `interrupt` dai `--mode` che il modello può scegliere per sbaglio dentro `/send`, ottenendo l'80% dell'item 15 senza il gate. Consolidare la spiegazione dei modi in un posto solo (oggi duplicata in `send.md`, SKILL e README).

---

## 3. SCARTATE

- **Item 16 — Audit durevole 0600 fuori dalla directory effimera**: metà è duplicazione dell'item 4 (fatta meglio là, che include il lato controller); l'altra metà è un sottosistema di audit (file giornalieri, sha256 troncato, `ATOMIC_REMOTE_AUDIT_CONTENT`, `RETENTION_DAYS`, sottocomando `audit`) che per un utente singolo registra le proprie azioni per un lettore che non esiste — e l'item stesso ammette la ridondanza dicendo di non copiare il contenuto perché «il transcript è già persistito su disco». Sopravvivono due righe, già assorbite nella TOP 5: il `mode 0o600` sull'outbox e la cancellazione della sola inbox allo shutdown.
- **Item 29 — Flotta di worker headless-RPC**: l'unica proposta che non corregge nulla di osservato. Costruisce supervisori per worker, gestione completa di `extension_ui_request`, registry `in.jsonl`/`out.jsonl` per processo, health via `get_session_stats`, riavvio con riattacco, budget in dollari con parking, broadcast e gather — sopra fondamenta dove `--wait` attribuisce la risposta sbagliata e `list` cancella le directory delle sessioni vive: moltiplica i modi di sbagliare per N. Atomic offre già l'orchestrazione multi-agente in prima persona (`@bastani/subagents`, workflow `parallel`/`chain`, gruppi Intercom): il pattern planner→N worker si esprime *dentro* Atomic con un workflow, e il ruolo del plugin è comandarne uno, non reimplementare lo scheduler fuori. Contiene anche due assunzioni non documentate (`--mode rpc --session <path>` non esiste — il percorso è `switch_session`; e una sessione è raggiungibile via Intercom solo dopo aver invocato una superficie Intercom, quindi i worker non si vedono "per costruzione"). L'unico pezzo utile, il binario pinnato con check di Node, è già nel backlog.
- **Item 15 (policy completa)**, **item 28 (auto-update)**, **item 23 (unificazione CLI)**, **item 26 (fallback su artefatti su disco)**: ridotti al pezzo utile, il resto rinviato — motivi nelle voci di backlog corrispondenti.
- **Duplicati puri**, fusi senza contenuto residuo: item 1 e 25 (in 2), item 2 e 26 (in 3), item 3, 11, 21, 27 (in 1), item 6, 9, 19 (nel progress stream), item 13 (in 4), item 20 (in 5).

---

## 4. La modifica da fare per prima

**Il fix identità/liveness (TOP 5 #1), e in particolare togliere il `rmSync` da `listSessions()`.** Non perché sia il difetto più visibile — quello è il `--wait` che ha stampato «Workflow avviato: `<id>`» come risultato — ma perché è l'unico che *distrugge dati e li distrugge silenziosamente durante un'operazione di sola lettura*. `atomic-ctl.mjs:54-60` esegue `rmSync` recursive dentro un `list`, decidendo la vita sulla base di `process.kill(meta.pid, 0)` su un pid che la doc di Atomic dichiara esplicitamente transitorio: dopo ogni sostituzione dell'engine child — watchdog o crash, entrambi documentati con il loro messaggio — il primo `list` cancella la directory di una sessione perfettamente viva, portandosi via outbox, comandi pendenti e il target su cui gli script dell'utente puntano. Ogni altro item della roadmap scrive in quella directory: l'attribuzione, il progress stream, la storia durevole, l'handshake di versione. Costruirli sopra una directory che un comando innocuo può cancellare significa doverli debuggare due volte. Il fatto che questo stesso fix ricorra in sei proposte indipendenti su trenta è il segnale più forte prodotto da tutta la valutazione: è la fondazione, e va posata prima.

## Upstream gap (atomic 0.9.15, filed from the v3 e2e)

`/workflow reload` followed immediately by `/workflow <name>` can run the
pre-reload module: `pi.sendUserMessage` returns before command execution
(fire-and-forget binding), workflow name resolution does not await an
in-flight reload (`ensureWorkflowResourcesLoaded` waits only while no
discovery exists at all), and a reload report can reflect a coalesced warmup
that read the file before it was rewritten. Observed live: overwrite → reload
"generation 2" → run executes the old module → the real reload lands as
generation 3 after the run. The bridge mitigates with `RELOAD_SETTLE_MS`
between the two injections; the durable fix belongs in the engine (await
in-flight discovery on name resolution, or expose reload completion to
extensions).

**Status:** the engine fix exists and is submitted upstream for maintainer
review (branch `fix/workflows-await-inflight-reload` on `bastani-inc/atomic`:
`ensureWorkflowResourcesLoaded` now awaits an in-flight reload). Keep
`RELOAD_SETTLE_MS` until the fix ships in a released Atomic and that release
is the oldest engine this bridge supports; it protects every engine ≤ 0.9.15.
When dropping it, gate on the Atomic version rather than deleting outright.
