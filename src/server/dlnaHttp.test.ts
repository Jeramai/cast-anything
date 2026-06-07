/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
  npt,
  nptToSeconds,
  parseHttpHead,
  planResponse,
  type ServedFile,
} from "./dlnaHttp";

const FILE: ServedFile = {
  path: "/x.mp4",
  size: 1000,
  mime: "video/mp4",
  durationSec: 30,
  features: "DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000",
};
const DATE = "Sat, 07 Jun 2026 00:00:00 GMT";

describe("parseHttpHead", () => {
  test("parses method, path, and lower-cased headers", () => {
    const r = parseHttpHead(
      "GET /movie.mp4 HTTP/1.1\r\nHost: tv:51797\r\nRange: bytes=10-20\r\nTimeSeekRange.dlna.org: npt=5-",
    );
    expect(r.method).toBe("GET");
    expect(r.path).toBe("/movie.mp4");
    expect(r.headers["range"]).toBe("bytes=10-20");
    expect(r.headers["timeseekrange.dlna.org"]).toBe("npt=5-");
  });
});

describe("nptToSeconds / npt", () => {
  test("parses plain seconds and clock form", () => {
    expect(nptToSeconds("84.000")).toBe(84);
    expect(nptToSeconds("0:01:24.000")).toBe(84);
    expect(nptToSeconds("1:00:00")).toBe(3600);
  });
  test("npt formats to 3 decimals and clamps negatives", () => {
    expect(npt(84)).toBe("84.000");
    expect(npt(-5)).toBe("0.000");
  });
});

describe("planResponse", () => {
  test("404 for no file or non GET/HEAD", () => {
    expect(planResponse({ method: "GET", path: "/", headers: {} }, null, DATE).status).toBe("404 Not Found");
    expect(
      planResponse({ method: "POST", path: "/", headers: {} }, FILE, DATE).status,
    ).toBe("404 Not Found");
  });

  test("full GET → 200 with DLNA headers and full length", () => {
    const p = planResponse({ method: "GET", path: "/x", headers: {} }, FILE, DATE);
    expect(p.status).toBe("200 OK");
    expect(p.hasBody).toBe(true);
    expect(p.start).toBe(0);
    expect(p.end).toBe(999);
    expect(p.headers["Content-Length"]).toBe("1000");
    expect(p.headers["Date"]).toBe(DATE);
    expect(p.headers["Accept-Ranges"]).toBe("bytes");
    expect(p.headers["contentFeatures.dlna.org"]).toBe(FILE.features);
  });

  test("HEAD computes headers but has no body", () => {
    const p = planResponse({ method: "HEAD", path: "/x", headers: {} }, FILE, DATE);
    expect(p.status).toBe("200 OK");
    expect(p.hasBody).toBe(false);
    expect(p.headers["Content-Length"]).toBe("1000");
  });

  test("byte Range → 206 with Content-Range", () => {
    const open = planResponse(
      { method: "GET", path: "/x", headers: { range: "bytes=100-" } },
      FILE,
      DATE,
    );
    expect(open.status).toBe("206 Partial Content");
    expect(open.start).toBe(100);
    expect(open.end).toBe(999);
    expect(open.headers["Content-Range"]).toBe("bytes 100-999/1000");
    expect(open.headers["Content-Length"]).toBe("900");

    const closed = planResponse(
      { method: "GET", path: "/x", headers: { range: "bytes=0-99" } },
      FILE,
      DATE,
    );
    expect(closed.end).toBe(99);
    expect(closed.headers["Content-Length"]).toBe("100");
  });

  test("unsatisfiable Range → 416", () => {
    const p = planResponse(
      { method: "GET", path: "/x", headers: { range: "bytes=5000-" } },
      FILE,
      DATE,
    );
    expect(p.status).toBe("416 Range Not Satisfiable");
    expect(p.hasBody).toBe(false);
    expect(p.headers["Content-Range"]).toBe("bytes */1000");
  });

  test("TimeSeekRange maps npt time → byte offset", () => {
    const p = planResponse(
      { method: "GET", path: "/x", headers: { "timeseekrange.dlna.org": "npt=15-" } },
      FILE,
      DATE,
    );
    expect(p.status).toBe("206 Partial Content");
    expect(p.start).toBe(500); // 1000 * 15/30
    expect(p.end).toBe(999);
    expect(p.headers["Content-Range"]).toBe("bytes 500-999/1000");
    expect(p.headers["TimeSeekRange.dlna.org"]).toBe(
      "npt=15.000-30.000/30.000 bytes=500-999/1000",
    );
  });

  test("TimeSeekRange ignored when duration unknown (falls back to full)", () => {
    const p = planResponse(
      { method: "GET", path: "/x", headers: { "timeseekrange.dlna.org": "npt=15-" } },
      { ...FILE, durationSec: 0 },
      DATE,
    );
    expect(p.status).toBe("200 OK");
    expect(p.headers["TimeSeekRange.dlna.org"]).toBeUndefined();
  });
});
