/// <reference types="bun-types" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import {
  castMedia,
  getCurrentTransportActions,
  getPositionInfo,
  getTransportInfo,
  getVolume,
  pause,
  play,
  seek,
  seekBytes,
  setVolume,
  stop,
} from "./avtransport";
import type { DlnaDevice } from "./types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The error-path tests deliberately exercise the module's own console diagnostics
// (SOAP fault warnings, inspectDevice) — keep the test output clean.
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

const dev = {
  friendlyName: "TV",
  avTransportControlURL: "http://tv:9197/ctrl",
  avTransportSCPDURL: "http://tv:9197/scpd.xml",
  renderingControlURL: "http://tv:9197/rc",
} as unknown as DlnaDevice;

type FakeRes = { ok: boolean; status: number; text: () => Promise<string> };
const res = (xml: string, ok = true, status = 200): FakeRes => ({ ok, status, text: async () => xml });

function setFetch(impl: (url: string, opts: any) => FakeRes | Promise<FakeRes>) {
  const m = mock(impl);
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

const action = (opts: any) => String(opts?.headers?.SOAPAction || "");

const envelope = (inner: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
const okEmpty = () => envelope('<u:Ok xmlns:u="x"/>');
const fault = (code: number, desc: string) =>
  envelope(
    `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>` +
      `<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
      `<errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault>`,
  );

describe("SOAP request building", () => {
  test("play() posts a Play action to the control URL", async () => {
    const m = setFetch(() => res(okEmpty()));
    await play(dev);
    expect(m).toHaveBeenCalledTimes(1);
    const [url, opts] = m.mock.calls[0] as [string, any];
    expect(url).toBe("http://tv:9197/ctrl");
    expect(opts.body).toContain("<u:Play");
    expect(action(opts)).toContain("AVTransport:1#Play");
  });

  test("seek() defaults to REL_TIME with an H:MM:SS target", async () => {
    const m = setFetch(() => res(okEmpty()));
    await seek(dev, 90);
    const [, opts] = m.mock.calls[0] as [string, any];
    expect(opts.body).toContain("<Unit>REL_TIME</Unit>");
    expect(opts.body).toContain("<Target>0:01:30</Target>");
  });

  test("seek() honors a custom unit (Samsung X_DLNA_SeekTime)", async () => {
    const m = setFetch(() => res(okEmpty()));
    await seek(dev, 5, "X_DLNA_SeekTime");
    const [, opts] = m.mock.calls[0] as [string, any];
    expect(opts.body).toContain("<Unit>X_DLNA_SeekTime</Unit>");
  });

  test("seekBytes() uses X_DLNA_SeekByte with a byte target", async () => {
    const m = setFetch(() => res(okEmpty()));
    await seekBytes(dev, 123456);
    const [, opts] = m.mock.calls[0] as [string, any];
    expect(opts.body).toContain("<Unit>X_DLNA_SeekByte</Unit>");
    expect(opts.body).toContain("<Target>123456</Target>");
  });

  test("pause() and stop() post their actions", async () => {
    const m = setFetch(() => res(okEmpty()));
    await pause(dev);
    await stop(dev);
    expect(action(m.mock.calls[0][1])).toContain("#Pause");
    expect(action(m.mock.calls[1][1])).toContain("#Stop");
  });
});

describe("SOAP response parsing", () => {
  test("getTransportInfo parses state + status", async () => {
    setFetch(() =>
      res(
        envelope(
          '<u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
            "<CurrentTransportState>PLAYING</CurrentTransportState>" +
            "<CurrentTransportStatus>OK</CurrentTransportStatus></u:GetTransportInfoResponse>",
        ),
      ),
    );
    expect(await getTransportInfo(dev)).toEqual({ state: "PLAYING", status: "OK" });
  });

  test("getPositionInfo converts H:MM:SS to seconds", async () => {
    setFetch(() =>
      res(
        envelope(
          '<u:GetPositionInfoResponse xmlns:u="x">' +
            "<TrackDuration>0:02:00</TrackDuration><RelTime>0:00:45</RelTime>" +
            "<TrackURI>http://tv/file.mp4</TrackURI></u:GetPositionInfoResponse>",
        ),
      ),
    );
    expect(await getPositionInfo(dev)).toEqual({
      duration: 120,
      position: 45,
      trackURI: "http://tv/file.mp4",
    });
  });

  test("getCurrentTransportActions returns the raw Actions string", async () => {
    setFetch(() =>
      res(envelope('<u:GetCurrentTransportActionsResponse xmlns:u="x"><Actions>Play,Pause,Seek</Actions></u:GetCurrentTransportActionsResponse>')),
    );
    expect(await getCurrentTransportActions(dev)).toBe("Play,Pause,Seek");
  });
});

describe("volume", () => {
  test("getVolume parses + clamps", async () => {
    setFetch(() => res(envelope('<u:GetVolumeResponse xmlns:u="x"><CurrentVolume>140</CurrentVolume></u:GetVolumeResponse>')));
    expect(await getVolume(dev)).toBe(100); // clamped to 0..100
  });

  test("getVolume returns null without a RenderingControl URL (no request)", async () => {
    const m = setFetch(() => res(okEmpty()));
    const noRc = { ...dev, renderingControlURL: undefined } as DlnaDevice;
    expect(await getVolume(noRc)).toBeNull();
    expect(m).toHaveBeenCalledTimes(0);
  });

  test("setVolume clamps + rounds the desired value", async () => {
    const m = setFetch(() => res(okEmpty()));
    await setVolume(dev, 33.6);
    const [, opts] = m.mock.calls[0] as [string, any];
    expect(opts.body).toContain("<DesiredVolume>34</DesiredVolume>");
  });
});

describe("UPnP fault handling", () => {
  test("throws with the code + description on a fault", async () => {
    setFetch(() => res(fault(716, "Resource not found"), false, 500));
    await expect(getTransportInfo(dev)).rejects.toThrow(/716/);
    setFetch(() => res(fault(716, "Resource not found"), false, 500));
    await expect(getTransportInfo(dev)).rejects.toThrow(/Resource not found/);
  });
});

describe("castMedia", () => {
  test("retries SetAVTransportURI with empty metadata on UPnP 402", async () => {
    let setUriCalls = 0;
    const m = setFetch((_url, opts) => {
      const a = action(opts);
      if (a.includes("SetAVTransportURI")) {
        setUriCalls += 1;
        return setUriCalls === 1 ? res(fault(402, "Invalid Args"), false, 500) : res(okEmpty());
      }
      return res(okEmpty()); // Play
    });

    await castMedia(dev, { url: "http://h/v.mp4", title: "V", kind: "video", mime: "video/mp4" });

    const setUri = m.mock.calls.filter((c) => action(c[1]).includes("SetAVTransportURI"));
    const plays = m.mock.calls.filter((c) => action(c[1]).includes("#Play"));
    expect(setUri.length).toBe(2);
    expect(plays.length).toBe(1);
    // First attempt carries DIDL metadata, the retry sends it empty.
    expect((setUri[0][1] as any).body).toContain("DIDL-Lite");
    expect((setUri[1][1] as any).body).toContain("<CurrentURIMetaData></CurrentURIMetaData>");
  });

  test("tolerates a 701 from Play (Samsung auto-plays on SetAVTransportURI)", async () => {
    setFetch((_url, opts) =>
      action(opts).includes("#Play")
        ? res(fault(701, "Transition not available"), false, 500)
        : res(okEmpty()),
    );
    // Should resolve, not throw.
    await expect(
      castMedia(dev, { url: "http://h/v.mp4", title: "V", kind: "video", mime: "video/mp4" }),
    ).resolves.toBeUndefined();
  });

  test("rethrows a non-402 SetAVTransportURI failure", async () => {
    setFetch((_url, opts) =>
      action(opts).includes("SetAVTransportURI")
        ? res(fault(714, "Unsupported media"), false, 500)
        : res(okEmpty()), // inspectDevice's diagnostics
    );
    await expect(
      castMedia(dev, { url: "http://h/v.mp4", title: "V", kind: "video", mime: "video/mp4" }),
    ).rejects.toThrow(/714/);
  });
});

describe("no AVTransport service", () => {
  test("play() rejects when the device has no AVTransport control URL", async () => {
    const noAv = { friendlyName: "X" } as unknown as DlnaDevice;
    await expect(play(noAv)).rejects.toThrow(/no AVTransport/);
  });
});

describe("fault without a description", () => {
  test("falls back to the built-in hint for a bare error code", async () => {
    // errorDescription is empty → the message uses UPNP_ERRORS[code] instead.
    setFetch(() => res(fault(701, ""), false, 500));
    await expect(getTransportInfo(dev)).rejects.toThrow(/Transition not available/);
  });
});

describe("post-cast diagnostic (inspectDevice)", () => {
  test("on a non-701 Play failure it rethrows AND runs the SCPD diagnostic", async () => {
    setFetch((url, opts) => {
      if (String(url).includes("scpd")) {
        return res(
          "<scpd><actionList>" +
            "<action><name>SetAVTransportURI</name></action>" +
            "<action><name>Play</name></action>" +
            "</actionList></scpd>",
        );
      }
      if (action(opts).includes("GetTransportInfo")) {
        return res(
          envelope(
            '<u:GetTransportInfoResponse xmlns:u="x">' +
              "<CurrentTransportState>STOPPED</CurrentTransportState>" +
              "<CurrentTransportStatus>OK</CurrentTransportStatus></u:GetTransportInfoResponse>",
          ),
        );
      }
      // Play fails with a non-701 fault → castMedia's Play catch rethrows (not the
      // 701-tolerate branch) → outer catch fires inspectDevice fire-and-forget.
      if (action(opts).includes("#Play")) return res(fault(714, "Unsupported"), false, 500);
      return res(okEmpty()); // SetAVTransportURI
    });
    await expect(
      castMedia(dev, { url: "http://h/v.mp4", title: "V", kind: "video", mime: "video/mp4" }),
    ).rejects.toThrow(/714/);
    // inspectDevice runs fire-and-forget from the catch — let its detached fetches settle.
    await new Promise((r) => setTimeout(r, 40));
  });
});

describe("post-cast diagnostic (inspectDevice) — inner failures", () => {
  test("swallows failures of its own GetTransportInfo + SCPD probes", async () => {
    setFetch((url, opts) => {
      // Everything the diagnostic touches fails → exercises both its catch blocks.
      if (String(url).includes("scpd")) throw new Error("network down");
      if (action(opts).includes("GetTransportInfo")) return res(fault(501, "Action failed"), false, 500);
      if (action(opts).includes("#Play")) return res(fault(714, "Unsupported"), false, 500);
      return res(okEmpty()); // SetAVTransportURI
    });
    await expect(
      castMedia(dev, { url: "http://h/v.mp4", title: "V", kind: "video", mime: "video/mp4" }),
    ).rejects.toThrow(/714/);
    await new Promise((r) => setTimeout(r, 40));
  });
});
