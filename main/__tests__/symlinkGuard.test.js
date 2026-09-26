import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { withSymlinkGuard } = require("../symlink-guard");

const directories = [];
afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop(), { recursive: true, force: true });
});

describe("withSymlinkGuard", () => {
  it.skipIf(process.platform === "win32")(
    "never builds a record for a symbolic link, and passes everything else through",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-links-"));
      directories.push(directory);
      const target = path.join(directory, "clip.mp4");
      const link = path.join(directory, "link.mp4");
      fs.writeFileSync(target, "content");
      fs.symlinkSync(target, link);
      const create = vi.fn(async (filePath) => ({ id: filePath }));
      const guarded = withSymlinkGuard(create);

      expect(await guarded(link, directory, { a: 1 })).toBeNull();
      expect(await guarded(target, directory, { a: 1 })).toEqual({ id: target });
      expect(await guarded(path.join(directory, "gone.mp4"), directory)).toEqual({
        id: path.join(directory, "gone.mp4"),
      });
      expect(create.mock.calls.map(([filePath]) => filePath)).toEqual([
        target,
        path.join(directory, "gone.mp4"),
      ]);
      expect(create.mock.calls[0].slice(1)).toEqual([directory, { a: 1 }]);
    }
  );
});
