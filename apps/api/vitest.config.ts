import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Equity and holdout suites are reported separately (PROJECT_REPORT.md §13),
    // so keep names greppable: `npm test -- equity.regression`.
    reporters: ['verbose'],
  },
});
