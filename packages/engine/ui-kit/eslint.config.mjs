import baseConfig from '@medea/engine-eslint-config';

const ROOT = import.meta.dirname;

/**
 * Gate eslint per @medea/engine-ui-kit (libreria React — prima senza config: lint
 * script presente ma rotto). Variante React: tsconfig.eslint.json standalone con
 * JSX (react-jsx) + lib DOM, e glob estesi a .tsx. Type-aware (RE-include i test).
 */
export default [
  ...baseConfig,
  {
    ignores: ['dist', 'node_modules', 'coverage', '**/*.config.*', 'src/**/*.js'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: ROOT,
      },
    },
  },
  // ── Override TEST: idiomi vitest legittimi (NON silenziamento di codice prod) ──
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
];
