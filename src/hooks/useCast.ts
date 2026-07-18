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
  backgroundSleep,
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
  serveTranscodedFile,
  stopLiveStream,
} from '../server/fileServer';
import {
  convertForCast,
  cancelConvert,
  ffmpegAvailable,
  probeMedia,
  extractThumbnail,
} from '../convert/transcode';
import { assessForCast, MAX_HEIGHT, MAX_WIDTH } from '../convert/plan';
import {
  CONVERT_QUALITY_TUNING,
  DEFAULT_CONVERT_QUALITY,
  type ConvertQuality,
} from '../convert/quality';
import { loadConvertQuality, saveConvertQuality } from '../convert/qualityStore';
import {
  advance,
  anchorOrder,
  indexAfterRemoval,
  makeOrder,
  retreat,
  type RepeatMode,
} from '../media/playlist';
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
  pickMediaFiles,
  type MediaItem,
} from '../media/media';
import { pickFolderMedia } from '../media/folder';

const SCAN_MS = 6000;
const POLL_MS = 1500;
// How close to the duration (seconds) counts as "the end". Some renderers
// (notably Samsung) don't report STOPPED when a video finishes — they keep
// reporting PLAYING with the clock frozen at the last second. We treat a
// non-advancing position within this window of the end as end-of-media.
const END_EPSILON_S = 2;
// A terminal STOPPED this close to the end (seconds) counts as the media finishing
// (→ queue may auto-advance); further away it's the user stopping from the TV remote
// (→ tear down). Wider than END_EPSILON_S because some renderers reset the position
// a beat before reporting STOPPED.
const END_STOP_NEAR_S = 10;

// Devices that rejected every seek mode (e.g. Samsung "The Freestyle" advertises
// Seek but its renderer refuses it for pushed content). Remembered by device id
// so we hide the seek controls from the first cast next time, not just after a
// failed attempt. Cleared if a seek ever succeeds.
const seekUnsupportedDevices = new Set<string>();

export type PlaybackStatus = TransportState | 'IDLE';

function errMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  // Native modules (e.g. react-native-udp) sometimes emit plain objects that are
  // NOT Error instances — `String(obj)` would render the useless "[object Object]".
  // Pull a sensible message out of common shapes, else fall back to JSON.
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    for (const key of ['message', 'error', 'code', 'reason'] as const) {
      if (typeof o[key] === 'string' && o[key]) return o[key] as string;
    }
    try {
      const json = JSON.stringify(e);
      if (json && json !== '{}') return json;
    } catch {
      /* circular / non-serializable */
    }
  }
  return String(e);
}

