import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { replaceNonFiniteJsonTokens } = require("../json-non-finite");

describe("replaceNonFiniteJsonTokens", () => {
  it("turns Python's non-finite tokens into null outside strings", () => {
    const source = '{"a":NaN,"b":[NaN, Infinity,-Infinity],"c":{"d":-Infinity}}';
    expect(JSON.parse(replaceNonFiniteJsonTokens(source))).toEqual({
      a: null,
      b: [null, null, null],
      c: { d: null },
    });
  });

  it("leaves string contents alone, including escaped quotes", () => {
    const source =
      '{"text":"NaN and Infinity are words","tricky":"a \\"NaN\\" -Infinity","n":NaN}';
    expect(JSON.parse(replaceNonFiniteJsonTokens(source))).toEqual({
      text: "NaN and Infinity are words",
      tricky: 'a "NaN" -Infinity',
      n: null,
    });
  });

  it("returns well-formed JSON unchanged and tolerates odd input", () => {
    const valid = '{"seed":18446744073709551615,"x":-1.5e3,"s":"ok"}';
    expect(replaceNonFiniteJsonTokens(valid)).toBe(valid);
    expect(replaceNonFiniteJsonTokens("")).toBe("");
    expect(replaceNonFiniteJsonTokens(null)).toBe("");
    expect(replaceNonFiniteJsonTokens('"unterminated NaN')).toBe('"unterminated NaN');
  });
});
