import { defineConfig } from "@playwright/test";
const port = process.env.TASK_PREVIEW_PORT || "3101";
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `NEXT_BUILD_DIR=.next-task-e2e npm run dev -- --port ${port}`,
    url: `http://localhost:${port}/tasks/demo`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
