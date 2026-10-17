import { act, renderHook } from "@testing-library/react";
import { normalizeStackSimilarity, promptKeysOf, useSimilarPrompts } from "./useSimilarPrompts";

const key = (n) => `pk2-${n.toString(16).padStart(32, "0")}`;
const clip = (id, promptKey) => ({ id, promptKey });

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

describe("promptKeysOf and normalizeStackSimilarity", () => {
  it("lists distinct prompt keys in key order", () => {
    expect(promptKeysOf([clip("a", key(2)), clip("b", key(1)), clip("c", key(2)), clip("d", null)])).toEqual([
      key(1),
      key(2),
    ]);
  });

  it("keeps known levels and falls back to the default", () => {
    expect(normalizeStackSimilarity(0.9)).toBe(0.9);
    expect(normalizeStackSimilarity(1)).toBe(1);
    expect(normalizeStackSimilarity(0.5)).toBe(0.8);
    expect(normalizeStackSimilarity(undefined)).toBe(0.8);
  });
});

describe("useSimilarPrompts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  const videos = [clip("a", key(1)), clip("b", key(1)), clip("c", key(2))];

  it("asks for the collection's keys and answers which are alike, asking again only on change", async () => {
    const similarPrompts = vi.fn(async () => ({
      success: true,
      alike: { [key(1)]: [key(2)], [key(2)]: [key(1)] },
    }));
    window.electronAPI = { stacks: { similarPrompts } };
    const { result, rerender } = renderHook((props) => useSimilarPrompts(props), {
      initialProps: { videos, enabled: true, similarity: 0.8 },
    });
    expect(result.current(key(1), key(2))).toBe(false);
    await settle();
    expect(similarPrompts).toHaveBeenCalledWith({ promptKeys: [key(1), key(2)], threshold: 0.8 });
    expect(result.current(key(1), key(2))).toBe(true);
    expect(result.current(key(3), key(3))).toBe(true);
    expect(result.current(key(1), key(3))).toBe(false);

    rerender({ videos: videos.map((video) => ({ ...video, tags: ["x"] })), enabled: true, similarity: 0.8 });
    await settle();
    expect(similarPrompts).toHaveBeenCalledTimes(1);

    rerender({ videos, enabled: true, similarity: 0.7 });
    await settle();
    expect(similarPrompts).toHaveBeenCalledTimes(2);
    expect(similarPrompts.mock.calls[1][0].threshold).toBe(0.7);
  });

  it("matches exactly when off, exact, or main cannot answer", async () => {
    const similarPrompts = vi.fn(async () => ({ success: false, error: "no" }));
    window.electronAPI = { stacks: { similarPrompts } };
    const { result, rerender } = renderHook((props) => useSimilarPrompts(props), {
      initialProps: { videos, enabled: false, similarity: 0.8 },
    });
    await settle();
    rerender({ videos, enabled: true, similarity: 1 });
    await settle();
    expect(similarPrompts).not.toHaveBeenCalled();

    rerender({ videos, enabled: true, similarity: 0.8 });
    await settle();
    expect(similarPrompts).toHaveBeenCalledTimes(1);
    expect(result.current(key(1), key(2))).toBe(false);
  });

  it("drops an answer for a collection that has since changed", async () => {
    const resolvers = [];
    const similarPrompts = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    window.electronAPI = { stacks: { similarPrompts } };
    const { result, rerender } = renderHook((props) => useSimilarPrompts(props), {
      initialProps: { videos, enabled: true, similarity: 0.8 },
    });
    await settle();
    rerender({ videos: [...videos, clip("d", key(3))], enabled: true, similarity: 0.8 });
    await settle();
    expect(similarPrompts).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvers[0]({ success: true, alike: { [key(1)]: [key(2)] } });
      await Promise.resolve();
    });
    expect(result.current(key(1), key(2))).toBe(false);
    await act(async () => {
      resolvers[1]({ success: true, alike: { [key(3)]: [key(1)] } });
      await Promise.resolve();
    });
    expect(result.current(key(3), key(1))).toBe(true);
  });
});
