import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseComfyGraphJson, stringifyComfyGraphJson } = require("../comfy-graph-json");

describe("comfy graph JSON", () => {
  it("round-trips integers beyond 2^53 as the same digits", () => {
    const text = '{"3":{"inputs":{"seed":18446744073709551615,"neg":-9007199254740993,"cfg":1.5,"steps":35}}}';
    const graph = parseComfyGraphJson(text);
    expect(graph["3"].inputs.seed).toBe(18446744073709551615n);
    expect(graph["3"].inputs.steps).toBe(35);
    expect(stringifyComfyGraphJson(graph)).toBe(text);
  });

  it("reads Python's non-finite numbers as null, leaving strings alone", () => {
    const graph = parseComfyGraphJson('{"1":{"inputs":{"a":NaN,"b":-Infinity,"text":"NaN"},"is_changed":[NaN]}}');
    expect(graph["1"]).toEqual({ inputs: { a: null, b: null, text: "NaN" }, is_changed: [null] });
  });

  it("reports invalid JSON with the strict parser's error", () => {
    expect(() => parseComfyGraphJson("{nope")).toThrow(SyntaxError);
  });
});
