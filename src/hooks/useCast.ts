import { useCallback, useEffect, useRef, useState } from 'react';
import {
  castMedia,
  discoverDevices,
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
  type DlnaDevice,
  type TransportState,
} from '../dlna';
import { isUnreachableByLan, parseUrl } from '../dlna/url';
import {
  addTransportCommandListener,
  presentKeepAlive,
  stopKeepAlive,
  type PlaybackInfo,
  type TransportAction,
} from '../background/keepAlive';
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
/** One notch per press, like a TV remote (0–100 scale). */
const VOLUME_STEP = 1;

// Devices that rejected every seek mode (e.g. Samsung "The Freestyle" advertises
// Seek but its renderer refuses it for pushed content). Remembered by device id
// so we hide the seek controls from the first cast next time, not just after a
// failed attempt. Cleared if a seek ever succeeds.
const seekUnsupportedDevices = new Set<string>();

export type PlaybackStatus = TransportState | 'IDLE';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface UseCast {
  devices: DlnaDevice[];
  isScanning: boolean;
  selectedDevice: DlnaDevice | null;
  /** The current selection (what a Cast press will send). */
  media: MediaItem | null;
  /** What's actually on the TV right now (snapshot from the last cast). */
  nowPlaying: MediaItem | null;
  /** True while the picked file is being imported (copied) by the OS picker. */
  importing: boolean;
  status: PlaybackStatus;
  position: number;
  duration: number;
  /** False once the selected device has refused every seek mode (e.g. Samsung
   * "The Freestyle" — it advertises Seek but its renderer won't honor it). */
  seekSupported: boolean;
  /** Last known device volume (0–100), or null if not read / unsupported. */
  volume: number | null;
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
  /** Step the device volume by `delta` notches (±) on the 0–100 scale. */
  onVolumeStep: (delta: number) => Promise<void>;
  dismissError: () => void;
  dismissSignage: () => void;
}

