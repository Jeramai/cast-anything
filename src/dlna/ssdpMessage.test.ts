/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { buildMSearch, parseSsdpHeaders } from "./ssdpMessage";

describe("buildMSearch", () => {
  const msg = buildMSearch("ssdp:all");

  test("is a CRLF-terminated M-SEARCH ending in a blank line", () => {
    expect(msg.startsWith("M-SEARCH * HTTP/1.1\r\n")).toBe(true);
    expect(msg.endsWith("\r\n\r\n")).toBe(true);
  });

  test("includes the required SSDP headers", () => {
    expect(msg).toContain("HOST: 239.255.255.250:1900\r\n");
    expect(msg).toContain('MAN: "ssdp:discover"\r\n');
    expect(msg).toContain("ST: ssdp:all\r\n");
    expect(msg).toContain("MX: 2\r\n");
  });

  test("honors a custom MX", () => {
    expect(buildMSearch("x", 5)).toContain("MX: 5\r\n");
  });
});

describe("parseSsdpHeaders", () => {
  test("lowercases keys, trims values, keeps colons in the value", () => {
    const raw =
      "HTTP/1.1 200 OK\r\n" +
      "LOCATION: http://192.168.1.5:9197/desc.xml\r\n" +
      "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n" +
      "USN: uuid:abc::urn:x\r\n" +
      "SERVER: Linux/4 UPnP/1.0\r\n\r\n";
    const h = parseSsdpHeaders(raw);
    expect(h.location).toBe("http://192.168.1.5:9197/desc.xml");
    expect(h.st).toBe("urn:schemas-upnp-org:device:MediaRenderer:1");
    expect(h.usn).toBe("uuid:abc::urn:x");
    expect(h.server).toBe("Linux/4 UPnP/1.0");
    // The status line (no colon) is ignored.
    expect(Object.keys(h)).not.toContain("http/1.1 200 ok");
  });

  test("returns {} for an empty / header-less message", () => {
    expect(parseSsdpHeaders("")).toEqual({});
  });
});
