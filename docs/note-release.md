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

## Cosa non c'è ancora, e va detto

**Le automazioni girano mentre Medea è aperta.** Un orario notturno parte se il
computer è acceso e l'app è in esecuzione. Il motore come servizio di sistema —
che continui a lavorare a finestra chiusa — non c'è ancora.

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
