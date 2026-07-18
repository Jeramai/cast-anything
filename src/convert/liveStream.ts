import { CachesDirectoryPath, exists, mkdir, readDir, unlink } from '@dr.pogodin/react-native-fs';
import { FFmpegKit, ReturnCode } from '@wokcito/ffmpeg-kit-react-native';
import { contentFeatures } from '../dlna/avtransport';
import { pickReadySegment, pickStaleSegments } from '../server/dlnaHttp';
import type { LiveSource } from '../server/mediaServer';
import { ffmpegAvailable, ffmpegInput } from './transcode';

/**
 * Live web streams (HLS `.m3u8`) can't be pushed at a DLNA TV directly — most
 * Samsung sets refuse a raw playlist over AVTransport. So we let the phone do the
 * work: FFmpeg pulls the HLS feed and *remuxes* it (copying the H.264/AAC streams
 * untouched — no re-encode, this build has no x264) into a rolling series of short
 * MPEG-TS segments. Our DLNA media server then streams those segments back-to-back
 * to the TV as one continuous `video/mp2t` live feed, which Samsung handles well.
 *
 * Disk is bounded by a rolling retention window: a background pruner deletes segments
 * that fall RETAIN_SEGMENTS behind the live edge (readers never delete — see
 * mediaServer.LiveSource.createReader), so only a bounded window ever sits on disk
 * regardless of how long the game runs.
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
// A local-file transcode's first attempt often dies instantly with AVERROR_INVALIDDATA
// — the SAF input handle / hardware MediaCodec from a just-superseded session isn't
// released yet. Retrying with a fresh input token after a short delay reliably succeeds
// (this is what the user was doing by hand). Only the transcode path uses these.
const FIRST_OUTPUT_TIMEOUT_MS = 7000;
const TRANSCODE_START_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1200;
// A healthy segment is well above this; a failed start leaves only a ~2KB stub.
const MIN_HEALTHY_SEGMENT_BYTES = 50 * 1024;
// Rolling retention window: segments this far behind the newest are pruned (for a
// transcode, seg #0 is additionally pinned — it carries the decoder headers every new
// reader must start with). 30 × 4s ≈ 2 minutes of look-back, so a viewer can pause the
// TV that long without the pruner deleting not-yet-sent segments out from under the
// reader; with -re pacing that's ≤ ~90MB of disk at 6Mbps.
const RETAIN_SEGMENTS = 30;
const PRUNE_INTERVAL_MS = 5000;

let sessionId: number | null = null;
let running = false;
let activePruneTimer: ReturnType<typeof setInterval> | null = null;
// Monotonic session generation. The ffmpeg completion callback fires ASYNCHRONOUSLY —
// for a superseded session it can land AFTER the replacement session has already
// started, and must not clobber the new session's running/sessionId state (that left
// orphaned encoders running and disabled pruning). Each callback only touches module
// state if its generation is still the current one.
let sessionGen = 0;

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
  if (activePruneTimer) {
    clearInterval(activePruneTimer);
    activePruneTimer = null;
  }
  if (sessionId != null) {
    const id = sessionId;
    sessionId = null;
    await FFmpegKit.cancel(id).catch(() => {});
  }
  await clearLiveDir();
}

/**
 * Shared core for both the HLS remux and the local-file transcode: run FFmpeg with
 * the given `args` (which must write `${LIVE_DIR}/seg%06d.ts`) and return a
 * {@link LiveSource} whose readers hand the media server complete segments in order.
 * Supersedes any segmenter already running.
 *
 * `pinFirstSegment` keeps seg #0 for the whole session — required for the TRANSCODE
 * path, whose hardware encoder writes the H.264 decoder headers (SPS/PPS) only into
 * that first segment, so every new connection must be able to start there. The HLS
 * REMUX path must NOT pin: broadcast streams carry in-band headers before every
 * keyframe (any segment is a valid entry point), and replaying a session's very first
 * segment to a mid-game reconnect would show minutes-old content and a huge timestamp
 * discontinuity.
 */
