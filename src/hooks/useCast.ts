import { useCallback, useEffect, useRef, useState } from 'react';
import {
  castMedia,
  discoverDevices,
  getPositionInfo,
  getTransportInfo,
  pause,
  play,
  seek,
  setVolume,
  stop,
  type DlnaDevice,
  type TransportState,
} from '../dlna';
import { isUnreachableByLan, parseUrl } from '../dlna/url';
import { shareLocalFile, writePlayerPage } from '../server/fileServer';
import { startWsServer, wsSendControl } from '../ws/wsServer';
import { castToSignage, type SignageCastResult } from '../signage/castSignage';

export interface SignageSetup {
  /** URL to enter on the panel's URL Launcher. */
  url: string;
  /** False if this is an emulator/loopback address the panel can't reach. */
  reachable: boolean;
}

export interface SignageControls {
  /** True when the panel has an open WebSocket to the phone. */
  connected: boolean;
  playing: boolean;
  /** Current playback position (seconds), reported by the panel. */
  position: number;
  /** Track duration (seconds), reported by the panel. */
  duration: number;
  play: () => void;
  pause: () => void;
  seek: (delta: number) => void;
  seekTo: (seconds: number) => void;
}
import {
  mediaFromUrl,
  pickMedia,
  type MediaItem,
} from '../media/media';

const SCAN_MS = 6000;
const POLL_MS = 1500;

export type PlaybackStatus = TransportState | 'IDLE';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface UseCast {
  devices: DlnaDevice[];
  isScanning: boolean;
  selectedDevice: DlnaDevice | null;
  media: MediaItem | null;
  status: PlaybackStatus;
  position: number;
  duration: number;
  busy: boolean;
  error: string | null;
  signage: SignageCastResult | null;
  signageSetup: SignageSetup | null;
  signageControls: SignageControls;
  scan: () => void;
  selectDevice: (d: DlnaDevice) => void;
  chooseFile: () => Promise<void>;
  chooseUrl: (url: string) => void;
  clearMedia: () => void;
  cast: () => Promise<void>;
  onPlay: () => Promise<void>;
  onPause: () => Promise<void>;
  onStop: () => Promise<void>;
  onSeek: (seconds: number) => Promise<void>;
  onVolume: (volume: number) => Promise<void>;
  dismissError: () => void;
  dismissSignage: () => void;
}

