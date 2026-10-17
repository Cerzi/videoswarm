import { act, renderHook } from "@testing-library/react";
import {
  normalizeStackSimilarity,
  promptKeyCounts,
  useSimilarPromptGroups,
} from "./useSimilarPromptGroups";

const key = (n) => `pk2-${n.toString(16).padStart(32, "0")}`;
const clip = (id, promptKey) => ({ id, promptKey });

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

describe("promptKeyCounts and normalizeStackSimilarity", () => {
  it("counts clips per prompt key in key order", () => {
    expect(
      promptKeyCounts([clip("a", key(2)), clip("b", key(1)), clip("c", key(2)), clip("d", null)])
    ).toEqual([
      { promptKey: key(1), count: 1 },
      { promptKey: key(2), count: 2 },
    ]);
  });

  it("keeps known levels and falls back to the default", () => {
    expect(normalizeStackSimilarity(0.9)).toBe(0.9);
    expect(normalizeStackSimilarity(1)).toBe(1);
    expect(normalizeStackSimilarity(0.5)).toBe(0.8);
    expect(normalizeStackSimilarity(undefined)).toBe(0.8);
  });
});

describe("useSimilarPromptGroups", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  const videos = [clip("a", key(1)), clip("b", key(1)), clip("c", key(2))];

  it("sends keys and counts, maps keys to their anchors, and asks again only on change", async () => {
    const similarGroups = vi.fn(async () => ({
      success: true,
      groups: { [key(2)]: key(1) },
    }));
    window.electronAPI = { stacks: { similarGroups } };
    const { result, rerender } = renderHook((props) => useSimilarPromptGroups(props), {
      initialProps: { videos, enabled: true, similarity: 0.8 },
    });
    expect(result.current(key(2))).toBeUndefined();
    await settle();
    expect(similarGroups).toHaveBeenCalledWith({
      entries: [
        { promptKey: key(1), count: 2 },
        { promptKey: key(2), count: 1 },
      ],
      threshold: 0.8,
    });
    expect(result.current(key(2))).toBe(key(1));
    expect(result.current(key(1))).toBeUndefined();

    rerender({ videos: videos.map((video) => ({ ...video, tags: ["x"] })), enabled: true, similarity: 0.8 });
    await settle();
    expect(similarGroups).toHaveBeenCalledTimes(1);

    rerender({ videos, enabled: true, similarity: 0.7 });
    await settle();
    expect(similarGroups).toHaveBeenCalledTimes(2);
    expect(similarGroups.mock.calls[1][0].threshold).toBe(0.7);
  });

  it("stacks exactly when off, exact, or main cannot answer", async () => {
    const similarGroups = vi.fn(async () => ({ success: false, error: "no" }));
    window.electronAPI = { stacks: { similarGroups } };
    const { result, rerender } = renderHook((props) => useSimilarPromptGroups(props), {
      initialProps: { videos, enabled: false, similarity: 0.8 },
    });
    await settle();
    rerender({ videos, enabled: true, similarity: 1 });
    await settle();
    expect(similarGroups).not.toHaveBeenCalled();

    rerender({ videos, enabled: true, similarity: 0.8 });
    await settle();
    expect(similarGroups).toHaveBeenCalledTimes(1);
    expect(result.current(key(2))).toBeUndefined();
  });

  it("drops an answer for a collection that has since changed", async () => {
    const resolvers = [];
    const similarGroups = vi.fn(
      () => new Promise((resolve) => resolvers.push(resolve))
    );
    window.electronAPI = { stacks: { similarGroups } };
    const { result, rerender } = renderHook((props) => useSimilarPromptGroups(props), {
      initialProps: { videos, enabled: true, similarity: 0.8 },
    });
    await settle();
    rerender({ videos: [...videos, clip("d", key(3))], enabled: true, similarity: 0.8 });
    await settle();
    expect(similarGroups).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvers[0]({ success: true, groups: { [key(2)]: key(1) } });
      await Promise.resolve();
    });
    expect(result.current(key(2))).toBeUndefined();
    await act(async () => {
      resolvers[1]({ success: true, groups: { [key(3)]: key(1) } });
      await Promise.resolve();
    });
    expect(result.current(key(3))).toBe(key(1));
  });
});
