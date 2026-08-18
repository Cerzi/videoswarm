import {
  buildGenerationMetadataFacts,
  buildMetadataInfoLineItems,
  deriveMetadataRelativePath,
  deriveMetadataSelectionCount,
  deriveMetadataSelectionKey,
  deriveMetadataTagSummary,
  deriveSingleSelectionInfo,
  parseMetadataTagInput,
  selectMetadataTagCompletion,
  selectMetadataTagSuggestions,
} from "./metadataContent";

describe("shared metadata content helpers", () => {
  it("derives stable selection and reusable file facts", () => {
    const video = {
      instanceId: 17,
      name: "clip.mp4",
      dirname: "runs\\seed-1",
      createdMs: new Date("2025-01-02T03:04:05Z").getTime(),
      dimensions: {
        width: 1280,
        height: 720,
        durationMs: 62_000,
        frameRate: 29.97,
      },
      size: 1234,
    };

    expect(deriveMetadataSelectionCount(undefined, [video])).toBe(1);
    expect(deriveMetadataSelectionKey([video])).toBe("17");
    expect(deriveMetadataRelativePath(video)).toBe("runs/seed-1/clip.mp4");

    const info = deriveSingleSelectionInfo([video], 1);
    expect(info).toMatchObject({
      filename: "clip.mp4",
      relativePath: "runs/seed-1/clip.mp4",
      resolution: "1280×720",
      duration: "1:02",
      frameRate: "29.97 fps",
      sizeBytes: 1234,
    });
    expect(buildMetadataInfoLineItems(info)).toHaveLength(6);
    expect(
      buildMetadataInfoLineItems(info, { includeRelativePath: true }).map(
        ({ key }) => key
      )
    ).toEqual([
      "filename",
      "relative-path",
      "resolution",
      "frame-rate",
      "duration",
      "size",
      "created",
    ]);
  });

  // The scan attaches a toLocaleDateString string alongside the real
  // timestamp. Preferring the string meant re-parsing a localized display
  // value: "04/08/2026" is 4 August here and the Date constructor reads it
  // month-first as 8 April, and it carries no time, so the clock read
  // midnight for every clip in the library.
  it("reads the created date from the timestamp, not the formatted string", () => {
    const createdMs = new Date("2026-08-04T00:34:53").getTime();
    const info = deriveSingleSelectionInfo(
      [
        {
          name: "clip.mp4",
          createdMs,
          metadata: { dateCreatedFormatted: "04/08/2026" },
        },
      ],
      1
    );

    // Asserted against the same instant formatted the same way, rather than
    // against one locale's rendering of it. The first version of this test
    // matched /00:34:53/ and failed on CI, which runs en-US and writes that
    // instant as "12:34:53 AM" — a green suite here and a red one there, for
    // a value that was correct in both.
    const format = (date) =>
      new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);

    expect(info.created).toBe(format(new Date(createdMs)));
    // The regression, stated as the value it used to produce: "04/08/2026"
    // parsed month-first is 8 April at midnight, in any locale.
    expect(info.created).not.toBe(format(new Date("04/08/2026")));
  });

  it("still shows a formatted date when no timestamp came with the record", () => {
    const info = deriveSingleSelectionInfo(
      [{ name: "clip.mp4", metadata: { dateCreatedFormatted: "04/08/2026" } }],
      1
    );
    expect(info.created).toBe("04/08/2026");
  });

  it("derives shared/partial tags and bounded ranked suggestions", () => {
    expect(
      deriveMetadataTagSummary(
        [
          { tags: ["shared", "first"] },
          { tags: ["shared", "second"] },
        ],
        2
      )
    ).toEqual({
      sharedTags: ["shared"],
      partialTags: [
        { tag: "first", count: 1 },
        { tag: "second", count: 1 },
      ],
    });

    const availableTags = [
      { name: "shared", usageCount: 99 },
      { name: "dog", usageCount: 3 },
      { name: "dog", usageCount: 7 },
      { name: "doughnut", usageCount: 2 },
    ];
    expect(
      selectMetadataTagSuggestions({
        availableTags,
        sharedTags: ["shared"],
        query: "do",
      })
    ).toEqual([
      { name: "dog", usageCount: 7 },
      { name: "doughnut", usageCount: 2 },
    ]);
    expect(selectMetadataTagCompletion(availableTags, "do")).toBe("dog");
    expect(parseMetadataTagInput(" one, two ,, ")).toEqual(["one", "two"]);
  });

  it("normalizes supported generation fields for either metadata surface", () => {
    expect(
      buildGenerationMetadataFacts({
        seed: "42",
        models: ["wan2.2", "vae"],
        samplers: ["euler"],
        generationRun: "run-a",
        sourceImages: ["source.png"],
      })
    ).toEqual([
      { label: "Seed", value: "42" },
      { label: "Model", value: "wan2.2, vae" },
      { label: "Sampler", value: "euler" },
      { label: "Run", value: "run-a" },
      { label: "Source", value: "source.png" },
    ]);
  });
});
