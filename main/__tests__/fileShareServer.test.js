import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createShareURL, shutdown } from "../fileShareServer";

function makeTempFile(contents = "sample") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-test-"));
  const filePath = path.join(dir, "clip.mp4");
  fs.writeFileSync(filePath, contents);
  return { dir, filePath };
}

async function createShareURLWithRetry(options, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return createShareURL(options);
    } catch (error) {
      lastError = error;
      if (error?.message !== "FileShareServer not ready" || i === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe("fileShareServer", () => {
  afterEach(() => {
    shutdown();
  });

  it("streams requested files via ephemeral URLs", async () => {
    const { dir, filePath } = makeTempFile("hello world");

    try {
      const url = await createShareURLWithRetry({
        filePath,
        mimeType: "text/plain",
        downloadName: "clip.mp4",
        ttlMs: 60_000,
      });

      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain");
      const body = await response.text();
      expect(body).toBe("hello world");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
