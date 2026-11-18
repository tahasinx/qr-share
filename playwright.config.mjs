import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.mjs',
  use: {
    bypassCSP: true, // the CSP only allows the public PeerJS cloud; tests use a local signaling server
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
