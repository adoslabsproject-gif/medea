# Qui ci va il motore dei workflow

Questa cartella è **vuota di proposito** in una copia pulita del repository.
Il motore — il runtime di FlowForge, con il suo Node e le sue dipendenze —
pesa circa 595 MB e si rigenera:

```bash
FLOWFORGE_RUNTIME_SRC=/percorso/a/apps/engine pnpm runtime:package
```

Il perché di quei 595 MB, e le tre riduzioni provate e scartate, stanno in
[ADR 0008](../../../../docs/architecture/adr/0008-motore-impacchettato.md).

## Cosa cambia se non lo si costruisce

L'app si compila e funziona: posta, rubrica, documenti, assistente, e
l'editor dei workflow con tutti i 193 nodi disegnabili. Quello che non si può
fare è **eseguirli** — Medea lo dice con parole sue («il motore dei workflow
non è installato con questa copia»), invece di lasciare un pulsante che non
risponde.

È la ragione per cui gli installatori costruiti dalla CI di GitHub non
contengono il motore: il runtime di FlowForge sta in un altro repository, e
la CI non ce l'ha.

## Perché questo file esiste

`tauri.conf.json` dichiara `resources/runtime` fra le risorse del pacchetto.
Tauri verifica che ogni percorso dichiarato esista, e senza questo file la
cartella sparirebbe da git — facendo fallire ogni compilazione su una copia
pulita con «resource path doesn't exist».
