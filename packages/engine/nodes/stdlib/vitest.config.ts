import { defineConfig } from 'vitest/config';

/**
 * Default Vitest suite for `@flowforge/nodes-stdlib`.
 *
 * Scope: unit + in-process integration tests only — fast (< 10s), no external
 * deps, deterministic, CI-safe without secrets.
 *
 * `*.e2e.test.ts` files (currently `actions/odoo_create_lead/e2e.test.ts`) hit
 * a REAL Odoo 17 instance via XML-RPC and are gated by `ODOO_E2E=1` + four
 * connection env vars. They run from `vitest.e2e.config.ts` instead.
 *
 * Rationale (2026-06-06): pre-fix the E2E file matched the default discovery
 * pattern (`*.test.ts`), so the suite reported `2 skipped` on every run —
 * confusing the "all green" signal. Splitting the configs keeps the default
 * run at ZERO skipped while preserving the E2E coverage on demand.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.e2e.test.ts', 'node_modules/**', 'dist/**'],
  },
});
