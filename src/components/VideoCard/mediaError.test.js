import { describe, test, expect } from "vitest";
import { classifyMediaError } from "./mediaError";

describe("classifyMediaError", () => {
  test("code 4 → terminal unsupported", () => {
    expect(classifyMediaError({ code: 4 }).terminal).toBe(true);
  });

  test("file not found message → terminal", () => {
    expect(classifyMediaError(new Error("ERR_FILE_NOT_FOUND")).terminal).toBe(true);
  });

  test("decode error → terminal", () => {
    expect(classifyMediaError({ code: 3, message: "Demuxer: failed to parse" }).terminal).toBe(true);
  });

  test("aborted → transient", () => {
    expect(classifyMediaError({ code: 1, message: "aborted" }).terminal).toBe(false);
  });

  test("network → transient", () => {
    expect(classifyMediaError({ code: 2, message: "network" }).terminal).toBe(false);
  });

  test("unknown → transient by default", () => {
    expect(classifyMediaError({ message: "weird" }).terminal).toBe(false);
  });
});
