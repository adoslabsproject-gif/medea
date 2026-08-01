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

C'è l'editor visuale dei workflow, con i 193 nodi del catalogo di FlowForge:
si disegnano, si configurano, si descrivono a parole all'assistente, e passano
un controllo di qualità a 21 regole prima di poter essere attivati.

## Cosa NON funziona in questi file, e va detto

**I workflow non si eseguono.** Il motore che li fa girare pesa circa 600 MB e
sta in un altro repository, che la macchina di compilazione non ha: non è
dentro questi installatori. Medea se ne accorge e lo dice — «il motore dei
workflow non è installato con questa copia» — invece di lasciare un pulsante
che non risponde.

Si possono quindi disegnare e salvare workflow, ma non farli partire. Una
versione con il motore incluso arriverà.

Chi compila l'app da sé, avendo accesso al runtime di FlowForge, ha tutto:
esecuzione locale, cron e trigger che partono da soli, segreti nel portachiavi,
prova del singolo nodo, dati fissati, riesecuzione da un punto — anche
cambiando i dati di prima — tester dei webhook con firma vera, confronto fra
versioni, e webhook da internet attraverso un relay, spento finché non lo si
accende.

## Il resto

Sorgenti, decisioni architetturali e stato di avanzamento:
<https://github.com/adoslabsproject-gif/medea>

Licenza PolyForm Noncommercial 1.0.0 — uso libero per scopi non commerciali.
