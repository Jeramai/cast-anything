/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { Buffer } from "buffer";
import {
  buildPacket,
  decodeLauncherUrl,
  MDC_CMD,
  parseResponse,
  SUB_URL_ADDRESS,
  type MdcResponse,
} from "./mdcProtocol";

describe("buildPacket", () => {
  test("frames [0xAA, cmd, id, len, ...data, checksum]", () => {
    // checksum = (0x14 + 0 + 1 + 0x63) & 0xff = 0x78
    expect([...buildPacket(MDC_CMD.INPUT_SOURCE, 0, [0x63])]).toEqual([
      0xaa, 0x14, 0x00, 0x01, 0x63, 0x78,
    ]);
  });

  test("empty data → zero checksum", () => {
    expect([...buildPacket(MDC_CMD.STATUS, 0, [])]).toEqual([0xaa, 0x00, 0x00, 0x00, 0x00]);
  });

  test("checksum wraps at 0xff (header byte excluded)", () => {
    const pkt = buildPacket(0xc7, 0x00, [0xff, 0xff]);
    // (0xc7 + 0 + 2 + 0xff + 0xff) & 0xff = (199 + 2 + 510) & 255 = 711 & 255 = 199 = 0xc7
    expect(pkt[pkt.length - 1]).toBe(0xc7);
  });
});

describe("parseResponse", () => {
  test("parses an ACK with payload", () => {
    // [AA FF id len=3 ack=A rcmd=0x14 data=0x63 checksum]
    const r = parseResponse(Buffer.from([0xaa, 0xff, 0x00, 0x03, 0x41, 0x14, 0x63, 0x00]));
    expect(r.ok).toBe(true);
    expect(r.ack).toBe("A");
    expect(r.rcmd).toBe(0x14);
    expect([...r.data]).toEqual([0x63]);
  });

  test("flags a NAK as not ok", () => {
    const r = parseResponse(Buffer.from([0xaa, 0xff, 0x00, 0x02, 0x4e, 0x14, 0x00]));
    expect(r.ok).toBe(false);
    expect(r.ack).toBe("N");
  });

  test("rejects a malformed header", () => {
    const r = parseResponse(Buffer.from([0x00, 0x01, 0x02]));
    expect(r.ok).toBe(false);
    expect(r.ack).toBe("?");
    expect(r.data.length).toBe(0);
  });
});

describe("decodeLauncherUrl", () => {
  const mk = (bytes: number[]): MdcResponse => ({
    ok: true,
    ack: "A",
    rcmd: 0xc7,
    data: Uint8Array.from(bytes),
    raw: new Uint8Array(),
  });

  test("strips the 0x82 sub-command and trailing NULs", () => {
    const url = "http://192.168.1.9:51799";
    const bytes = [SUB_URL_ADDRESS, ...Buffer.from(url, "ascii"), 0, 0];
    expect(decodeLauncherUrl(mk(bytes))).toBe(url);
  });

  test("handles data without the leading sub-command", () => {
    expect(decodeLauncherUrl(mk([...Buffer.from("http://x", "ascii")]))).toBe("http://x");
  });
});
