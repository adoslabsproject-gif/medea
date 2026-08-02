import baseConfig from '@medea/engine-eslint-config';

const ROOT = import.meta.dirname;

/**
 * Gate eslint per @medea/engine-templates (prima ASSENTE — wirato per la regola "GATE VERDE,
 * ZERO DEBITO": ogni package deve avere lint+tsc+test a zero). Type-aware via
 * tsconfig.eslint.json (standalone: RE-include i *.test.ts che il build-tsconfig
 * esclude, ed evita il TS5012 da extends a catena del tsconfig base).
 */
export default [
  ...baseConfig,
  {
    // I .js in src sono build-helper (es. serialize-entry): non type-aware-lintabili.
    ignores: ['dist', 'node_modules', 'coverage', '**/*.config.*', 'src/**/*.js'],
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
  // ── Override CLI bin/: gli entrypoint da terminale stampano legittimamente. ──
  {
    files: ['src/bin/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // ── Override TEST + script di verifica in __tests__: idiomi vitest legittimi
  //    (NON silenziamento di codice prod). ──
  {
    files: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // destructuring di funzioni pure da builtin node → falso positivo unbound-method
      '@typescript-eslint/unbound-method': 'off',
      // mock che implementano un'interfaccia async (redis/trigger/executor) senza
      // await reale: idioma test legittimo, non un async morto di produzione.
      '@typescript-eslint/require-await': 'off',
    },
  },
];
