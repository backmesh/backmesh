import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Specs import website/src modules, whose own tsconfig extends Astro's,
  // which only website/'s install has.
  tsconfig: 'tsconfig.json',
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    expect: { requireAssertions: true },
    allowOnly: false,
    passWithNoTests: false,
  },
});
