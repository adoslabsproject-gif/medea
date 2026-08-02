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

C'è l'editor visuale dei workflow con 193 nodi: si disegnano, si configurano,
si descrivono a parole all'assistente, e passano un controllo di qualità a 21
regole prima di poter essere attivati.

**E si eseguono.** Da questa versione il motore viaggia dentro l'installatore,
con il suo Node e le sue librerie compilate per il tuo sistema: non devi
installare niente, non serve un account e non passa niente da un server. Ci
sono esecuzione locale, orari e trigger che partono da soli, segreti nel
portachiavi, prova del singolo nodo, dati fissati, riesecuzione da un punto —
anche cambiando i dati di prima — tester dei webhook con firma vera, confronto
fra versioni ed elenco dei form pubblici.

È il motivo per cui i file pesano più di prima: 150 MB su macOS, 77 MB su
Windows, contro i 9 della versione precedente. Quei 9 MB erano un editor che
disegnava automazioni e non ne eseguiva nessuna.

## Novità della 0.4.0

**Le automazioni restano in vita.** Chiudere la finestra non spegne più il
motore, se si vuole: resta un'icona nella barra di stato, e con l'avvio al
login le automazioni ripartono da sole dopo un riavvio del computer. Entrambe
le cose si accendono in _Credenziali → Automazioni attive_ e sono spente
finché non le si accende.

E le scadenze non si perdono più in silenzio: se un orario cade mentre Medea è
chiusa o il portatile dorme, alla ripartenza viene recuperato — una volta
sola, non una per ogni ora saltata.

**Si torna a trascinare i nodi.** Sul Mac il trascinamento dalla palette al
disegno non arrivava a destinazione: il nodo si prendeva, compariva il segno
di aggiunta, e lasciandolo non succedeva niente.

**Il menu delle azioni scorre.** Con la finestra bassa le ultime voci non si
raggiungevano.

**Cancellare un workflow chiede conferma**, dicendo quale e avvertendo se è
attivo. Prima spariva al primo clic.

Sotto il cofano il motore ha smesso di portare il nome del progetto da cui
deriva e adesso si chiama come l'applicazione che lo ospita. Chi ha scritto
nodi personalizzati che importano `@flowforge/safe-fetch` o
`@flowforge/community-node-sdk` deve aggiornarli a `@medea/engine-*`.

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
