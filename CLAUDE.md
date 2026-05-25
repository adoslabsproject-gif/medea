# CLAUDE.md — guida per agenti AI sul codebase di Medea

> Leggimi prima di toccare qualunque cosa.

## La visione (la cosa che viene prima di tutto)

Medea è un **personal operational memory system** in forma di client email. Il valore reale è **ridurre il carico cognitivo della posta**. L'AI fa SOLO 6 cose mail-centric: priorità, sintesi, ricerca semantica, risposta intelligente, estrazione task, follow-up. Tutto il resto è fuori scope.

**Filtro mentale obbligatorio**: prima di proporre una feature, chiediti «questa cosa riduce il carico cognitivo della posta?». Se la risposta è no, *non* proporla.

## Le tre verità tecniche

1. **Il pezzo difficile è il sync mail**, non la UI e non i provider AI. IMAP è inconsistente, Gmail è "IMAP con personalità multiple". Una mail duplicata o una unread del 2018 fantasma = Medea sembra rotta. Il sync engine in `packages/mail-core/crates/mail-sync/` è il vero deliverable, non un sotto-modulo.
2. **RAM budget del RAG è critico** — embedding lazy, chunking intelligente, eviction cache, batching, priority indexing. Mai indicizzare l'intera mailbox al primo run.
3. **L'AI deve ricordare e suggerire, non gridare.** Memoria operativa di lungo termine (mittenti, accordi, pattern) è il vero differenziatore.

## Regole di codice non negoziabili

### File e struttura

- **Niente file monolitici**. Hard cap 300 righe, soft cap 200. Oltre 200 si valuta uno split, oltre 300 si splitta sempre.
- **Co-location** per ogni componente UI: `Foo.tsx`, `Foo.module.css`, `Foo.types.ts`, `Foo.test.tsx`, `Foo.stories.tsx`, `index.ts`.
- **Barrel `index.ts`** come unica public API di ogni cartella/package.
- **Import cross-package** sempre con alias `@medea/<pkg>`, mai path relativi tra package.

### CSS

- **Mai hex colors raw** nei componenti. Solo `var(--color-*)` semantici dal design system. ESLint blocca i literal hex via `no-restricted-syntax`.
- **Mai `z-index` magic numbers.** Solo `var(--z-*)` dalla scala in `packages/design-system/tokens/z-index.json`.
- **Container queries** (`@container`) invece di `@media` quando il layout deve rispondere al container e non al viewport.
- Ogni regola CSS appartiene a un `@layer`: `reset, tokens, base, themes, components, features, utilities, overrides`. `overrides` richiede commento obbligatorio.
- **Niente animazioni se l'utente ha `prefers-reduced-motion: reduce`** — gestito nel reset.

### TypeScript

- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` sono attivi. Non si toccano per "comodità".
- `verbatimModuleSyntax: true` → import dei type espliciti (`import type { Foo }`).
- Niente `any`, niente `// @ts-ignore`. Se serve, c'è `Result<T, E>` in `@medea/utils/result`.

### Rust (`mail-core` e `apps/*/src-tauri`)

- `cargo fmt --check` + `cargo clippy -- -D warnings` in CI e pre-commit.
- Niente `unwrap()` in produzione (fuori dai test). Usa `?` e tipi `Result` propri.
- Async: `tokio` 1.x. SQLite via `rusqlite` con `spawn_blocking` quando serve.
- Niente `sqlx` (compile-time DB check rompe CI cross-platform).
- Vector store: **`sqlite-vec`** caricata come extension. Mai PGlite/pgvector-via-WASM (incompatibile con Android).

### Tauri

- **Capabilities least-privilege** dal giorno 1. Aggiungere permessi è facile, toglierli dopo è incident-grade.
- `fs:scope` solo `$APPLOCALDATA/Medea/**` + `$DOWNLOAD/Medea/**`. **Mai** `$HOME/**`.
- `http:default` con allowlist puntuale di domini, **mai** `*`.
- CSP rigorosa con `connect-src` per i soli provider AI/mail OAuth.

### Sicurezza

- Token via `OsKeychain` (Keychain/Credential Manager/Secret Service/Android Keystore). Fallback `EncryptedFileStore` AES-256-GCM, chiave da Argon2id(machine-id).
- OAuth PKCE S256 obbligatorio. Callback solo loopback `127.0.0.1:[19847-19851]`. Manual code-paste fallback per ambienti firewalled (un certo numero di reti enterprise blocca il callback).
- Body email HTML in `<iframe sandbox>` minimo, sanitizzato server-side con `ammonia`.
- Tracker pixel: blocco di default, toggle utente per messaggio.

## Cosa NON fare (esplicito)

- Niente «Chat view» generica — l'AI vive in 6 *modes* mail-contextual in `features/ai-mail/`.
- Niente tool explosion — max 15 tool registrabili nell'AI, tutti mail-centric. La logica esistente in `nha-toolkit/src/services/tool-executor.mjs` (110+ tool) **non si porta tutta**: solo i 15 mail-specific.
- Niente canvas/browser/web search/finance/screen/voice/RSS/agenti multipli dal toolkit NHA.
- Niente fork conversazione esposto in UI in Fase 1 (la metadata `parent_id` c'è per il futuro, ma il prodotto non la espone).
- Niente auto-send. Ogni mutation richiede conferma esplicita dell'utente.
- Niente indexing eager dell'intera mailbox al primo run — lazy tier (6 mesi → 6-24 mesi → oltre 24 mesi su richiesta).
- Niente Electron. Niente PGlite. Niente sidecar Node. Solo Tauri 2 + Rust nativo.

## Materiale di riferimento (non da copiare)

Il porting prende **logica**, non file:

- `/Users/zelistore/nha-toolkit/src/services/email-*.mjs` → crates Rust in `mail-core/crates/`
- `/Users/zelistore/NotHumanAllowed/packages/nha-ui/src/views/Email.tsx` (730 righe) → spezzato in `apps/desktop/src/features/mail/` (~20 file)
- `/Users/zelistore/NotHumanAllowed/packages/nha-ui/src/views/Chat.tsx` (1009) → spezzato in `apps/desktop/src/features/ai-mail/` (~15 file)
- `/Users/zelistore/nha-toolkit/src/services/llm.mjs` (provider router, BPE repair Qwen3, OpenRouter auto-prefix) → `mail-core/crates/mail-ai/`
- `/Users/zelistore/nha-toolkit/src/services/message-responder.mjs` (3925 righe — **porting selettivo**: solo loop, guardrails, language detection)

## Comandi rapidi

```bash
pnpm install                   # installa tutto il workspace
pnpm tokens:build              # genera packages/design-system/dist/tokens.css
pnpm tauri:dev                 # shell desktop in dev
pnpm tauri:build               # build .dmg/.exe/.deb/.appimage
pnpm typecheck                 # tsc --noEmit
pnpm lint                      # eslint
pnpm format                    # prettier
cargo test --workspace         # da packages/mail-core (dopo Fase 1)
cargo tauri android dev        # mobile (dopo Fase 8)
```

## Decisioni architetturali

Vedi `docs/architecture/adr/`. In particolare:

- **ADR 0001** — Tauri 2 + Rust + Tauri Mobile (e perché non Electron, non Capacitor)
- **ADR 0002** — Sync engine è il prodotto (e perché ha 4-5 settimane dedicate prima della UI)

Quando devi prendere una decisione di architettura non banale, **scrivi un nuovo ADR** in `docs/architecture/adr/NNNN-<slug>.md`. È più importante della PR che lo accompagna.
