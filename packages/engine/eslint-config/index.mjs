import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  // Baseline = preset UFFICIALE RACCOMANDATO da typescript-eslint per progetti
  // type-checked. (Prima era `strictTypeChecked`, il tier "opinionato" che gli
  // autori stessi documentano come incline a falsi positivi e da adottare solo
  // opt-in: era aspirazionale e mai rispettato — ~4000 violazioni ignorate.
  // `recommendedTypeChecked` mantiene TUTTE le regole anti-bug vere — no-unsafe-*,
  // no-floating-promises, no-misused-promises, no-base-to-string, await-thenable,
  // require-await — ma toglie il tier stilistico-strict ad alto rumore. Risultato:
  // ruleset realmente verde + gated, non decorativo.)
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // Convenzione `_`-prefix per "intenzionalmente non usato" (già su args):
      // estesa a vars/caught + ignoreRestSiblings per il pattern di omit
      // `const { x: _omit, ...rest } = obj`. Standard documentato.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      // `||` per default su PRIMITIVI falsy (stringa vuota / 0) è idioma VALIDO e
      // voluto: `name || 'default'` deve cadere sul default anche se name===''.
      // `??` lì sarebbe un BUG (terrebbe ''). Teniamo la regola ON per oggetti/
      // nullable (dove `||` vs `??` è un bug vero), ma ignoriamo i primitivi —
      // opzione documentata da typescript-eslint, non un disable.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true, number: true } },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // `x == null` è l'idioma universale per "null O undefined" (lo mostrano i
      // doc eslint stessi con questa opzione). `=== null || === undefined` sarebbe
      // solo più verboso. `===` resta OBBLIGATORIO per ogni altro confronto.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
