# Valutazione evolutiva `atomic-remote` 0.3.0 — Report finale

Ciclo verso la 0.3.1. Verifica condotta rileggendo per intero `scripts/atomic-ctl.mjs` (832 righe) e `atomic-extension/atomic-remote-bridge.ts` (958 righe), più le finestre rilevanti di `extensions.md`, `rpc.md`, `workflows.md`, `intercom.md`, `environment-variables.md`, `security.md` (doc primaria Atomic, `packages/coding-agent/docs/`). Tutti gli 8 difetti candidati reggono; due sono più gravi del dichiarato. Delle 14 leve nuove, 11 sono documentate; 3 non superano la verifica valore/rischio.

Il protocollo v3 ha chiuso i quattro anelli deboli della staffetta (handoff, dispatch, feedback tipizzato, outcome interrogabile). I difetti residui stanno tutti in un posto: lo stato in memoria dell'attribuzione e la storia su disco. Le leve nuove che valgono sono due, non quattordici: la visibilità dell'`awaiting_input` (l'unico stato di run oggi strutturalmente invisibile al bridge) e la validazione della superficie comandi. Il resto o è già coperto dal file transport esistente, o costruisce sopra API non documentate.

Notazione: `ctl` = `scripts/atomic-ctl.mjs`, `bridge` = `atomic-extension/atomic-remote-bridge.ts`, doc = `packages/coding-agent/docs/`. I riferimenti riga sono allo stato 0.3.0 (commit `09ae937`).

---

## 1. TOP 5 prioritizzato

### 1. Attribuzione: discriminatore di preemption strutturale + scadenza dello stato pendente
**Effort: M** — fonde i difetti 3 e 4, con la leva (a) come contorno.

**Problema.** Tre fori nella stessa membrana, tutti verificati sul codice:
- Preemption (`bridge:860`): il settle di un run abortito è distinto dal settle del turno dell'interrupt solo tramite `!endSeenSinceStart`. L'interleaving rotto è reale: se l'`agent_end` tardivo del run abortito arriva dopo l'`agent_start` dell'interrupt, `endSeenSinceStart` torna `true`, il settle abortito cade nel ramo normale (`bridge:875-897`), viene attribuito all'owner dell'interrupt con `text` del run abortito (`bridge:884-885`), e azzera `activeOwner` mentre il turno dell'interrupt è ancora vivo. Il controller risolve exit 0 su testo altrui. È la stessa classe di bug che 0.3.0 ha appena dichiarato chiusa nel CHANGELOG.
- `pendingBindings` (`bridge:262`, popolata a `:451-454`): rimossa solo su match dell'evento `input`, sul catch, o a `session_start`. Un binding mai consumato (es. `--mode command`, dove il commento a `bridge:555-556` documenta che una slash gestita non emette `input`) resta vivo per sempre e cattura un turno futuro con testo identico.
- `pendingWorkflowLaunch` (`bridge:277`, armato a `:557`): disarmato in un solo punto (`bridge:398-401`, match del notice `started`). Non è nel catch (`bridge:573-577`) e non è nella lista di reset di `session_start` (`bridge:720-730`), quindi sopravvive anche a `/new`, `/resume` e `/fork`, contraddicendo il commento a `bridge:718-719`. Un launch fallito lascia il prossimo run omonimo, anche lanciato a mano dall'utente, attribuito a un command morto.

**Design.**
- Discriminatore: al settle, se `preemptedOwner !== null`, attribuire al preempted quando `!endSeenSinceStart` **oppure** quando l'engine è ancora occupato (`ctx.isIdle()` falso, la stessa fonte di verità già adottata per busy/idle a `bridge:253-259`). `agent_settled` significa per doc «Atomic has no automatic continuation left» (extensions.md:620), quindi al settle vero l'engine è idle. Un boolean di ordinamento in meno, un predicato dell'engine in più.
- Contorno a costo zero: passare `interruptAbortMessage: "interrupted by atomic-remote command <id>"` nell'interrupt (`bridge:564-569`), documentato a extensions.md:1548. Rende leggibile nel transcript perché il turno è morto. Non risolve l'attribuzione, la spiega.
- Scadenza: `pendingBindings` con cap (32 voci, evizione FIFO) e TTL (10 min); allo scadere il bridge emette `{type:"error", id, error:"binding expired: injection produced no input event"}` così `--wait` fallisce forte invece di appendersi. `pendingWorkflowLaunch` con TTL di 60 s (2 × `RELOAD_SETTLE_MS` più margine), disarmo nel catch, e aggiunta alla lista di reset di `session_start`.

**File:** `bridge`. **Perché ora.** L'attribuzione affidabile è la promessa centrale del plugin e la feature su cui CC replana. Un leak che misattribuisce in silenzio è la classe di fallimento peggiore: produce risposte plausibili e sbagliate, come il difetto che 0.3.0 ha corretto in demo. Dentro l'item, la prima modifica in assoluto è il disarmo di `pendingWorkflowLaunch`: è l'unico difetto che sopravvive perfino a `/new` e `/fork` e che misattribuisce lavoro lanciato dall'utente a un comando remoto morto.

### 2. HIL visibile e sbloccabile: awaiting_input, heartbeat dei run, statusFile
**Effort: M** — la leva nuova con il rapporto valore/rischio migliore del lotto.

**Problema.** Un run che si ferma su una domanda umana è oggi strutturalmente invisibile al bridge. La tabella di config a workflows.md:3610 lo dice verbatim: «`awaiting_input` is tracked for dedupe/restore without waking the main agent». Nessuna card in main chat, quindi nessun `custom_message` da mirrorare, quindi il bridge non lo vedrà mai per costruzione. Scenario concreto della staffetta: CC lancia un workflow con `run-workflow --wait`, il run chiede conferma, nessuno risponde, `--wait` esce 7 o va in idle-timeout dicendo «sta ancora lavorando». Falso, sta aspettando te.

**Design.**
- Heartbeat dei run: lo scan a `bridge:369-423` filtra oggi solo `customType === "workflows:lifecycle-notice"` (`bridge:81`). Aggiungere `workflows:workflow-heartbeat` (workflows.md:1963, consegnata come steer accodato in main chat, quindi entry visibile a `getEntries()`) ed emettere `{type:"workflow_heartbeat", runId, elapsed}`. Cardinalità 1 ogni 15 minuti per run (default `heartbeatIntervalMinutes`, workflows.md:3271): compatibile con l'outbox a bassa cardinalità, e alimenta l'idle-timeout del controller, che oggi scatta a 120 s su run lunghi e muti.
- Lettura `statusFile`: quando il progetto abilita `statusFile: true`, il runtime scrive un derivato in `.atomic/workflows/status.json` (workflows.md:3610). Il controller ha già `cwd` nel meta: `status` e `follow` lo leggono read-only, a costo zero token, e riportano i run `awaiting_input`. Feature dichiarata `best-effort, se configurato`, con l'istruzione di abilitazione nel messaggio quando il file manca e ci sono pending run. Caveat documentato: `statusFile: true` paga un clone completo dello snapshot a ogni versione dello store (workflows.md:3990), quindi resta opt-in dell'utente, il bridge non tocca la config di progetto.
- Sblocco: nuovo comando controller `answer <target> <runId> <testo>` che inietta (via `follow_up`) un prompt operativo: «rispondi al prompt pendente del run `<runId>` con `workflow({action:"send", runId, ..., delivery:"answer"})`». La forma dell'azione è documentata a workflows.md:3128, e il `runId` viaggia sempre come UUID pieno di 36 caratteri (workflows.md:124). Costa un turno del modello: accettabile, perché il bridge non può invocare tool di altre estensioni (verificato nella spike B1, `decisions.tsv`), e l'alternativa (parlare al broker DBOS) è rifiutata sotto.
- Snapshot `outcome`/`--wait`: i run pendenti guadagnano `awaitingInput: true` quando noto, e il messaggio di exit 7 distingue «in esecuzione» da «in attesa di input umano: usa answer».

**File:** `bridge`, `ctl`, `SKILL.md`. **Perché ora.** È il buco più largo rispetto all'intento del prodotto. La staffetta CC→workflow→CC oggi si spezza esattamente nel punto in cui il workflow ha bisogno di un umano, e nessun exit code lo dice. (Principio experience-first: questo item batte in priorità fix più facili perché è quello che l'utente della staffetta sente.)

