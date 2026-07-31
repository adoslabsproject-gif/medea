# ADR 0005 — FlowForge dentro Medea: canvas locale, runtime sidecar, relay sul server

- **Stato**: proposto (2026-07-31)
- **Contesto**: Medea deve avere una tab **Workflow** con le stesse capacità di
  FlowForge (`/Users/zelistore/zeliAI`), self-hosted sul PC dell'utente, senza
  registrazione, con i nodi scaricati dal nostro registry ma poi autonoma.

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

## Decisioni

### 1. Runtime come processo figlio (sidecar)

Il runtime Node di FlowForge viene impacchettato e avviato da Tauri su porta
effimera, con health-check e spegnimento legato al processo padre. È l'unica
strada che conserva i 186 nodi e la sandbox `isolated-vm` (modulo nativo C++,
senza equivalente in Rust).

Costo accettato: l'installer passa da ~8 MB a ~100 MB.

### 2. Nessuna registrazione

FlowForge è multi-tenant e `getTenantId` lancia se manca l'auth: non si
disattiva, si **auto-provisiona**. Al primo avvio Medea crea l'owner locale,
salva il token nel **keychain** (già in uso per chiavi API e credenziali IMAP)
e lo usa in silenzio. Zero schermate di accesso.

### 3. Nodi dal registry, poi autonomia

Si riusa **as-is** il formato `.ffnode` (zip firmato Ed25519) e il protocollo
del registry: cache 5 minuti, fallback stale fino a un'ora se offline, nodi
installati che restano sul disco. È già esattamente il comportamento richiesto.

### 4. Dove si esegue: locale o server, per workflow

- **Locale** tutto ciò che tocca dati locali — la posta vive nel SQLite del PC,
  il server non la vede.
- **Sul server** ciò che deve girare a macchina spenta: FlowForge in produzione
  ha già i container per tenant.

Stesso editor, stessi nodi, la destinazione è una proprietà del workflow.

### 5. Webhook via relay sul server esistente

Il PC dietro NAT non è raggiungibile dall'esterno, ma può aprire un canale **in
uscita**: Medea tiene un WebSocket verso `hooks.automazionezeli.com`, il relay
instrada la chiamata HTTP dentro quel canale e mette in coda su Dragonfly
quello che arriva mentre il dispositivo è offline.

nginx sul server gestisce già l'upgrade WebSocket. Ogni installazione ha un id
e un token nel keychain: senza, chiunque conosca l'URL potrebbe iniettare
eventi nel PC dell'utente. Funzione **disattivata di default**: aprire un
ingresso da internet è una scelta consapevole.

## Struttura dei moduli

Regola del progetto: hard cap 300 righe, soft cap 200, split oltre i 200.

```
apps/desktop/src/features/workflows/
├── index.ts                    barrel: unica API pubblica
├── types.ts                    schema workflow (port di core-schema)
├── api.ts                      wrapper invoke() verso i comandi Tauri
├── canvas/                     editor xyflow
│   ├── WorkflowCanvas.tsx      canvas e interazioni
│   ├── WorkflowNode.tsx        nodo singolo
│   ├── NodePalette.tsx         palette e ricerca
│   └── layout.ts               posizionamento automatico
├── scaffold/                   generazione da linguaggio naturale
│   ├── prompt.ts               costruzione del prompt (contratto esplicito)
│   ├── catalog.ts              catalogo nodi compattato per il modello
│   ├── parse.ts                estrazione del JSON dalla risposta
│   └── validate.ts             i 3 livelli di validazione
├── runs/                       esecuzioni e log
└── registry/                   nodi scaricati dal sito

apps/desktop/src-tauri/src/
├── commands/workflow_cmd.rs    comandi esposti alla UI
├── sidecar/                    avvio, health-check, spegnimento del runtime
└── db/workflows.rs             persistenza locale
```

## Ordine di lavoro

1. Canvas con i nodi base e persistenza locale (valore visibile subito).
2. **AI scaffold** col contratto esplicito e la validazione a 3 livelli.
3. Sidecar del runtime e esecuzione reale.
4. Registry dei nodi `.ffnode`.
5. Relay per i webhook e promozione del runtime a servizio di sistema.
