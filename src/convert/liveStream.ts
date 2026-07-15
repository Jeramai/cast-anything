import { CachesDirectoryPath, exists, mkdir, readDir, unlink } from '@dr.pogodin/react-native-fs';
import { FFmpegKit, ReturnCode } from '@wokcito/ffmpeg-kit-react-native';
import { contentFeatures } from '../dlna/avtransport';
import { pickReadySegment } from '../server/dlnaHttp';
import type { LiveSource } from '../server/mediaServer';
import { ffmpegAvailable } from './transcode';

/**
 * Live web streams (HLS `.m3u8`) can't be pushed at a DLNA TV directly — most
 * Samsung sets refuse a raw playlist over AVTransport. So we let the phone do the
 * work: FFmpeg pulls the HLS feed and *remuxes* it (copying the H.264/AAC streams
 * untouched — no re-encode, this build has no x264) into a rolling series of short
 * MPEG-TS segments. Our DLNA media server then streams those segments back-to-back
 * to the TV as one continuous `video/mp2t` live feed, which Samsung handles well.
 *
 * Disk is bounded: the server deletes each segment the moment it's been sent, so
 * only a couple segments ever sit on disk regardless of how long the game runs.
 */

const LIVE_DIR = `${CachesDirectoryPath}/cast-live`;
// 4s segments balance start-up latency against per-segment overhead. We always
// stream one segment behind the live edge (a segment is only "complete" once the
// next one exists), so end-to-end lag is roughly two segments + the TV's buffer.
const SEGMENT_SECONDS = 4;
const POLL_MS = 250;
// If FFmpeg never produces a first segment (dead URL, geo-block, DRM), give up so
// the renderer gets EOF and the cast surfaces an error instead of hanging forever.
const STARTUP_TIMEOUT_MS = 20_000;

let sessionId: number | null = null;
let running = false;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function clearLiveDir(): Promise<void> {
  try {
    const entries = await readDir(LIVE_DIR);
    await Promise.all(entries.map((e) => unlink(e.path).catch(() => {})));
  } catch {
    /* dir may not exist yet */
  }
}

/** Whether the FFmpeg remux is currently producing segments. */
export function isLiveRunning(): boolean {
  return running;
}

/** Cancel the remux (if any) and wipe its segment dir. Idempotent. */
export async function stopLiveRemux(): Promise<void> {
  running = false;
  if (sessionId != null) {
    const id = sessionId;
    sessionId = null;
    await FFmpegKit.cancel(id).catch(() => {});
  }
  await clearLiveDir();
}

/**
 * Start remuxing `srcUrl` (an HLS playlist) into rolling MPEG-TS segments and
 * return a {@link LiveSource} the media server can stream. Throws if FFmpeg isn't
 * in this binary. Supersedes any remux already running.
 */
export async function startLiveRemux(srcUrl: string): Promise<LiveSource> {
  if (!ffmpegAvailable) {
    throw new Error('Live stream remux needs the FFmpeg build (Android only).');
  }
  await stopLiveRemux();
  if (!(await exists(LIVE_DIR))) await mkdir(LIVE_DIR);
  running = true;
  // Per-session segment cursor (was a module global that bled across streams and
  // reconnects — a fresh remux must always start from the beginning of its own dir).
  let lastIndex = -1;

  /** Block until the next complete segment is ready, or null once the feed ends. */
  const next = async (alive: () => boolean): Promise<string | null> => {
    let waited = 0;
    while (alive()) {
      let names: string[] = [];
      try {
        names = (await readDir(LIVE_DIR)).map((e) => e.name);
      } catch {
        /* transient */
      }
      const pick = pickReadySegment(names, lastIndex, running);
      if (pick) {
        lastIndex = pick.index;
        return `${LIVE_DIR}/${pick.name}`;
      }
      // FFmpeg has exited and nothing complete remains → the stream is over.
      if (!running && pickReadySegment(names, lastIndex, false) == null) return null;
      // Bail if startup never yields a first segment, so the cast can error out.
      if (lastIndex < 0 && waited >= STARTUP_TIMEOUT_MS) return null;
      await delay(POLL_MS);
      waited += POLL_MS;
    }
    return null;
  };

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    // Many live CDNs (sports especially) 404/403 FFmpeg's default `Lavf/*`
    // User-Agent. Pose as a mobile browser so the playlist + segments load.
    '-user_agent',
    'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    // HLS CDNs drop connections mid-game; auto-reconnect rather than die.
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-i',
    srcUrl,
    // Copy both streams — fast, lossless. (No x264 here, so we can't re-encode a
    // non-H.264 source; such streams simply won't play, same as any other input.)
    '-c',
    'copy',
    '-f',
    'segment',
    '-segment_format',
    'mpegts',
    '-segment_time',
    String(SEGMENT_SECONDS),
    // Keep source timestamps continuous across segments so concatenation is seamless.
    '-reset_timestamps',
    '0',
    `${LIVE_DIR}/seg%06d.ts`,
  ];

  const session = await FFmpegKit.executeWithArgumentsAsync(args, async (s) => {
    running = false;
    sessionId = null;
    const rc = await s.getReturnCode();
    if (!ReturnCode.isSuccess(rc) && !ReturnCode.isCancel(rc)) {
      console.warn('[live] ffmpeg ended with code', rc?.getValue?.());
    }
  });
  sessionId = session.getSessionId();

  return {
    mime: 'video/mp2t',
    features: contentFeatures('video', true),
    next,
    done: (path: string) => {
      unlink(path).catch(() => {});
    },
    stop: () => {
      void stopLiveRemux();
    },
  };
}
