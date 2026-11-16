import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    expect: { requireAssertions: true },
    allowOnly: false,
    passWithNoTests: false,
  },
});
