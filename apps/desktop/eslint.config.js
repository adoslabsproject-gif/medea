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
];
