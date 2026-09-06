import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

/**
 * Flat ESLint config.
 *
 * `eslint-config-next` v16 ships native flat configs, so they are spread
 * directly. Routing them through `@eslint/eslintrc`'s FlatCompat instead
 * crashes with "Converting circular structure to JSON".
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      'private/**',
      'storage/**',
      'next-env.d.ts',
    ],
  },

  ...nextCoreWebVitals,
  ...nextTypeScript,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // `console.log` is noise; deliberate operator output uses info/warn/error.
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },

  {
    // CLI scripts and tests print to stdout and use non-null assertions on
    // rows the surrounding SQL guarantees exist.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];

export default config;
