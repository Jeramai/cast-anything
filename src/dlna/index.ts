import { discoverSsdp, type DiscoveryHandle } from './ssdp';
import { fetchDevice } from './device';
import type { DlnaDevice } from './types';

export * from './types';
export * from './avtransport';
export { discoverSsdp } from './ssdp';
export { fetchDevice } from './device';

/**
 * Discover castable DLNA renderers on the LAN. For each SSDP responder we fetch
 * and parse its description; only devices with an AVTransport service are
 * reported (de-duped by id). Returns a handle to stop discovery early.
 */
export function discoverDevices(opts: {
  timeoutMs?: number;
  onDevice: (device: DlnaDevice) => void;
  onError?: (err: Error) => void;
}): DiscoveryHandle {
  const reported = new Set<string>();

  return discoverSsdp({
    timeoutMs: opts.timeoutMs,
    onError: opts.onError,
    onHit: (hit) => {
      // Fire-and-forget: descriptions are fetched concurrently as hits arrive.
      fetchDevice(hit)
        .then((device) => {
          if (!device || reported.has(device.id)) return;
          reported.add(device.id);
          opts.onDevice(device);
        })
        .catch((err) => opts.onError?.(err as Error));
    },
  });
}