async function startSegmenter(args: string[], pinFirstSegment: boolean): Promise<LiveSource> {
  if (!ffmpegAvailable) {
    throw new Error('Live streaming needs the FFmpeg build (Android only).');
  }
  await stopLiveRemux();
  if (!(await exists(LIVE_DIR))) await mkdir(LIVE_DIR);
  running = true;
  const gen = ++sessionGen;

  // Rolling-window retention (replaces delete-on-send). Segments used to be handed out
  // destructively — whichever connection read one consumed it, and the renderer's short
  // probe GET would eat seg #0, the ONLY segment carrying the H.264 decoder headers
  // (SPS/PPS: the HW encoder writes them once at stream start, and every bitstream
  // filter that could repeat them crashes this ffmpeg build). The playback GET then got
  // an uninitializable stream and hung in TRANSITIONING. Now nothing is deleted on
  // send: a background pruner drops segments that fall RETAIN_SEGMENTS behind the live
  // edge, and seg #0 is pinned for the whole session (see pickStaleSegments).
  const pruneTimer = setInterval(async () => {
    if (!running) return;
    try {
      const names = (await readDir(LIVE_DIR)).map((e) => e.name);
      for (const name of pickStaleSegments(names, RETAIN_SEGMENTS, pinFirstSegment)) {
        unlink(`${LIVE_DIR}/${name}`).catch(() => {});
      }
    } catch {
      /* transient */
    }
  }, PRUNE_INTERVAL_MS);
  activePruneTimer = pruneTimer;

  /**
   * Independent reader per HTTP connection: each has its OWN cursor starting at the
   * oldest retained segment (for a pinned transcode that's always the headers-bearing
   * seg #0, so probe and playback connections can each initialize a decoder; for the
   * remux it's the tail of the live window). Blocks until the next complete segment
   * is ready; null once the feed ends.
   */
  const createReader = () => {
    let lastIndex = -1;
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
    return { next };
  };

  console.log(`[live-ff] starting ffmpeg: ${args.join(' ')}`);
  const startedAt = Date.now();
  const session = await FFmpegKit.executeWithArgumentsAsync(args, async (s) => {
    // Only the CURRENT session may clear module state: a superseded session's callback
    // fires late (cancel is async) and must not clobber its replacement (which left
    // readers serving the in-progress segment, pruning disabled, and the new ffmpeg
    // uncancellable — an orphaned encoder burning CPU after Stop).
    if (gen === sessionGen) {
      running = false;
      sessionId = null;
    }
    const rc = await s.getReturnCode();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    const kind = ReturnCode.isSuccess(rc) ? 'completed' : ReturnCode.isCancel(rc) ? 'cancelled' : 'FAILED';
    console.log(`[live-ff] ffmpeg ${kind} after ${secs}s (code=${rc?.getValue?.() ?? '?'}${gen === sessionGen ? '' : ', superseded'})`);
  });
  sessionId = session.getSessionId();
  console.log('[live-ff] ffmpeg session started, id=' + sessionId);

  return {
    mime: 'video/mp2t',
    features: contentFeatures('video', true),
    createReader,
    stop: () => {
      void stopLiveRemux();
    },
  };
}

/**
 * Start remuxing `srcUrl` (an HLS playlist) into rolling MPEG-TS segments and
 * return a {@link LiveSource} the media server can stream. Throws if FFmpeg isn't
 * in this binary. Supersedes any run already going.
 */
export async function startLiveRemux(srcUrl: string): Promise<LiveSource> {
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
  return startSegmenter(args, false); // broadcast TS has in-band headers — no seg#0 pin
}

export interface LiveTranscodeTuning {
  /** Downscale target (px); omit to keep source resolution. */
  scaleTo?: { w: number; h: number };
  /** H.264 target bitrate in megabits/s. */
  bitRateMbps: number;
  /** Hardware-decode the source (`-hwaccel mediacodec`). */
  hwDecode?: boolean;
  /** Source frame rate — used to pin the GOP so a keyframe lands on every segment. */
  fps?: number;
}

/**
 * Transcode a LOCAL file (HEVC etc. the TV can't play) into rolling H.264/AAC MPEG-TS
 * segments and return a {@link LiveSource}. Because the hardware encoder runs faster
 * than 1x playback, the TV can start almost immediately and the encoder stays ahead —
 * "play while transcoding", vs waiting for a full up-front convert. `inputPath` must
 * already be FFmpeg-readable (see transcode.ffmpegInput for content:// URIs).
 */
