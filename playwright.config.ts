// Automated tests of the app in a browser, against the local test database (never the real one).
// npm run e2e  (builds the test database and the web app first: see e2e/run.mjs)
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/tests",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "e2e/report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8089",
    viewport: { width: 430, height: 900 },
    locale: "fr-FR",
    timezoneId: "Africa/Tunis",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: { command: "node e2e/serve.mjs", url: "http://127.0.0.1:8089", reuseExistingServer: true },
});
