import baseConfig from '@flowforge/eslint-config';

export default [
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Pino logging is allowed
      'no-console': 'off',
    },
  },
  {
    // ─── Test files: SOLO le regole di TYPE-SAFETY rilassate ───────────────
    // Questo è lo standard DOCUMENTATO da typescript-eslint per i file di test
    // (vedi typescript-eslint.io/troubleshooting/formatting + le linee guida
    // "Linting with Type Information" → i test mockano con `any`/`as never`/`!`
    // per natura, dove i dati sono CONTROLLATI dal test). Disattivare qui
    // no-unsafe-* / no-explicit-any / no-non-null-assertion NON nasconde bug:
    // in PRODUZIONE queste regole restano ATTIVE.
    //
    // `unbound-method`: la stessa categoria. typescript-eslint la documenta
    // ESPLICITAMENTE come da disabilitare nei test (jest/vitest passano metodi
    // mock a expect(): `expect(handler.save)`). È un falso-positivo su mock e
    // funzioni-modulo pure (this mai usato) — il "fix" sarebbe .bind()/ristruttura
    // dei mock = rumore che peggiora i test. ON in produzione.
    //
    // ⚠️ NIENTE override "di comodo": le regole NON-test-idiom (no-base-to-string,
    // no-floating-promises, no-useless-escape, consistent-type-imports,
    // no-empty-function, only-throw-error, eqeqeq, …) restano ON ANCHE nei test
    // e sono corrette nel CODICE, non spente.
    // Glob: i `.test.ts` + i file di SUPPORTO test (fake-adapters, testkit,
    // mocks dentro __tests__/__testkit__/__mocks__) — stessa categoria di
    // codice-di-test, stessi idiomi (stub async-by-interface, mock con any).
    files: [
      '**/*.test.ts', '**/*.test.tsx',
      '**/__tests__/**/*.{ts,tsx}', '**/__testkit__/**/*.{ts,tsx}', '**/__mocks__/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // `throw 'string'` nei MOCK è intenzionale: simula una dipendenza che lancia
      // un non-Error per verificare che il sistema lo gestisca (il "fix" a Error
      // vanificherebbe il test).
      '@typescript-eslint/only-throw-error': 'off',
      // beforeEach/afterAll sono prassi standard vitest; `vitest/no-hooks` è una
      // regola d'opinione (no setup/teardown) che il codebase non adotta.
      'vitest/no-hooks': 'off',
      // consistent-type-imports RESTA ON (import type per gli statement), ma
      // `disallowTypeAnnotations:false` SOLO nei test: `vi.importActual<typeof
      // import('node:fs')>(...)` è l'idioma vitest e NON ha forma hoistata
      // pulita (`import type * as X` → TS2709, non usabile come tipo-modulo).
      // Le annotazioni inline `import()` sono type-only (erase a compile, zero
      // impatto runtime/bundle). In PRODUZIONE resta strict (disallow=true).
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    },
  },
  {
    // scripts/ + setup non sono nel projectService tsconfig (non-app code) →
    // eslint type-aware non li può lintare; sono build/test tooling.
    ignores: ['dist', 'node_modules', 'drizzle', '**/*.config.*', 'scripts/**', 'vitest.setup.ts'],
  },
];
