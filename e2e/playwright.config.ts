import { defineConfig, devices } from '@playwright/test';

/**
 * Starts the API (8000), instructor (5175) and student (5176) dev servers.
 * Specs mock API calls with page.route(), so no AWS credentials are needed; the
 * backend still has to come up because /health is the readiness check.
 */

// Minimal ambient type so this file type-checks without @types/node.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,           // serial — servers are shared
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  // Playwright defaults to 'list' only under CI, so the workflow's
  // "Upload Playwright report" step had nothing to collect and warned
  // "No files were found". Emit the HTML report explicitly.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Set SKIP_WEBSERVER=true if the servers are already running.
  webServer: process.env.SKIP_WEBSERVER
    ? undefined
    : [
        {
          // Backend API — must be first so frontends can reach it during build
          command: 'cd .. && python app.py',
          url: 'http://localhost:8000/health',
          reuseExistingServer: true,
          timeout: 30_000,
          env: {
            LOG_FORMAT: 'text',
            LOG_LEVEL: 'WARNING',
          },
        },
        {
          command: 'cd ../oral-assessment-student && npm run dev',
          url: 'http://localhost:5176',
          reuseExistingServer: true,
          timeout: 30_000,
        },
        {
          command: 'cd ../oral-assessment-instructor && npm run dev',
          url: 'http://localhost:5175',
          reuseExistingServer: true,
          timeout: 30_000,
        },
      ],
});
