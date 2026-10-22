// Screenshots for the user manual: npx playwright test -c e2e/manual
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8089",
    viewport: { width: 420, height: 860 },
    deviceScaleFactor: 2,
    locale: "fr-FR",
    timezoneId: "Africa/Tunis",
  },
  webServer: { command: "node e2e/serve.mjs", url: "http://127.0.0.1:8089", reuseExistingServer: true, cwd: "../.." },
});
