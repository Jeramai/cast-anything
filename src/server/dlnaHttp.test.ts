/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
  npt,
  nptToSeconds,
  parseHttpHead,
  pickReadySegment,
  pickStaleSegments,
  planLiveResponse,
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

const LIVE = {
  mime: "video/mp2t",
  features: "DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8d500000000000000000000000000000",
};

describe("planLiveResponse", () => {
  test("404 when there is no live source or wrong method", () => {
    expect(planLiveResponse({ method: "GET", path: "/live.ts", headers: {} }, null, DATE).status).toBe(
      "404 Not Found",
    );
    expect(planLiveResponse({ method: "POST", path: "/live.ts", headers: {} }, LIVE, DATE).status).toBe(
      "404 Not Found",
    );
  });

  test("GET streams with no Content-Length / Accept-Ranges and the live features", () => {
    const p = planLiveResponse({ method: "GET", path: "/live.ts", headers: {} }, LIVE, DATE);
    expect(p.status).toBe("200 OK");
    expect(p.hasBody).toBe(true);
    expect(p.headers["Content-Type"]).toBe("video/mp2t");
    expect(p.headers["contentFeatures.dlna.org"]).toBe(LIVE.features);
    expect(p.headers["transferMode.dlna.org"]).toBe("Streaming");
    expect(p.headers["Content-Length"]).toBeUndefined();
    expect(p.headers["Accept-Ranges"]).toBeUndefined();
  });

  test("HEAD returns headers but no body", () => {
    const p = planLiveResponse({ method: "HEAD", path: "/live.ts", headers: {} }, LIVE, DATE);
    expect(p.status).toBe("200 OK");
    expect(p.hasBody).toBe(false);
  });
});

describe("pickReadySegment", () => {
  const names = ["seg000000.ts", "seg000001.ts", "seg000002.ts"];

  test("while running, holds back the highest (in-progress) segment", () => {
    // seg2 is being written, so the newest complete one is seg1.
    expect(pickReadySegment(names, -1, true)).toEqual({ name: "seg000000.ts", index: 0 });
    expect(pickReadySegment(names, 0, true)).toEqual({ name: "seg000001.ts", index: 1 });
    // Only the in-progress segment is newer than what we've served → nothing ready.
    expect(pickReadySegment(names, 1, true)).toBeNull();
  });

  test("once stopped, the final segment is also served", () => {
    expect(pickReadySegment(names, 1, false)).toEqual({ name: "seg000002.ts", index: 2 });
  });

  test("ignores non-segment files and returns null when nothing is newer", () => {
    expect(pickReadySegment(["index.html", "seg000005.ts"], 5, false)).toBeNull();
    expect(pickReadySegment([], -1, true)).toBeNull();
  });
});

describe("pickStaleSegments (rolling retention)", () => {
  const seg = (i: number) => `seg${String(i).padStart(6, "0")}.ts`;

  test("keeps everything while within the retention window", () => {
    expect(pickStaleSegments([seg(0), seg(1), seg(2)], 8, true)).toEqual([]);
  });

  test("deletes segments older than newest-retain, but NEVER seg0 when pinned", () => {
    const names = Array.from({ length: 13 }, (_, i) => seg(i)); // seg0..seg12
    // newest=12, retain=8 → stale are 0<idx<4 → seg1..seg3 (seg0 pinned).
    expect(pickStaleSegments(names, 8, true)).toEqual([seg(1), seg(2), seg(3)]);
  });

  test("pins seg0 no matter how far the stream has advanced", () => {
    const names = [seg(0), seg(100), seg(101), seg(102)];
    expect(pickStaleSegments(names, 2, true)).not.toContain(seg(0));
  });

  test("without the pin (HLS remux), seg0 ages out of the window like any other", () => {
    const names = [seg(0), seg(100), seg(101), seg(102)];
    expect(pickStaleSegments(names, 2, false)).toEqual([seg(0)]);
  });

  test("ignores non-segment files and handles empty dirs", () => {
    expect(pickStaleSegments(["index.html", "current.json"], 4, true)).toEqual([]);
    expect(pickStaleSegments([], 4, false)).toEqual([]);
  });
});