### 3. Coda a due corsie: abort/status mai in coda dietro uno sleep di 5 s
**Effort: S** — fonde i difetti 7 e 5.

**Problema.** La catena seriale è unica per l'intera sessione (`bridge:280`, `:646-647`) e `run_workflow` ci dorme dentro 5 s (`bridge:549`, `RELOAD_SETTLE_MS` a `:75`). Ogni comando accodato dietro aspetta: un `abort` o un `interrupt` (la cui ragione d'essere è la latenza) restano fermi, e `ping`/`status` hanno un timeout client di soli 10 s (`ctl:43`). In un batch da 32 (`bridge:66`) bastano due `run_workflow` per far scadere un `ping`. Secondo foro nello stesso percorso: `session_shutdown` rimuove l'inbox e ferma il watcher (`bridge:930-939`), ma l'heartbeat resta «fresco» fino a 20 s (`ctl:37`), quindi `writeCommand` supera il check di liveness (`ctl:224`) e `fs.mkdirSync(tmpDir, {recursive: true})` (`ctl:229`) ricrea un'inbox che nessuno leggerà. Se il `bridge_closed` era già stato consumato dalla `readNew()` iniziale (`ctl:409`), il `--wait` brucia l'intero idle-timeout.

**Design.**
- Due corsie nel dispatch dell'ingestione: `ping`/`status`/`abort` non iniettano nulla e vengono gestiti subito, fuori dalla chain; le azioni che iniettano (`prompt`/`steer`/`follow_up`/`command`/`interrupt`/`run_workflow`) restano seriali. La corsia di controllo non ha stato condiviso in scrittura con quella di iniezione, quindi non serve serializzarla (principio separate-before-serializing: si elimina la condivisione invece di ereditare il lock).
- `RELOAD_SETTLE_MS` resta ma diventa version-gated appena il fix upstream (`fix/workflows-await-inflight-reload`, già inviato ai maintainer) esce in una release di Atomic: gate sulla versione engine se esposta dall'API, altrimenti resta finché la release minima supportata non la include. Non allargarlo, non replicarlo.
- Fail-fast di consegna: `writeCommand` legge `meta.json` e rifiuta con exit 3 quando `status === "closed"` (una riga, chiude quasi tutta la finestra TOCTOU di 20 s senza toccare il bridge).

