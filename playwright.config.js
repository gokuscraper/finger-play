const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 180000,
  expect: { timeout: 15000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8125",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "python -m http.server 8125",
    url: "http://localhost:8125",
    reuseExistingServer: true,
    timeout: 15000,
  },
});
