# ADR 0004 — Tool system allineato all'app Liara + BYOK-only

- **Stato**: accettato (2026-07-31)
- **Contesto**: pivot del prodotto — Medea diventa un client email **neutro**
  (nessun verticale Zeli/elettrovalvole), con l'obiettivo di usare **lo stesso
  modello fine-tuned** dell'app Liara (`/Users/zelistore/zeli-local`,
  modello `liara-24b` / alias `nha-v1` servito via vLLM OpenAI-compatible).

## Decisione 1 — BYOK come unico modo (già implementato)

Nessun provider AI preconfigurato. L'utente porta la propria chiave:
Anthropic / OpenAI / Gemini / DeepSeek / Grok / OpenRouter, oppure un
**endpoint personalizzato OpenAI-compatibile** (`provider: custom`, base URL +
nome modello configurabili) — che copre vLLM self-hosted, gateway privati e
lo stesso endpoint Liara se l'utente ne ha accesso.

Le chiavi vivono nel **keychain di sistema** (crate `keyring`, comandi Tauri
`secret_set/get/delete`, service `Medea`), mai su disco in chiaro. Anche le
credenziali IMAP/SMTP degli account sono nel keychain (chiave `accounts.v1`),
con migrazione one-shot dal vecchio blob AES in localStorage (la cui chiave
era derivata da fingerprint pubblici del device → non era vera crittografia).

## Decisione 2 — Protocollo tool: percorso "cloud" di Liara

Medea non ha inference locale: parla sempre con API remote. Il riferimento è
quindi il percorso **cloud** di zeli-local (`commands/remote.rs`), NON i
dialetti ChatML/Gemma/Mistral dell'inference locale:

1. **Tool-use nativo OpenAI-style**: array `tools` =
   `[{type:"function", function:{name, description, parameters}}]`,
   `tool_choice: "auto"`, risultati reiniettati con role `tool`.
   Fallback: parsing testuale di `<tool_call>{json}` nel content.
2. **Nomi tool in snake_case senza punti**, e dove c'è overlap semantico si
   adottano i **nomi esatti di Liara** (il modello li conosce dal training):
   `email_recent`, `email_sent`, `email_search`, `email_reply`, `email_draft`,
   `email_send`, `calendar_add/list/search/delete/update` (→ sostituisce
   `reminders.*`), `note_add/list/search` (→ memorie), `datetime` (→ `now`).
3. I tool ERP generici di Medea (clienti, articoli, listini, documenti,
   analytics, allegati, sicurezza) restano come **tool aggiuntivi** in
   snake_case (`customer_search`, `article_get`, `pricing_resolve`, …).
   Nota da zeli-local: passare al modello MENO tool del training è sicuro,
   tool NUOVI funzionano via instruction-following sul percorso cloud.
4. **Pattern proposta → conferma** (sostituisce i 15 `proposalType` morti):
   come in Liara, `email_draft`/`email_reply` NON inviano (aprono il form
   precompilato), `email_send` e ogni tool di scrittura sono **sensitive** e
   passano da un **consent gate** UI (card di conferma con dettaglio azione;
   timeout → negato). Il risultato del tool riflette SEMPRE l'esito reale.
5. **Risultati tool in testo naturale italiano** (non JSON) per i tool
   overlappanti, nei formati canonici di
   `ml/liara-zelilocal/tool_result_formats.py`.

## Stato di implementazione (2026-07-31)

Fatto:

- **Registry riscritto** (`ai_tools/mod.rs`): 54 tool in snake_case, con i nomi
  di Liara dove c'è overlap (`datetime`, `email_recent`, `email_sent`,
  `email_search`, `email_draft`, `email_reply`, `email_send`,
  `calendar_add/list/search/delete/update/snooze`, `contact_search`). Quattro
  `kind`: `read`, `write`, `sensitive`, `proposal`.
- **Account implicito**: i tool email accettano `accountId` opzionale e in
  assenza usano l'unico account configurato (`helpers::account_id`), perché i
  tool Liara non hanno quel parametro. Idem `count` → `limit` normalizzato in
  `execute()`.
- **Protocollo**: `ai_chat` ora accetta `tools` (formato OpenAI) e ritorna
  `ChatResponse { content, toolCalls }`. Tool-use nativo per OpenAI-compat
  (custom/vLLM, OpenAI, DeepSeek, Grok, OpenRouter) e per Anthropic (con
  conversione a `input_schema` / blocchi `tool_use`+`tool_result`); per tutti,
  fallback che riconosce `<tool_call>{…}</tool_call>` scritto nel testo — il
  formato dei fine-tuned in stile Liara. I risultati rientrano come turni
  `role: "tool"`.
- **Consent gate**: i 9 tool `sensitive` (scritture su anagrafiche, articoli,
  prezzi, sconti, documenti) sospendono il loop e mostrano `ConsentCard`;
  senza consenso il tool non viene eseguito e il modello riceve
  «Permesso negato dall'utente». Le scritture ora avvengono davvero
  (`tools_write.rs` non produce più proposte inerti).
- **Rimossi** perché non eseguibili o verticali: `memory.read`,
  `mail.move_to_folder`, `mail.archive`, `mail.extract_attachments`,
  `inventory.giacenza`, `analytics.aging_credits`, `sigla.refresh`, i 5
  `valvopedia.*`.
- `docs/lora/` eliminata: il tool-calling vive nei pesi del modello, un
  dataset duplicato nel repo di Medea sarebbe solo una fonte di drift.

- **`note_add` / `note_list` / `note_search` / `note_delete`** implementati su
  tabella `notes` (migrazione v10). Le memorie persistenti non vivono più in
  `localStorage` — erano invisibili ai tool: ora il drawer 🧠 e il modello
  leggono e scrivono la stessa tabella, con migrazione automatica dei dati
  esistenti.
