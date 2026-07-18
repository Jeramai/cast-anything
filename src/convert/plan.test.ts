/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { assessForCast, buildConvertArgs, type MediaProbe } from "./plan";

const probe = (p: Partial<MediaProbe>): MediaProbe => ({
  container: "",
  videoCodec: null,
  audioCodec: null,
  durationSec: 0,
  ...p,
});

describe("assessForCast", () => {
  test("already TV-friendly MP4 (h264 + aac) → compatible, copies both streams", () => {
    const a = assessForCast(probe({ container: "mov,mp4,m4a", videoCodec: "h264", audioCodec: "aac" }));
    expect(a.compatible).toBe(true);
    expect(a.canConvert).toBe(true);
    expect(a.videoPlan).toBe("copy");
    // Regression: must NOT be 'none' — that emitted `-an` and stripped the audio.
    expect(a.audioPlan).toBe("copy");
  });

  test("compatible MP4 with no audio → audioPlan 'none'", () => {
    const a = assessForCast(probe({ container: "mp4", videoCodec: "h264", audioCodec: null }));
    expect(a.compatible).toBe(true);
    expect(a.audioPlan).toBe("none");
  });

  test("mkv + h264 + ac3 → remux video, transcode audio to AAC", () => {
    const a = assessForCast(probe({ container: "matroska,webm", videoCodec: "h264", audioCodec: "ac3" }));
    expect(a.compatible).toBe(false);
    expect(a.canConvert).toBe(true);
    expect(a.videoPlan).toBe("copy");
    expect(a.audioPlan).toBe("aac");
  });

  test("mkv + h264 + aac → just remux, copy audio", () => {
    const a = assessForCast(probe({ container: "matroska,webm", videoCodec: "h264", audioCodec: "aac" }));
    expect(a.canConvert).toBe(true);
    expect(a.videoPlan).toBe("copy");
    expect(a.audioPlan).toBe("copy");
  });

  test("1080p HEVC → re-encode to H.264, no downscale", () => {
    const a = assessForCast(
      probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac", width: 1920, height: 1080 }),
    );
    expect(a.canConvert).toBe(true);
    expect(a.videoPlan).toBe("reencode");
    expect(a.downscale).toBeFalsy();
    expect(a.audioPlan).toBe("copy");
  });

  test("4K HEVC → re-encode + downscale to 1080p", () => {
    const a = assessForCast(
      probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac", width: 3840, height: 2160 }),
    );
    expect(a.canConvert).toBe(true);
    expect(a.videoPlan).toBe("reencode");
    expect(a.downscale).toBe(true);
  });

  test("HEVC with AC-3 audio → re-encode video AND audio→AAC", () => {
    const a = assessForCast(
      probe({ container: "matroska", videoCodec: "hevc", audioCodec: "ac3", width: 1920, height: 1080 }),
    );
    expect(a.canConvert).toBe(true);
    expect(a.videoPlan).toBe("reencode");
    expect(a.audioPlan).toBe("aac");
  });

  test("VP9/WebM 720p → re-encode to H.264, no downscale", () => {
    const a = assessForCast(
      probe({ container: "matroska,webm", videoCodec: "vp9", audioCodec: "opus", width: 1280, height: 720 }),
    );
    expect(a.canConvert).toBe(true);
    expect(a.videoPlan).toBe("reencode");
    expect(a.downscale).toBeFalsy();
  });
});

