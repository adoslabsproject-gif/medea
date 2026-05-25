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

## Stack

- **Tauri 2** desktop (Win/macOS/Linux) + **Tauri 2 Mobile** (Android `.apk`)
- **Rust** core (cargo workspace `packages/mail-core/`)
- **React 19 + Vite + TypeScript strict** UI
- **pnpm 11 workspaces + Turborepo 2** monorepo
- Design system: **OKLCH** + `light-dark()` + **CSS `@layer`** + container queries
- Vector store: **`sqlite-vec`** (estensione caricata da `rusqlite`)
- AI: multi-provider (Liara default + Anthropic + OpenAI + Gemini + OpenRouter + Ollama)

## Stato attuale

🟢 **Fase 0 — Scaffold** in piedi. Shell Tauri che apre una finestra "Medea" con design system OKLCH e 5 primitivi UI (Button, TextField, Select, Tooltip, Dialog).

Le fasi successive (vedi `docs/architecture/adr/`):

| Fase | Stato |
| --- | --- |
| 0. Scaffold | 🟢 done |
| 1. `mail-core` base (Rust IMAP/SMTP/DB) | ⏳ next |
| 2. **Sync engine** (il pezzo che decide tutto) | ⏳ |
| 3. UI Email funzionante | ⏳ |
| 4. Google OAuth + Gmail | ⏳ |
| 5. AI mail capabilities (le 6 di sopra) | ⏳ |
| 6. RAG con budget RAM esplicito | ⏳ |
| 7. Microsoft + politeness AI | ⏳ |
| 8. Tauri Mobile Android | ⏳ |
| 9. Distribuzione + auto-update | ⏳ |
| 10. i18n + a11y + tema light + encryption at rest | ⏳ |

## Requisiti

- Node ≥ 22 (`nvm use` legge `.nvmrc`)
- pnpm ≥ 9 (`corepack enable` raccomandato)
- Rust stable (`rustup` legge `rust-toolchain.toml`)
- macOS 11+, Windows 10+, Ubuntu 22.04+
- Per build mobile: Android Studio + NDK r26

## Sviluppo

```bash
pnpm install
pnpm tokens:build     # genera packages/design-system/dist/tokens.css
pnpm tauri:dev        # apre la shell desktop in dev mode
```

Altri script:

```bash
pnpm typecheck        # tsc --noEmit su tutto il workspace
pnpm lint             # eslint
pnpm test             # vitest (quando ci saranno test)
pnpm format           # prettier
```

## Struttura

```
mailer/
├── apps/
│   ├── desktop/      Tauri shell desktop (Win/macOS/Linux)
│   └── mobile/       Tauri Mobile (Android, arriverà in Fase 8)
├── packages/
│   ├── design-system/  CSS-only: OKLCH tokens, @layer, light-dark()
│   ├── ui/             primitivi React headless+styled
│   ├── mail-core/      cargo workspace (arriverà in Fase 1)
│   ├── mail-ipc/       wrapper TS type-safe su invoke/listen
│   ├── ai-mail/        XState + hooks (Fase 5)
│   ├── i18n/  utils/  tsconfig/  eslint-config/
└── docs/architecture/adr/
```

## Documentazione

- [`CLAUDE.md`](./CLAUDE.md) — guida per agenti AI sullo stack
- [`docs/architecture/adr/`](./docs/architecture/adr/) — Architecture Decision Records
- Piano architetturale completo: vedi ADR 0001 e 0002

## Licenza

UNLICENSED finché non viene scelta una licenza esplicita.