**File:** `bridge`, `ctl`. **Perché ora.** La latenza di `abort`/`interrupt` è il pegno operativo più visibile del plugin, e il fix è piccolo e locale. Curare il sintomo alzando i timeout sarebbe il classico guard-fix; la causa è la corsia unica (principio fix-root-causes).

### 4. Ordine totale e replay onesto: `seq` monotono, `tail` multi-generazione, `outcome` action-aware, cursore entry persistito
**Effort: S** — fonde i difetti 1, 2 e 6.

**Problema.** Quattro difetti piccoli nello stesso strato, tutti confermati:
- `outcome` costruisce il tracker con `action: "prompt"` hardcoded (`ctl:737`) e `isPrompt` è un `const` catturato alla costruzione (`ctl:241`); l'`accepted` aggiorna solo `st.action` (`ctl:269`). Uno steer replayato perde la weak-attribution (`ctl:327`) e riporta `working`/`exitCode: 2` per sempre; un `foreign_input` innocuo replayato riporta `uncertain`/6 (`ctl:287`). È la divergenza che il commento a `ctl:237-238` dichiara impossibile («cannot disagree»).
- `tail` legge solo `outbox.jsonl` (`ctl:766-771`); `outcome` legge anche la generazione ruotata (`ctl:739`). Dopo una rotazione `tail` stampa «(outbox empty)» su una sessione piena di storia.
- La dedupe key del reader (`ctl:204`) non discrimina record senza `id`/`runId`/`kind`: due `foreign_input` (o due `agent_end`) nello stesso millisecondo collassano in uno. E la dedupe è permanente entro il processo, non limitata ai rescan come dice il commento a `ctl:192`, mentre `outcome` non deduplica affatto: live e replay possono contare eventi diversi.
- Il cursore del mirroring workflow è un indice numerico (`bridge:272`, azzerato a `:728`): dopo un `/reload` lo scan ripete l'intera storia e la ri-emette; il path `outcome`, senza dedupe, la conta due volte.

**Design.**
- Ogni record emesso porta `seq` monotono di sessione (contatore in memoria, base = ms di avvio per unicità tra generazioni engine). La dedupe key diventa `seq` quando presente, la vecchia chiave resta per i record v2/v3.0 (compatibilità mantenuta senza gate). L'ordine diventa totale anche attraverso rotazione, e `outcome` guadagna la stessa dedupe del reader.
- `tail` legge `[outbox.1.jsonl, outbox.jsonl]` come `outcome`.
- Il tracker deriva la classificazione da `st.action` corrente (funzione, non `const`), e `outcome` parte con `action: "unknown"` adottando quella dell'`accepted`. Test red-then-green sul replay di uno steer completato.
- Il cursore dello scan passa dall'indice all'id dell'ultimo entry visto, persistito in `meta.json` (gli entry hanno id stabili con semantica di cursore durevole, rpc.md:746). Un `/reload` riprende da dove era, senza ri-emissioni (principio make-operations-idempotent: il replay converge allo stesso stato da qualunque punto di ripartenza).