describe("buildConvertArgs", () => {
  const copyPlan = assessForCast(probe({ container: "matroska", videoCodec: "h264", audioCodec: "aac" }));
  const aacPlan = assessForCast(probe({ container: "matroska", videoCodec: "h264", audioCodec: "ac3" }));
  const compatPlan = assessForCast(probe({ container: "mp4", videoCodec: "h264", audioCodec: "aac" }));
  const noAudioPlan = assessForCast(probe({ container: "mp4", videoCodec: "h264", audioCodec: null }));

  test("always copies video and writes faststart MP4", () => {
    const args = buildConvertArgs("in", "/out.mp4", copyPlan);
    expect(args.slice(0, 5)).toEqual(["-y", "-i", "in", "-c:v", "copy"]);
    expect(args.slice(-3)).toEqual(["-movflags", "+faststart", "/out.mp4"]);
  });

  test("audio copy plan → -c:a copy, never -an", () => {
    const args = buildConvertArgs("in", "/out.mp4", copyPlan);
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
    expect(args).not.toContain("-an");
  });

  test("compatible-with-audio plan keeps audio (regression: no -an)", () => {
    const args = buildConvertArgs("in", "/out.mp4", compatPlan);
    expect(args).not.toContain("-an");
    expect(args).toContain("copy");
  });

  test("aac plan → -c:a aac -b:a 192k", () => {
    const args = buildConvertArgs("in", "/out.mp4", aacPlan);
    expect(args.join(" ")).toContain("-c:a aac -b:a 192k");
  });

  test("no-audio plan → -an", () => {
    expect(buildConvertArgs("in", "/out.mp4", noAudioPlan)).toContain("-an");
  });

  test("software re-encode → libx264 + yuv420p, no HW accel, no scale @1080p", () => {
    const p = assessForCast(
      probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac", width: 1920, height: 1080 }),
    );
    const args = buildConvertArgs("in", "/out.mp4", p, { hwDecode: false, hwEncode: false });
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args.join(" ")).toContain("format=yuv420p");
    expect(args.join(" ")).not.toContain("scale=");
    expect(args).not.toContain("-hwaccel");
  });

  test("full-HW re-encode → -hwaccel mediacodec + h264_mediacodec + nv12 + bitrate", () => {
    const p = assessForCast(
      probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac", width: 1920, height: 1080 }),
    );
    const args = buildConvertArgs("in", "/out.mp4", p, { hwDecode: true, hwEncode: true });
    expect(args.slice(0, 3)).toEqual(["-y", "-hwaccel", "mediacodec"]);
    expect(args[args.indexOf("-c:v") + 1]).toBe("h264_mediacodec");
    expect(args).toContain("-b:v");
    expect(args.join(" ")).toContain("format=nv12");
  });

  test("4K re-encode → adds a downscale -vf scale filter (HW or SW)", () => {
    const p = assessForCast(
      probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac", width: 3840, height: 2160 }),
    );
    expect(buildConvertArgs("in", "/out.mp4", p, {}).join(" ")).toContain("scale=w=1920:h=1080");
    expect(
      buildConvertArgs("in", "/out.mp4", p, { hwDecode: true, hwEncode: true }).join(" "),
    ).toContain("scale=w=1920:h=1080");
  });

  const reencodePlan = assessForCast(
    probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac", width: 1920, height: 1080 }),
  );

  test("tuning: custom bitrate flows into the HW encoder -b:v", () => {
    const args = buildConvertArgs("in", "/out.mp4", reencodePlan, { hwEncode: true }, { bitRateMbps: 6 });
    expect(args[args.indexOf("-b:v") + 1]).toBe("6M");
  });

  test("tuning: default bitrate stays 8M when unspecified", () => {
    const args = buildConvertArgs("in", "/out.mp4", reencodePlan, { hwEncode: true });
    expect(args[args.indexOf("-b:v") + 1]).toBe("8M");
  });

  test("tuning: maxFps adds -r on a re-encode, before -movflags", () => {
    const args = buildConvertArgs("in", "/out.mp4", reencodePlan, { hwEncode: true }, { maxFps: 30 });
    expect(args[args.indexOf("-r") + 1]).toBe("30");
    // Still ends with the faststart output triplet (regression guard).
    expect(args.slice(-3)).toEqual(["-movflags", "+faststart", "/out.mp4"]);
  });

  test("tuning: maxFps is NOT applied to a remux (video copy has no frames to drop)", () => {
    const args = buildConvertArgs("in", "/out.mp4", copyPlan, {}, { maxFps: 30 });
    expect(args).not.toContain("-r");
  });

  test("tuning: maxFps 0 (keep source) adds no -r", () => {
    const args = buildConvertArgs("in", "/out.mp4", reencodePlan, { hwEncode: true }, { maxFps: 0 });
    expect(args).not.toContain("-r");
  });

  test("tuning: scaleTo emits a scale filter at the requested target (720p)", () => {
    const args = buildConvertArgs(
      "in",
      "/out.mp4",
      reencodePlan,
      { hwEncode: true },
      { scaleTo: { w: 1280, h: 720 } },
    );
    expect(args.join(" ")).toContain("scale=w=1280:h=720");
  });

  test("tuning: scaleTo overrides the default 1080p downscale on a 4K plan", () => {
    const p4k = assessForCast(
      probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac", width: 3840, height: 2160 }),
    );
    const joined = buildConvertArgs("in", "/out.mp4", p4k, { hwEncode: true }, { scaleTo: { w: 1280, h: 720 } }).join(
      " ",
    );
    expect(joined).toContain("scale=w=1280:h=720");
    expect(joined).not.toContain("scale=w=1920:h=1080");
  });

  test("tuning: no scaleTo on a non-4K reencode → no scale filter", () => {
    // reencodePlan is a 1080p source (downscale falsy); without scaleTo, no scaling.
    expect(buildConvertArgs("in", "/out.mp4", reencodePlan, { hwEncode: true }).join(" ")).not.toContain(
      "scale=",
    );
  });
});
