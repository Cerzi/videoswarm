const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/electron",
  outputDir: "./test-results/electron",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
