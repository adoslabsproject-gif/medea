# Medea

> Personal operational memory system in forma di client email.

Medea **non è** «un client email con un'AI accanto». È un **personal operational memory system**: le tue email sono il log narrativo della vita lavorativa (identità, relazioni, accordi, contesto, cronologia, intenti, conflitti, decisioni). Il valore reale è **ridurre il carico cognitivo della posta**. Tutto il resto è decorazione.

L'AI in Medea fa **solo sei cose**, tutte mail-centric:

1. **Priorità** — cosa va letto adesso vs dopo vs mai.
2. **Sintesi** — thread lunghi compressi in 3 righe.
3. **Ricerca semantica** — sul corpus delle proprie email, con citazione.
4. **Risposta intelligente** — bozze contestuali, sempre previa conferma.
5. **Estrazione task** — action items da thread di posta.
6. **Follow-up** — chi non ha risposto, cosa aspetto, cosa ho promesso.

Tutto qui. Niente canvas, niente browser tool, niente «AI Vegas Casino».

Il client è **neutro**: nessun verticale di settore, nessun dato aziendale
precablato. Anagrafiche, articoli, listini e documenti sono strutture generiche
utilizzabili da qualsiasi azienda.

## Stack

- **Tauri 2** desktop (Win/macOS/Linux); Tauri Mobile per Android è previsto ma non ancora avviato
- **Rust** core nel crate `apps/desktop/src-tauri` (IMAP, SMTP, sync, SQLite, tool AI)
- **React 19 + Vite + TypeScript strict** UI
- **pnpm 11 workspaces + Turborepo 2** monorepo
- Design system: **OKLCH** + `light-dark()` + **CSS `@layer`**
- Persistenza: **SQLite** (`rusqlite`, bundled) con **FTS5** per la ricerca full-text
- AI: **BYOK** — nessun provider preconfigurato. Anthropic, OpenAI, Gemini,
  DeepSeek, Grok, OpenRouter, oppure un endpoint OpenAI-compatibile a scelta
  (vLLM, gateway privato). Le chiavi stanno nel **keychain di sistema**.

## Stato attuale

Funzionanti oggi:

| Area                                               | Stato |
| -------------------------------------------------- | ----- |
| Shell desktop + design system + primitivi UI       | 🟢    |
| Account IMAP/SMTP, sync cartelle, lettura/invio    | 🟢    |
| DB locale SQLite + ricerca FTS5                    | 🟢    |
| Rubrica, anagrafiche, articoli, listini, documenti | 🟢    |
| Pannello AI con tool-calling nativo + consent gate | 🟢    |
| Promemoria con notifiche OS                        | 🟢    |
| DB Studio (esplora/modifica tabelle)               | 🟢    |
| OAuth Google/Microsoft                             | ⏳    |
| RAG / ricerca semantica con budget RAM             | ⏳    |
| Tauri Mobile Android                               | ⏳    |
| Distribuzione + auto-update                        | ⏳    |

Il tool system dell'AI è allineato per nomi e protocollo a quello dell'app
Liara, così lo stesso modello fine-tuned funziona su entrambe: vedi
[ADR 0004](./docs/architecture/adr/0004-tool-system-allineato-liara-byok.md).

## Requisiti

- Node ≥ 22 (`nvm use` legge `.nvmrc`)
- pnpm ≥ 9 (`corepack enable` raccomandato)
- Rust stable (`rustup` legge `rust-toolchain.toml`)
- macOS 11+, Windows 10+, Ubuntu 22.04+

## Sviluppo

```bash
pnpm install
pnpm tokens:build     # genera packages/design-system/dist/tokens.css
pnpm tauri:dev        # apre la shell desktop in dev mode
```

Altri script:

```bash
pnpm typecheck        # tsc --noEmit su tutto il workspace
pnpm lint             # eslint (app + packages) e stylelint (design system)
pnpm format           # prettier
```

Test: `cargo test` dentro `apps/desktop/src-tauri` (pricing engine e scanner
allegati). Non ci sono ancora test lato frontend.

## Struttura

```
mailer/
├── apps/
│   └── desktop/          Tauri shell + React UI + crate Rust (src-tauri/)
├── packages/
│   ├── design-system/    CSS-only: OKLCH tokens, @layer, temi
│   ├── ui/               primitivi React (Button, TextField, Select, Tooltip, Dialog)
│   ├── utils/            Result, date, html
│   ├── tsconfig/         config TypeScript condivise
│   └── eslint-config/    config ESLint condivise
└── docs/architecture/adr/
```

## Documentazione

- [`CLAUDE.md`](./CLAUDE.md) — guida per agenti AI sullo stack
- [`docs/architecture/adr/`](./docs/architecture/adr/) — Architecture Decision Records

## Licenza

UNLICENSED finché non viene scelta una licenza esplicita.
