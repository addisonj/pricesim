import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'] },
    // closed forms and Monte Carlo metering take a few seconds on small CI runners
    testTimeout: 60_000,
  },
})