**File:** `ctl`, `bridge`. **Perché ora.** `outcome` è l'API con cui CC replana: un `outcome` che mente su uno steer completato è lo stesso genere di bug del «Workflow avviato» spacciato per risultato, solo spostato di un livello. E la rotazione oggi è un evento che i comandi di lettura gestiscono in tre modi diversi (uno giusto, uno parziale, uno cieco): una sola semantica di lettura, condivisa.

### 5. Superficie comandi verificata via `getCommands()` + SKILL come albero decisionale
**Effort: S/M** — leva (g) più l'item SKILL già in backlog, fusi perché si documentano a vicenda.

**Problema.** `--mode command` inietta qualunque slash: un nome sbagliato o un'estensione non caricata degradano in testo chat che il modello può ignorare o, peggio, interpretare. E il modello CC che guida il plugin non ha modo di sapere cosa la sessione target sa fare.

**Design.**
- Bridge, su `action: "command"`: estrarre il nome (`/name …`) e validarlo contro `pi.getCommands()` (extensions.md:1699; include i comandi skill `/skill:name`, extensions.md:1205). Sconosciuto → record `error` tipizzato con i nomi disponibili (cap a 20). I built-in interattivi assenti da `getCommands()` vengono rifiutati automaticamente dalla stessa regola.
- `status` con flag opzionale che aggiunge `commands: [nomi]` allo `status_report` (solo nomi, non le descrizioni: l'outbox resta magro).
- SKILL.md riscritta nei tre blocchi già progettati (tabella bridge/RPC, protocollo di attribuzione imperativo, tabella exit code → azione), estesa con `answer`/`awaiting_input` dell'item 2. Va fatta per ultima nell'ordine di implementazione, perché documenta ciò che gli altri item costruiscono, ma sta nel TOP 5 perché in demo l'errore costoso è stato del modello lettore, non del transport.

**File:** `bridge`, `ctl`, `SKILL.md`, `commands/*.md`. **Perché ora.** Chiude l'ultimo fallimento silenzioso della staffetta in andata (comando che non dispatcha) e rende leggibili gli exit code nuovi introdotti dagli item 2-4.

---

## 2. Backlog

- **Progress stream separato** [S/M]. `progress.jsonl` con `tool_start`/`tool_end` troncati e `text_progress` a 1 Hz, `watch` nel controller. L'heartbeat mirroring dell'item 2 ne copre la fetta workflow; questo copre i turni ordinari lunghi. Resta su file separato, l'outbox non si tocca.
- **Targeting a precedenza con path-splitting** [S]. La precedenza a livelli è entrata in 0.3.0 (`ctl:112-118`); resta il livello 5 su `endsWith` di stringa (`ctl:117`), da sostituire con confronto per componenti di path, più l'affinità con la cwd del controller.
- **`--image`** [S]. Content block base64 documentato (extensions.md:1574), tetto 5 MB, allowlist di media type. Solo dopo l'item 1: un allegato su attribuzione fragile è peso morto.
- **`project_trust` per i run headless** [M, con riserva]. La leva regge sulla doc: un'estensione user/global può possedere la decisione (extensions.md:416-431, «the first yes/no decision wins»), e un progetto non trusted perde estensioni e context file in silenzio (security.md:24), il che in RPC senza UI significa risultati sbagliati senza diagnosi. Ma auto-trustare da remoto è un dirupo di sicurezza. Se si fa: allowlist per-path esplicita, scritta solo da un comando controller dedicato, default `"undecided"`. Non prima che esista un caso d'uso osservato.
- **Validazione Node-major in `rpc-run`** [XS]. Trasforma il `TypeError` di undici in «atomic richiede Node ≥ 22».
- **`ctx.ui.confirm` su interrupt** [S]. Solo su `interrupt`, gate su `ctx.mode === "tui"` (non `ctx.hasUI`, che è `true` anche in RPC), timeout fail-closed.

---

## 3. Reject motivati

- **Intercom-peer**. La parte pubblicabile della leva non esiste nella doc primaria: `broker.sock` e il framing length-prefixed non compaiono in `intercom.md` (verificato con grep sull'intero file), quindi il protocollo di registrazione peer è una superficie interna, senza contratto. Anche fosse documentato, i vincoli remano contro: una sessione non è raggiungibile finché non ha invocato una superficie Intercom (intercom.md:123-129), e ogni invocazione workflow top-level vive in un gruppo non-default derivato dall'identità del run (intercom.md:182) con isolamento imposto dal broker (intercom.md:176-178), quindi un peer esterno nel gruppo default non vedrebbe proprio i run che vorrebbe osservare. Il file transport fa già lo stesso lavoro, con contratto proprio e 83 test. (Principio laziness-protocol: un secondo transport è il genere di strato che si aggiunge e non si toglie più.)
- **`pi.events`**. Bus in-process, per istanza di estensione, con facade che scade al reload (extensions.md:1846-1856). Serve a estensioni che cooperano nella stessa sessione per contratto reciproco; gli eventi interni di `@bastani/workflows` non sono un contratto pubblico. Il canale documentato per il ciclo di vita è quello già usato, i `custom_message` in sessione. Nessun beneficio residuo sopra lo scan esistente.
- **Controllo di sessione remoto via `ExtensionCommandContext`**. Rifiuto netto, e la doc dà la ragione tecnica oltre a quella di prodotto: `waitForIdle`/`newSession`/`switchSession`/`navigateTree` esistono solo nei command handler «because they can deadlock if called from event handlers» (extensions.md:1209), e il bridge gestisce i comandi esattamente da event handler, watcher e timer. Il vincolo di prodotto («command one session, not a scheduler») resta valido e questa leva lo eroderebbe: chi comanda `/new` e `/fork` è l'utente davanti alla TUI.
- **Lettura diretta del backend DBOS/Postgres**. Il cluster su porta 5439 è un dettaglio del runtime (workflows.md:3307) che può anche degradare a backend in-memory con warning (workflows.md:3311), nel qual caso una lettura Postgres è confidentemente sbagliata. Il contratto di inspection è l'azione `status` del tool workflow (workflows.md:3153), che l'item 2 usa nel modo mediato. La metà buona della leva (heartbeat card, `notifyOn`) è promossa nell'item 2.
- **Discovery via env `ATOMIC_SESSION_ID`**. Documentata (environment-variables.md:24, :36) ma ridondante: il bridge ha già l'identità stabile da `ctx.sessionManager.getSessionId()` in `meta.json`, che è anche l'identità della directory. Un secondo canale di discovery è un secondo modo di divergere.
- **Follow durevole via RPC `get_entries`**. Il cursore `since` è eccellente (rpc.md:744-772) ma RPC è una modalità di avvio del processo su stdin/stdout (rpc.md:1-12): non esiste un modo documentato per attaccarsi dall'esterno a una sessione TUI già aperta. Per il bridge in-process l'equivalente è `getEntries()` con cursore a id di entry, promosso nell'item 4. Per `rpc-run`, che è one-shot, un cursore durevole non ha un consumatore.
- **Controllo diretto dei subagent**. Confermato che non esiste handle esterno; solo controllo parent-mediato (`subagent({action:"status"|"interrupt"})` via prompt, o target intercom derivati dall'identità del run).
- **Re-reject confermati** senza riesame: fleet RPC headless con scheduler esterno, audit subsystem, `entry_appended` come canale lifecycle, probe `workflow status` iniettato a ogni lancio, lettura dei transcript su disco dei run (workflows.md:2507 conferma che è layout interno con retention propria), auto-update/doctor, unificazione dei due CLI.

---

## 4. Chore di coerenza (nel primo PR utile)

Doc drift confermato in ogni punto: `ctl:3` e `ctl:575` dicono «atomic-ctl v2», `bridge:2` dice «bridge v2» mentre il corpo documenta le «Protocol additions (v3)» a `bridge:20`, `README.md:61` promette «bridge v0.2.1 active» mentre il bridge stampa `v0.3.0` (`bridge:801`), `README.md:40` disegna «protocol v2». Chore da mezz'ora, con una condizione strutturale: il test di consistenza esistente (`test/consistency.test.mjs`) confronta plugin.json/bridge/badge/changelog ma non copre le stringhe di versione negli header e nel corpo del README, ed è esattamente così che questo drift è passato. Estendere il test a quei pattern, così il drift torna a essere un test rosso invece di una voce di review (principio encode-lessons-in-structure).

## 5. Upstream gap tracciato

`RELOAD_SETTLE_MS = 5000` resta la mitigazione per la race di `/workflow reload` (fix reale su branch `fix/workflows-await-inflight-reload` di `bastani-inc/atomic`, inviato ai maintainer). Quando esce in release: version-gate, non rimozione, finché quella release non è l'engine minimo supportato. Vedi item 3.

## 6. La modifica da fare per prima

L'item 1, e dentro l'item 1 il disarmo di `pendingWorkflowLaunch`. Tutto il valore del plugin sta nella frase «questa risposta è davvero la risposta al tuo comando»; ogni item successivo (HIL, outcome, superficie comandi) presuppone che quella frase sia vera.
