/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { SUBTITLE_MIME_TYPES, isSubtitleFile } from "./subtitleTypes";

describe("isSubtitleFile", () => {
  test("accepts known subtitle extensions, case-insensitively", () => {
    for (const name of ["movie.srt", "Movie.SRT", "ep01.vtt", "x.ass", "x.ssa", "x.sub"]) {
      expect(isSubtitleFile(name)).toBe(true);
    }
  });

  test("rejects non-subtitle and extension-less files", () => {
    for (const name of ["movie.mp4", "notes.txt", "image.png", "archive.zip", "README", ""]) {
      expect(isSubtitleFile(name)).toBe(false);
    }
  });

  test("matches only the final extension", () => {
    expect(isSubtitleFile("subtitle.srt.txt")).toBe(false);
    expect(isSubtitleFile("my.movie.en.srt")).toBe(true);
  });

  test("offers broad text MIME types so unregistered .srt stays selectable", () => {
    expect(SUBTITLE_MIME_TYPES).toContain("application/x-subrip");
    expect(SUBTITLE_MIME_TYPES).toContain("text/plain");
  });
});
