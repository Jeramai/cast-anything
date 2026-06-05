/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchDevice } from "./device";
import type { SsdpHit } from "./types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type FakeRes = { ok: boolean; status: number; text: () => Promise<string> };
function mockFetch(xml: string, ok = true) {
  globalThis.fetch = mock(async () => ({ ok, status: ok ? 200 : 404, text: async () => xml }) as FakeRes) as unknown as typeof fetch;
}
function mockFetchThrows() {
  globalThis.fetch = mock(async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

const hit = (over: Partial<SsdpHit> = {}): SsdpHit => ({
  location: "http://192.168.1.5:9197/desc.xml",
  st: "",
  usn: "uuid:abc-123::urn:schemas-upnp-org:device:MediaRenderer:1",
  address: "192.168.1.5",
  ...over,
});

const deviceXml = (opts: {
  urlBase?: string;
  friendlyName?: string;
  manufacturer?: string;
  modelName?: string;
  avControl?: string;
  withRendering?: boolean;
  embedded?: boolean;
}) => {
  const av = opts.avControl ?? "/upnp/control/AVTransport1";
  const avService = `<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>${av}</controlURL><SCPDURL>/AVTransport_1.xml</SCPDURL></service>`;
  const rcService = opts.withRendering
    ? `<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/upnp/control/RenderingControl1</controlURL></service>`
    : "";
  const inner =
    `<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>` +
    `<friendlyName>${opts.friendlyName ?? "Living Room TV"}</friendlyName>` +
    `<manufacturer>${opts.manufacturer ?? "Samsung Electronics"}</manufacturer>` +
    (opts.modelName ? `<modelName>${opts.modelName}</modelName>` : "");
  const services = `<serviceList>${avService}${rcService}</serviceList>`;
  const device = opts.embedded
    ? `<device>${inner}<deviceList><device><deviceType>x</deviceType>${services}</device></deviceList></device>`
    : `<device>${inner}${services}</device>`;
  return (
    `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">` +
    (opts.urlBase ? `<URLBase>${opts.urlBase}</URLBase>` : "") +
    device +
    `</root>`
  );
};

describe("fetchDevice", () => {
  test("parses a renderer and resolves control URLs against URLBase", async () => {
    mockFetch(deviceXml({ urlBase: "http://192.168.1.5:9197/", withRendering: true }));
    const d = await fetchDevice(hit());
    expect(d).not.toBeNull();
    expect(d!.avTransportControlURL).toBe("http://192.168.1.5:9197/upnp/control/AVTransport1");
    expect(d!.avTransportSCPDURL).toBe("http://192.168.1.5:9197/AVTransport_1.xml");
    expect(d!.renderingControlURL).toBe("http://192.168.1.5:9197/upnp/control/RenderingControl1");
    expect(d!.id).toBe("abc-123");
    expect(d!.address).toBe("192.168.1.5");
    expect(d!.isSamsung).toBe(true);
    expect(d!.isSignage).toBe(false);
  });

  test("resolves control URLs against the description URL when no URLBase", async () => {
    mockFetch(deviceXml({ avControl: "/ctrl/av" }));
    const d = await fetchDevice(hit({ location: "http://10.0.0.9:8200/dev/desc.xml" }));
    expect(d!.avTransportControlURL).toBe("http://10.0.0.9:8200/ctrl/av");
  });

  test("resolves a path-relative control URL against the base directory", async () => {
    mockFetch(deviceXml({ avControl: "ctrl/av" }));
    const d = await fetchDevice(hit({ location: "http://h/dev/desc.xml" }));
    expect(d!.avTransportControlURL).toBe("http://h/dev/ctrl/av");
  });

  test("finds services on an embedded sub-device", async () => {
    mockFetch(deviceXml({ embedded: true, urlBase: "http://h:9197/" }));
    const d = await fetchDevice(hit());
    expect(d!.avTransportControlURL).toBe("http://h:9197/upnp/control/AVTransport1");
  });

  test("detects signage by friendlyName / modelName", async () => {
    mockFetch(deviceXml({ friendlyName: "QMR Signage Panel", modelName: "QM55R" }));
    const d = await fetchDevice(hit());
    expect(d!.isSignage).toBe(true);
  });

  test("non-Samsung manufacturer is not flagged Samsung", async () => {
    mockFetch(deviceXml({ manufacturer: "Sony", friendlyName: "Bravia" }));
    const d = await fetchDevice(hit());
    expect(d!.isSamsung).toBe(false);
  });

  test("id falls back to the location when USN has no uuid", async () => {
    mockFetch(deviceXml({ urlBase: "http://h/" }));
    const d = await fetchDevice(hit({ usn: "no-uuid-here" }));
    expect(d!.id).toBe("http://192.168.1.5:9197/desc.xml");
  });

  test("returns null when there is no AVTransport service", async () => {
    const xml =
      `<?xml version="1.0"?><root><device><friendlyName>Speaker</friendlyName>` +
      `<serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>` +
      `<controlURL>/rc</controlURL></service></serviceList></device></root>`;
    mockFetch(xml);
    expect(await fetchDevice(hit())).toBeNull();
  });

  test("returns null on HTTP error, network error, and unparseable body", async () => {
    mockFetch("whatever", false);
    expect(await fetchDevice(hit())).toBeNull();
    mockFetchThrows();
    expect(await fetchDevice(hit())).toBeNull();
    mockFetch("<root><device>"); // malformed / no closing — no usable device
    expect(await fetchDevice(hit())).toBeNull();
  });
});
