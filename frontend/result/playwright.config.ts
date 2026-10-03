import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://localhost:3102",
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: "NEXT_BUILD_DIR=.next-results-e2e npm run dev -- --port 3102",
    url: "http://localhost:3102/tasks/demo/results",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
