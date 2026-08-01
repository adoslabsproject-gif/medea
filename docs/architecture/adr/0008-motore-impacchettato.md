# ADR 0008 — Il motore dei workflow viaggia dentro l'app

- Stato: **accettato**
- Data: 2026-08-01
- Contesto: ADR 0005 (workflow locali), ADR 0007 (autonomia del runtime locale)

## Il problema

Medea esegue i workflow con il runtime di FlowForge, avviato come processo
figlio. Finché quel runtime è un percorso sulla macchina di chi sviluppa,
Medea «funziona» soltanto lì — che è un altro modo di dire che non funziona.

Un client email che promette automazioni e poi, sul computer di chi lo
installa, mostra il pulsante «Esegui» spento per sempre non è un prodotto con
un pezzo mancante: è un prodotto che mente.

## La decisione

Il runtime viene impacchettato **dentro l'app**, con tutto quello che gli
serve, incluso il proprio `node`. Niente scaricamenti al primo avvio, niente
dipendenze da un Node di sistema, niente servizi da installare a parte.

`pnpm runtime:package` produce `apps/desktop/src-tauri/resources/runtime/`:

```
runtime/
  node                 il binario Node, ~82 MB
  dist/main.js         il runtime compilato, ~25 MB
  node_modules/        le dipendenze di produzione, installate
  package.json
```

Tauri lo include fra le risorse; il Rust lo cerca lì e ripiega su
`MEDEA_WORKFLOW_RUNTIME` solo in sviluppo, dove il bundle si ricostruisce di
continuo.

## Perché non si può fare più piccolo

**595 MB.** È molto, e non è negoziabile senza rinunciare a qualcosa che
l'utente ha chiesto esplicitamente: *tutti* i nodi eseguibili, come sul
server.

I moduli nativi — `better-sqlite3`, `isolated-vm`, `argon2`, `duckdb` — non si
uniscono in un file solo per costruzione: sono librerie compilate per una
piattaforma. Vanno installate, non impacchettate.

Sono state provate, e scartate, tre riduzioni:

- **Togliere `@duckdb/node-api`** (107 MB): nessun nodo del catalogo lo usa,
  ma il runtime lo importa all'avvio. Tolto, non parte affatto.
- **Togliere `typescript`** (23 MB): è dichiarato come dipendenza di
  sviluppo, e il runtime lo carica all'avvio per compilare i nodi
  personalizzati. Va *aggiunto*, non tolto — è l'unica cosa che il `deploy`
  di produzione dimentica.
- **Cancellare i file `.d.ts`**: la libreria `typescript` è fatta
  praticamente solo di quelli.

Quello che si toglie davvero sono le mappe dei sorgenti: circa 10.900 file,
che non servono a eseguire niente.

Per confronto: l'immagine Docker dello stesso runtime supera il gigabyte, e
n8n desktop stava sui 600 MB. Il prezzo è quello del mestiere, non di questa
implementazione.

## Le conseguenze

- Il pacchetto **non si committa**: si rigenera. È in `.gitignore`.
- La costruzione dell'installatore richiede `pnpm runtime:package` prima di
  `pnpm tauri:build`, e va rifatta su ogni piattaforma di destinazione — il
  `node` e i moduli nativi sono compilati per quella e basta.
- Lo script si verifica da solo: avvia quello che ha appena messo insieme e
  aspetta che risponda. Se manca un modulo lo dice per nome, invece di
  produrre un pacchetto che fallisce sul computer di qualcun altro.
- Il collaudo (`scripts/collaudo-workflow.mjs`,
  `scripts/collaudo-eventi.mjs`) è stato eseguito **contro il pacchetto**, non
  contro l'albero di sviluppo: 5/5 casi di esecuzione e 4/4 verifiche sul
  flusso di eventi.

## Quello che resta aperto

- **Le altre piattaforme.** Oggi il pacchetto si costruisce per la macchina su
  cui gira lo script. Windows e Linux richiedono una costruzione su quelle
  piattaforme — probabilmente in CI, con un artefatto per bersaglio.
- **L'aggiornamento del motore separato dall'app.** Ogni correzione del
  runtime oggi costa un aggiornamento intero di Medea, con dentro 595 MB.
  Vale la pena solo se il runtime comincia a cambiare più spesso dell'app.
