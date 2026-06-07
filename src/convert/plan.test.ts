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

  test("non-H.264 video (HEVC) → cannot convert (needs re-encode)", () => {
    const a = assessForCast(probe({ container: "matroska", videoCodec: "hevc", audioCodec: "aac" }));
    expect(a.canConvert).toBe(false);
    expect(a.videoPlan).toBe("reencode");
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
});
