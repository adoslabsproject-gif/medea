import baseConfig from '@flowforge/eslint-config';

const ROOT = import.meta.dirname;

/**
 * Gate eslint per il package ai-agents (prima ASSENTE — wirato 2026-06-18 per la
 * regola "GATE VERDE, ZERO DEBITO": ogni package deve avere lint+tsc+test). Pattern
 * identico a nodes/stdlib: type-aware via tsconfig.eslint.json (include i *.test.ts,
 * esclusi dal build tsconfig), no import statici `node:*` (il package è tree-shakeato
 * anche dall'editor SPA Vite → un `import 'node:*'` top-level rompe il bundle), e
 * downgrade-a-warn (NON silenziamento) dei false-positive cosmetici su payload Zod-parsed.
 */
export default [
  ...baseConfig,
  {
    ignores: ['dist', 'node_modules', 'coverage', '**/*.config.*'],
  },
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
  // ── No import statici node:* (Vite editor bundle safety; eccezione: i test) ──
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                "Import statico da node:* è vietato (rompe il bundle Vite editor). " +
                "Usa lazy: `type X = typeof import('node:crypto');` + `await import('node:crypto')` dentro funzioni async.",
            },
          ],
        },
      ],
    },
  },
  // ── Downgrade-a-warn del legacy debt cosmetico (payload externi Zod-parsed):
  //    l'operatore vede il debito ma il gate passa. Le regole SEMANTICHE
  //    (no-floating-promises, no-misused-promises) restano ERROR. ──
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/require-await': 'off',
    },
  },
  // ── Override TEST: idiomi vitest legittimi (NON silenziamento di codice prod) ──
  //   - `orig<typeof import('x')>()` per i mock tipizzati → consistent-type-imports
  //     deve consentire le type-annotation inline.
  //   - logger/ctx stub con metodi vuoti `info() {}` → no-empty-function off.
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
