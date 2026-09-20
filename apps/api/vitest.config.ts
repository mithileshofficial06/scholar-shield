import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests need Postgres and are run by their own config, so that
    // `npm test` stays a pure unit suite anyone can run on a laptop with
    // nothing started. `npm run test:integration` is the other half.
    exclude: ['test/integration/**'],
    // Equity and holdout suites are reported separately (PROJECT_REPORT.md §13),
    // so keep names greppable: `npm test -- equity.regression`.
    reporters: ['verbose'],
  },
});
