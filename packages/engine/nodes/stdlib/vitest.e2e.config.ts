import { defineConfig } from 'vitest/config';

/**
 * On-demand Vitest suite for E2E integration tests in `@medea/engine-nodes-stdlib`.
 *
 * Pattern: any `*.e2e.test.ts`. The tests inside are individually `skipIf`-
 * gated by environment vars (e.g. `ODOO_E2E=1` + connection creds), so calling
 * this config without env yields an empty pass — by design.
 *
 * Invoke:
 *
 *   ODOO_E2E=1 ODOO_BASE_URL=… ODOO_DB=… ODOO_LOGIN=… ODOO_PASSWORD=… \
 *     pnpm --filter @medea/engine-nodes-stdlib run test:e2e
 */
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
