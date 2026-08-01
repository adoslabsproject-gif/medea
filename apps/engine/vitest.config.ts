/**
 * Vitest config — runtime app.
 *
 * Coverage gate Federico-grade:
 *   • Provider: v8 (built-in Node, no extra deps)
 *   • Soft target globale: 60% line/func/stmt, 50% branch
 *   • Hard target su `services/` e `engine/` (logica core business): 80%
 *   • Exclude generated/binary files + sub-dir non testabili
 *
 * Run:
 *   pnpm test              # esegue test, no coverage
 *   pnpm test:coverage     # esegue test + report coverage in coverage/
 *
 * Report HTML in `coverage/index.html`, summary lcov in `coverage/lcov.info`
 * (compatibile con Codecov / Coveralls / SonarQube se vorremo integrare CI).
 *
 * Threshold per-glob: alzato a 80% su core business logic.
 * Coverage globale resta al 60% — Federico-grade pragmatico: il codice
 * di route/middleware/lib è coperto via E2E Playwright (smoke nel deploy).
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // DB di test effimero + migrato (schema completo) per ogni worker.
    // Vedi vitest.setup.ts — elimina il file stale ./data/flowforge.sqlite.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/**',
        'dist/**',
        'coverage/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        'src/bin/**',                  // CLI entrypoint, banner-only
        'src/storage/migrate.ts',      // schema DDL idempotente
      ],
      thresholds: {
        // Soft global targets — buoni come baseline iniziale,
        // sostenibili a lungo termine senza CI flake.
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 50,
        // Hard threshold sui moduli core (logica business).
        // Per-glob threshold raised → CI gate fail se queste cartelle
        // scendono sotto 80%. Pattern Federico-grade.
        'src/services/**/*.ts': {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
        'src/engine/**/*.ts': {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
});
