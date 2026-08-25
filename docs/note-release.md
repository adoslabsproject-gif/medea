<!--
  Le note che accompagnano ogni release. Il flusso `release.yml` le legge da
  qui, quindi si scrivono una volta e valgono per tutte: se cambiano le cose
  che l'app sa fare, si cambia questo file e non l'interfaccia di GitHub.
-->

**Medea** — client email desktop con dentro un editor di workflow a nodi.

## Cosa scaricare

| Sistema                                | File                             |
| -------------------------------------- | -------------------------------- |
| macOS (Apple Silicon — M1, M2, M3, M4) | `Medea_<versione>_aarch64.dmg`   |
| macOS (Intel)                          | `Medea_<versione>_x64.dmg`       |
| Windows 10/11 (64 bit)                 | `Medea_<versione>_x64-setup.exe` |

## Al primo avvio il sistema si lamenta

I file non sono firmati con un certificato a pagamento, quindi macOS e Windows
li trattano come sconosciuti. Non è un segnale che qualcosa non va: è quello
che succede a ogni programma non firmato.

**macOS** — se dice che l'app è danneggiata, da Terminale:

```bash
xattr -cr /Applications/Medea.app
```

**Windows** — SmartScreen mostra una schermata blu: «Ulteriori informazioni» →
«Esegui comunque».

## Cosa funziona

Posta via IMAP e SMTP con ricerca full-text, rubrica e anagrafiche, documenti e
listini, promemoria, e un assistente AI con 63 strumenti che agisce davvero sul
sistema — con conferma esplicita su ogni scrittura. La chiave del modello è tua
e sta nel portachiavi del sistema operativo, non in un file di configurazione.

C'è l'editor visuale dei workflow con 194 nodi: si disegnano, si configurano,
si descrivono a parole all'assistente, e passano un controllo di qualità a 26
regole prima di poter essere attivati.

**E si eseguono.** Dalla 0.4.0 il motore viaggia dentro l'installatore,
con il suo Node e le sue librerie compilate per il tuo sistema: non devi
installare niente, non serve un account e non passa niente da un server. Ci
sono esecuzione locale, orari e trigger che partono da soli, segreti nel
portachiavi, prova del singolo nodo, dati fissati, riesecuzione da un punto —
anche cambiando i dati di prima — tester dei webhook con firma vera, confronto
fra versioni ed elenco dei form pubblici.

È il motivo per cui i file pesano quello che pesano: 150 MB su macOS, 77 MB su
Windows, contro i 9 delle versioni fino alla 0.3.0. Quei 9 MB erano un editor
che disegnava automazioni e non ne eseguiva nessuna.

## Novità della 0.5.0

Questa versione ha un tema solo: **i workflow che l'assistente costruisce
devono funzionare davvero**. Non «sembrare giusti» — funzionare.

**Ogni nodo dichiara cosa produce.** Tutti e 194. Prima il modello doveva
indovinare i nomi dei campi da usare nelle espressioni, e li inventava:
`{{tldr}}`, `{{summary}}`, campi plausibili che a runtime non esistevano. Il
workflow partiva, non falliva, e mandava email con un buco al posto del testo.
Adesso ogni nodo porta scritto cosa restituisce, campo per campo, e un test
verifica che quella promessa combaci con il codice che la mantiene.

**Le tabelle nascono insieme al workflow.** Chi chiedeva «salva i contatti del
modulo in una tabella» si ritrovava un workflow che al primo colpo diceva «no
such table», e in DB Studio non c'era niente da gestire perché niente era mai
stato creato. Adesso le tabelle si creano quando accetti il workflow, con le
colonne giuste, e ogni workflow ha le sue: due automazioni che nominano
entrambe una tabella `log` non si pestano più i piedi, nemmeno se si chiamano
allo stesso modo. Le tabelle che avevi già restano tue e vengono usate, non
duplicate.

E quando cancelli un workflow, la conferma ti chiede se vuoi portarti via anche
i suoi dati — con una spunta, che di suo è spenta.

**L'assistente vede il database.** Può elencare le tabelle, leggerne la
struttura e i contenuti, e — su tua conferma esplicita, una per volta — creare
una tabella o scriverci dentro. Prima, alla domanda «leggi gli articoli dalla
tabella magazzino», si inventava strumenti che non aveva e rispondeva con una
riga di codice al posto di una risposta.

**Cinque difetti di generazione che passavano in silenzio.** Erano i peggiori:
non rompono niente, non segnalano niente, e trasformano un'automazione in un
rituale a vuoto. Una condizione scritta in una forma che non verrà mai
valutata, e quindi sempre falsa — l'avviso che non arriva mai. Un filtro
puntato su un singolo messaggio invece che su un elenco, con l'effetto opposto:
l'avviso che arriva **sempre**, per ogni email. Un nodo che riassume l'orario
in cui è scattato perché nessuno gli ha passato niente da riassumere. Ognuno
adesso ha un controllo che lo riconosce prima che tu lo importi, e lo spiega
con parole a cui il modello sa rispondere.

Lo stesso vale per l'esempio che insegna al modello a costruire i workflow: era
rotto nello stesso modo, e glielo stavamo insegnando noi.

**Le porte collegate contano.** Il filtro ha due uscite — quello che passa e
quello che viene scartato — ma il motore le ignorava, e i nodi a valle
partivano comunque su entrambe. Adesso chi collega l'uscita «tenuti» ottiene
solo i tenuti, e gli scartati si possono mandare da un'altra parte davvero. I
workflow già salvati non cambiano comportamento: un collegamento senza uscita
specificata continua a ricevere tutto. Vedi
[ADR 0011](docs/architecture/adr/0011-le-porte-nominate-si-rispettano.md).

**Il wizard non resta più appeso.** La costruzione ha un tempo massimo e
finisce; si vede a che punto è, passo per passo, con la richiesta e la risposta
di ognuno; e alla fine un verdetto racconta cosa ha costruito. Se il modello si
rifiuta o risponde fuori formato, adesso lo si riconosce e lo si dice, invece
di aspettare.

**Il resto.** Tre temi nuovi e l'editor dei workflow che si sistema. La rubrica
naviga dalle aziende ai loro contatti e dai contatti alla scheda. Il relay dei
webhook può essere il tuo, non solo quello di esempio. Si può fermare
l'inferenza a metà, e si vede quanto è costata.

## Cosa non c'è ancora, e va detto

**Le automazioni hanno bisogno che Medea ci sia.** Si può chiederle di
continuare a lavorare a finestra chiusa e di ripartire all'accensione del
computer — sono due interruttori in _Credenziali → Automazioni attive_ — ma
resta un'applicazione, non un servizio di sistema: se esci davvero, o se il
computer è spento, non gira niente. Le scadenze passate a vuoto vengono
recuperate alla ripartenza, una sola volta.

**I webhook che arrivano da internet passano da un relay.** In locale
l'indirizzo è `127.0.0.1`, raggiungibile solo da quel computer: va bene per uno
script sulla stessa macchina, non per un servizio esterno. Il relay si accende
dalle impostazioni ed è spento finché non lo si accende.

**Le chiavi dei modelli AI le metti tu.** Non è una mancanza, è la scelta del
progetto: la chiave resta nel portachiavi del sistema e non passa da nessun
server nostro. Ma i nodi AI non funzionano finché non ne configuri una.

## Il resto

Sorgenti, decisioni architetturali e stato di avanzamento:
<https://github.com/adoslabsproject-gif/medea>

Licenza PolyForm Noncommercial 1.0.0 — uso libero per scopi non commerciali.
