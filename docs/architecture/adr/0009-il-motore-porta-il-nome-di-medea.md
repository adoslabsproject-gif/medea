# ADR 0009 — Il motore dei workflow porta il nome di Medea

- **Stato**: accettato (2026-08-02)
- **Sostituisce in parte**: [ADR 0005](0005-flowforge-in-medea.md) (il motore
  entra in Medea) e [ADR 0008](0008-motore-impacchettato.md) (il motore viaggia
  dentro gli installatori)

## Contesto

Con l'ADR 0005 il motore dei workflow è entrato dentro questo repository, e con
l'ADR 0008 ha cominciato a viaggiare dentro gli installatori. Dal punto di vista
del codice l'operazione era completa: nessuna dipendenza verso repository
esterni, tutto compilato e impacchettato da qui.

Restava però il **nome**. Trentatré pacchetti su trentanove si chiamavano
`@flowforge/*` o `@zeliai/*`, centotrenta variabili d'ambiente cominciavano per
`FLOWFORGE_`, il database si chiamava `flowforge.sqlite`. Aprire il repository
dava l'impressione di stare guardando il monorepo di qualcun altro con dentro
un'applicazione ospite — mentre il rapporto è esattamente l'opposto.

Un nome sbagliato non è cosmesi. Racconta a chi legge una gerarchia che non
esiste, e prima o poi qualcuno agisce di conseguenza: cerca il "vero" repository
del motore, evita di modificarlo perché sembra roba di terzi, o tratta un
aggiornamento upstream come un merge invece che come una scelta.

## Decisione

Il motore è di Medea e si chiama come Medea. Un solo scope per tutto il
repository, con il prefisso `engine-` a distinguere le due metà:

| Prima | Dopo |
| --- | --- |
| `@flowforge/tsconfig` | `@medea/engine-tsconfig` |
| `@flowforge/nodes-stdlib` | `@medea/engine-nodes-stdlib` |
| `@flowforge/runtime` | `@medea/engine-runtime` |
| `@zeliai/shared` | `@medea/engine-shared` |
| `FLOWFORGE_DATA_DIR` | `MEDEA_DATA_DIR` |
| `flowforge.sqlite` | `medea.sqlite` |

Il prefisso serve a evitare collisioni reali: `@flowforge/tsconfig`,
`@flowforge/eslint-config` e `@flowforge/ui-kit` avevano già un omonimo lato
applicazione (`@medea/tsconfig`, `@medea/eslint-config`, `@medea/ui`).

### Il rapporto con FlowForge resta dichiarato

Il motore **deriva** da FlowForge. Questo ADR non cancella quella storia: i
commenti che spiegano perché una cosa è fatta in un certo modo continuano a
nominare il progetto d'origine, e devono continuare a farlo. Quello che sparisce
è il nome altrui dai **nomi delle cose di Medea**.

### Cosa NON è stato rinominato, e perché

Tre categorie restano com'erano, deliberatamente:

1. **Indirizzi e percorsi di infrastruttura reale** — `flowforge.automazionezeli.com`,
   `/var/data/flowforge`, `/opt/flowforge`. Puntano a un server che si chiama
   davvero così. Rinominarli avrebbe prodotto riferimenti a cose inesistenti.
2. **`FLOWFORGE_SRC` e `FLOWFORGE_RUNTIME_SRC`** — non configurano Medea:
   indicano dove sta il monorepo di FlowForge sulla macchina di chi sviluppa.
   Chiamarle `MEDEA_*` avrebbe detto una cosa falsa.
3. **Le menzioni di FlowForge nella prosa dei commenti** — sono lineage, non
   branding. Vedi sopra.

## Conseguenze

### Il database va migrato, non solo rinominato

Cambiare il nome del file SQLite senza altro avrebbe fatto trovare a chi
aggiorna un motore senza workflow: il motore non trova `medea.sqlite`, ne crea
uno vuoto, e il lavoro dell'utente resta su disco ma invisibile.

`runtime/mod.rs` porta il file al nome nuovo al primo avvio, insieme ai file
`-wal` e `-shm` — spostare solo il database lascerebbe indietro le scritture non
ancora consolidate, cioè l'ultima sessione di lavoro. Se il nuovo nome esiste
già non si tocca niente, e se una rinomina fallisce il motore parte comunque sul
file vecchio.

### I nodi custom scritti prima vanno aggiornati

Chi ha scritto un nodo custom che importa `@flowforge/safe-fetch` o
`@flowforge/community-node-sdk` deve cambiare quegli import: il resolver di
compilazione (`compile.service.ts`) ora riconosce solo `@medea/engine-*`. È una
rottura di compatibilità consapevole, sul presupposto che la base installata
alla 0.3.0 sia trascurabile.

### Un rename silenzioso è più pericoloso di un rename rumoroso

Tre punti sarebbero passati inosservati: il `noExternal` di `tsup.config.ts`
(che avrebbe smesso di includere le dipendenze interne nel bundle, rompendo
l'avvio del motore **senza errori di build**), il filtro `onResolve` di
`compile.service.ts`, e i nomi di variabile costruiti a pezzi in
`oauth-connect.service.ts` (`` `FLOWFORGE_${provider}_OAUTH_CLIENT_ID` ``).

La lezione operativa: dopo una rinomina di massa non basta che compili. Le
espressioni regolari che nominano pacchetti, i nomi costruiti per
concatenazione e i percorsi risolti a runtime vanno cercati a mano, perché
nessun compilatore li verifica.

## Alternative scartate

- **Scope separato `@medea-engine/*`** — avrebbe reso più semplice estrarre un
  giorno il motore in un repository proprio. Scartata perché quel giorno non è
  previsto, e nel frattempo due scope nello stesso workspace sono due posti dove
  cercare.
- **Un nome di prodotto tutto suo** per il motore. Più forte come marchio, più
  debole per chi legge il codice: un terzo nome da imparare per una cosa che è
  un dettaglio di come Medea esegue i workflow.
- **Lasciare i nomi e documentare la provenienza.** È ciò che si era fatto fino
  alla 0.3.0. Non ha retto: nessuno legge un ADR prima di aprire un
  `package.json`.
