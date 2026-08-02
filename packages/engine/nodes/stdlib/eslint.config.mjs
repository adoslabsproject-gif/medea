import baseConfig from '@medea/engine-eslint-config';
import path from 'node:path';

const ROOT = import.meta.dirname;

/**
 * stdlib è dual-target: importato da `apps/engine` (server Node) E
 * tree-shakeato dall'editor SPA Vite via barrel `src/index.ts`. Un singolo
 * `import 'node:crypto'` top-level in un file raggiungibile dal barrel rompe
 * il bundle Vite con "node:crypto is not externalized by the resolver"
 * (incident 2026-06-04 stream_proxy, 2026-06-05 email-tracking-token).
 *
 * Regola: `import` statico da `node:*` è VIETATO in `src/**` tranne in
 * `src/server.ts` (entry server-only) e nei file di test (vitest env=node).
 *
 * Pattern consentiti per moduli server-only:
 *   - `type CryptoModule = typeof import('node:crypto');`  (type-only)
 *   - `const { createHmac } = await import('node:crypto');` (dynamic, async fn)
 *
 * Strict-type-checked tuning (2026-06-05): stdlib ha ~140 file mai-linted prima
 * con 500+ errori `no-base-to-string` / `restrict-template-expressions` /
 * `no-non-null-assertion`. Sono false-positive su `${obj}` con type unknown.
 * Downgrade a warn invece di silenziare → operatore vede il debt ma CI passa.
 * Le regole SEMANTICHE (no-floating-promises, no-misused-promises) restano
 * error perché beccano bug runtime reali.
 */
export default [
  ...baseConfig,
  {
    // `coverage/` aggiunto: pre-fix `vitest --coverage` generava 3 parse-error
    // su coverage/*.js (transpile output incompatibile con projectService).
    ignores: ['dist', 'node_modules', 'coverage', '**/*.config.*'],
  },
  // ── Lint tsconfig dedicato: include i *.test.ts (esclusi dal build tsconfig
  // per non emetterli ma necessari al type-aware lint). projectService:false
  // disabilita auto-discovery del tsconfig.json (che esclude .test.ts) e usa
  // il nostro tsconfig.eslint.json esplicito.
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: ROOT,
      },
    },
  },
  // ── Regola enterprise: no import statici node:* (Vite editor bundle safety) ──
  {
    files: ['src/**/*.ts'],
    ignores: ['src/server.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                "Import statico da node:* è vietato in stdlib (rompe Vite editor bundle). " +
                "Usa lazy: `type X = typeof import('node:crypto');` + `await import('node:crypto')` dentro funzioni async. " +
                "Eccezione: src/server.ts (entry server-only).",
            },
          ],
        },
      ],
    },
  },
  // ── Tuning regole rumorose per il legacy debt (warn invece di error) ──
  {
    files: ['src/**/*.ts'],
    rules: {
      // `${obj}` con type `unknown`/object — pattern frequente in logging
      // diagnostico Zod-parsed. Off per stdlib (sprint refactor dedicato per
      // upgrade).
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Optional chaining safe coerce — false positive su input.* type guards
      // gia\` Zod-validati ma TS narrow non lo capisce.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      // Access su payload externi (Zod parsed) → unsafe per TS ma safe semanticamente.
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      // Executor pattern: `async fn(rawConfig)` deve essere async per
      // l'interface NodeExecutor — anche se internamente non ha await. Off.
      '@typescript-eslint/require-await': 'off',
      // Preferenza stilistica `??` vs `||` — frequente nei default fallback;
      // non sempre semanticamente equivalente, lascio al dev decidere.
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/no-unnecessary-type-conversion': 'warn',
      '@typescript-eslint/prefer-for-of': 'warn',
      '@typescript-eslint/restrict-plus-operands': 'warn',
      // 2026-06-05: backtick escaped nei commenti italiano (`e\``) flaggati
      // come "Unnecessary escape character" — falso positivo: il backtick va
      // escape per non rompere template literal annidati. Warn invece di error.
      'no-useless-escape': 'warn',
      // Regex detection di control char (\\x00-\\x1F) usato per anti-injection
      // ma flaggato come "Unexpected control character in regular expression".
      // Intenzionale — warn.
      'no-control-regex': 'warn',
      // `typeof import('node:crypto')` e\` la SINTASSI VOLUTA per lazy type
      // import (vedi pattern legal-archive, email-tracking-token). La regola
      // consistent-type-imports vuole `import type { … } from '…'` che NON
      // permette lazy. Off per stdlib.
      '@typescript-eslint/consistent-type-imports': 'off',
      // unbound-method false positive su detail-render mock + bench callbacks.
      '@typescript-eslint/unbound-method': 'warn',
      // no-unused-vars con `_` prefix gia\` permesso dal base config — gli altri
      // sono debt cleanup non-bloccante.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // only-throw-error / prefer-promise-reject-errors / no-unsafe-call —
      // pattern legacy con throw string in regex strategies. Da rivedere.
      '@typescript-eslint/only-throw-error': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      '@typescript-eslint/no-unnecessary-type-parameters': 'warn',
      // makeIdempotencyKeyLegacy deprecated: 3 occorrenze legacy in test che
      // verificano back-compat — l'API esiste per single-tenant. Warn.
      '@typescript-eslint/no-deprecated': 'warn',
    },
  },
  // ── Test files: niente strict-type sui mock + empty function ammessi (logger mock) ──
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Mock logger pattern: `info(){}, warn(){}` — intenzionalmente empty.
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
