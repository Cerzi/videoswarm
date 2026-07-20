#!/usr/bin/env node

const { spawn } = require("node:child_process");

const electronPath = require("electron");
const vitestPath = require.resolve("vitest/vitest.mjs");
const forwardedArgs = process.argv.slice(2);
const vitestArgs = forwardedArgs.length > 0 ? forwardedArgs : ["run"];

const child = spawn(electronPath, [vitestPath, ...vitestArgs], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    VIDEOSWARM_REQUIRE_SQLITE_TESTS: "1",
  },
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error("Unable to start Vitest with Electron's Node runtime:", error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Electron Vitest exited after signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 1;
});
