# @flowforge/observability

Observability primitives per FlowForge: logger, metrics, audit log, OpenTelemetry.

## Design intent

Questa cartella è organizzata in **3 sub-packages** che riflettono i 3 pillar
classici dell'observability:

- **`metrics/`** — Prometheus exposition + custom counters/histograms
- **`audit-log/`** — append-only hash-chained event log per security/compliance
- **`otel/`** — OpenTelemetry traces/spans (future)

## Stato corrente

Le implementazioni operative vivono attualmente in `apps/runtime/src/`:

| Concern | Path corrente | Estrazione futura |
|---------|---------------|-------------------|
| Pino logger | `apps/runtime/src/lib/logger.ts` | → `@flowforge/observability/logger` |
| Prometheus | `apps/runtime/src/lib/metrics-store.ts` + `routes/metrics.ts` | → `@flowforge/observability/metrics` |
| Audit log | `apps/runtime/src/services/audit.service.ts` | → `@flowforge/observability/audit-log` |
| OTel | (non ancora) | → `@flowforge/observability/otel` |

## Perché non estratto ancora

L'estrazione di librerie condivise da un'app monorepo è una refactor
incrementale: prematuro estrarre prima che esistano 2+ consumer rende
l'astrazione meno informata. Oggi `apps/runtime` è l'unico consumer di queste
primitive. Quando aggiungeremo:

- `apps/desktop` (worker locale che logga sulla stessa pipeline)
- `apps/cli` (operations tooling che vuole metrics emit)
- Un secondo runtime tenant (es. `apps/runtime-edge` per Cloudflare Workers)

allora l'estrazione diventerà naturale e l'API surface sarà guidata da
2+ use case reali, non da una sola.

## Migration plan (quando arriverà il momento)

1. Copia `apps/runtime/src/lib/logger.ts` → `packages/observability/logger/src/index.ts`
2. Aggiungi `package.json` con `"name": "@flowforge/observability-logger"`
3. Importa `pino` come peer dep (consumer sceglie versione)
4. In `apps/runtime/src/lib/logger.ts` re-exporta da `@flowforge/observability-logger`
5. Iterativo per metrics, audit-log, otel

Vedi `packages/secrets/` come esempio di estrazione già completata (logger di
secrets già spostato da `apps/runtime` a libreria condivisa).
