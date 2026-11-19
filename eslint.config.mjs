import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.context/**',
      // Fetched render assets (internal/launch-video/README.md).
      'internal/launch-video/*/assets/**',
      '**/dist/**',
      '**/.astro/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // Object-literal casts hide intent; declare `const x: T = {...}` so the
      // shape is checked against T.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `${error}` yields "[object Object]" for anything without a useful
      // toString, losing the reason.
      '@typescript-eslint/no-base-to-string': 'error',
      // A union switch must name every member, so a new member can't silently
      // fall through a default.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  eslintConfigPrettier,
);