export function useCast(): UseCast {
  const [devices, setDevices] = useState<DlnaDevice[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<DlnaDevice | null>(null);
  const [media, setMedia] = useState<MediaItem | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>('IDLE');
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signage, setSignage] = useState<SignageCastResult | null>(null);
  const [signageSetup, setSignageSetup] = useState<SignageSetup | null>(null);
  const [sigPlaying, setSigPlaying] = useState(true);
  const [sigPosition, setSigPosition] = useState(0);
  const [sigDuration, setSigDuration] = useState(0);
  const [sigConnected, setSigConnected] = useState(false);

  const discoveryRef = useRef<{ stop: () => void } | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (device: DlnaDevice) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const [transport, pos] = await Promise.all([
            getTransportInfo(device),
            getPositionInfo(device),
          ]);
          setStatus(transport.state);
          setPosition(pos.position);
          setDuration(pos.duration);
          if (
            transport.state === 'STOPPED' ||
            transport.state === 'NO_MEDIA_PRESENT'
          ) {
            stopPolling();
          }
        } catch {
          /* transient network blip; keep polling */
        }
      }, POLL_MS);
    },
    [stopPolling],
  );

  const scan = useCallback(() => {
    discoveryRef.current?.stop();
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    setDevices([]);
    setError(null);
    setIsScanning(true);

    discoveryRef.current = discoverDevices({
      timeoutMs: SCAN_MS,
      onDevice: (device) => {
        setDevices((prev) =>
          prev.some((d) => d.id === device.id) ? prev : [...prev, device],
        );
      },
      onError: (err) => setError(errMessage(err)),
    });

    scanTimerRef.current = setTimeout(() => setIsScanning(false), SCAN_MS);
  }, []);

  const selectDevice = useCallback((d: DlnaDevice) => {
    setSelectedDevice(d);
  }, []);

  const chooseFile = useCallback(async () => {
    setError(null);
    try {
      const item = await pickMedia();
      if (item) setMedia(item);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);

  const chooseUrl = useCallback((url: string) => {
    if (!url.trim()) return;
    setError(null);
    setMedia(mediaFromUrl(url));
  }, []);

  const clearMedia = useCallback(() => setMedia(null), []);

  const cast = useCallback(async () => {
    if (!selectedDevice) {
      setError('Pick a TV / device first.');
      return;
    }
    if (!media) {
      setError('Choose a file or enter a URL first.');
      return;
    }
    setBusy(true);
    setError(null);
    setSignage(null);

    // Samsung signage panels don't accept DLNA push — drive them over MDC.
    if (selectedDevice.isSignage) {
      try {
        setSignage(await castToSignage(selectedDevice.address, media));
        setStatus('IDLE');
      } catch (e) {
        setError(errMessage(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    try {
      const url = media.isLocal
        ? await shareLocalFile(media.uri, media.name)
        : media.uri;

      console.log('[DLNA] casting', {
        url,
        mime: media.mime,
        kind: media.kind,
        device: selectedDevice.friendlyName,
        control: selectedDevice.avTransportControlURL,
      });

      if (media.isLocal) {
        // An emulator's NAT address (or loopback) is reachable by this app but
        // NOT by the TV, so local-file casting can't work there.
        const { host } = parseUrl(url);
        if (isUnreachableByLan(host)) {
          throw new Error(
            `The TV can't reach this device at ${host}. You're likely on an ` +
              `emulator — run on a physical phone on the same Wi-Fi as the TV ` +
              `(or cast a public URL instead of a local file).`,
          );
        }
        // Confirm the phone is actually serving the file before involving the TV.
        try {
          const probe = await fetch(url, { method: 'HEAD' });
          if (!probe.ok) {
            console.warn('[DLNA] file server HEAD', probe.status, url);
          }
        } catch (e) {
          throw new Error(
            `The phone's media server isn't reachable at ${url} ` +
              `(${errMessage(e)}). Casting can't continue.`,
          );
        }
      }

      await castMedia(selectedDevice, {
        url,
        title: media.name,
        kind: media.kind,
        mime: media.mime,
      });
      setStatus('PLAYING');
      setPosition(0);
      setDuration(0);
      startPolling(selectedDevice);
    } catch (e) {
      const msg = errMessage(e);
      // DLNA push rejected (UPnP 402) — the device may be signage we didn't
      // flag. Fall back to the MDC / URL Launcher path.
      if (/\b402\b/.test(msg) && selectedDevice.address) {
        try {
          setSignage(await castToSignage(selectedDevice.address, media));
          setStatus('IDLE');
          return;
        } catch (e2) {
          setError(
            `DLNA push was rejected and the signage fallback failed: ${errMessage(e2)}`,
          );
          return;
        }
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [selectedDevice, media, startPolling]);

  const runAction = useCallback(
    async (fn: (device: DlnaDevice) => Promise<void>) => {
      if (!selectedDevice) return;
      setBusy(true);
      setError(null);
      try {
        await fn(selectedDevice);
      } catch (e) {
        setError(errMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [selectedDevice],
  );

  const onPlay = useCallback(
    () =>
      runAction(async (d) => {
        await play(d);
        setStatus('PLAYING');
        startPolling(d);
      }),
    [runAction, startPolling],
  );

  const onPause = useCallback(
    () =>
      runAction(async (d) => {
        await pause(d);
        setStatus('PAUSED_PLAYBACK');
        stopPolling();
      }),
    [runAction, stopPolling],
  );

  const onStop = useCallback(
    () =>
      runAction(async (d) => {
        await stop(d);
        setStatus('STOPPED');
        setPosition(0);
        stopPolling();
      }),
    [runAction, stopPolling],
  );

  const onSeek = useCallback(
    (seconds: number) =>
      runAction(async (d) => {
        await seek(d, seconds);
        setPosition(seconds);
      }),
    [runAction],
  );

  const onVolume = useCallback(
    (volume: number) => runAction((d) => setVolume(d, volume)),
    [runAction],
  );

  const dismissError = useCallback(() => setError(null), []);
  const dismissSignage = useCallback(() => setSignage(null), []);

  // Controls are pushed instantly over the WebSocket. Optimistic local state is
  // corrected by the status the panel streams back.
  const sigPlay = useCallback(() => {
    setSigPlaying(true);
    wsSendControl('play');
  }, []);
  const sigPause = useCallback(() => {
    setSigPlaying(false);
    wsSendControl('pause');
  }, []);
  const sigSeek = useCallback((delta: number) => wsSendControl('seekBy', delta), []);
  const sigSeekTo = useCallback((seconds: number) => {
    setSigPosition(seconds);
    wsSendControl('seekTo', seconds);
  }, []);

  // When a signage panel is selected, bring up the player page + the WebSocket
  // server immediately, so the setup URL is ready and the panel can connect
  // before the first cast.
  useEffect(() => {
    let cancelled = false;
    if (!selectedDevice?.isSignage) {
      setSignageSetup(null);
      return;
    }
    startWsServer({
      onStatus: (msg) => {
        if (cancelled || msg?.type !== 'status') return;
        setSigPlaying(msg.state === 'playing');
        if (typeof msg.position === 'number') setSigPosition(msg.position);
        if (typeof msg.duration === 'number') setSigDuration(msg.duration);
      },
      onClientsChange: (count) => {
        if (!cancelled) setSigConnected(count > 0);
      },
    }).catch(() => {});
    writePlayerPage()
      .then((url) => {
        if (!cancelled) {
          setSignageSetup({ url, reachable: !isUnreachableByLan(parseUrl(url).host) });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDevice]);

  useEffect(() => {
    return () => {
      discoveryRef.current?.stop();
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return {
    devices,
    isScanning,
    selectedDevice,
    media,
    status,
    position,
    duration,
    busy,
    error,
    signage,
    signageSetup,
    signageControls: {
      connected: sigConnected,
      playing: sigPlaying,
      position: sigPosition,
      duration: sigDuration,
      play: sigPlay,
      pause: sigPause,
      seek: sigSeek,
      seekTo: sigSeekTo,
    },
    scan,
    selectDevice,
    chooseFile,
    chooseUrl,
    clearMedia,
    cast,
    onPlay,
    onPause,
    onStop,
    onSeek,
    onVolume,
    dismissError,
    dismissSignage,
  };
}