export interface UseCast {
  devices: DlnaDevice[];
  isScanning: boolean;
  /** True once at least one scan has finished (to distinguish "not scanned yet"
   *  from "scanned, found nothing"). */
  scanCompleted: boolean;
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
  chooseUrl: (url: string) => void;
  clearMedia: () => void;
  cast: () => Promise<void>;
  /** Play the selected local video now by transcoding it on the fly (starts in
   *  seconds; no seeking). The instant alternative to a full up-front Convert. */
  playNow: () => Promise<void>;
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
  /** True when the last cast was blocked (TV can't play the file) but it could be
   *  served over HTTP instead — gates the "Stream via URL" fallback button. */
  canStreamViaUrl: boolean;
  /** The URL the picked file is being served at (for manual streaming), or null. */
  streamUrl: string | null;
  /** Serve the selected local file over HTTP and expose its URL as `streamUrl`. */
  streamViaUrl: () => Promise<void>;
  /** True while a local conversion is running. */
  converting: boolean;
  /** Conversion progress, 0–1 (best-effort). */
  convertProgress: number;
  /** Estimated seconds remaining for the running conversion, or null. */
  convertEtaSec: number | null;
  /** Convert the selected local file into a castable MP4, replacing the selection.
   *  `mode` controls whether the result is also saved to the gallery. */
  convertSelected: (mode?: OutputMode) => Promise<void>;
  /** Cancel an in-progress conversion. */
  cancelConversion: () => void;
  /** The chosen convert speed/quality preset (persisted). */
  convertQuality: ConvertQuality;
  /** Change the convert speed/quality preset. */
  setConvertQuality: (q: ConvertQuality) => void;
  // ---- Playlist ----
  /** The playback queue (built with `enqueue`). Empty = single-shot casting. */
  queue: MediaItem[];
  /** Index of the currently-playing queue item, or -1 when not playing from the queue. */
  queueIndex: number;
  /** URIs of queue files this TV can't play even by transcoding — shown greyed/disabled
   *  and skipped by navigation. Discovered lazily on a failed cast attempt. */
  unplayable: ReadonlySet<string>;
  /** Whether the queue plays in a shuffled order. */
  shuffle: boolean;
  /** Repeat behavior: off / repeat-all / repeat-one. */
  repeatMode: RepeatMode;
  /** Append the current selection (`media`) to the queue and clear the selection. */
  enqueue: () => void;
  /** Pick one file (→ selection) or many (→ queue) via the system picker. */
  addMedia: () => Promise<void>;
  /** Pick a folder and append every media file directly inside it to the queue. */
  addFolder: () => Promise<void>;
  /** Remove the item at `index` from the queue (adjusts the current index). */
  removeFromQueue: (index: number) => void;
  /** Empty the queue. */
  clearQueue: () => void;
  /** Jump to and play a specific queue item now. */
  playQueueAt: (index: number) => void;
  /** Skip to the next queue item (honors shuffle/repeat). */
  next: () => void;
  /** Go back to the previous queue item (honors shuffle/repeat). */
  previous: () => void;
  /** Toggle shuffled playback. */
  toggleShuffle: () => void;
  /** Cycle repeat mode: off → all → one → off. */
  cycleRepeat: () => void;
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
  // True once a scan has run to completion at least once. Lets the UI tell
  // "you haven't scanned yet" apart from "scanned, found nothing" — the two
  // otherwise look identical (empty device list, not scanning).
  const [scanCompleted, setScanCompleted] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<DlnaDevice | null>(null);
  const [media, setMedia] = useState<MediaItem | null>(null);
  // What's actually on the TV — a snapshot taken when a cast succeeds. Kept
  // separate from `media` (the current selection) so picking a new file doesn't
  // make "Now playing" / the notification show something the TV isn't playing.
  const [nowPlaying, setNowPlaying] = useState<MediaItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  // Estimated seconds remaining for the current conversion (null until enough progress
  // to extrapolate, and while idle).
  const [convertEtaSec, setConvertEtaSec] = useState<number | null>(null);
  const [convertQuality, setConvertQualityState] = useState<ConvertQuality>(DEFAULT_CONVERT_QUALITY);
  // ---- Playlist ----
  // The queue is empty for the classic single-shot flow (Cast one file); once the
  // user enqueues items it becomes the playback source, with auto-advance on
  // end-of-media plus shuffle/repeat. `queueIndex` is the currently-playing slot.
  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  // Subtitles (SUBDL). subtitleUrlRef holds the served .srt URL passed to
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
  // "Stream via URL" fallback: when a picked file can't be DLNA-cast (e.g. a codec
  // the TV can't decode), we offer to serve it over HTTP so the user can open the
  // URL in a browser / player elsewhere. `canStreamViaUrl` gates the button;
  // `streamUrl` holds the served URL once they opt in.
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [canStreamViaUrl, setCanStreamViaUrl] = useState(false);
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
  // Token identifying the active poll loop (not an interval id): the loop runs on
  // backgroundSleep — JS intervals freeze when the screen goes off, which would kill
  // end-of-media detection and queue auto-advance the moment the phone is pocketed.
  // Replacing the token (or nulling it) makes the old loop exit at its next tick.
  const pollRef = useRef<object | null>(null);
  // End-of-media detection state for the poll loop: the position seen on the
  // previous tick (to spot a frozen clock), and whether playback ever actually
  // started (so a spurious STOPPED *before* the first frame can't end the cast).
  const prevPollPosRef = useRef(-1);
  const playbackSeenRef = useRef(false);
  // Mirror of `status` for callbacks that need the latest value without being
  // re-created (e.g. onSeek deciding whether to resume after a pause-seek).
  const statusRef = useRef<PlaybackStatus>('IDLE');
  statusRef.current = status;

  // Playlist state mirrored into refs so the poll-driven auto-advance and the
  // (stable) navigation callbacks read the latest queue without being re-created.
  const queueRef = useRef<MediaItem[]>([]);
  const queueIndexRef = useRef(-1);
  const orderRef = useRef<number[]>([]);
  const shuffleRef = useRef(false);
  const repeatRef = useRef<RepeatMode>('off');
  // Points at the latest castNext each render; finishPlayback (created below, before
  // castNext exists) calls it through this ref to auto-advance without a def-order cycle.
  const castNextRef = useRef<(manual: boolean) => boolean>(() => false);
  // True only while playback was started FROM the queue. Gates auto-advance: finishing
  // a one-off cast ("Play now" / single Cast) must never auto-start a parked queue.
  const playingFromQueueRef = useRef(false);
  // Monotonic cast sequence. Every castItem run takes a number; any later cast (or a
  // Stop/teardown) bumps it, making the older in-flight run "stale" so it aborts before
  // committing state or sending the TV a superseded SetAVTransportURI — rapid Next taps
  // and Stop-during-auto-advance would otherwise race on the single served-file slot.
  const castSeqRef = useRef(0);
  // URIs of queue files this TV can't play even by transcoding (discovered lazily when
  // a cast attempt returns 'skip'). Such items are greyed out in the queue and skipped
  // by navigation, so one bad file never dead-ends the queue. Kept as state (drives the
  // greyed UI) plus a ref mirror (read synchronously by the stable nav callbacks).
  const [unplayable, setUnplayable] = useState<ReadonlySet<string>>(() => new Set());
  const unplayableRef = useRef<ReadonlySet<string>>(unplayable);
  const markUnplayable = useCallback((uri: string) => {
    if (unplayableRef.current.has(uri)) return;
    const next = new Set(unplayableRef.current).add(uri);
    unplayableRef.current = next;
    setUnplayable(next);
  }, []);
  // Queue indices whose file is known-unplayable — the `blocked` set navigation skips.
  const blockedIndices = useCallback((): Set<number> => {
    const blocked = new Set<number>();
    const q = queueRef.current;
    const bad = unplayableRef.current;
    for (let i = 0; i < q.length; i++) {
      if (bad.has(q[i].uri)) blocked.add(i);
    }
    return blocked;
  }, []);

