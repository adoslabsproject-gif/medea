# ADR 0007 — L'autonomia del runtime locale

**Stato**: accettata — 2026-08-01
**Sostituisce in parte**: ADR 0005, decisione 4 (esecuzione «locale o server»)

## Il punto

Medea deve eseguire i workflow **da sola**, come farebbe un FlowForge
self-hosted. Non «quasi tutti i nodi», non «quando premi un pulsante»: tutti i
nodi, anche quando non c'è nessuno davanti allo schermo. Un editor che non
esegue è un disegnatore di diagrammi.

La strada è quella dell'ADR 0005: **riusare il runtime vero come processo
figlio**, non riscriverlo. Riscrivere 145 esecutori significa inseguire per
sempre, e «quasi tutti funzionano» non è una risposta.

## Cosa è già dimostrato

Il runtime di FlowForge, compilato con `tsup` e avviato su macOS con il suo
SQLite in una cartella locale:

- applica le migrazioni e risponde su `/health`;
- registra un utente proprietario e rilascia un token;
- **esegue**. Verificato con `scripts/collaudo-workflow.mjs`, 5 casi su 5:
  JavaScript nella sandbox `isolated-vm`, espressioni fra nodi
  (`{{$node.x.json.campo}}`), condizione con due rami dove **solo il ramo preso
  viene eseguito**, chiamata HTTP reale, e un errore che ferma il flusso.

Quindi il motore non è il problema. Il problema sono le gambe che lo tengono
in piedi da solo.

## I quattro buchi, in ordine di gravità

### 1. Il runtime non è distribuibile

Il percorso del bundle era scritto nel codice e puntava alla macchina di
sviluppo. Su qualunque altro computer la funzione è morta — e il modo peggiore
di essere morta, perché funziona per chi l'ha scritta.

**Deciso**: il bundle sta nelle risorse Tauri, risolto da `resource_dir()`. In
sviluppo si indica con la variabile `MEDEA_WORKFLOW_RUNTIME`, e se manca il
messaggio d'errore dice cosa fare. Nessun percorso personale nel codice.

Resta da fare l'impacchettamento vero: `dist/main.js`, l'eseguibile Node, e i
due moduli nativi (`better-sqlite3`, `isolated-vm`) compilati per ciascuna
piattaforma.

### 2. I trigger esistono, ma nessuno li accende

Il runtime avvia già da solo `SchedulerService` (cron) e
`TriggerWatchersService` (IMAP con cursore UID, file, database, Kafka,
RabbitMQ, Odoo). Non manca niente lì dentro. Mancano tre collegamenti:

- **Il workflow non arriva mai al runtime** se non premendo «Esegui»: un cron
  attivato in Medea non esiste nel database del runtime, quindi lo scheduler
  non lo vede.
- **Il pulsante «Attivo» scrive un flag che nessuno legge.** È interfaccia che
  promette un comportamento inesistente, ed è la cosa peggiore che possa fare
  un pulsante.
- **`reloadJobs()` viene chiamato solo all'avvio.** Verificato: attivare un
  workflow con il runtime già in piedi non lo aggiunge alla pianificazione. In
  produzione non si nota perché i cron li pianifica il portal centrale; in
  self-hosted il portal non c'è.

**Deciso**: attivare o disattivare un workflow lo sincronizza sul runtime e ne
fa ricaricare la pianificazione. Poiché il runtime è nostro e riparte in circa
un secondo, il riavvio del processo figlio è un modo legittimo di ricaricare —
non serve modificare FlowForge.

**Deciso**: il runtime parte all'avvio dell'applicazione se esiste almeno un
workflow attivo, non all'apertura della sezione.

**Rimandato**: girare ad applicazione chiusa (servizio di sistema) e i webhook
dall'esterno (relay). Sono la fase 5 dell'ADR 0005 e non bloccano l'autonomia
a finestra aperta.

### 3. La catena dei segreti è interrotta

L'AI genera `{{secrets.NOME}}`, il quality gate lo accetta, e poi non succede
niente: in Medea non c'è modo di definire un segreto, e il runtime li risolve
dalla sua tabella `tenant_variables`, che resta vuota.

