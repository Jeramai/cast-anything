/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { buildDidlMetadata, contentFeatures, hmsToSeconds, secondsToHms } from "./avtransport";

describe("secondsToHms", () => {
  test("formats H:MM:SS", () => {
    expect(secondsToHms(0)).toBe("0:00:00");
    expect(secondsToHms(75)).toBe("0:01:15");
    expect(secondsToHms(3661)).toBe("1:01:01");
  });
  test("floors fractional seconds and clamps negatives", () => {
    expect(secondsToHms(22.9)).toBe("0:00:22");
    expect(secondsToHms(-5)).toBe("0:00:00");
  });
});

describe("hmsToSeconds", () => {
  test("parses H:MM:SS", () => {
    expect(hmsToSeconds("1:01:01")).toBe(3661);
    expect(hmsToSeconds("0:01:15")).toBe(75);
  });
  test("pads short forms to the right", () => {
    expect(hmsToSeconds("5:30")).toBe(330); // m:ss
  });
  test("floors fractional seconds", () => {
    expect(hmsToSeconds("0:00:22.500")).toBe(22);
  });
  test("returns 0 for NOT_IMPLEMENTED / garbage / empty", () => {
    expect(hmsToSeconds("NOT_IMPLEMENTED")).toBe(0);
    expect(hmsToSeconds("garbage")).toBe(0);
    expect(hmsToSeconds("")).toBe(0);
  });
  test("round-trips with secondsToHms", () => {
    for (const s of [0, 1, 59, 60, 3599, 3600, 7384]) {
      expect(hmsToSeconds(secondsToHms(s))).toBe(s);
    }
  });
});

describe("buildDidlMetadata", () => {
  test("video advertises both time + byte seek (OP=11) and the video class", () => {
    const xml = buildDidlMetadata({
      url: "http://h/v.mp4",
      title: "Clip",
      kind: "video",
      mime: "video/mp4",
    });
    expect(xml).toContain("DLNA.ORG_OP=11");
    expect(xml).toContain("object.item.videoItem");
    expect(xml).toContain("http-get:*:video/mp4:");
    expect(xml).toContain("<dc:title>Clip</dc:title>");
  });

  test("audio uses the music-track class", () => {
    const xml = buildDidlMetadata({ url: "http://h/a.mp3", title: "Song", kind: "audio", mime: "audio/mpeg" });
    expect(xml).toContain("object.item.audioItem.musicTrack");
    expect(xml).toContain("DLNA.ORG_OP=11");
  });

  test("image is non-seekable (OP=00) with the photo class", () => {
    const xml = buildDidlMetadata({ url: "http://h/p.jpg", title: "Pic", kind: "image", mime: "image/jpeg" });
    expect(xml).toContain("DLNA.ORG_OP=00");
    expect(xml).toContain("object.item.imageItem.photo");
    expect(xml).not.toContain("DLNA.ORG_OP=11");
  });

  test("escapes XML in the title and url", () => {
    const xml = buildDidlMetadata({
      url: "http://h/a.mp4?a=1&b=2",
      title: 'Tom & "Jerry" <fun>',
      kind: "video",
      mime: "video/mp4",
    });
    expect(xml).toContain("Tom &amp; &quot;Jerry&quot; &lt;fun&gt;");
    expect(xml).toContain("a=1&amp;b=2");
    expect(xml).not.toContain("Tom & ");
  });

  test("adds size + duration attributes on the res when provided (enables seeking)", () => {
    const xml = buildDidlMetadata({
      url: "http://h/a.mp4",
      title: "Clip",
      kind: "video",
      mime: "video/mp4",
      size: 12345,
      durationSec: 84,
    });
    expect(xml).toContain('size="12345"');
    expect(xml).toContain('duration="0:01:24"');
  });

  test("adds a subtitle res + Samsung sec:CaptionInfo when a subtitleUrl is given", () => {
    const xml = buildDidlMetadata({
      url: "http://h/a.mp4",
      title: "Clip",
      kind: "video",
      mime: "video/mp4",
      subtitleUrl: "http://h/subtitle.srt",
    });
    expect(xml).toContain('xmlns:sec="http://www.sec.co.kr/"');
    expect(xml).toContain('<res protocolInfo="http-get:*:text/srt:*">http://h/subtitle.srt</res>');
    expect(xml).toContain('<sec:CaptionInfoEx sec:type="srt">http://h/subtitle.srt</sec:CaptionInfoEx>');
  });

  test("does not add subtitle elements for non-video or when absent", () => {
    const noSub = buildDidlMetadata({ url: "http://h/a.mp4", title: "C", kind: "video", mime: "video/mp4" });
    expect(noSub).not.toContain("CaptionInfo");
    const img = buildDidlMetadata({
      url: "http://h/p.jpg",
      title: "P",
      kind: "image",
      mime: "image/jpeg",
      subtitleUrl: "http://h/subtitle.srt",
    });
    expect(img).not.toContain("CaptionInfo");
  });

  test("omits size/duration when absent, and never adds duration to an image", () => {
    const noMeta = buildDidlMetadata({ url: "http://h/a.mp4", title: "C", kind: "video", mime: "video/mp4" });
    expect(noMeta).not.toContain("size=");
    expect(noMeta).not.toContain("duration=");
    const img = buildDidlMetadata({
      url: "http://h/p.jpg",
      title: "P",
      kind: "image",
      mime: "image/jpeg",
      durationSec: 84,
    });
    expect(img).not.toContain("duration=");
  });
});

describe("contentFeatures", () => {
  test("video/audio advertise both seek modes (OP=11)", () => {
    expect(contentFeatures("video")).toContain("DLNA.ORG_OP=11");
    expect(contentFeatures("audio")).toContain("DLNA.ORG_OP=11");
  });
  test("image is non-seekable (OP=00)", () => {
    expect(contentFeatures("image")).toContain("DLNA.ORG_OP=00");
  });
});
