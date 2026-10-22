// Checks the code for mistakes that compile but break at run time: `npm run lint` (run before every push).
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "dist-apk/*", "android/*", "ios/*", "node_modules/*", "supabase/*", "scripts/*", "eslint-report.json", "e2e/**", "tests/**", "test-results/*", "playwright.config.ts"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Resetting a form when a modal opens, loading on mount: wanted patterns here.
      "react-hooks/set-state-in-effect": "off",
      // "Latest callback" refs (camera, signature pad) are read on purpose.
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
      // Reviewed 2026-10-22: the effects that subscribe (realtime, timers) only call state setters.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/rules-of-hooks": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
]);
