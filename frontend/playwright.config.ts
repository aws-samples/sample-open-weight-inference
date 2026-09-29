import { defineConfig, devices } from '@playwright/test';

// Browser tests run against the deployed application, so there is no local server
// and no retries that could mask a flaky wire contract.
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // Use the locally installed Chrome rather than downloading a matching build.
    channel: 'chrome',
    viewport: { width: 1600, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
});
