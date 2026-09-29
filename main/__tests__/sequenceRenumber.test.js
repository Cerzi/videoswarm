import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  RENUMBER_CODES,
  createSequenceRenumberCoordinator,
  executeSequenceRenumber,
  numberedName,
  planSequenceRenumber,
  preflightSequenceRenumber,
  sequenceNumberPrefix,
  sequenceNumberWidth,
  stripSequenceNumber,
} = require("../sequence-renumber");

const fsp = fs.promises;
const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "vs-renumber-"));
  const canonical = await fsp.realpath(directory);
  temporaryDirectories.push(canonical);
  return canonical;
}

async function writeClips(directory, names) {
  for (const name of names) {
    await fsp.writeFile(path.join(directory, name), `content of ${name}`);
  }
}

const entriesFor = (directory, names) =>
  names.map((name) => ({ absolutePath: path.join(directory, name) }));

const listing = async (directory) => (await fsp.readdir(directory)).sort();

const contentOf = (directory, name) =>
  fsp.readFile(path.join(directory, name), "utf8");

afterEach(async () => {
  while (temporaryDirectories.length) {
    await fsp.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("sequence numbering", () => {
  it("uses gap numbers, three digits until the sequence needs more", () => {
    expect(sequenceNumberWidth(1)).toBe(3);
    expect(sequenceNumberWidth(99)).toBe(3);
    expect(sequenceNumberWidth(100)).toBe(4);
    expect(sequenceNumberWidth(500)).toBe(4);
    expect(sequenceNumberPrefix(0, 3)).toBe("010");
    expect(sequenceNumberPrefix(2, 3)).toBe("030");
    expect(sequenceNumberPrefix(0, 120)).toBe("0010");
    expect(numberedName("shot.mp4", 1, 5)).toBe("020_shot.mp4");
  });

  it("strips only a number this feature would have written", () => {
    expect(stripSequenceNumber("010_shot.mp4")).toBe("shot.mp4");
    expect(stripSequenceNumber("0120_shot.mp4")).toBe("shot.mp4");
    // Not gap numbers: kept as part of the name.
    expect(stripSequenceNumber("2024_take.mp4")).toBe("2024_take.mp4");
    expect(stripSequenceNumber("001_take.mp4")).toBe("001_take.mp4");
    expect(stripSequenceNumber("000_take.mp4")).toBe("000_take.mp4");
    expect(stripSequenceNumber("10_take.mp4")).toBe("10_take.mp4");
    expect(stripSequenceNumber("take.mp4")).toBe("take.mp4");
    expect(numberedName("030_shot.mp4", 0, 3)).toBe("010_shot.mp4");
  });
});

describe("planSequenceRenumber", () => {
  it("refuses a sequence with missing clips, naming their positions", () => {
    expect(() =>
      planSequenceRenumber([
        { absolutePath: "/clips/a.mp4" },
        { absolutePath: null },
        { absolutePath: "/clips/c.mp4" },
        { absolutePath: null },
      ])
    ).toThrow(
      expect.objectContaining({
        code: RENUMBER_CODES.MISSING,
        positions: [2, 4],
        message: expect.stringMatching(/positions 2, 4/),
      })
    );
  });

  it("refuses a file that occupies two positions", () => {
    expect(() =>
      planSequenceRenumber(
        [
          { absolutePath: "/clips/a.mp4" },
          { absolutePath: "/clips/b.mp4" },
          { absolutePath: "/clips/a.mp4" },
        ],
        { pathImpl: path.posix, caseInsensitive: false }
      )
    ).toThrow(
      expect.objectContaining({
        code: RENUMBER_CODES.REPEATED,
        message: expect.stringMatching(/Positions 1 and 3 are the same file/),
      })
    );
  });

  it("refuses an empty sequence", () => {
    expect(() => planSequenceRenumber([])).toThrow(
      expect.objectContaining({ code: RENUMBER_CODES.EMPTY })
    );
  });

  it("plans Windows and UNC paths with Windows path rules", () => {
    const plan = planSequenceRenumber(
      [
        { absolutePath: "\\\\server\\share\\shots\\b.mp4" },
        { absolutePath: "C:\\Clips\\010_a.mp4" },
      ],
      { pathImpl: path.win32, caseInsensitive: true }
    );
    expect(plan.renames).toEqual([
      expect.objectContaining({
        directory: "\\\\server\\share\\shots",
        from: "\\\\server\\share\\shots\\b.mp4",
        to: "\\\\server\\share\\shots\\010_b.mp4",
      }),
      expect.objectContaining({
        directory: "C:\\Clips",
        to: "C:\\Clips\\020_a.mp4",
      }),
    ]);
    expect(() =>
      planSequenceRenumber(
        [
          { absolutePath: "C:\\Clips\\A.mp4" },
          { absolutePath: "c:\\clips\\a.MP4" },
        ],
        { pathImpl: path.win32, caseInsensitive: true }
      )
    ).toThrow(expect.objectContaining({ code: RENUMBER_CODES.REPEATED }));
  });

  it("leaves a file that already has its number alone", () => {
    const plan = planSequenceRenumber(
      [{ absolutePath: "/clips/010_a.mp4" }, { absolutePath: "/clips/b.mp4" }],
      { pathImpl: path.posix, caseInsensitive: false }
    );
    expect(plan.unchangedCount).toBe(1);
    expect(plan.renames.map((rename) => rename.toName)).toEqual(["020_b.mp4"]);
  });
});

describe("renumbering on disk", () => {
  const renumber = async (directory, order) => {
    const plan = planSequenceRenumber(entriesFor(directory, order));
    await preflightSequenceRenumber(plan);
    return executeSequenceRenumber(plan, { tag: "test" });
  };

  it("writes the order as 010, 020, 030 prefixes", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["b.mp4", "c.mp4", "a.mp4"]);

    const result = await renumber(directory, ["c.mp4", "a.mp4", "b.mp4"]);

    expect(result.renamed).toHaveLength(3);
    expect(await listing(directory)).toEqual([
      "010_c.mp4",
      "020_a.mp4",
      "030_b.mp4",
    ]);
    expect(await contentOf(directory, "010_c.mp4")).toBe("content of c.mp4");
  });

  it("renumbers a permutation of already-numbered files, swaps and cycles included", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["010_a.mp4", "020_b.mp4", "030_c.mp4", "040_d.mp4"]);

    // a <-> b swap, and c -> d -> c: every target is another file's name.
    await renumber(directory, ["020_b.mp4", "010_a.mp4", "040_d.mp4", "030_c.mp4"]);

    expect(await listing(directory)).toEqual([
      "010_b.mp4",
      "020_a.mp4",
      "030_d.mp4",
      "040_c.mp4",
    ]);
    expect(await contentOf(directory, "010_b.mp4")).toBe("content of 020_b.mp4");
    expect(await contentOf(directory, "040_c.mp4")).toBe("content of 030_c.mp4");
  });

  it("aborts before the first rename when a target belongs to a file outside the sequence", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["a.mp4", "b.mp4", "020_b.mp4"]);
    const before = await listing(directory);

    await expect(renumber(directory, ["a.mp4", "b.mp4"])).rejects.toMatchObject({
      code: RENUMBER_CODES.COLLISION,
      names: ["020_b.mp4"],
      message: expect.stringMatching(/Nothing was renamed: 020_b\.mp4 already exists/),
    });
    expect(await listing(directory)).toEqual(before);
    expect(await contentOf(directory, "020_b.mp4")).toBe("content of 020_b.mp4");
  });

  it("renames in each clip's own folder", async () => {
    const root = await temporaryDirectory();
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    await fsp.mkdir(left);
    await fsp.mkdir(right);
    await writeClips(left, ["x.mp4"]);
    await writeClips(right, ["y.mp4"]);

    const plan = planSequenceRenumber([
      { absolutePath: path.join(right, "y.mp4") },
      { absolutePath: path.join(left, "x.mp4") },
    ]);
    await preflightSequenceRenumber(plan);
    await executeSequenceRenumber(plan);

    expect(await listing(right)).toEqual(["010_y.mp4"]);
    expect(await listing(left)).toEqual(["020_x.mp4"]);
  });

  it("renames everything back when a step fails part-way", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["a.mp4", "b.mp4", "c.mp4"]);
    const plan = planSequenceRenumber(entriesFor(directory, ["c.mp4", "b.mp4", "a.mp4"]));
    await preflightSequenceRenumber(plan);

    let renames = 0;
    const failingFs = {
      ...fsp,
      lstat: (...args) => fsp.lstat(...args),
      rename: async (from, to) => {
        renames += 1;
        // Three staging renames succeed, then the second final one fails.
        if (renames === 5) {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        return fsp.rename(from, to);
      },
    };

    await expect(
      executeSequenceRenumber(plan, { fsPromises: failingFs, tag: "t" })
    ).rejects.toMatchObject({ code: RENUMBER_CODES.FAILED });
    expect(await listing(directory)).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    expect(await contentOf(directory, "a.mp4")).toBe("content of a.mp4");
  });

  it("stops with nothing renamed when a clip changed after the confirmation", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["a.mp4", "b.mp4"]);
    const plan = planSequenceRenumber(entriesFor(directory, ["b.mp4", "a.mp4"]));
    await preflightSequenceRenumber(plan);

    await fsp.writeFile(path.join(directory, "a.mp4"), "rewritten, and longer than before");

    await expect(executeSequenceRenumber(plan)).rejects.toMatchObject({
      code: RENUMBER_CODES.SOURCE_CHANGED,
    });
    expect(await listing(directory)).toEqual(["a.mp4", "b.mp4"]);
  });

  it("stops with nothing renamed when a target appears after the confirmation", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["a.mp4", "b.mp4"]);
    const plan = planSequenceRenumber(entriesFor(directory, ["a.mp4", "b.mp4"]));
    await preflightSequenceRenumber(plan);

    await writeClips(directory, ["020_b.mp4"]);

    await expect(executeSequenceRenumber(plan)).rejects.toMatchObject({
      code: RENUMBER_CODES.COLLISION,
    });
    expect(await listing(directory)).toEqual(["020_b.mp4", "a.mp4", "b.mp4"]);
  });

  it("refuses a symbolic link rather than renaming the link", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["a.mp4"]);
    await fsp.symlink(path.join(directory, "a.mp4"), path.join(directory, "link.mp4"));
    const plan = planSequenceRenumber(entriesFor(directory, ["link.mp4"]));

    await expect(preflightSequenceRenumber(plan)).rejects.toMatchObject({
      code: RENUMBER_CODES.SOURCE_INVALID,
    });
  });
});

