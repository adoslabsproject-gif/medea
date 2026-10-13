# ADR 0014 — L'assistente esce dalla posta: web per tutti, e Claude Code nel pannello

- **Data**: 2026-10-13
- **Stato**: accettata
- **Modifica**: la regola «niente web search» e la parte dell'ADR 0013 su Claude
  in abbonamento (la CLI senza strumenti suoi)
- **Contesto**: `apps/desktop/src-tauri/src/{ai_tools/web,claude_cli,mcp}/`,
  `apps/desktop/src/features/ai/`

## Il problema

L'assistente di Medea non poteva uscire dalla posta. Era una scelta di prodotto,
presa quando Medea fu estratta da un toolkit con più di cento strumenti: tenerla
concentrata. L'effetto pratico era che con un'API a chiave il modello non poteva
cercare niente, e con Claude in abbonamento sì — ma solo perché la CLI porta i
suoi strumenti, non perché Medea lo volesse. Con la 0.6.0 la CLI era stata
chiusa in una gabbia (`--tools ""`) e nemmeno quella cercava più.

Il proprietario ha deciso due cose: la ricerca sul web vale per ogni modello, e
con l'abbonamento il pannello deve essere Claude Code per intero.

Tutte e due aprono una porta che prima non c'era. L'assistente legge email
scritte da estranei: una frase rivolta al modello dentro un'email può chiedergli
di aprire un indirizzo, o di eseguire un comando. Finché non poteva fare né
l'uno né l'altro, non c'era niente da difendere.

## La decisione

### 1. Due strumenti di Medea: `web_search` e `web_fetch`

Sono di Medea, non del provider: per questo valgono con qualunque modello.
Gli strumenti passano da 63 a 65.

`web_search` usa Tavily o Brave se l'utente ha messo la sua chiave nel
portachiavi, DuckDuckGo altrimenti. Una strada che fallisce passa alla
successiva.

`web_fetch` apre una pagina e ne restituisce il testo. Le difese:

- **Si esce solo verso internet.** Macchina locale, reti di casa e d'ufficio,
  reti private virtuali (100.64.0.0/10) sono rifiutate. Il motore dei workflow
  ascolta su `127.0.0.1` con dentro le chiavi dell'utente: è il primo bersaglio.
- **Ci si collega agli IP controllati**, non a una seconda risposta del DNS.
- **Ogni rinvio ripassa dal controllo.**
- **Il testo arriva al modello dichiarato come scritto da terzi.**
- **L'utente conferma il sito.** La ricerca parte da sola. La prima pagina di
  ogni sito, in ogni conversazione, compare con l'indirizzo e parte col sì.
  Un'impostazione toglie la conferma.

### 2. Con l'abbonamento, il pannello è Claude Code

La CLI parte con tutti i suoi strumenti, le impostazioni dell'utente e in più
gli strumenti di Medea. Medea la pilota a righe JSON in entrambi i versi — il
protocollo degli SDK ufficiali — e da lì vengono:

- il testo che scorre mentre viene scritto;
- le **richieste di permesso**: ogni azione che la CLI non considera lettura
  arriva al pannello con il comando, il file o l'indirizzo, e parte col sì;
- l'interruzione del turno;
- la ripresa della sessione, invece di rimandare tutta la conversazione.

La cartella di lavoro la sceglie l'utente. Senza una scelta la CLI lavora in una
cartella vuota di Medea e non vede i suoi file.

### 3. Gli strumenti web di Medea non si offrono alla CLI

Alla CLI gli strumenti di Medea sono permessi in blocco. I nostri `web_*`
arriverebbero come doppioni di quelli di Claude Code e aprirebbero pagine senza
la conferma sito per sito, che vive nel pannello. Il server MCP avviato da Medea
non li elenca e li rifiuta se chiamati per nome.

## Cosa si è scartato

- **La descrizione del modello nella richiesta di permesso.** La CLI accompagna
  il comando con una frase scritta dal modello. Mostrare quella lascerebbe al
  modello, e a chi gli scrive, la scelta di cosa far leggere all'utente. Si
  mostra il comando.
- **Una modalità «tutto libero».** In un programma che legge posta di terzi,
  un'email diventerebbe un modo di eseguire comandi.
- **`web_fetch` senza conferma di suo.** Il controllo sugli indirizzi interni
  ferma l'accesso alla rete di casa, non l'uscita di un dato dentro
  l'indirizzo di un sito pubblico.
- **Un processo della CLI tenuto vivo fra un turno e l'altro.** Più veloce, ma
  un processo che sopravvive all'app o alla conversazione è stato da gestire.
  Un processo per turno con `--resume` regge anche un riavvio.

## Conseguenze

- La regola «niente web search» in `CLAUDE.md` non vale più per questi due
  strumenti. Resta per tutto il resto: canvas, browser, finanza, schermo, voce.
- Con l'abbonamento le istruzioni personali dell'utente per Claude Code
  (`~/.claude/CLAUDE.md`, plugin, server MCP) entrano nella conversazione di
  Medea. È quello che è stato chiesto; la 0.6.0 le teneva fuori.
- Le conversazioni con Claude Code restano fra le sessioni della CLI, sul disco
  dell'utente: serve a riprenderle.

## Limiti noti

- Il pannello a schermo — testo che scorre, richieste di permesso, scelta della
  cartella — è coperto da test, non da una prova a mano.
- DuckDuckGo senza chiave si legge dalla sua pagina HTML: se cambia forma, la
  ricerca senza chiave smette di dare risultati finché non si aggiorna il
  lettore.
- Tavily e Brave sono implementati dalle loro specifiche ma non provati con una
  chiave vera.
- I comandi `/` che nel terminale aprono una schermata (per esempio `/config`)
  qui non hanno una schermata da aprire. Modello e cartella si scelgono dalla
  barra del pannello.
- Windows: il turno in streaming non è ancora stato provato lì.
