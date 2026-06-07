/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { downloadSubtitle, searchSubtitles } from "./subdl";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string) => { ok?: boolean; status?: number; json?: any; bytes?: Uint8Array }) {
  globalThis.fetch = (async (url: string) => {
    const r = handler(String(url));
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer,
    } as Response;
  }) as typeof fetch;
}

describe("searchSubtitles", () => {
  test("requires a key and maps results", async () => {
    await expect(searchSubtitles("", "movie", "en")).rejects.toThrow(/API key/);

    mockFetch((url) => {
      expect(url).toContain("film_name=movie");
      expect(url).toContain("languages=EN");
      return {
        json: {
          status: true,
          subtitles: [
            { url: "/subtitle/1-2.zip", language: "EN", release_name: "Movie.1080p" },
            { language: "EN", release_name: "no-url" }, // skipped (no url)
          ],
        },
      };
    });
    expect(await searchSubtitles("key", "movie", "en")).toEqual([
      { url: "/subtitle/1-2.zip", language: "EN", release: "Movie.1080p" },
    ]);
  });

  test("surfaces an API error and a non-ok response", async () => {
    mockFetch(() => ({ json: { status: false, error: "no results" } }));
    await expect(searchSubtitles("key", "x", "en")).rejects.toThrow(/no results/);
    mockFetch(() => ({ ok: false, status: 500 }));
    await expect(searchSubtitles("key", "x", "en")).rejects.toThrow(/500/);
  });
});

describe("downloadSubtitle", () => {
  test("downloads the zip and returns the .srt inside", async () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
    const zip = zipSync({ "Movie.srt": new TextEncoder().encode(srt), "readme.txt": new Uint8Array([1]) });
    mockFetch((url) => {
      expect(url).toBe("https://dl.subdl.com/subtitle/1-2.zip");
      return { bytes: zip };
    });
    expect(await downloadSubtitle("/subtitle/1-2.zip")).toBe(srt);
  });

  test("throws when the archive has no subtitle", async () => {
    const zip = zipSync({ "readme.txt": new Uint8Array([1]) });
    mockFetch(() => ({ bytes: zip }));
    await expect(downloadSubtitle("/subtitle/x.zip")).rejects.toThrow(/no subtitle/i);
  });
});
