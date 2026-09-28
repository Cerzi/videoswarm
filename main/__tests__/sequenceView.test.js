import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSequenceSnapshotResponse } = require("../sequence-view");

const instance = (name, overrides = {}) => ({
  instanceId: Number(name.replace(/\D/gu, "")) || 1,
  rootPath: "/library",
  relativePath: `${name}.mp4`,
  absolutePath: `/library/${name}.mp4`,
  size: 1024,
  mtimeMs: 10,
  createdMs: 5,
  fingerprint: `fp-${name}`,
  tags: [],
  rating: null,
  reviewState: "unreviewed",
  dimensions: { width: 1920, height: 1080, aspectRatio: 16 / 9 },
  hasAudio: false,
  ...overrides,
});

const entry = (id, instanceRecord) => ({
  id,
  position: id - 1,
  fingerprint: instanceRecord?.fingerprint || `fp-missing-${id}`,
  addedAt: 0,
  instance: instanceRecord,
});

const storeReturning = (snapshot) => ({
  getSequenceSnapshot: () => snapshot,
});

const snapshotOf = (entries) => ({
  id: 7,
  name: "Act one",
  entryCount: entries.length,
  createdAt: 1,
  updatedAt: 2,
  entries,
  missingCount: entries.filter((item) => !item.instance).length,
});

describe("buildSequenceSnapshotResponse", () => {
  it("gives every present entry a keyable, playable, labelled record", () => {
    const store = storeReturning(
      snapshotOf([entry(1, instance("a1")), entry(2, instance("b2"))])
    );

    const { sequence } = buildSequenceSnapshotResponse(store, {
      sequenceId: 7,
      generation: 3,
    });

    expect(sequence.entries).toHaveLength(2);
    for (const item of sequence.entries) {
      expect(item.video.id).toBeTruthy();
      expect(item.video.name).toBeTruthy();
      expect(item.video.sourceUrl).toMatch(/^videoswarm-media:\/\/instance\//u);
      expect(item.video.sourceUrl).toContain("g=3");
      expect(item.video.rootPath).toBe("/library");
    }
    expect(sequence.missingCount).toBe(0);
  });

  it("keeps a missing entry in its slot instead of shortening the story", () => {
    const store = storeReturning(
      snapshotOf([
        entry(1, instance("a1")),
        entry(2, null),
        entry(3, instance("c3")),
      ])
    );

    const { sequence } = buildSequenceSnapshotResponse(store, { sequenceId: 7 });

    expect(sequence.entries.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(sequence.entries[1].video).toBeNull();
    expect(sequence.entries[1].fingerprint).toBe("fp-missing-2");
    expect(sequence.entries[2].video.name).toBe("c3.mp4");
    expect(sequence.missingCount).toBe(1);
  });

  it("does not shift later entries when a record cannot be projected", () => {
    // An instance the projection refuses is dropped from the built list. Pairing
    // by index would then slide every following clip one slot earlier, which is
    // the silent story corruption this pairing exists to prevent.
    const store = storeReturning(
      snapshotOf([
        entry(1, instance("a1")),
        entry(2, instance("b2", { absolutePath: null })),
        entry(3, instance("c3")),
      ])
    );

    const { sequence } = buildSequenceSnapshotResponse(store, { sequenceId: 7 });

    expect(sequence.entries[0].video.name).toBe("a1.mp4");
    expect(sequence.entries[1].video).toBeNull();
    expect(sequence.entries[2].video.name).toBe("c3.mp4");
    expect(sequence.missingCount).toBe(1);
  });

  it("lets the same clip hold two positions", () => {
    const repeated = instance("a1");
    const store = storeReturning(
      snapshotOf([entry(1, repeated), entry(2, instance("b2")), entry(3, repeated)])
    );

    const { sequence } = buildSequenceSnapshotResponse(store, { sequenceId: 7 });

    expect(sequence.entries.map((item) => item.video.name)).toEqual([
      "a1.mp4",
      "b2.mp4",
      "a1.mp4",
    ]);
    expect(sequence.entries[0].id).not.toBe(sequence.entries[2].id);
  });

  it("reports a sequence that does not exist as null", () => {
    const { sequence } = buildSequenceSnapshotResponse(storeReturning(null), {
      sequenceId: 99,
    });
    expect(sequence).toBeNull();
  });

  it("passes the preferred root through to the store", () => {
    let received = null;
    const store = {
      getSequenceSnapshot: (id, options) => {
        received = { id, options };
        return snapshotOf([]);
      },
    };

    buildSequenceSnapshotResponse(store, {
      sequenceId: 7,
      preferredRootPath: "/library",
    });

    expect(received).toEqual({
      id: 7,
      options: { preferredRootPath: "/library" },
    });
  });
});