  const stopPolling = useCallback(() => {
    pollRef.current = null; // the loop sees its token replaced and exits
  }, []);

  // Tear down all playback state: notification/keep-alive, the Now-Playing sheet,
  // any on-device remux/transcode, the queue cursor, and any in-flight cast.
  const teardownPlayback = useCallback(() => {
    stopPolling();
    castSeqRef.current++; // abort any in-flight castItem before it commits
    playingFromQueueRef.current = false;
    queueIndexRef.current = -1;
    setQueueIndex(-1);
    // IDLE, not STOPPED: the notification's castActive gate ignores both, but the
    // Now-Playing sheet's `hasPlayback` gate hides only on IDLE/NO_MEDIA_PRESENT — a
    // STOPPED here left the sheet on-screen showing "STOPPED" after Stop/end-of-queue.
    setStatus('IDLE');
    setPosition(0);
    setNowPlaying(null);
    setBusy(false); // an aborted in-flight cast skips its own busy-reset
    setCastProgress(null);
    stopLiveStream().catch(() => {});
  }, [stopPolling]);

  // Playback finished on the TV. `endedNaturally` distinguishes reaching the end of
  // the media (may auto-advance the queue) from the user stopping it with the TV's
  // own remote (must tear down — auto-advancing there would make the queue impossible
  // to stop from the TV). Stop the poll first so it can't fire again mid-advance.
  const finishPlayback = useCallback(
    (endedNaturally: boolean) => {
      stopPolling();
      // Only auto-advance when the media actually finished AND we were playing from
      // the queue. A finished one-off ("Play now" / single Cast) with a parked queue
      // must NOT jump into that queue.
      if (endedNaturally && playingFromQueueRef.current && castNextRef.current(false)) {
        return;
      }
      console.log('[cast] finishPlayback: tearing down — stopping live stream');
      teardownPlayback();
    },
    [stopPolling, teardownPlayback],
  );

  const startPolling = useCallback(
    (device: DlnaDevice) => {
      stopPolling();
      prevPollPosRef.current = -1;
      playbackSeenRef.current = false;
      // backgroundSleep-driven loop, NOT setInterval: RN freezes JS timers while the
      // activity is paused (screen off), which silently stopped this poll — no
      // end-of-media detection, no auto-advance, and a keep-alive notification frozen
      // at the last on-screen position the moment the user pocketed the phone.
      const token = {};
      pollRef.current = token;
      void (async () => {
        while (pollRef.current === token) {
          await backgroundSleep(POLL_MS);
          if (pollRef.current !== token) return;
          try {
            const [transport, pos] = await Promise.all([
              getTransportInfo(device),
              getPositionInfo(device),
            ]);
            // If polling was stopped while this request was in flight (e.g. the user
            // hit Stop), don't clobber the IDLE status the stop just set — otherwise
            // the device's post-stop "STOPPED" reappears and the sheet pops back.
            if (pollRef.current !== token) return;
            const prevPos = prevPollPosRef.current;
            // Whether the clock is advancing tells working (pos rising) from stalled
            // (state PLAYING but pos frozen) at a glance in the log.
            const advancing = pos.position !== prevPos;
            console.log(
              `[poll] state=${transport.state} pos=${pos.position} dur=${pos.duration} advancing=${advancing}`,
            );
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
              pos.position === prevPos;
            prevPollPosRef.current = pos.position;

            if ((terminal || frozenAtEnd) && playbackSeenRef.current) {
              // A STOPPED near the end of the timeline is the media finishing; a STOPPED
              // far from it is the user pressing Stop on the TV's own remote — only the
              // former may auto-advance the queue (else the TV can't stop a queue at
              // all). With no known duration we can't tell, so we let it advance.
              const dur = pos.duration > 0 ? pos.duration : durationRef.current;
              const nearEnd =
                dur <= 0 || pos.position >= dur - END_STOP_NEAR_S || prevPos >= dur - END_STOP_NEAR_S;
              const endedNaturally = frozenAtEnd || (terminal && nearEnd);
              console.log(
                `[poll] END detected (terminal=${terminal} frozenAtEnd=${frozenAtEnd} endedNaturally=${endedNaturally}) → finishPlayback`,
              );
              finishPlayback(endedNaturally);
            }
          } catch (e) {
            // Was swallowed as a "transient blip" — but a poll error can mean the TV
            // dropped the control channel (its player crashed), so surface it.
            console.log(`[poll] error: ${errMessage(e)}`);
          }
        }
      })();
    },
    [stopPolling, finishPlayback],
  );

  const scan = useCallback(() => {
    discoveryRef.current?.stop();
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    setDevices([]);
    setError(null);
    setScanCompleted(false);
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

    scanTimerRef.current = setTimeout(() => {
      setIsScanning(false);
      setScanCompleted(true);
    }, SCAN_MS);
  }, []);

