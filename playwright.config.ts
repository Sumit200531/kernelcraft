import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the real UI against the real API (in-memory storage).
 * `npm run test:e2e` starts both servers unless they are already running.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev -w @kernelcraft/api', url: 'http://127.0.0.1:8787/api/health', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev -w @kernelcraft/web -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 60_000 }
  ]
});
