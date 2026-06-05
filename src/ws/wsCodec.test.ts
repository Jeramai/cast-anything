/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { Buffer } from "buffer";
import { acceptKey, encodeText, parseFrames, sha1Bytes } from "./wsCodec";

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");

describe("sha1Bytes", () => {
  test('matches the known digest of "abc"', () => {
    expect(hex(sha1Bytes([0x61, 0x62, 0x63]))).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });
  test("hashes the empty input", () => {
    expect(hex(sha1Bytes([]))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });
});

describe("acceptKey", () => {
  test("computes the RFC 6455 example accept key", () => {
    // From RFC 6455 §1.3.
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });
});

describe("encodeText", () => {
  test("short frame: 0x81, len, payload", () => {
    expect([...encodeText("hi")]).toEqual([0x81, 0x02, 0x68, 0x69]);
  });
  test("medium frame uses the 16-bit length header", () => {
    const frame = encodeText("x".repeat(130));
    expect([...frame.subarray(0, 4)]).toEqual([0x81, 126, 0, 130]);
    expect(frame.length).toBe(4 + 130);
  });

  test("large frame uses the 64-bit length header", () => {
    const n = 70000; // > 65535
    const frame = encodeText("y".repeat(n));
    expect([...frame.subarray(0, 2)]).toEqual([0x81, 127]);
    // low 4 bytes of the 64-bit length carry 70000 (0x00011170)
    expect([...frame.subarray(6, 10)]).toEqual([0x00, 0x01, 0x11, 0x70]);
    expect(frame.length).toBe(10 + n);
  });
});

// Build a masked client→server text frame (browsers always mask).
function clientTextFrame(text: string, mask = [0x01, 0x02, 0x03, 0x04]): Buffer {
  const payload = Buffer.from(text, "utf8");
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length, ...mask]), masked]);
}

describe("parseFrames", () => {
  test("unmasks a single text frame", () => {
    const frame = clientTextFrame("hello");
    const r = parseFrames(frame);
    expect(r.texts).toEqual(["hello"]);
    expect(r.closed).toBe(false);
    expect(r.consumed).toBe(frame.length);
  });

  test("parses multiple frames back to back", () => {
    const buf = Buffer.concat([clientTextFrame("a"), clientTextFrame("bc")]);
    const r = parseFrames(buf);
    expect(r.texts).toEqual(["a", "bc"]);
    expect(r.consumed).toBe(buf.length);
  });

  test("flags a close frame", () => {
    const close = Buffer.from([0x88, 0x80, 0, 0, 0, 0]);
    const r = parseFrames(close);
    expect(r.closed).toBe(true);
    expect(r.texts).toEqual([]);
  });

  test("leaves an incomplete frame unconsumed", () => {
    // Claims 5 payload bytes but only 2 are present.
    const partial = Buffer.from([0x81, 0x85, 1, 2, 3, 4, 0x10, 0x11]);
    const r = parseFrames(partial);
    expect(r.texts).toEqual([]);
    expect(r.consumed).toBe(0);
  });

  test("parses a frame using the extended 16-bit length", () => {
    const text = "z".repeat(200); // > 125 → 16-bit length path
    const payload = Buffer.from(text, "utf8");
    const mask = [9, 8, 7, 6];
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | 126, (200 >> 8) & 0xff, 200 & 0xff, ...mask]),
      masked,
    ]);
    const r = parseFrames(frame);
    expect(r.texts).toEqual([text]);
    expect(r.consumed).toBe(frame.length);
  });
});
