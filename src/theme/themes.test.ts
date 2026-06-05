/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
  ACCENTS,
  BASES,
  composePalette,
  hexToRgb,
  mix,
  resolveBaseKey,
} from "./themes";

describe("hexToRgb / mix", () => {
  test("parses hex", () => {
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#4f8cff")).toEqual([79, 140, 255]);
  });
  test("mixing a color with itself is a no-op", () => {
    expect(mix("#102030", "#102030", 0.5)).toBe("#102030");
  });
  test("midpoint of black and white is grey", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  test("always returns a 7-char hex", () => {
    expect(mix("#010203", "#040506", 0.33)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("composePalette", () => {
  test("combines a base with an accent + derived accentDim", () => {
    const p = composePalette("dark", "blue");
    expect(p.bg).toBe("#0b0f17");
    expect(p.accent).toBe("#4f8cff");
    expect(p.isDark).toBe(true);
    expect(p.danger).toBe("#ff5d6c");
    expect(p.good).toBe("#3ddc97");
    // accentDim = mix(card #151b27, accent #4f8cff, 0.22)
    expect(p.accentDim).toBe("#223457");
  });

  test("light base reports isDark false", () => {
    const p = composePalette("light", "rose");
    expect(p.isDark).toBe(false);
    expect(p.bg).toBe("#eef1f6");
    expect(p.accent).toBe("#fb7185");
  });

  test("unknown keys fall back to the first base + accent", () => {
    const p = composePalette("does-not-exist", "nope");
    expect(p.bg).toBe(BASES[0].bg);
    expect(p.accent).toBe(ACCENTS[0].color);
  });

  test("every base × accent combo yields valid hex colors", () => {
    for (const b of BASES) {
      for (const a of ACCENTS) {
        const p = composePalette(b.key, a.key);
        expect(p.accentDim).toMatch(/^#[0-9a-f]{6}$/);
        expect(p.accent).toBe(a.color);
        expect(p.isDark).toBe(b.isDark);
      }
    }
  });
});

describe("resolveBaseKey", () => {
  test("system follows the OS scheme", () => {
    expect(resolveBaseKey("system", true)).toBe("dark");
    expect(resolveBaseKey("system", false)).toBe("light");
  });
  test("concrete keys pass through untouched", () => {
    expect(resolveBaseKey("amoled", true)).toBe("amoled");
    expect(resolveBaseKey("sepia", false)).toBe("sepia");
  });
});
