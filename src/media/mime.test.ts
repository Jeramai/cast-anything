/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { extensionOf, guessMime, kindFromMime, mediaFromUrl } from "./mime";

describe("extensionOf", () => {
  test("lowercases and strips query/hash", () => {
    expect(extensionOf("movie.MP4?token=abc#t=10")).toBe("mp4");
  });
  test("uses the last dot", () => {
    expect(extensionOf("my.video.final.mkv")).toBe("mkv");
  });
  test("empty when no extension", () => {
    expect(extensionOf("noext")).toBe("");
  });
});

describe("kindFromMime", () => {
  test("audio/* → audio", () => expect(kindFromMime("audio/mpeg")).toBe("audio"));
  test("image/* → image", () => expect(kindFromMime("image/png")).toBe("image"));
  test("video/* → video", () => expect(kindFromMime("video/mp4")).toBe("video"));
  test("unknown → video (default)", () => expect(kindFromMime("application/x")).toBe("video"));
});

describe("guessMime", () => {
  test("trusts an explicit, non-octet mime", () => {
    expect(guessMime("x.mp4", "audio/flac")).toBe("audio/flac");
  });
  test("ignores application/octet-stream and uses the extension", () => {
    expect(guessMime("song.mp3", "application/octet-stream")).toBe("audio/mpeg");
  });
  test("infers from extension when no explicit mime", () => {
    expect(guessMime("photo.jpeg")).toBe("image/jpeg");
    expect(guessMime("clip.mkv")).toBe("video/x-matroska");
  });
  test("falls back to video/mp4 for unknown extensions", () => {
    expect(guessMime("mystery.xyz")).toBe("video/mp4");
  });
});

describe("mediaFromUrl", () => {
  test("derives name, mime and kind for a remote URL", () => {
    const m = mediaFromUrl("  https://cdn.example.com/clips/trailer.mp4?sig=1 ");
    expect(m.uri).toBe("https://cdn.example.com/clips/trailer.mp4?sig=1");
    expect(m.name).toBe("trailer.mp4");
    expect(m.mime).toBe("video/mp4");
    expect(m.kind).toBe("video");
    expect(m.isLocal).toBe(false);
  });
  test("URL-decodes the filename", () => {
    expect(mediaFromUrl("http://h/My%20Song.mp3").name).toBe("My Song.mp3");
  });
  test("falls back to 'Stream' when there's no filename", () => {
    expect(mediaFromUrl("http://h/").name).toBe("Stream");
  });
});
