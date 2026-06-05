/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { isUnreachableByLan, parseUrl, resolveUrl } from "./url";

describe("parseUrl", () => {
  test("parses host, port, path and origin", () => {
    expect(parseUrl("http://192.168.1.5:9197/upnp/control?x=1")).toEqual({
      scheme: "http",
      host: "192.168.1.5",
      port: "9197",
      path: "/upnp/control",
      origin: "http://192.168.1.5:9197",
    });
  });

  test("https without explicit port", () => {
    const p = parseUrl("https://example.com/a/b");
    expect(p.scheme).toBe("https");
    expect(p.host).toBe("example.com");
    expect(p.port).toBe("");
    expect(p.path).toBe("/a/b");
    expect(p.origin).toBe("https://example.com");
  });

  test("defaults path to / when absent", () => {
    expect(parseUrl("http://host").path).toBe("/");
  });

  test("lowercases the scheme", () => {
    expect(parseUrl("HTTP://host/x").scheme).toBe("http");
  });

  test("returns empty parts for a non-URL", () => {
    expect(parseUrl("not a url")).toEqual({
      scheme: "http",
      host: "",
      port: "",
      path: "/",
      origin: "",
    });
  });
});

describe("resolveUrl", () => {
  test("returns an absolute ref unchanged", () => {
    expect(resolveUrl("http://h/a/", "https://other/x")).toBe("https://other/x");
  });

  test("resolves a root-relative ref against the origin", () => {
    expect(resolveUrl("http://h:9197/a/b.xml", "/AVTransport")).toBe(
      "http://h:9197/AVTransport",
    );
  });

  test("resolves a relative ref against the base directory", () => {
    expect(resolveUrl("http://h/a/desc.xml", "control.xml")).toBe(
      "http://h/a/control.xml",
    );
  });

  test("empty ref returns the base", () => {
    expect(resolveUrl("http://h/a", "")).toBe("http://h/a");
  });
});

describe("isUnreachableByLan", () => {
  test.each([
    "localhost",
    "0.0.0.0",
    "127.0.0.1",
    "169.254.1.2",
    "10.0.2.15",
    "10.0.2.16",
    "10.0.3.15",
  ])("treats %s as unreachable", (host) => {
    expect(isUnreachableByLan(host)).toBe(true);
  });

  test.each(["192.168.178.173", "10.0.0.5", "10.1.2.3", "172.16.0.4"])(
    "treats real LAN %s as reachable",
    (host) => {
      expect(isUnreachableByLan(host)).toBe(false);
    },
  );
});
