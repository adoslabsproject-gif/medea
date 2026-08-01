/**
 * HTTP Request node — re-export di back-compat.
 *
 * L'implementazione e\` stata refactored in `./http/` (v3.0):
 *   • definition.ts — NodeDef metadata (configFields, label, icon, …)
 *   • schema.ts     — Zod config schema (parse-once)
 *   • executor.ts   — orchestrator (~200 righe, usa utils + paginationWalker)
 *   • index.ts      — assembly + wrap con httpMiddlewarePreset
 *
 * Questo file resta come entry-point storico per i consumer che importano
 * `actions/http.js`. Niente logica qui.
 */

export { httpActionNode, httpExecutor, httpNodeDef, HttpConfigSchema, type HttpConfig } from './http/index.js';