**Deciso**: i segreti stanno nel portachiavi del sistema — l'infrastruttura
c'è già — e vengono consegnati al runtime all'apertura della sessione. Qui
Medea fa **meglio dell'originale**, dove le variabili del tenant sono in chiaro
nel database nonostante i commenti dichiarino il contrario.

Stesso discorso per la posta: oggi viaggia solo `systemAccountId`, ma nessuno
consegna al runtime le credenziali IMAP/SMTP. Finché non si fa,
`action_send_email` e `trigger_imap` non possono funzionare.

> **Risolto il 2026-08-01.** I segreti si definiscono dalla barra dell'editor e
> il valore sta nel portachiavi del sistema; gli account di posta di Medea
> diventano account del runtime. La consegna avviene all'apertura della
> sessione — vedi `runtime/secrets.ts` e `runtime/provision.ts`.

### 4. Il catalogo è parziale

145 defId estratti contro i 193 che il runtime carica. Mancano pezzi grossi:
`logic_subworkflow`, `action_pdf_parse`, `action_xlsx_*`, `db_sql_query`, otto
`agent_*`. Da capire se è un filtro voluto dello script di estrazione o è
deriva.

> **Risolto il 2026-08-01.** Era deriva: i pacchetti espongono i nodi in due
> forme — un oggetto per nodo, e un unico array `stdlibNodes` — e l'estrattore
> leggeva solo la prima. Adesso il catalogo ne ha 193, gli stessi che il
> runtime dichiara, e `catalog.guard.test.ts` verifica l'uguaglianza fra i due
> insiemi a ogni esecuzione dei test.

E mancano del tutto i pacchetti `.ffnode` della community — 391 azioni fra
Telegram, GitHub, Slack, Stripe. È la fase 4 dell'ADR 0005: registry, verifica
della firma Ed25519, installazione, caricamento a caldo.

## Altre cose vere, meno urgenti

- **`tablesToCreate` si valida ma non si crea.** L'originale ha
  `provisionDeclaredTables()`; Medea ha già DB Studio, va collegato.
- **Lo storico perde le esecuzioni non manuali.** Il rispecchiamento avviene
  solo a fine esecuzione manuale, con interrogazione ogni 400 ms e un limite di
  cinque minuti. Il runtime espone eventi in streaming: vanno usati quelli, e
  la riga va scritta all'avvio dell'esecuzione, non alla fine — altrimenti un
  crash a metà non lascia traccia.
- **L'esportazione può portarsi via i segreti in chiaro.** L'originale
  sanifica e mette un checksum.
- Mancano versioni con ripristino, bozza separata da ciò che gira, dati
  fissati per nodo, prova del singolo nodo, riesecuzione.

Fuori perimetro per un prodotto a utente singolo: collaborazione in tempo
reale, blocco multi-editor, condivisione, portale clienti, fatturazione.

## Dove Medea è già alla pari o avanti

Scaffold in un colpo con riparazioni e validazione a tre livelli; quality gate
con tutte e 21 le regole; agente a 9 strumenti con i nomi congelati per il
modello addestrato; formato del catalogo e schema del workflow compatibili;
identità locale che si autoprovvede nel portachiavi, più pulita del
multi-tenant; validazione dei nomi di tabella fatta prima invece che dopo.

## Ordine di lavoro

1. Distribuzione del runtime nelle risorse. Senza, tutto il resto è teoria.
2. Ciclo di vita di «Attivo»: sincronizzazione e ricarica della pianificazione.
   Cron e IMAP si accendono da soli, perché il runtime li ha già.
3. Segreti dal portachiavi al runtime, credenziali di posta comprese.
4. Catalogo completo, poi il registry `.ffnode`.
5. Creazione delle tabelle dichiarate.
6. Parità dell'editor: versioni, bozza, dati fissati, prova del nodo,
   esportazione sanificata.
7. Relay dei webhook e runtime come servizio di sistema.

## Conseguenze

- Il selettore «locale o server» non torna: senza account sul server non
  esiste un posto dove ospitare il workflow, e il server resta soltanto il
  relay dei webhook.
- L'ADR 0005 va aggiornato: dichiara 186 nodi e uno stato «proposto» che non
  corrisponde più.
- Il README e il post di presentazione dicono ancora che l'esecuzione manca.
  Non è più vero, ed è vero il contrario di ciò che dicono: esegue, ma non da
  sola. Vanno corretti quando il punto 2 è chiuso.