describe("createSequenceRenumberCoordinator", () => {
  it("binds a plan to its owner, applies it once, and lists exactly what will change", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["a.mp4", "010_b.mp4"]);
    const coordinator = createSequenceRenumberCoordinator();

    const prepared = await coordinator.prepare({
      ownerId: 1,
      entries: entriesFor(directory, ["010_b.mp4", "a.mp4"]),
    });
    expect(prepared).toMatchObject({
      total: 2,
      unchangedCount: 1,
      renames: [
        { position: 2, directory, fromName: "a.mp4", toName: "020_a.mp4" },
      ],
    });

    await expect(
      coordinator.apply({ ownerId: 2, planId: prepared.planId })
    ).rejects.toMatchObject({ code: RENUMBER_CODES.PLAN_NOT_FOUND });

    const applied = await coordinator.apply({ ownerId: 1, planId: prepared.planId });
    expect(applied.renamed).toEqual([
      {
        position: 2,
        from: path.join(directory, "a.mp4"),
        to: path.join(directory, "020_a.mp4"),
        toName: "020_a.mp4",
        entry: { absolutePath: path.join(directory, "a.mp4") },
      },
    ]);
    expect(await listing(directory)).toEqual(["010_b.mp4", "020_a.mp4"]);

    await expect(
      coordinator.apply({ ownerId: 1, planId: prepared.planId })
    ).rejects.toMatchObject({ code: RENUMBER_CODES.PLAN_NOT_FOUND });
  });

  it("expires a plan and replaces an owner's earlier plan", async () => {
    const directory = await temporaryDirectory();
    await writeClips(directory, ["a.mp4", "b.mp4"]);
    let clock = 1000;
    let nextId = 0;
    const coordinator = createSequenceRenumberCoordinator({
      now: () => clock,
      ttlMs: 50,
      createPlanId: () => `plan-${++nextId}`,
    });
    const entries = entriesFor(directory, ["b.mp4", "a.mp4"]);

    const first = await coordinator.prepare({ ownerId: 1, entries });
    const second = await coordinator.prepare({ ownerId: 1, entries });
    expect(coordinator.size).toBe(1);
    await expect(
      coordinator.apply({ ownerId: 1, planId: first.planId })
    ).rejects.toMatchObject({ code: RENUMBER_CODES.PLAN_NOT_FOUND });

    clock += 100;
    await expect(
      coordinator.apply({ ownerId: 1, planId: second.planId })
    ).rejects.toMatchObject({ code: RENUMBER_CODES.PLAN_EXPIRED });
    expect(await listing(directory)).toEqual(["a.mp4", "b.mp4"]);
  });
});
