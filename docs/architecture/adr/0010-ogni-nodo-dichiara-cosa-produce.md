# ADR 0010 — Ogni nodo dichiara cosa produce

- **Stato**: accettata
- **Data**: 2026-08-06
- **Contesto**: [ADR 0005](0005-flowforge-in-medea.md) (i nodi di FlowForge dentro Medea), [ADR 0006](0006-quality-gate-scaffold.md) (il vaglio sui workflow generati)

## Il problema

Il wizard genera workflow che *sembrano* giusti e non funzionano, sempre per lo
stesso motivo: le espressioni leggono campi che non esistono.

Il modello riceveva, per ogni nodo del catalogo, il nome e **cosa accetta in
configurazione**. Non riceveva niente su **cosa produce**. Così, dovendo
scrivere `{{$node.arrivo.json.???}}`, indovinava — e indovinava in modo
plausibile: `email.id` invece di `messageId`, `attachment.base64` invece di
`attachments`, `hour` e `dayOfWeek` su un `trigger_cron` che non li ha mai
prodotti, `rows` su nodi che restituiscono `items`.

Un'espressione sbagliata non fa fallire niente in modo rumoroso: restituisce
vuoto. Il workflow gira, manda una email senza allegato, scrive una riga con
metà campi nulli. Il difetto si scopre in produzione, non in fase di
generazione.

Il meccanismo per dirlo esisteva già: `NodeDef.outputContract`, con lo schema
che avvertiva in maiuscolo «NON-ASPIRAZIONALE: deve riflettere l'executor
REALE». Ma lo dichiaravano **6 nodi su 195**, e — questo era il punto —
`outputContract` era anche l'**unico** campo che arrivava al modello:
`outputs` e `outputFields`, che 80 nodi dichiaravano diligentemente, non
uscivano mai dal catalogo.

## La decisione

**Ogni nodo dichiara cosa produce, campo per campo, e un test lo verifica
contro il codice che lo produce.**

Tre pezzi, e nessuno funziona senza gli altri due.

### 1. Il contratto arriva al modello

`prompt.ts` aggiunge a ogni riga di catalogo la coda `→ produce{nome:tipo,…}`.
È la differenza fra un modello che indovina e uno che legge:

```
trigger_imap (trigger): host, port, … → produce{uid:number, messageId:string,
  subject:string, from:string, …, attachments:array, headers:object}
```

### 2. Il catalogo si genera da QUESTO repository

`scripts/extract-flowforge-nodes.mjs` leggeva i pacchetti compilati di
FlowForge. Era corretto al momento del porting e ha smesso di esserlo appena i
nodi sono diventati nostri: ogni campo dichiarato qui restava invisibile alla
palette e all'assistente. La generazione «riusciva» e non cambiava niente, che
è il modo peggiore di sbagliare.

Ora la sorgente predefinita è `packages/engine/nodes/`, con `FLOWFORGE_SRC` che
resta per rileggere l'originale quando serve confrontarsi con lui.

### 3. Un guard che rende impossibile il contratto inventato

**Un contratto sbagliato è peggio di nessun contratto.** Senza, il modello
indovina e a volte azzecca; con un contratto errato scrive espressioni rotte
*con fiducia*, e noi le abbiamo benedette.

`apps/engine/src/executors/contratti-output.guard.test.ts` prende ogni campo
dichiarato e lo cerca nel sorgente che lo produce. Due scelte lo rendono
sostenibile:

- **Dove sta l'executor non è scritto a mano**: lo dice `registry.ts`, che è
  l'autorità su chi esegue cosa. Una mappa parallela di 160 righe sarebbe
  andata fuori sincrono al primo nodo spostato, e un guard fuori sincrono è un
  guard che non guarda. `SORGENTI_EXTRA` copre solo i payload che nascono
  altrove — i trigger che riusano il poller di un altro, i nodi di diramazione
  il cui output nasce in una *strategia* del motore.
- **Il confronto è sul testo, non sull'esecuzione**: far girare gli executor
  vorrebbe dire un server IMAP, un broker Kafka e una casella PEC in piedi per
  controllare l'ortografia di una chiave. La deriva che conta — un nome che
  cambia da una parte sola — questo la prende.

Il guard si è dimostrato utile al primo giro: ha trovato tre disallineamenti
veri prima ancora che il lavoro fosse metà.

Accanto c'è il guard di **completezza**: un nodo senza contratto fa diventare
rosso il test, a meno che non sia in `SENZA_CONTRATTO_AMMESSI` **con la ragione
scritta accanto**. Una mancanza diventa una decisione leggibile, non una
dimenticanza.

## Come si scrive un contratto

Il `desc` si legge dall'executor, mai dalla descrizione del nodo — le
descrizioni sono promesse, gli executor sono fatti. In pratica quello che
serve dire quasi sempre è una di queste cose:

- **Le forme diverse.** `logic_wait` produce due insiemi di campi a seconda che
  aspetti un tempo o un richiamo; `action_csv` produce `rows` leggendo e `csv`
  scrivendo. Un modello che non lo sa scrive l'espressione giusta per il ramo
  sbagliato.
- **Il campo su cui diramare.** `found`, `ok`, `valid`, `truncated`: quasi ogni
  nodo ne ha uno, e quasi mai è quello che sembra. `action_jwt` verificando ha
  sia `verified` sia `signatureValid`, e su un token scaduto valgono cose
  opposte.
- **Dove sta davvero il dato.** `action_set_fields` mette tutto in `result`,
  `action_regex_multi` in `fields`, `action_run_js` in `result`. Leggere il
  campo direttamente sul nodo non trova niente.
- **Quando riuscire non significa aver fatto.** `db_update` con
  `affectedRows: 0`, `action_send_email` con `rejected` non vuoto,
  `ai_agent_tool_loop` che restituisce `error` senza sollevare eccezioni.

Per i nodi la cui uscita non ha nomi fissi — `agent_extractor` segue lo schema
in configurazione, `logic_transform` l'espressione JSONata, `trigger_form` il
modulo — il campo si chiama `<descrizione fra parentesi angolari>` e il guard
lo salta. Dire «i nomi li decidi tu» è informazione vera; inventarne di
plausibili no.

## Conseguenze

**Tutti i nodi del catalogo dichiarano cosa producono**, ognuno verificato
contro il codice che lo esegue. L'elenco delle eccezioni è vuoto.

Lo è per una ragione che vale la pena raccontare. L'unico nodo mai iscritto
là dentro è stato `db_subscribe`, e scriverne la ragione — «non ha né executor
né watcher» — ha fatto capire che esentarlo era la risposta sbagliata. Un nodo
che nessun codice esegue non va documentato: va tolto. Peggio, la eval del
catalogo lo dava per risposta **valida** a «quando cambia una tabella del
database», quindi il modello poteva sceglierlo e consegnare un workflow che non
sarebbe partito mai, senza un errore da nessuna parte. `trigger_db_change` fa
la stessa cosa e funziona davvero.

Il catalogo passa così da 195 a **194 nodi**. Costringersi a motivare
un'eccezione ha trovato un difetto che il conteggio da solo non mostrava: è il
motivo per cui l'elenco chiede il perché e non solo il nome.

Il prezzo è che aggiungere un nodo ora costa di più: bisogna dichiarare cosa
produce e i nomi devono corrispondere al codice. È esattamente il prezzo che si
voleva pagare — l'alternativa è un catalogo che descrive un'app diversa da
quella che gira.
