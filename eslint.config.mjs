// ESLint 9 flat config. Replaces the legacy .eslintrc.cjs, which ESLint 9 no
// longer reads by default. Rule set is a straight port of that file; the only
// dropped rule is @typescript-eslint/interface-name-prefix, which no longer
// exists in typescript-eslint v8.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'prisma/migrations/**',
      'eslint.config.mjs',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['{src,test,prisma}/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Nest has a Logger; console belongs only in the bootstrap fatal handlers,
      // which opt out explicitly.
      'no-console': 'warn',
    },
  },
  prettier,
);
