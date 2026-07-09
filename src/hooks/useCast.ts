import { useCallback, useEffect, useRef, useState } from 'react';
import {
  castMedia,
  discoverDevices,
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
  ensureBackgroundExemption,
  presentKeepAlive,
  stopKeepAlive,
  type PlaybackInfo,
  type TransportAction,
} from '../background/keepAlive';
import {
  shareLocalFile,
  writePlayerPage,
  serveSubtitle,
  clearServedSubtitle,
  serveLiveStream,
  stopLiveStream,
} from '../server/fileServer';
import {
  convertForCast,
  cancelConvert,
  ffmpegAvailable,
  probeMedia,
  extractThumbnail,
} from '../convert/transcode';
import { saveToGallery, type OutputMode } from '../convert/gallery';
import { searchSubtitles, downloadSubtitle, type SubtitleResult } from '../subtitles/subdl';
import { loadApiKey, saveApiKey } from '../subtitles/subtitleStore';
import { pickSubtitleFile } from '../subtitles/pickSubtitle';
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
// How close to the duration (seconds) counts as "the end". Some renderers
// (notably Samsung) don't report STOPPED when a video finishes — they keep
// reporting PLAYING with the clock frozen at the last second. We treat a
// non-advancing position within this window of the end as end-of-media.
const END_EPSILON_S = 2;

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
  /** True if this binary can convert files locally (FFmpeg present). */
  canConvert: boolean;
  /** Copy progress (0–1) while a large local file is staged for casting; null otherwise. */
  castProgress: number | null;
  /** True while a local conversion is running. */
  converting: boolean;
  /** Conversion progress, 0–1 (best-effort). */
  convertProgress: number;
  /** Convert the selected local file into a castable MP4, replacing the selection.
   *  `mode` controls whether the result is also saved to the gallery. */
  convertSelected: (mode?: OutputMode) => Promise<void>;
  /** Cancel an in-progress conversion. */
  cancelConversion: () => void;
  // ---- Subtitles ----
  /** Saved SUBDL API key (empty until the user sets one). */
  subdlKey: string;
  setSubdlKey: (k: string) => void;
  /** Latest subtitle search results. */
  subResults: SubtitleResult[];
  /** True while searching, downloading, or reading a subtitle. */
  searchingSubs: boolean;
  /** The attached subtitle (language + release label), or null. */
  subtitle: { language: string; release: string } | null;
  /** Search SUBDL for the selected file in the given language code. */
  searchSubs: (language: string) => Promise<void>;
  /** Download + attach a SUBDL result; sent to the TV on the next cast. */
  attachSub: (r: SubtitleResult) => Promise<void>;
  /** Attach a subtitle from a local file the user picks. */
  pickSubtitle: () => Promise<void>;
  /** Detach the current subtitle. */
  clearSubtitle: () => void;
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
  const [converting, setConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  // Subtitles (OpenSubtitles). subtitleUrlRef holds the served .srt URL passed to
  // the renderer at cast time; `subtitle` is the attached label for the UI.
  const [subdlKey, setSubdlKeyState] = useState('');
  const [subResults, setSubResults] = useState<SubtitleResult[]>([]);
  const [searchingSubs, setSearchingSubs] = useState(false);
  const [subtitle, setSubtitle] = useState<{ language: string; release: string } | null>(null);
  const subtitleUrlRef = useRef<string | null>(null);
  // A video frame used as the notification artwork (extracted once per cast).
  const artworkPathRef = useRef<string | null>(null);
  const [artworkNonce, setArtworkNonce] = useState(0);
  // Non-null while a large local file is being copied into the server dir before
  // the DLNA hand-off (0–1). Null when there's nothing to copy (remote/instant move).
  const [castProgress, setCastProgress] = useState<number | null>(null);
  // Bumped on each successful seek so the playback notification re-syncs its
  // timeline (we otherwise let the MediaSession extrapolate, ignoring polls).
  const [seekNonce, setSeekNonce] = useState(0);
  const [status, setStatus] = useState<PlaybackStatus>('IDLE');
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState<number | null>(null);
  // For seeking: the URL we actually served (so a byte-seek can size the file even
  // when the renderer reports no track URI) and the latest known duration.
  const lastServedUrlRef = useRef<string | null>(null);
  const durationRef = useRef(0);
  // Guards against overlapping seeks (e.g. a double-fired tap), which otherwise
  // race: the second hits the renderer mid-transition and 701s.
  const seekInFlightRef = useRef(false);
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
  // End-of-media detection state for the poll loop: the position seen on the
  // previous tick (to spot a frozen clock), and whether playback ever actually
  // started (so a spurious STOPPED *before* the first frame can't end the cast).
  const prevPollPosRef = useRef(-1);
  const playbackSeenRef = useRef(false);
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

  // The video finished on the TV (or was stopped by its own remote): drop the
  // notification, hide the Now-Playing sheet, and stop any on-device remux so
  // FFmpeg isn't left running. Mirrors onStop, minus the DLNA Stop call (the TV
  // has already stopped itself).
  const finishPlayback = useCallback(() => {
    stopPolling();
    setStatus('STOPPED'); // → castActive becomes false → keep-alive/notification torn down
    setPosition(0);
    setNowPlaying(null);
    stopLiveStream().catch(() => {});
  }, [stopPolling]);

  const startPolling = useCallback(
    (device: DlnaDevice) => {
      stopPolling();
      prevPollPosRef.current = -1;
      playbackSeenRef.current = false;
      pollRef.current = setInterval(async () => {
        try {
          const [transport, pos] = await Promise.all([
            getTransportInfo(device),
            getPositionInfo(device),
          ]);
          // If polling was stopped while this request was in flight (e.g. the user
          // hit Stop), don't clobber the IDLE status the stop just set — otherwise
          // the device's post-stop "STOPPED" reappears and the sheet pops back.
          if (!pollRef.current) return;
          setStatus(transport.state);
          setPosition(pos.position);
          setDuration(pos.duration);

          if (
            transport.state === 'PLAYING' ||
            transport.state === 'PAUSED_PLAYBACK' ||
            transport.state === 'TRANSITIONING'
          ) {
            playbackSeenRef.current = true;
          }

          // End-of-media takes two shapes: the renderer reports a terminal
          // transport state, OR it keeps saying PLAYING with the clock frozen at
          // the very end (Samsung). Catch the latter via a non-advancing position
          // within END_EPSILON_S of the duration. A genuine pause near the end
          // isn't "ended", so the frozen-clock case is restricted to PLAYING.
          const terminal =
            transport.state === 'STOPPED' ||
            transport.state === 'NO_MEDIA_PRESENT';
          const frozenAtEnd =
            transport.state === 'PLAYING' &&
            pos.duration > 0 &&
            pos.position >= pos.duration - END_EPSILON_S &&
            pos.position === prevPollPosRef.current;
          prevPollPosRef.current = pos.position;

          if ((terminal || frozenAtEnd) && playbackSeenRef.current) {
            finishPlayback();
          }
        } catch {
          /* transient network blip; keep polling */
        }
      }, POLL_MS);
    },
    [stopPolling, finishPlayback],
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

  // Detach any subtitle (called when a different item is chosen — the subtitle
  // was matched to the old one).
  const clearSubtitle = useCallback(() => {
    subtitleUrlRef.current = null;
    setSubtitle(null);
    setSubResults([]);
    clearServedSubtitle();
    artworkPathRef.current = null; // also drop the old item's notification frame
  }, []);

  const chooseFile = useCallback(async () => {
    setError(null);
    // The OS picker copies the chosen file into our cache before resolving; for
    // a multi-GB file that takes a while (it runs natively, so the app stays
    // responsive — but show a spinner so it doesn't look dead).
    setImporting(true);
    try {
      const item = await pickMedia();
      if (item) {
        setMedia(item);
        clearSubtitle();
      }
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setImporting(false);
    }
  }, [clearSubtitle]);

  const chooseUrl = useCallback(
    (url: string) => {
      if (!url.trim()) return;
      setError(null);
      setMedia(mediaFromUrl(url));
      clearSubtitle();
    },
    [clearSubtitle],
  );

  const clearMedia = useCallback(() => {
    setMedia(null);
    clearSubtitle();
  }, [clearSubtitle]);

  // Convert the selected local file into a TV-friendly MP4 (remux + AAC), then
  // swap it in as the selection so a normal Cast press streams the converted file.
  const convertSelected = useCallback(
    async (mode: OutputMode = 'cache') => {
      if (!media || !media.isLocal) return;
      setError(null);
      setConverting(true);
      setConvertProgress(0);
      try {
        const out = await convertForCast(media, { onProgress: setConvertProgress });
        setMedia(out);
        if (mode !== 'cache') {
          // Secondary to the cast: if the gallery save fails, the converted file
          // still works for casting, so surface a note but don't lose the result.
          try {
            await saveToGallery(out.uri, out.name, mode);
          } catch (e) {
            setError(`Converted, but couldn't save to gallery: ${errMessage(e)}`);
          }
        }
      } catch (e) {
        if (!(e as { cancelled?: boolean })?.cancelled) setError(errMessage(e));
      } finally {
        setConverting(false);
      }
    },
    [media],
  );

  const cancelConversion = useCallback(() => {
    cancelConvert();
  }, []);

  // ---- Subtitles ----
  useEffect(() => {
    loadApiKey().then(setSubdlKeyState);
  }, []);

  const setSubdlKey = useCallback((k: string) => {
    setSubdlKeyState(k);
    saveApiKey(k);
  }, []);

  /** Search SUBDL for the selected file (by name) in `language`. */
  const searchSubs = useCallback(
    async (language: string) => {
      if (!media) return;
      setError(null);
      setSearchingSubs(true);
      try {
        const query = media.name.replace(/\.[^.]+$/, '');
        setSubResults(await searchSubtitles(subdlKey, query, language));
      } catch (e) {
        setSubResults([]);
        setError(errMessage(e));
      } finally {
        setSearchingSubs(false);
      }
    },
    [media, subdlKey],
  );

  /** Download a chosen SUBDL result (.zip → .srt) and serve it for the next cast. */
  const attachSub = useCallback(async (r: SubtitleResult) => {
    setError(null);
    setSearchingSubs(true);
    try {
      const srt = await downloadSubtitle(r.url);
      subtitleUrlRef.current = await serveSubtitle(srt);
      setSubtitle({ language: r.language, release: r.release });
      setSubResults([]);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSearchingSubs(false);
    }
  }, []);

  /** Attach a subtitle from a local file the user picks (no account needed). */
  const pickSubtitle = useCallback(async () => {
    setError(null);
    setSearchingSubs(true);
    try {
      const picked = await pickSubtitleFile();
      if (picked) {
        subtitleUrlRef.current = await serveSubtitle(picked.content);
        setSubtitle({ language: 'file', release: picked.name });
        setSubResults([]);
      }
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSearchingSubs(false);
    }
  }, []);

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

    // A live HLS stream can't be pushed to most DLNA TVs as-is. When FFmpeg is
    // present (Android) we remux it on-device into a continuous MPEG-TS feed the
    // TV can play; otherwise we hand the TV the HLS URL directly (step-1 path,
    // works on the sets that natively support HLS).
    const usingRemux = media.live === true && ffmpegAvailable;
    const servedFromPhone = media.isLocal || usingRemux;

    try {
      // A prior cast may have left a live remux running; tear it down unless we're
      // about to start a fresh one (serveLiveStream supersedes it on its own).
      if (!usingRemux) await stopLiveStream();

      // Serving from the phone needs the app to keep running with the screen off —
      // ask for the battery-optimization exemption (once) so Doze doesn't drop it.
      if (servedFromPhone) ensureBackgroundExemption();

      // Probe the duration up front (best-effort, local files) so BOTH the media
      // server (TimeSeekRange → byte mapping) and the DIDL <res> can advertise a
      // seekable timeline — Samsung rejects Seek with 701 without it. Live streams
      // have no duration, so skip it for them.
      let durationSec = 0;
      if (media.isLocal && ffmpegAvailable) {
        try {
          durationSec = (await probeMedia(media.uri)).durationSec;
        } catch {
          /* duration is best-effort */
        }
      }

      // Grab a representative frame for the notification artwork (async, best-effort)
      // — the next poll-driven present (bumped by artworkNonce) picks it up.
      if (media.isLocal && media.kind === 'video' && ffmpegAvailable) {
        const at = durationSec > 0 ? Math.min(durationSec * 0.3, 120) : 5;
        extractThumbnail(media.uri, at).then((p) => {
          if (p) {
            artworkPathRef.current = p;
            setArtworkNonce((n) => n + 1);
          }
        });
      }

      // The MIME we advertise to the TV: for a remux it's the MPEG-TS feed we now
      // serve, not the original playlist's `application/vnd.apple.mpegurl`.
      let castMime = media.mime;
      let url: string;
      if (media.isLocal) {
        url = await shareLocalFile(media.uri, media.name, {
          mime: media.mime,
          kind: media.kind,
          durationSec: durationSec || undefined,
          size: media.size,
          onProgress: setCastProgress,
        });
      } else if (usingRemux) {
        url = await serveLiveStream(media.uri);
        castMime = 'video/mp2t';
      } else {
        url = media.uri;
      }
      lastServedUrlRef.current = url; // for the byte-seek fallback

      console.log('[DLNA] casting', {
        url,
        mime: castMime,
        kind: media.kind,
        live: media.live === true,
        remux: usingRemux,
        device: selectedDevice.friendlyName,
        control: selectedDevice.avTransportControlURL,
      });

      if (servedFromPhone) {
        // An emulator's NAT address (or loopback) is reachable by this app but
        // NOT by the TV, so serving from the phone can't work there.
        const { host } = parseUrl(url);
        if (isUnreachableByLan(host)) {
          throw new Error(
            `The TV can't reach this device at ${host}. You're likely on an ` +
              `emulator — run on a physical phone on the same Wi-Fi as the TV ` +
              `(or cast a public URL instead).`,
          );
        }
        // Confirm the phone is actually serving before involving the TV. (HEAD on
        // the live path returns headers only — it doesn't consume any segments.)
        try {
          const probe = await fetch(url, { method: 'HEAD' });
          if (!probe.ok) {
            console.warn('[DLNA] media server HEAD', probe.status, url);
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
        mime: castMime,
        size: media.size,
        durationSec: durationSec || undefined,
        subtitleUrl: subtitleUrlRef.current ?? undefined,
        live: media.live === true,
      });
      setNowPlaying(media);
      setStatus('PLAYING');
      setPosition(0);
      setDuration(0);
      // A live stream has no timeline to scrub, so don't offer seek for it.
      setSeekSupported(
        !media.live && !seekUnsupportedDevices.has(selectedDevice.id),
      );
      startPolling(selectedDevice);
      // Photos have no volume; only sync it for audio/video.
      if (media.kind !== 'image') refreshVolume(selectedDevice);
    } catch (e) {
      const msg = errMessage(e);
      // A live remux that never reached playback is just burning CPU — stop it.
      if (usingRemux) stopLiveStream().catch(() => {});
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
      setCastProgress(null);
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
        setStatus('IDLE'); // back to idle so the Now-Playing sheet hides
        setPosition(0);
        setNowPlaying(null);
        stopPolling();
        // Stop the on-device remux (if this was a live stream) so FFmpeg isn't
        // left running after the TV has stopped.
        stopLiveStream().catch(() => {});
      }),
    [runAction, stopPolling],
  );

  const onSeek = useCallback(
    (seconds: number) =>
      runAction(async (d) => {
        // Ignore a seek that arrives while another is still running (double-fired
        // taps, rapid scrubbing) — it would otherwise hit the renderer mid-jump.
        if (seekInFlightRef.current) return;
        seekInFlightRef.current = true;
        try {
          const codeOf = (e: unknown): string | null => {
            const m = e instanceof Error ? e.message.match(/\b(70\d|71\d)\b/) : null;
            return m ? m[1] : null;
          };
          const isSeekFault = (c: string | null) => c === '701' || c === '710' || c === '711';

          // Clamp to the timeline so we never seek past the end (→ 711 "illegal target").
          const dur = durationRef.current;
          const target =
            dur > 0 ? Math.max(0, Math.min(Math.floor(seconds), dur - 1)) : Math.max(0, Math.floor(seconds));
          const applyOk = () => {
            setPosition(target);
            setSeekNonce((n) => n + 1); // re-sync the notification timeline
            seekUnsupportedDevices.delete(d.id);
            setSeekSupported(true);
          };

          // Prefer what the renderer reports, but fall back to the URL we served and
          // the duration we already know — some renderers return an empty PositionInfo.
          let trackURI = lastServedUrlRef.current ?? '';
          let trackDuration = dur;
          let state = '';
          try {
            const [ti, pi] = await Promise.all([getTransportInfo(d), getPositionInfo(d)]);
            state = ti.state;
            if (pi.trackURI) trackURI = pi.trackURI;
            if (pi.duration > 0) trackDuration = pi.duration;
            console.log(`[DLNA] seek: state=${state} pos=${pi.position} dur=${trackDuration} → ${target}`);
          } catch {
            /* diagnostics only */
          }

          // The renderer can't seek mid-jump (701). Silently skip — the user can
          // just seek again once it settles.
          if (state === 'TRANSITIONING') return;

          // Conclude "unsupported" only if a mode is explicitly rejected with 710
          // ("seek mode not supported"). 701 (transient) and 711 (bad target) don't
          // mean the device can't seek, so they must never hide the controls.
          let definitelyUnsupported = true;
          let relCode: string | null = null;
          let byteCode: string | null = null;
          let triedByte = false;

          // (A) Standard time seek (REL_TIME) — what this TV actually honors.
          try {
            await seek(d, target, 'REL_TIME');
            applyOk();
            return;
          } catch (e) {
            relCode = codeOf(e);
            if (!isSeekFault(relCode)) throw e;
            if (relCode !== '710') definitelyUnsupported = false;
          }

          // (B) Byte seek fallback for renderers that prefer it.
          if (trackURI && trackDuration > 0) {
            triedByte = true;
            try {
              const head = await fetch(trackURI, { method: 'HEAD' });
              const size = Number(head.headers.get('content-length'));
              if (Number.isFinite(size) && size > 0) {
                const offset = Math.max(0, Math.min(size - 1, Math.floor((size * target) / trackDuration)));
                await seekBytes(d, offset);
                applyOk();
                return;
              }
              byteCode = 'no-size';
              definitelyUnsupported = false;
            } catch (e) {
              byteCode = codeOf(e);
              if (!isSeekFault(byteCode)) throw e;
              if (byteCode !== '710') definitelyUnsupported = false;
            }
          } else {
            definitelyUnsupported = false;
          }

          // Only a hard, definitive refusal (710 on every mode) hides the controls.
          // Transient 701/711 failures fail silently — seeking just didn't take.
          if (definitelyUnsupported) {
            seekUnsupportedDevices.add(d.id);
            setSeekSupported(false);
            const detail = `time ${relCode ?? '—'}${triedByte ? `, byte ${byteCode ?? '—'}` : ''}`;
            setError(`This TV doesn’t support seeking (${detail}).`);
          }
        } finally {
          seekInFlightRef.current = false;
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
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

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

  // Absolute volume set — used by the phone's hardware volume keys, which the
  // native MediaSession routes here as a computed target (0–100) rather than a
  // relative nudge, so the on-phone volume slider and the TV stay in lock-step.
  const onVolumeSet = useCallback(
    (v: number) =>
      runAction(async (d) => {
        const next = Math.max(0, Math.min(100, Math.round(v)));
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
  const pbPosition = signage ? sigPosition : position;

  // Re-sync the notification on every poll tick. The MediaSession extrapolates the
  // seek bar between updates, but if we only re-present on state changes it drifts
  // (the TV's real position vs. our 1× guess, esp. across buffering). Re-presenting
  // each tick is cheap — present() updates the same notification id in place.
  useEffect(() => {
    if (castActive) {
      presentKeepAlive({
        title: pbTitle,
        state: pbState,
        position: pbPosition,
        duration: pbDuration,
        controls: pbControls,
        artworkPath: artworkPathRef.current ?? undefined,
        // Keep the native volume provider in sync with the TV so the phone's
        // hardware-key volume slider reflects the real level (-1 = unknown).
        volume: volume ?? -1,
      });
    } else {
      stopKeepAlive();
    }
  }, [castActive, pbTitle, pbState, pbDuration, pbControls, pbPosition, volume, seekNonce, artworkNonce]);

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
      // 'volumeTo' ignored — signage panels have no volume channel.
    } else {
      if (action === 'play') onPlay();
      else if (action === 'pause') onPause();
      else if (action === 'stop') onStop();
      else if (action === 'seekBy') onSeek(Math.max(0, pbPosition + (value ?? 0)));
      else if (action === 'seekTo') onSeek(value ?? 0);
      else if (action === 'volumeTo') onVolumeSet(value ?? 0);
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
    castProgress,
    canConvert: ffmpegAvailable,
    converting,
    convertProgress,
    convertSelected,
    cancelConversion,
    subdlKey,
    setSubdlKey,
    subResults,
    searchingSubs,
    subtitle,
    searchSubs,
    attachSub,
    pickSubtitle,
    clearSubtitle,
  };
}
