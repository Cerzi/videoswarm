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
      dimensions: { width: 1280, height: 720 },
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
      sizeBytes: 1234,
    });
    expect(buildMetadataInfoLineItems(info)).toHaveLength(4);
    expect(
      buildMetadataInfoLineItems(info, { includeRelativePath: true }).map(
        ({ key }) => key
      )
    ).toEqual(["filename", "relative-path", "resolution", "size", "created"]);
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
