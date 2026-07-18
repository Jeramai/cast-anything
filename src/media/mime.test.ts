/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
  extensionOf,
  guessMime,
  isHlsMime,
  isKnownMediaExtension,
  kindFromMime,
  mediaFromUrl,
  mediaItemFromSafUri,
  fileNameFromSafUri,
  HLS_MIME,
} from "./mime";

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
  test("flags an .m3u8 URL as a live HLS stream", () => {
    const m = mediaFromUrl("https://cdn.example.com/game/index.m3u8?token=abc");
    expect(m.mime).toBe(HLS_MIME);
    expect(m.kind).toBe("video");
    expect(m.live).toBe(true);
    expect(m.isLocal).toBe(false);
  });
  test("detects HLS even without a clean .m3u8 extension", () => {
    expect(mediaFromUrl("https://h/live/playlist.m3u8/chunklist").live).toBe(true);
  });
  test("a regular mp4 URL is not live", () => {
    expect(mediaFromUrl("https://h/clip.mp4").live).toBe(false);
  });
});

describe("isHlsMime", () => {
  test("true for the apple mpegurl mimes", () => {
    expect(isHlsMime("application/vnd.apple.mpegurl")).toBe(true);
    expect(isHlsMime("application/x-mpegURL")).toBe(true);
  });
  test("false for plain video mimes", () => {
    expect(isHlsMime("video/mp4")).toBe(false);
  });
});

describe("isKnownMediaExtension", () => {
  test("true for recognized media extensions", () => {
    expect(isKnownMediaExtension("clip.mkv")).toBe(true);
    expect(isKnownMediaExtension("song.mp3")).toBe(true);
    expect(isKnownMediaExtension("pic.JPG")).toBe(true);
  });
  test("false for non-media / extensionless", () => {
    expect(isKnownMediaExtension("notes.txt")).toBe(false);
    expect(isKnownMediaExtension("subfolder")).toBe(false);
    expect(isKnownMediaExtension("archive.zip")).toBe(false);
  });
});

describe("fileNameFromSafUri", () => {
  test("decodes the file name from a SAF document URI", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3AMovies/document/primary%3AMovies%2FAvatar%2Fep1.mkv";
    expect(fileNameFromSafUri(uri)).toBe("ep1.mkv");
  });
  test("strips the volume prefix from a root-level document id", () => {
    expect(fileNameFromSafUri("content://x/document/primary%3Aclip.mp4")).toBe("clip.mp4");
    expect(fileNameFromSafUri("content://x/document/1D04-2A08%3Asong.mp3")).toBe("song.mp3");
  });
  test("preserves colons that are part of the file name", () => {
    const uri = "content://x/document/primary%3AMovies%2F12%3A30 recording.mp4";
    expect(fileNameFromSafUri(uri)).toBe("12:30 recording.mp4");
  });
});

describe("mediaItemFromSafUri", () => {
  const uri = (docId: string) =>
    `content://com.android.externalstorage.documents/tree/primary%3AMovies/document/${encodeURIComponent(docId)}`;

  test("builds a MediaItem for a media file, keeping the content:// uri", () => {
    const raw = uri("primary:Movies/ep1.mkv");
    const item = mediaItemFromSafUri(raw);
    expect(item).not.toBeNull();
    expect(item?.uri).toBe(raw); // uri passed through untouched (pipeline handles content://)
    expect(item?.name).toBe("ep1.mkv");
    expect(item?.mime).toBe("video/x-matroska");
    expect(item?.kind).toBe("video");
    expect(item?.isLocal).toBe(true);
  });

  test("returns null for a non-media file (skipped in a folder scan)", () => {
    expect(mediaItemFromSafUri(uri("primary:Movies/readme.txt"))).toBeNull();
  });

  test("returns null for a subdirectory (no media extension)", () => {
    expect(mediaItemFromSafUri(uri("primary:Movies/Season 2"))).toBeNull();
  });

  test("classifies audio and image children by extension", () => {
    expect(mediaItemFromSafUri(uri("primary:M/track.flac"))?.kind).toBe("audio");
    expect(mediaItemFromSafUri(uri("primary:M/poster.png"))?.kind).toBe("image");
  });
});
