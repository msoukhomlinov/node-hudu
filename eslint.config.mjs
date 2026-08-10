import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests frequently assert side effects via `await expect(...).rejects`; sync
      // variables bound for clarity are acceptable.
      '@typescript-eslint/no-unused-vars': 'off',
      // Test data-driven resource accessors use `as any` to index resource fields.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
