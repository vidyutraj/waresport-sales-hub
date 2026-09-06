import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  test: {
    projects: [
      {
        resolve: { alias: { '@': resolve(root, 'src') } },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          globals: false,
        },
      },
      {
        resolve: { alias: { '@': resolve(root, 'src') } },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globals: false,
          setupFiles: ['tests/integration/setup.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          // Integration tests share one PostgreSQL database and assert on
          // cross-transaction behaviour, so they must not interleave.
          fileParallelism: false,
          sequence: { concurrent: false },
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
