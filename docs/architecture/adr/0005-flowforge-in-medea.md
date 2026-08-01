# ADR 0005 — FlowForge dentro Medea: canvas locale, motore impacchettato

- **Stato**: **accettato** — proposto il 2026-07-31, in gran parte realizzato
  al 2026-08-01. Le parti ancora aperte sono elencate in fondo, con il nome
  di chi le ha prese in carico dopo (ADR 0007, ADR 0008).
- **Contesto**: Medea deve avere una sezione **Workflow** con le stesse
  capacità di FlowForge (repository privato), sul computer dell'utente,
  senza registrazione e senza dipendere da un server.

## Vincolo non negoziabile: l'AI scaffold

La capacità dell'assistente di **creare workflow da linguaggio naturale** deve
restare identica a quella del server, e deve funzionare **con qualsiasi
modello**, non solo col LoRA addestrato su di essa.

Conseguenze pratiche:

1. Il **contratto** (system prompt, formato del catalogo nodi, schema JSON di
   output, regole di validazione) è una **specifica esplicita** condivisa, non
   conoscenza implicita nei pesi. Un modello generico deve poterlo eseguire
   leggendo solo il prompt.
2. Lo schema del workflow prodotto è **byte-compatibile** con
   `packages/flowforge/core/schema` (Zod): un JSON generato in Medea deve poter
   essere importato sul server e viceversa.
3. La **validazione a 3 livelli** (defId + config · tool registry · edges,
   porte e id) gira in Medea prima di salvare, e in caso di errore il modello
   riceve il motivo e riprova: mai un workflow rotto salvato in silenzio.

A questi si è aggiunto un quarto livello che l'ADR originale non prevedeva: il
**controllo di qualità a 21 regole** portato dal server (ADR 0006). Non
verifica che il workflow sia valido — verifica che sia _sensato_.

## Decisioni

### 1. Il motore è il runtime di FlowForge, impacchettato dentro l'app

Il runtime Node viene avviato da Tauri su porta effimera, con controllo di
salute e spegnimento legato al processo padre. È l'unica strada che conserva
**193 nodi** e la sandbox `isolated-vm` (modulo nativo C++, senza equivalente
in Rust).

> Correzione rispetto alla stesura originale: i nodi sono 193, non 186, ed è il
> numero che il runtime dichiara su `/api/v1/nodes`. Il catalogo di Medea è
> verificato contro quella cifra da `catalog.guard.test.ts` — se le due si
> separano, la palette offre nodi che nessuno sa eseguire.

Costo accettato: **595 MB**, non i ~100 MB stimati qui. La differenza è tutta
nei moduli nativi e in `duckdb`, che il runtime importa all'avvio anche se
nessun nodo del catalogo lo usa. Il conto dettagliato, e le tre riduzioni
provate e scartate, stanno in **ADR 0008**.

### 2. Nessuna registrazione

FlowForge è multi-tenant e `getTenantId` lancia se manca l'auth: non si
disattiva, si **auto-provisiona**. Al primo avvio Medea crea l'owner locale,
salva la password nel **portachiavi del sistema** (già in uso per chiavi API e
credenziali IMAP) e la usa in silenzio. Zero schermate di accesso.

### 3. Nodi dal registry, poi autonomia

Si riusa **as-is** il formato `.ffnode` (zip firmato Ed25519) e il protocollo
del registry: cache 5 minuti, fallback stale fino a un'ora se offline, nodi
installati che restano sul disco.

**Fatto a metà, e di proposito.** Un pacchetto `.ffnode` si installa da un
**file scelto a mano**: il formato è quello, il motore ne verifica la firma, e
il nodo compare nella palette. Il _registro remoto_ non c'è, e non è una
mancanza — un pacchetto contiene codice di terzi che verrà eseguito su quel
computer, e la decisione di fidarsi deve restare una decisione, non un click
accanto a un nome in una lista.

### 4. Dove si esegue: solo locale

L'ADR originale prevedeva due destinazioni, locale e server, come proprietà del
workflow. **Superato**: l'app deve essere autonoma per tutto il possibile, e un
workflow che gira su un server richiederebbe l'account che Medea non ha e non
vuole. Il campo `executionTarget` resta nel documento per compatibilità con lo
schema del server, ma in Medea vale sempre `local`.

Le automazioni girano anche quando la sezione Workflow è chiusa, e le
esecuzioni partite da sole — cron, casella in ascolto — finiscono nello storico
come tutte le altre. Vedi **ADR 0007**.

### 5. Webhook via relay sul server esistente

Il computer dietro NAT non è raggiungibile dall'esterno, ma può aprire un
canale **in uscita**: Medea tiene un WebSocket verso
`hooks.automazionezeli.com`, il relay instrada la chiamata HTTP dentro quel
canale e mette in coda quello che arriva mentre il dispositivo è offline.

**Non ancora fatto**, e resta l'unica funzione che richiede un server. Sarà
**disattivata di default**: aprire un ingresso da internet è una scelta
consapevole, non un'impostazione predefinita.

Nel frattempo i webhook **locali** funzionano: il motore ascolta su una porta
stabile (39100–39119) e il token si deriva da un segreto tenuto nel
portachiavi, così l'indirizzo copiato oggi vale anche domani. Serve a un altro
programma sulla stessa macchina, a uno script, a un tunnel aperto apposta —
ed è quanto un'app senza server può offrire onestamente.

## Struttura dei moduli

Regola del progetto: hard cap 300 righe, soft cap 200, split oltre i 200.

```
apps/desktop/src/features/workflows/
├── index.ts                    barrel: unica API pubblica
├── types.ts                    schema workflow (port di core-schema)
├── api.ts                      wrapper invoke() verso i comandi Tauri
├── canvas/                     editor xyflow, icone, disposizione automatica
├── catalog/                    i 193 nodi, generati dai pacchetti di FlowForge
├── scaffold/                   generazione da linguaggio naturale (agente)
├── quality/                    le 21 regole del controllo di qualità
├── wizard/                     creazione guidata, con i passi in chiaro
├── assistant/                  il pannello conversazionale
├── runtime/                    sessione, eventi, segreti, tabelle, esecuzione
├── runs/                       storico e log per nodo
└── fields/                     i tipi di campo della configurazione

apps/desktop/src-tauri/src/
├── commands/workflow_cmd.rs    comandi esposti alla UI
├── runtime/                    avvio, salute, spegnimento del motore
└── db/workflows.rs             persistenza locale
```

## Ordine di lavoro, e dove si è arrivati

1. ✅ Canvas con i nodi base e persistenza locale.
2. ✅ AI scaffold col contratto esplicito e la validazione a 3 livelli, più il
   controllo di qualità (ADR 0006) e il wizard che mostra i passi.
3. ✅ Motore e esecuzione reale, impacchettati e autonomi (ADR 0007, ADR 0008).
4. ✅ Pacchetti `.ffnode` installabili da file (senza registro remoto).
5. ⬜ Relay per i webhook da internet, e motore come servizio di sistema.

Fatte dopo la stesura: versioni con ritorno indietro, prova del singolo nodo su
bozza non salvata, riesecuzione da un punto, esportazione ripulita dalle
credenziali, webhook locali.

Restano aperte: bozza separata dal salvato, dati fissati sui nodi, e il punto 5.