export function useCast(): UseCast {
  const [devices, setDevices] = useState<DlnaDevice[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<DlnaDevice | null>(null);
  const [media, setMedia] = useState<MediaItem | null>(null);
  // What's actually on the TV — a snapshot taken when a cast succeeds. Kept
  // separate from `media` (the current selection) so picking a new file doesn't
  // make "Now playing" / the notification show something the TV isn't playing.
  const [nowPlaying, setNowPlaying] = useState<MediaItem | null>(null);
  const [importing, setImporting] = useState(false);
  // Bumped on each successful seek so the playback notification re-syncs its
  // timeline (we otherwise let the MediaSession extrapolate, ignoring polls).
  const [seekNonce, setSeekNonce] = useState(0);
  const [status, setStatus] = useState<PlaybackStatus>('IDLE');
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState<number | null>(null);
  const [seekSupported, setSeekSupported] = useState(true);
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
  // Mirror of `status` for callbacks that need the latest value without being
  // re-created (e.g. onSeek deciding whether to resume after a pause-seek).
  const statusRef = useRef<PlaybackStatus>('IDLE');
  statusRef.current = status;

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
    setVol(null); // volume is per-device; re-read on next cast
    setSeekSupported(!seekUnsupportedDevices.has(d.id));
  }, []);

  const chooseFile = useCallback(async () => {
    setError(null);
    // The OS picker copies the chosen file into our cache before resolving; for
    // a multi-GB file that takes a while (it runs natively, so the app stays
    // responsive — but show a spinner so it doesn't look dead).
    setImporting(true);
    try {
      const item = await pickMedia();
      if (item) setMedia(item);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setImporting(false);
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
        setNowPlaying(media);
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
      setNowPlaying(media);
      setStatus('PLAYING');
      setPosition(0);
      setDuration(0);
      setSeekSupported(!seekUnsupportedDevices.has(selectedDevice.id));
      startPolling(selectedDevice);
      // Photos have no volume; only sync it for audio/video.
      if (media.kind !== 'image') refreshVolume(selectedDevice);
    } catch (e) {
      const msg = errMessage(e);
      // DLNA push rejected (UPnP 402) — the device may be signage we didn't
      // flag. Fall back to the MDC / URL Launcher path.
      if (/\b402\b/.test(msg) && selectedDevice.address) {
        try {
          setSignage(await castToSignage(selectedDevice.address, media));
          setNowPlaying(media);
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
        setNowPlaying(null);
        stopPolling();
      }),
    [runAction, stopPolling],
  );

  const onSeek = useCallback(
    (seconds: number) =>
      runAction(async (d) => {
        const seekFault = (e: unknown) =>
          e instanceof Error && /\b(701|710|711)\b/.test(e.message);
        const applyOk = () => {
          setPosition(seconds);
          setSeekNonce((n) => n + 1); // re-sync the notification timeline
          seekUnsupportedDevices.delete(d.id);
          setSeekSupported(true);
        };

        // Log the *actual* transport state so we can tell why a seek is refused
        // (701 is state-based — the device won't seek from where it currently is).
        let trackURI = '';
        let trackDuration = 0;
        try {
          const [ti, pi] = await Promise.all([getTransportInfo(d), getPositionInfo(d)]);
          trackURI = pi.trackURI;
          trackDuration = pi.duration;
          console.log(`[DLNA] seek: state=${ti.state} pos=${pi.position} dur=${pi.duration}`);
        } catch {
          /* diagnostics only */
        }

        // (A) Standard time seek (REL_TIME). Works on most renderers; Samsung
        //     answers 701 here (X_DLNA_SeekTime is 710 "not supported").
        try {
          await seek(d, seconds, 'REL_TIME');
          applyOk();
          return;
        } catch (e) {
          if (!seekFault(e)) throw e;
        }

        // (B) Samsung-native byte seek: derive the byte offset from the served
        //     file's size (Content-Length of the track URI) and the time fraction,
        //     then X_DLNA_SeekByte. The device snaps to the nearest keyframe.
        if (trackURI && trackDuration > 0) {
          try {
            const head = await fetch(trackURI, { method: 'HEAD' });
            const size = Number(head.headers.get('content-length'));
            if (Number.isFinite(size) && size > 0) {
              const offset = Math.max(0, Math.min(size - 1, Math.floor((size * seconds) / trackDuration)));
              await seekBytes(d, offset);
              applyOk();
              return;
            }
          } catch (e) {
            if (!seekFault(e)) throw e;
          }
        }

        // Every seek mode refused — this renderer doesn't honor Seek for pushed
        // content. Remember it and hide the seek controls instead of throwing.
        seekUnsupportedDevices.add(d.id);
        setSeekSupported(false);
        try {
          const actions = await getCurrentTransportActions(d);
          console.warn('[DLNA] seek unsupported by device. It allows:', actions);
        } catch {
          console.warn('[DLNA] seek unsupported by device; GetCurrentTransportActions failed.');
        }
      }),
    [runAction],
  );

  // Read the device's current volume so the on-screen value (and the next
  // relative step) start from the truth, not a guess. Best-effort: renderers
  // that don't implement RenderingControl just leave volume null.
  const refreshVolume = useCallback(async (d: DlnaDevice) => {
    try {
      const v = await getVolume(d);
      if (v != null) setVol(v);
    } catch {
      /* device doesn't support volume read */
    }
  }, []);

  const volumeRef = useRef<number | null>(null);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  // Relative volume: read the current level once, then nudge it by `delta`
  // notches per press (was jumping to a fixed absolute level before, which
  // lurched the volume by ~40). `volumeRef` avoids re-reading on every press.
  const onVolumeStep = useCallback(
    (delta: number) =>
      runAction(async (d) => {
        let base = volumeRef.current;
        if (base == null) base = (await getVolume(d)) ?? 50;
        const next = Math.max(0, Math.min(100, base + delta));
        await setVolume(d, next);
        setVol(next);
      }),
    [runAction],
  );

  const dismissError = useCallback(() => setError(null), []);
  const dismissSignage = useCallback(() => {
    setSignage(null);
    setNowPlaying(null);
  }, []);

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
  const sigSeek = useCallback((delta: number) => {
    wsSendControl('seekBy', delta);
    setSeekNonce((n) => n + 1);
  }, []);
  const sigSeekTo = useCallback((seconds: number) => {
    setSigPosition(seconds);
    wsSendControl('seekTo', seconds);
    setSeekNonce((n) => n + 1);
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

  // A cast is "active" — show the playback notification + keep the phone alive —
  // whenever DLNA playback is running or a signage cast is up. Local files also
  // need the phone to keep serving; remote URLs just want the control surface.
  const dlnaActive =
    status === 'PLAYING' ||
    status === 'PAUSED_PLAYBACK' ||
    status === 'TRANSITIONING';
  const castActive = dlnaActive || !!signage;

  // Playback snapshot for the notification. Signage state comes from the panel's
  // WebSocket; DLNA state from polling. Driven by `nowPlaying` (what's actually
  // cast), not the live selection. Photos get no transport controls.
  const pbTitle = nowPlaying?.name ?? 'Media';
  const pbState: PlaybackInfo['state'] = signage
    ? sigPlaying
      ? 'playing'
      : 'paused'
    : status === 'PAUSED_PLAYBACK'
      ? 'paused'
      : status === 'STOPPED' || status === 'NO_MEDIA_PRESENT'
        ? 'stopped'
        : // PLAYING *and* TRANSITIONING keep the bar moving — a brief buffering
          // blip shouldn't freeze/reset the notification timeline.
          'playing';
  const pbDuration = signage ? sigDuration : duration;
  const pbControls = nowPlaying?.kind !== 'image';

  // Current position via a ref so the notification effect doesn't re-fire on
  // every poll tick — the MediaSession extrapolates the seek bar between updates.
  const pbPositionRef = useRef(0);
  useEffect(() => {
    pbPositionRef.current = signage ? sigPosition : position;
  }, [signage, sigPosition, position]);

  useEffect(() => {
    if (castActive) {
      presentKeepAlive({
        title: pbTitle,
        state: pbState,
        position: pbPositionRef.current,
        duration: pbDuration,
        controls: pbControls,
      });
    } else {
      stopKeepAlive();
    }
  }, [castActive, pbTitle, pbState, pbDuration, pbControls, seekNonce]);

  // Route notification / lock-screen controls to whichever path is active (DLNA
  // push vs the signage WebSocket). Held in a ref so the listener stays stable.
  const transportRef = useRef<(action: TransportAction, value: number | null) => void>(
    () => {},
  );
  transportRef.current = (action, value) => {
    if (signage) {
      if (action === 'play') sigPlay();
      else if (action === 'pause') sigPause();
      else if (action === 'stop') sigPause(); // signage has no hard stop — pause
      else if (action === 'seekBy') sigSeek(value ?? 0);
      else if (action === 'seekTo') sigSeekTo(value ?? 0);
    } else {
      if (action === 'play') onPlay();
      else if (action === 'pause') onPause();
      else if (action === 'stop') onStop();
      else if (action === 'seekBy') onSeek(Math.max(0, pbPositionRef.current + (value ?? 0)));
      else if (action === 'seekTo') onSeek(value ?? 0);
    }
  };
  useEffect(() => {
    const sub = addTransportCommandListener((action, value) =>
      transportRef.current(action, value),
    );
    return () => sub.remove();
  }, []);

  useEffect(() => {
    return () => {
      discoveryRef.current?.stop();
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      stopKeepAlive();
    };
  }, []);

  return {
    devices,
    isScanning,
    selectedDevice,
    media,
    nowPlaying,
    importing,
    status,
    position,
    duration,
    seekSupported,
    volume,
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
    onVolumeStep,
    dismissError,
    dismissSignage,
  };
}