  const selectDevice = useCallback((d: DlnaDevice) => {
    setSelectedDevice(d);
    setVol(null); // volume is per-device; re-read on next cast
    setSeekSupported(!seekUnsupportedDevices.has(d.id));
    // A different TV might play a file the last one couldn't, so clear the
    // "can't cast this — stream it instead" fallback and the queue's unplayable
    // marks: the normal Cast button comes back and greyed queue rows get a fresh
    // chance on the newly-selected device.
    setStreamUrl(null);
    setCanStreamViaUrl(false);
    unplayableRef.current = new Set();
    setUnplayable(unplayableRef.current);
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

  const chooseUrl = useCallback(
    (url: string) => {
      if (!url.trim()) return;
      setError(null);
      setStreamUrl(null);
      setCanStreamViaUrl(false);
      setMedia(mediaFromUrl(url));
      clearSubtitle();
    },
    [clearSubtitle],
  );

  const clearMedia = useCallback(() => {
    setMedia(null);
    setStreamUrl(null);
    setCanStreamViaUrl(false);
    clearSubtitle();
  }, [clearSubtitle]);

  // Convert the selected local file into a TV-friendly MP4, then swap it in as the
  // selection so a normal Cast press streams the converted file. The chosen quality
  // preset owns the output resolution: a source larger than the preset's target is
  // downscaled + re-encoded; a compatible in-target file is a fast remux.
  const convertSelected = useCallback(
    async (mode: OutputMode = 'cache') => {
      if (!media || !media.isLocal) return;
      setError(null);
      setStreamUrl(null);
      setCanStreamViaUrl(false);
      setConverting(true);
      setConvertProgress(0);
      setConvertEtaSec(null);
      const startedAt = Date.now();
      try {
        const out = await convertForCast(media, {
          onProgress: (frac) => {
            setConvertProgress(frac);
            // Extrapolate time remaining from the elapsed/fraction rate once there's
            // enough signal (past the first few %) that it isn't wildly noisy.
            if (frac > 0.03) {
              const elapsed = (Date.now() - startedAt) / 1000;
              setConvertEtaSec(Math.max(0, Math.round(elapsed / frac - elapsed)));
            }
          },
          quality: convertQuality,
        });
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
        setConvertEtaSec(null);
      }
    },
    [media, convertQuality],
  );

  const cancelConversion = useCallback(() => {
    cancelConvert();
  }, []);

  // Load the persisted convert speed/quality preset once.
  useEffect(() => {
    loadConvertQuality().then(setConvertQualityState);
  }, []);

  const setConvertQuality = useCallback((q: ConvertQuality) => {
    setConvertQualityState(q);
    saveConvertQuality(q);
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

  // Cast a specific item now. The public `cast`, the queue navigators, and the
  // poll-driven auto-advance all funnel through here — it owns the signage-vs-DLNA
  // decision, on-device serving, the reachability probe, and starting the poll. The
  // CALLER owns the queue index (this just plays whatever item it's handed).
  // `liveTranscode` streams a local file the TV can't play by re-encoding it on the
  // fly (play-while-transcoding) instead of blocking for a full up-front convert.
  // `fromQueue` marks queue-initiated casts, which can't use the single-selection
  // fallback UI (Play now / Stream via URL need `media`, which a queue item isn't).
  //
  // Returns the outcome so queue logic can react: 'ok' (playing), 'failed' (error
  // surfaced — the queue should tear down rather than stay stuck "PLAYING"),
  // 'superseded' (a newer cast/Stop took over mid-flight — do nothing), or 'skip' (a
  // queued file this TV can't play even by transcoding — grey it out and move on).
  const castItem = useCallback(
    async (
      item: MediaItem,
      castOpts: { liveTranscode?: boolean; fromQueue?: boolean } = {},
    ): Promise<'ok' | 'failed' | 'superseded' | 'skip'> => {
    if (!selectedDevice) {
      setError('Pick a TV / device first.');
      return 'failed';
    }
    // Claim the cast slot: any later cast or Stop bumps the sequence, and this run
    // aborts at its next checkpoint instead of committing stale state.
    const seq = ++castSeqRef.current;
    const stale = () => seq !== castSeqRef.current;
    setBusy(true);
    setError(null);
    setSignage(null);
    setStreamUrl(null);
    setCanStreamViaUrl(false);

    // Samsung signage panels don't accept DLNA push — drive them over MDC.
    if (selectedDevice.isSignage) {
      try {
        // Signage serves the media file + player page from the phone, so it needs
        // the Doze exemption just as much as a DLNA cast does.
        ensureBackgroundExemption();
        const sig = await castToSignage(selectedDevice.address, item);
        if (stale()) return 'superseded';
        setSignage(sig);
        setNowPlaying(item);
        setStatus('IDLE');
        return 'ok';
      } catch (e) {
        if (stale()) return 'superseded';
        setError(errMessage(e));
        return 'failed';
      } finally {
        if (!stale()) setBusy(false);
      }
    }

    // `item` is what we actually cast — already swapped for an on-device-converted
    // copy (via convertSelected) when the picked video was a codec the TV can't play.
    let usingRemux = false;
    let servedFromPhone = false;
    let durationSec = 0;
    // Live on-the-fly transcode of a local file the TV can't play (play-while-transcoding).
    // A queued file that needs re-encoding turns this on automatically (below), so the
    // queue plays it instead of stopping — hence `let`, not `const`.
    let liveTranscode = castOpts.liveTranscode === true && ffmpegAvailable && item.isLocal;
    const canLiveTranscode = ffmpegAvailable && item.isLocal;

    console.log(
      `[cast] begin: name="${item.name}" kind=${item.kind} isLocal=${item.isLocal} live=${item.live === true} liveTranscode=${liveTranscode} device="${selectedDevice.friendlyName}"`,
    );
    try {
      // Probe local media up front: the duration feeds a seekable DLNA timeline
      // (Samsung 701s on Seek without it), and for video the codec/resolution lets
      // us catch files the TV can't play BEFORE copying gigabytes to serve them.
      let probe: Awaited<ReturnType<typeof probeMedia>> | undefined;
      if (item.isLocal && ffmpegAvailable) {
        try {
          probe = await probeMedia(item.uri);
        } catch (e) {
          console.log(`[cast] probe failed (best-effort): ${errMessage(e)}`);
        }
        if (stale()) return 'superseded';
        if (probe) {
          console.log(
            `[cast] probe: container=${probe.container} vcodec=${probe.videoCodec} acodec=${probe.audioCodec} ${probe.width}x${probe.height} ${probe.fps ?? '?'}fps dur=${Math.round(probe.durationSec)}s`,
          );
          durationSec = probe.durationSec;
          // The TV can't play this codec as-is (e.g. HEVC).
          if (!liveTranscode && item.kind === 'video' && assessForCast(probe).videoPlan === 'reencode') {
            if (castOpts.fromQueue && canLiveTranscode) {
              // A queued file: transcode it on the fly (like "Play now") so the queue
              // just plays it. If the transcode can't even start, the serve below
              // returns 'skip' and the caller greys it out and moves on — the queue
              // never dead-ends on one bad file.
              console.log(`[cast] queue item needs re-encode — auto live-transcoding: ${item.name}`);
              liveTranscode = true;
            } else if (castOpts.fromQueue) {
              // No FFmpeg / not local → can't transcode; skip it (greyed) rather than
              // stopping the whole queue.
              console.log(`[cast] queue item can't be transcoded here — skipping: ${item.name}`);
              return 'skip';
            } else {
              // Single-selection cast: offer the choice (Play now / Convert / Stream via URL).
              setError(
                'Your TV can’t play this video as-is. Use “Play now” to watch it while it converts, “Convert” to save a playable copy, or Stream via URL.',
              );
              setCanStreamViaUrl(true);
              return 'failed';
            }
          }
        }
      }

      // A live HLS stream (or a play-while-transcode of a local file) is served to the
      // TV as a continuous MPEG-TS feed rather than a seekable file. Computed AFTER any
      // convert (a converted file is a plain MP4).
      usingRemux = (item.live === true && ffmpegAvailable) || liveTranscode;
      servedFromPhone = item.isLocal || usingRemux;

      // A prior cast may have left a live remux running; tear it down unless we're
      // about to start a fresh one (serveLiveStream supersedes it on its own).
      if (!usingRemux) await stopLiveStream();

      // Serving from the phone needs the app to keep running with the screen off —
      // ask for the battery-optimization exemption (once) so Doze doesn't drop it.
      if (servedFromPhone) ensureBackgroundExemption();

      // Grab a representative frame for the notification artwork (async, best-effort)
      // — the next poll-driven present (bumped by artworkNonce) picks it up.
      if (item.isLocal && item.kind === 'video' && ffmpegAvailable) {
        const at = durationSec > 0 ? Math.min(durationSec * 0.3, 120) : 5;
        extractThumbnail(item.uri, at).then((p) => {
          if (p) {
            artworkPathRef.current = p;
            setArtworkNonce((n) => n + 1);
          }
        });
      }

      // The MIME we advertise to the TV: for a remux/transcode it's the MPEG-TS feed we
      // now serve, not the source's own MIME.
      let castMime = item.mime;
      let url: string;
      if (liveTranscode) {
        // Only downscale when the TV itself can't show the source (>1080p) — a scale
        // filter forces the CPU-copy pipeline, and an unscaled source can use the
        // zero-copy hardware path instead, the only one that keeps up with the phone
        // pocketed (screen-off caps the CPU clocks but not the codec silicon — see
        // liveStream's pipeline notes). The >1080p case scales to the preset's box
        // (speed matters most there) and remains screen-on-reliable only.
        const preset = CONVERT_QUALITY_TUNING[convertQuality];
        const w = probe?.width ?? 0;
        const h = probe?.height ?? 0;
        const needScale = h > MAX_HEIGHT || w > MAX_WIDTH;
        console.log(
          `[cast] starting live transcode: scaleTo=${needScale ? `${preset.maxWidth}x${preset.maxHeight}` : 'none (zero-copy eligible)'} bitrate=${preset.bitRateMbps}M fps=${probe?.fps ?? '?'}`,
        );
        try {
          url = await serveTranscodedFile(item.uri, {
            scaleTo: needScale ? { w: preset.maxWidth, h: preset.maxHeight } : undefined,
            bitRateMbps: preset.bitRateMbps,
            hwDecode: true,
            fps: probe?.fps,
          });
        } catch (e) {
          if (stale()) return 'superseded';
          // The transcode couldn't start (no MediaCodec pipeline accepted this file).
          // From the queue: skip + grey it out. Single selection: surface the error.
          if (castOpts.fromQueue) {
            console.log(`[cast] transcode failed to start — skipping queue item: ${item.name}`);
            return 'skip';
          }
          throw e;
        }
        console.log(`[cast] live transcode serving at ${url}`);
        castMime = 'video/mp2t';
      } else if (item.isLocal) {
        url = await shareLocalFile(item.uri, item.name, {
          mime: item.mime,
          kind: item.kind,
          durationSec: durationSec || undefined,
          size: item.size,
          onProgress: setCastProgress,
        });
      } else if (usingRemux) {
        url = await serveLiveStream(item.uri);
        castMime = 'video/mp2t';
      } else {
        url = item.uri;
      }
      // A newer cast (or Stop) superseded us while serving — it now owns the served
      // slot and the TV; committing anything (or casting) would corrupt its state.
      if (stale()) return 'superseded';
      lastServedUrlRef.current = url; // for the byte-seek fallback

      // A play-while-transcode feed is a live, non-seekable stream just like an HLS remux.
      const asLive = item.live === true || liveTranscode;

      console.log('[DLNA] casting', {
        url,
        mime: castMime,
        kind: item.kind,
        live: asLive,
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
        // the live path returns headers only — it doesn't consume any segments.) A
        // non-OK status means our own server can't serve the file (e.g. a stale/dead
        // media-server handle after backgrounding) — the TV would just get the same
        // and report a cryptic 716 "resource not found". Fail here with something
        // actionable instead of handing the TV a broken URL.
        let probeStatus = 0;
        try {
          const probe = await fetch(url, { method: 'HEAD' });
          probeStatus = probe.status;
        } catch (e) {
          throw new Error(
            `The phone's media server isn't reachable at ${url} ` +
              `(${errMessage(e)}). Casting can't continue.`,
          );
        }
        console.log(`[cast] reachability HEAD ${url} → ${probeStatus}`);
        if (probeStatus < 200 || probeStatus >= 400) {
          throw new Error(
            `The phone's media server returned ${probeStatus} for the file. ` +
              `Please try casting again — if it keeps happening, reopen the app.`,
          );
        }
      }
      // Last checkpoint before involving the TV: a superseded cast must not push a
      // stale SetAVTransportURI after (or racing) the newer one's.
      if (stale()) return 'superseded';

      console.log(`[cast] SetAVTransportURI+Play → ${selectedDevice.avTransportControlURL}`);
      await castMedia(selectedDevice, {
        url,
        title: item.name,
        kind: item.kind,
        mime: castMime,
        size: item.size,
        // A live feed advertises no seekable timeline.
        durationSec: asLive ? undefined : durationSec || undefined,
        subtitleUrl: subtitleUrlRef.current ?? undefined,
        live: asLive,
      });
      if (stale()) return 'superseded'; // superseded during the SOAP round-trip
      console.log('[cast] SetAVTransportURI+Play OK — starting poll');
      setNowPlaying(item);
      setStatus('PLAYING');
      setPosition(0);
      setDuration(0);
      // A live stream has no timeline to scrub, so don't offer seek for it.
      setSeekSupported(
        !asLive && !seekUnsupportedDevices.has(selectedDevice.id),
      );
      startPolling(selectedDevice);
      // Photos have no volume; only sync it for audio/video.
      if (item.kind !== 'image') refreshVolume(selectedDevice);
      return 'ok';
    } catch (e) {
      if (stale()) return 'superseded'; // newer cast owns the state; stay silent
      const msg = errMessage(e);
      console.log(`[cast] ERROR: ${msg}`);
      // A live remux that never reached playback is just burning CPU — stop it.
      if (usingRemux) stopLiveStream().catch(() => {});
      // DLNA push rejected (UPnP 402) — the device may be signage we didn't
      // flag. Fall back to the MDC / URL Launcher path.
      if (/\b402\b/.test(msg) && selectedDevice.address) {
        try {
          setSignage(await castToSignage(selectedDevice.address, item));
          setNowPlaying(item);
          setStatus('IDLE');
          return 'ok';
        } catch (e2) {
          setError(
            `DLNA push was rejected and the signage fallback failed: ${errMessage(e2)}`,
          );
          return 'failed';
        }
      }
      setError(msg);
      return 'failed';
    } finally {
      // A superseded run must not clear the busy/progress the newer run just set.
      if (!stale()) {
        setBusy(false);
        setCastProgress(null);
      }
    }
    },
    [selectedDevice, startPolling, convertQuality],
  );

  // ---- Playlist navigation ----
  // All queue mutations go through applyQueue so the ref mirror and the play order
  // stay in lockstep with the rendered state. Rebuilding the order on membership
  // change reshuffles when shuffle is on (fine — you just changed the queue), but the
  // currently-playing item is anchored to the front so advance() still visits every
  // other item (an unanchored fresh permutation skips whatever lands before it).
  const applyQueue = useCallback((next: MediaItem[]) => {
    queueRef.current = next;
    setQueue(next);
    let order = makeOrder(next.length, shuffleRef.current);
    const cur = queueIndexRef.current;
    if (cur >= 0 && cur < next.length) order = anchorOrder(order, cur);
    orderRef.current = order;
  }, []);

  // Play queue[idx] now. Queue items don't carry the standalone subtitle (it was
  // matched to one picked file), so clear it rather than push the wrong captions.
  // If the cast FAILS (not merely superseded by a newer action), tear down — leaving
  // the previous track's "PLAYING" state up with polling stopped would freeze the
  // Now-Playing sheet and keep-alive notification forever.
  const playQueueIndex = useCallback(
    (idx: number) => {
      const item = queueRef.current[idx];
      if (!item) return;
      queueIndexRef.current = idx;
      setQueueIndex(idx);
      playingFromQueueRef.current = true;
      if (subtitleUrlRef.current) {
        subtitleUrlRef.current = null;
        setSubtitle(null);
        clearServedSubtitle();
      }
      void castItem(item, { fromQueue: true }).then((outcome) => {
        if (outcome === 'skip') {
          // This TV can't play the file even by transcoding: grey it out and move to
          // the next playable item. If none remain, tear down.
          markUnplayable(item.uri);
          if (!castNextRef.current(false)) {
            console.log('[cast] no playable queue items left after skip — tearing down');
            teardownPlayback();
          }
        } else if (outcome === 'failed') {
          console.log('[cast] queue item failed to start — tearing down');
          teardownPlayback();
        }
      });
    },
    [castItem, teardownPlayback, markUnplayable],
  );

  // Advance to the next item (auto on end-of-media, or manual via Next). Returns
  // false when there's nowhere to go (end of queue, repeat off, or only unplayable
  // items remain) so finishPlayback can fall through to a real teardown.
  const castNext = useCallback(
    (manual: boolean): boolean => {
      const q = queueRef.current;
      if (q.length === 0) return false;
      const idx = advance(
        {
          length: q.length,
          current: queueIndexRef.current,
          order: orderRef.current,
          repeat: repeatRef.current,
          blocked: blockedIndices(),
        },
        manual,
      );
      if (idx == null || !q[idx]) return false;
      playQueueIndex(idx);
      return true;
    },
    [playQueueIndex, blockedIndices],
  );
  castNextRef.current = castNext;

  const next = useCallback(() => {
    castNext(true);
  }, [castNext]);

  const previous = useCallback(() => {
    const q = queueRef.current;
    if (q.length === 0) return;
    const idx = retreat({
      length: q.length,
      current: queueIndexRef.current,
      order: orderRef.current,
      repeat: repeatRef.current,
      blocked: blockedIndices(),
    });
    if (idx != null) playQueueIndex(idx);
  }, [playQueueIndex, blockedIndices]);

  const playQueueAt = useCallback(
    (index: number) => {
      playQueueIndex(index);
    },
    [playQueueIndex],
  );

  const enqueue = useCallback(() => {
    if (!media) return;
    applyQueue([...queueRef.current, media]);
    clearMedia(); // clear the pending selection (and its subtitle) — it's queued now
  }, [media, applyQueue, clearMedia]);

  // Smart "Add files": pick one or many. A single file becomes the working selection
  // (so Convert / Subs / a one-off Cast apply to it); several go straight to the queue.
  const addMedia = useCallback(async () => {
    setError(null);
    setStreamUrl(null);
    setCanStreamViaUrl(false);
    // The OS picker copies the chosen file into our cache before resolving; for a
    // multi-GB file that takes a while (native, so the UI stays responsive — show a
    // spinner so it doesn't look dead).
    setImporting(true);
    try {
      const items = await pickMediaFiles();
      if (items.length === 1) {
        setMedia(items[0]);
        clearSubtitle();
      } else if (items.length > 1) {
        applyQueue([...queueRef.current, ...items]);
      }
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setImporting(false);
    }
  }, [applyQueue, clearSubtitle]);

  // Pick a folder and append every media file inside it to the queue.
  const addFolder = useCallback(async () => {
    setError(null);
    setImporting(true);
    try {
      const items = await pickFolderMedia();
      // null = the user cancelled the folder picker (say nothing); [] = they picked a
      // folder with no playable media (tell them why nothing was added).
      if (items === null) return;
      if (items.length) applyQueue([...queueRef.current, ...items]);
      else setError('No playable video, audio, or images found directly in that folder.');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setImporting(false);
    }
  }, [applyQueue]);

  const removeFromQueue = useCallback(
    (index: number) => {
      const q = queueRef.current;
      if (index < 0 || index >= q.length) return;
      const nextQueue = q.filter((_, i) => i !== index);
      const newIdx = indexAfterRemoval(queueIndexRef.current, index, nextQueue.length);
      queueIndexRef.current = newIdx;
      setQueueIndex(newIdx);
      applyQueue(nextQueue);
    },
    [applyQueue],
  );

  const clearQueue = useCallback(() => {
    queueIndexRef.current = -1;
    setQueueIndex(-1);
    unplayableRef.current = new Set();
    setUnplayable(unplayableRef.current);
    applyQueue([]);
  }, [applyQueue]);

  const toggleShuffle = useCallback(() => {
    setShuffle((s) => {
      const nextShuffle = !s;
      shuffleRef.current = nextShuffle;
      let order = makeOrder(queueRef.current.length, nextShuffle);
      // Keep the currently-playing item at the front of the (re)built order so
      // advance() continues from it and still visits every other item — an
      // unanchored fresh permutation would skip whatever landed before it.
      const cur = queueIndexRef.current;
      if (cur >= 0 && cur < queueRef.current.length) order = anchorOrder(order, cur);
      orderRef.current = order;
      return nextShuffle;
    });
  }, []);

  const cycleRepeat = useCallback(() => {
    setRepeatMode((r) => {
      const nextMode: RepeatMode = r === 'off' ? 'all' : r === 'all' ? 'one' : 'off';
      repeatRef.current = nextMode;
      return nextMode;
    });
  }, []);

  // Start the queue from its first playable (possibly shuffled) slot — skip any items
  // already known-unplayable so pressing Play doesn't open on a greyed one.
  const startQueue = useCallback(() => {
    const q = queueRef.current;
    if (q.length === 0) return;
    orderRef.current = makeOrder(q.length, shuffleRef.current);
    const blocked = blockedIndices();
    const first = orderRef.current.find((idx) => !blocked.has(idx)) ?? orderRef.current[0] ?? 0;
    playQueueIndex(first);
  }, [playQueueIndex, blockedIndices]);

  // The primary Cast action: play the built queue if there is one, else cast the
  // single current selection (the classic one-shot flow, with an empty queue).
  const cast = useCallback(async () => {
    if (!selectedDevice) {
      setError('Pick a TV / device first.');
      return;
    }
    if (queueRef.current.length > 0) {
      startQueue();
      return;
    }
    if (!media) {
      setError('Choose a file or enter a URL first.');
      return;
    }
    // A one-off cast, not from the queue: end-of-media must tear down, not advance
    // a parked queue.
    playingFromQueueRef.current = false;
    queueIndexRef.current = -1;
    setQueueIndex(-1);
    await castItem(media);
  }, [selectedDevice, media, startQueue, castItem]);

  // Play the selected local video now by transcoding it on the fly (HEVC → H.264)
  // and streaming it as a live feed — playback starts in seconds instead of waiting
  // for a full up-front convert. No scrubbing (it's a live stream); for a seekable
  // copy the user runs Convert instead.
  const playNow = useCallback(async () => {
    if (!media) {
      setError('Choose a file first.');
      return;
    }
    console.log('[cast] playNow tapped (live transcode)');
    playingFromQueueRef.current = false;
    queueIndexRef.current = -1;
    setQueueIndex(-1);
    await castItem(media, { liveTranscode: true });
  }, [media, castItem]);

  // Fallback for a file the TV can't DLNA-cast: serve it over HTTP and expose the
  // URL so the user can open it in a browser / player on any device on the Wi-Fi.
  // This is the one place a "blocked" local file is still materialized (copied) —
  // opt-in, with copy progress — so we never copy gigabytes behind the user's back.
  const streamViaUrl = useCallback(async () => {
    if (!media || !media.isLocal) return;
    setBusy(true);
    setError(null);
    try {
      ensureBackgroundExemption(); // best-effort: keep serving with the screen off
      const url = await shareLocalFile(media.uri, media.name, {
        mime: media.mime,
        kind: media.kind,
        size: media.size,
        onProgress: setCastProgress,
      });
      setStreamUrl(url);
      setCanStreamViaUrl(false);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
      setCastProgress(null);
    }
  }, [media]);

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
        // Full teardown: stops the poll, bumps the cast sequence (so an in-flight
        // auto-advance from the queue aborts instead of restarting playback), clears
        // the queue cursor and Now-Playing, and stops any on-device remux/transcode.
        teardownPlayback();
      }),
    [runAction, teardownPlayback],
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
          let seekTimeCode: string | null = null;
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

          // (A2) Samsung's proprietary time seek — some sets reject REL_TIME (710)
          // but honor X_DLNA_SeekTime with the same H:MM:SS target. (Only reached
          // when REL_TIME faulted, so it never runs on sets that already seeked.)
          try {
            await seek(d, target, 'X_DLNA_SeekTime');
            applyOk();
            return;
          } catch (e) {
            seekTimeCode = codeOf(e);
            if (!isSeekFault(seekTimeCode)) throw e;
            if (seekTimeCode !== '710') definitelyUnsupported = false;
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
            const detail = `time ${relCode ?? '—'}/${seekTimeCode ?? '—'}${triedByte ? `, byte ${byteCode ?? '—'}` : ''}`;
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
      pollRef.current = null; // ends the poll loop at its next tick
      stopKeepAlive();
    };
  }, []);

  return {
    devices,
    isScanning,
    scanCompleted,
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
    chooseUrl,
    clearMedia,
    cast,
    playNow,
    onPlay,
    onPause,
    onStop,
    onSeek,
    onVolumeStep,
    dismissError,
    dismissSignage,
    castProgress,
    canStreamViaUrl,
    streamUrl,
    streamViaUrl,
    canConvert: ffmpegAvailable,
    converting,
    convertProgress,
    convertEtaSec,
    convertSelected,
    cancelConversion,
    convertQuality,
    setConvertQuality,
    queue,
    queueIndex,
    unplayable,
    shuffle,
    repeatMode,
    enqueue,
    addMedia,
    addFolder,
    removeFromQueue,
    clearQueue,
    playQueueAt,
    next,
    previous,
    toggleShuffle,
    cycleRepeat,
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
