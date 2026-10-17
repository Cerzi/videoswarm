import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  PROXY_PLAYBACK_REVISION,
  resolveProxyPlaybackEnabled,
} = require("../proxy-playback-settings");

describe("proxy playback profile setting", () => {
  it("turns proxies on for new settings and for settings saved before the default changed", () => {
    expect(resolveProxyPlaybackEnabled(null)).toBe(true);
    expect(resolveProxyPlaybackEnabled({})).toBe(true);
    expect(resolveProxyPlaybackEnabled({ proxyPlaybackEnabled: false })).toBe(true);
  });

  it("keeps a choice saved under the current revision", () => {
    const saved = (proxyPlaybackEnabled) => ({
      proxyPlaybackEnabled,
      proxyPlaybackRevision: PROXY_PLAYBACK_REVISION,
    });
    expect(resolveProxyPlaybackEnabled(saved(false))).toBe(false);
    expect(resolveProxyPlaybackEnabled(saved(true))).toBe(true);
    expect(resolveProxyPlaybackEnabled(saved("yes"))).toBe(false);
    expect(resolveProxyPlaybackEnabled({ proxyPlaybackRevision: 1 })).toBe(true);
  });

  it("is how main defaults and loads the setting", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    expect(source).toContain("proxyPlaybackEnabled: true,\n  proxyPlaybackRevision: PROXY_PLAYBACK_REVISION,");
    expect(source).toContain("proxyPlaybackEnabled: resolveProxyPlaybackEnabled(source),");
  });
});
