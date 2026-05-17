import { defineConfig } from 'vitest/config';

// Test files are co-located as `*.test.ts` under src/ and excluded from the
// production `tsc` build (see tsconfig.json). vitest transpiles them directly.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
