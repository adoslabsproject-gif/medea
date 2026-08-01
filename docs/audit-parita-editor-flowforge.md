# Audit di parità: editor workflow Medea vs FlowForge originale

> Data: 2026-08-01 · Metodo: diff deterministico dei 193 NodeDef (script, non
> impressioni) + inventario funzione-per-funzione dei due editor.
> Fonti: `/Users/zelistore/zeliai/apps/flowforge-editor` vs
> `apps/desktop/src/features/workflows` (HEAD 74232d4).

## Qualità dei nodi — verdetto misurato

**193/193 defId presenti, zero mancanti, zero divergenze** su `required`,
`options`, `actions`, `branching`, porte. La struttura è fedele. Le
degradazioni sono 7, tutte nell'estrattore (`scripts/extract-flowforge-nodes.mjs`):

| # | Campo perso | Portata | Impatto |
|---|---|---|---|
| 1 | `version` (defVersion) | 193 nodi | pinning versione morto: niente `versionDrift`, niente `NodeVersionNotice` |
| 2 | `description` troncata a 1 frase | 192 | palette più povera + retrieval lessicale AI più debole |
| 3 | `language` sui campi `code` | 45 campi | `CODE_NODE_LANG_MISMATCH` e l'editor codice non sanno il linguaggio |
| 4 | `searchAliases` | 25 nodi | ricerca palette e catalogo AI perdono gli alias |
| 5 | `outputContract` | 5 nodi | perso il grounding anti-allucinazione nel prompt |
| 6 | `selfManagedRetry` | `action_http` | la UI non può avvisare del doppio retry |
| 7 | `patternMessage` | 1 campo | messaggio di validazione perso |

**Fix**: l'estrattore deve conservare questi 7 campi. In più la palette
(`catalog/index.ts:74`) ignora `searchAliases` anche quando c'è, e manca il
port della mappa alias n8n (`layout/n8n-aliases.ts` — con test di copertura
che boccia i nodi senza alias).

## Gap P0 — parità funzionale reale

1. **NodeActionPicker assente**: i nodi `.ffnode` di comunità hanno fino a 75
   azioni (`config.__action`, pattern Resource/Operation) — Medea installa i
   pacchetti ma l'inspector non offre alcun selettore di azione né i campi
   per-azione. I community node sono di fatto non configurabili.
2. **Draft non separato dal committed**: l'autosave di Medea (1.5 s) riscrive
   il documento che il motore esegue. L'originale scrive su `draft_json`
   separato e promuove solo al Salva: su un workflow **attivo** la differenza
   è tra "modifico in pace" e "ogni battuta va in produzione".
3. **Monaco assente**: i campi `code`/`json`/`sql` sono `<textarea>`.
   L'originale ha Monaco lazy self-hosted con 6 linguaggi.
4. **`continueOnFail` + retry senza UI**: il tipo li prevede, l'engine li
   rispetta, nessun pannello li espone (originale: `ErrorHandlingSection` con
   categorie d'errore e retryCount/DelayMs).
5. **Multi-selezione e drag di gruppo assenti** (solo selezione singola) e
   **niente drag&drop dalla palette** (solo click).
6. **«Ferma esecuzione» non cablato**: `useWorkflowRun.cancel()` esiste, nessun
   pulsante lo chiama (originale: `StopRunButton` al posto di Esegui).
7. **Estrattore nodi**: i 7 campi della tabella sopra.

## Gap P1 — profondità operativa

- **Run inspector ricco**: viste Tree/Raw/Table/Schema/Binary, log
  strutturati filtrabili, execution profile, **drag di un valore →
  espressione** nel campo config. Medea ha JSON pretty-printed espandibile.
- **Pin data / mock trigger data / pannello I/O con dati reali** sul nodo
  (Medea mostra solo topologia e nomi campi dichiarati).
- **Webhook tester**: cURL con HMAC vera, 4 modalità auth, cattura della
  prossima richiesta reale come mock. Medea ha URL + Copia.
- **Suggerimenti espressioni da dati reali**: schema inferito dagli output
  dell'ultima run + `$env.*` + libreria di esempi. Medea suggerisce solo i
  campi dichiarati dai nodi a monte.
- **Picker DB non cablati**: `db-picker`/`db-table-picker` sono input liberi
  con «Scelgo dopo» — Medea ha già DB Studio, andrebbero collegati.
- **Diff fra versioni** (Myers word-level + minimappa dei cambi). Medea ha
  versioni+rollback ma nessun confronto.
- **Replay con pin-edit degli input a monte** (Medea ha «Riparti da qui» ✓,
  manca l'editor degli override).
- **AI explain / AI debug del run fallito**.

## Gap P2 — rifiniture

Sticky notes/gruppi con resize · command palette Cmd+K · snap-to-grid ·
riconnessione edge trascinando un capo · blocco trigger→trigger ·
colorazione degli edge con lo stato del run · export PNG · import n8n e
import da URL/incolla · estrazione subworkflow (+ `SubworkflowPicker` per
`logic_subworkflow`) · error-workflow binding · metadati (tag, runVerbosity
in UI) · anteprima del form pubblico + lista form · banner segreti mancanti
pre-esecuzione · tour di onboarding · traduzione errori in italiano ·
`Cmd/Ctrl+Space` per i suggerimenti · rich-text TipTap (oggi textarea).

## Dove Medea è già superiore

- **Quality gate live sul canvas** (21 regole mentre disegni; l'originale le
  applica solo allo scaffold AI — al run controlla solo i required).
- **Segreti nel keychain OS** (l'originale li tiene in chiaro in
  `tenant_variables`, nonostante i commenti dicano il contrario).
- **Export auto-sanificato** che sostituisce i valori sensibili con
  `{{secrets.NODEID_CAMPO}}` invece di azzerarli.
- **Relay opt-in** con allowlist dei soli percorsi `/webhooks/…`.
- **Intent classifier** davanti all'agente + fork «Correggi» della chat.
- **SSE unico condiviso** per tutta l'app, con retry esponenziale.
- Test-node **sulla bozza** senza salvare (l'endpoint effimero originale
  richiede più passi).

## Fuori scope (SaaS/multi-utente, esclusi consapevolmente)

Yjs/collab, lock multi-editor, @mention e commenti di team, sharing, admin
multi-tenant, billing/quote, client portal, PWA mobile, custom-nodes IDE.