export async function startLiveTranscode(
  sourceUri: string,
  tuning: LiveTranscodeTuning,
): Promise<LiveSource> {
  const vf: string[] = [];
  if (tuning.scaleTo) {
    vf.push(
      `scale=w=${tuning.scaleTo.w}:h=${tuning.scaleTo.h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    );
  }
  // nv12 downconverts 10-bit HDR → 8-bit and gives the HW encoder the format it wants.
  vf.push('format=nv12');
  const buildArgs = (input: string): string[] => [
    '-hide_banner',
    '-loglevel',
    'error',
    // Pace reading to ~1x real time — the config that plays on the Freestyle.
    '-re',
    ...(tuning.hwDecode ? ['-hwaccel', 'mediacodec'] : []),
    '-i',
    input,
    '-c:v',
    'h264_mediacodec',
    '-b:v',
    `${tuning.bitRateMbps}M`,
    // Pin the GOP so a keyframe lands on every segment boundary (fps × segment seconds),
    // making EACH segment independently decodable. The TV's playback GET often starts on
    // a later segment (its probe consumes the first), so without this it begins mid-GOP
    // with no keyframe and sits in TRANSITIONING forever, never decoding. `-g` is honored
    // by h264_mediacodec (unlike `-force_key_frames`).
    ...(tuning.fps && tuning.fps > 0
      ? ['-g', String(Math.max(1, Math.round(tuning.fps * SEGMENT_SECONDS)))]
      : []),
    '-vf',
    vf.join(','),
    // NOTE: no `-bsf:v` of any kind here. BOTH h264_mp4toannexb and dump_extra crash
    // this build's h264_mediacodec pipeline ("non-NULL packet sent after an EOF" →
    // "Error submitting a packet for bitstream filtering", killing the video ~1s in).
    // The decoder-headers problem they'd have solved is handled at the SERVER instead:
    // seg #0 (which carries the one-and-only SPS/PPS) is pinned, and every connection
    // reads independently from seg #0 — see mediaServer.LiveSource.createReader.
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-f',
    'segment',
    '-segment_format',
    'mpegts',
    '-segment_time',
    String(SEGMENT_SECONDS),
    '-reset_timestamps',
    '0',
    `${LIVE_DIR}/seg%06d.ts`,
  ];

  // Auto-retry the flaky first start (AVERROR_INVALIDDATA from an unreleased SAF/HW
  // handle) with a FRESH input token each time — automating the manual "retry until it
  // plays". Return as soon as ffmpeg is actually producing output.
  let source: LiveSource | null = null;
  for (let attempt = 1; attempt <= TRANSCODE_START_ATTEMPTS; attempt++) {
    const input = await ffmpegInput(sourceUri); // fresh SAF token per attempt
    // pin seg #0: it carries the only SPS/PPS this encoder emits (see startSegmenter).
    source = await startSegmenter(buildArgs(input), true); // supersedes any prior session
    if (await firstOutputReady()) {
      if (attempt > 1) console.log(`[live-ff] transcode producing on attempt ${attempt}`);
      return source;
    }
    console.log(
      `[live-ff] attempt ${attempt}/${TRANSCODE_START_ATTEMPTS} produced no output (input/HW not released yet) — retrying`,
    );
    await delay(RETRY_DELAY_MS);
  }
  // All attempts failed to confirm output; return the last source so the cast surfaces
  // a clean error rather than hanging.
  return source as LiveSource;
}

/**
 * Resolve true once ffmpeg has actually started producing real output, or false if it
 * died first (running flipped back off — e.g. INVALIDDATA). We require a segment
 * ≥ MIN_HEALTHY_SEGMENT_BYTES: a failing session leaves only a ~2KB stub, so "a file
 * exists" isn't enough to call the start healthy. If the timeout elapses with ffmpeg
 * still alive, we give it the benefit of the doubt (return true) — killing a slow but
 * healthy start just to retry would be strictly worse.
 */
async function firstOutputReady(): Promise<boolean> {
  let waited = 0;
  while (waited < FIRST_OUTPUT_TIMEOUT_MS) {
    if (!running) return false; // ffmpeg exited early
    let healthy = false;
    try {
      healthy = (await readDir(LIVE_DIR)).some(
        (e) => /seg\d+\.ts$/.test(e.name) && (e.size ?? 0) >= MIN_HEALTHY_SEGMENT_BYTES,
      );
    } catch {
      /* transient */
    }
    if (healthy) return true;
    await delay(POLL_MS);
    waited += POLL_MS;
  }
  return running;
}
