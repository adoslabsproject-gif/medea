import react from '@medea/eslint-config/react';

export default [
  ...react,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting: risolve i tsconfig del package.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    /**
     * Il divieto di colori esadecimali esiste perché un colore scritto a mano
     * sfugge al tema. Il blu di Telegram non è un colore del tema: è il colore
     * di Telegram, uguale in chiaro e in scuro, e cambiarlo vorrebbe dire
     * disegnare il logo sbagliato. Questo file contiene solo quello — i loghi
     * dei servizi presi da simple-icons, copiati dall'editor di FlowForge.
     */
    files: ['src/features/workflows/canvas/brand-icons.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
