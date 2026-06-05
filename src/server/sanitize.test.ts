/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { sanitizeFileName } from "./sanitize";

describe("sanitizeFileName", () => {
  test("replaces unsafe characters and collapses runs to a single _", () => {
    expect(sanitizeFileName("My Movie (2024).mp4")).toBe("My_Movie_2024_.mp4");
  });

  test("preserves safe characters (alnum . _ -) and the extension", () => {
    expect(sanitizeFileName("clip-01_final.v2.mp4")).toBe("clip-01_final.v2.mp4");
  });

  test("trims leading/trailing separators", () => {
    expect(sanitizeFileName("***name***")).toBe("name");
  });

  test("output only ever contains safe characters", () => {
    expect(sanitizeFileName("ä/b\\c:d*e?\"f")).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  test("falls back to media-<timestamp> when nothing safe remains", () => {
    expect(sanitizeFileName("***")).toMatch(/^media-\d+$/);
    expect(sanitizeFileName("")).toMatch(/^media-\d+$/);
  });
});
