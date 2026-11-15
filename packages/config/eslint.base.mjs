import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Shared lint rules for every TypeScript package in the repo. */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'Money is integer paise; use helpers from @mehfil/domain instead of parseFloat.',
        },
      ],
    },
  },
);
