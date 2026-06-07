import {
  setCurrentMedia,
  shareLocalFile,
  startFileServer,
  writePlayerPage,
} from '../server/fileServer';
import {
  INPUT_URL_LAUNCHER,
  PLAY_VIA_URL_LAUNCHER,
  setInputSource,
  setLauncherUrl,
  setPlayVia,
} from '../mdc/mdc';
import type { MediaItem } from '../media/media';
import { isUnreachableByLan, parseUrl } from '../dlna/url';
import { wsSetMedia } from '../ws/wsServer';

export interface SignageCastResult {
  /** The URL the panel's URL Launcher should load. */
  playerUrl: string;
  /** We set the launcher URL automatically over MDC. */
  urlSetViaMdc: boolean;
  /** We switched the panel's input to URL Launcher over MDC. */
  sourceSwitched: boolean;
  /** True if the user must set the launcher URL manually on the panel. */
  needsManualSetup: boolean;
  /** False when the player URL is an emulator/loopback the panel can't reach. */
  reachable: boolean;
  /** Human-readable next-step message for the UI. */
  message: string;
}

/**
 * Cast to a Samsung signage panel that doesn't accept DLNA push. We serve a
 * fullscreen player page (and the media) from the phone, then drive the panel
 * over MDC to load it. If the panel doesn't allow setting the launcher URL over
 * MDC, we return the URL for the user to configure once on the panel; after
 * that, future casts update live via the page's polling.
 */
export async function castToSignage(
  host: string,
  media: MediaItem,
): Promise<SignageCastResult> {
  // 1) Make the media reachable. Local files are copied into the served dir
  //    (this also starts the server); remote URLs are used directly.
  let mediaUrl = media.uri;
  if (media.isLocal) {
    mediaUrl = await shareLocalFile(media.uri, media.name, {
      mime: media.mime,
      kind: media.kind,
    });
  } else {
    await startFileServer();
  }

  // 2) Serve the player page and point it at the media. (Order matters:
  //    shareLocalFile clears the served dir, so write these AFTER it.) The same
  //    `v` token goes to the WS push and the current.json fallback so the player
  //    de-dupes either source.
  const playerUrl = await writePlayerPage();
  const item = {
    url: mediaUrl,
    kind: media.kind,
    title: media.name,
    v: String(Date.now()),
  };
  await setCurrentMedia(item);
  wsSetMedia(item); // instant push to any connected panel

  // 3) Drive the panel over MDC (best effort — older firmware may NAK these).
  let urlSetViaMdc = false;
  let sourceSwitched = false;
  try {
    urlSetViaMdc = (await setLauncherUrl(host, playerUrl)).ok;
  } catch {
    /* NAK / unsupported */
  }
  try {
    await setPlayVia(host, PLAY_VIA_URL_LAUNCHER);
  } catch {
    /* best effort */
  }
  try {
    sourceSwitched = (await setInputSource(host, INPUT_URL_LAUNCHER)).ok;
  } catch {
    /* best effort */
  }

  const needsManualSetup = !urlSetViaMdc;
  const reachable = !isUnreachableByLan(parseUrl(playerUrl).host);

  let message: string;
  if (!reachable) {
    message =
      `This phone's address (${parseUrl(playerUrl).host}) can't be reached by ` +
      `the panel — that's an emulator/loopback. Run the app on a real phone on ` +
      `the panel's Wi-Fi, then try again.`;
  } else if (urlSetViaMdc && sourceSwitched) {
    message = 'Sent to the panel via URL Launcher.';
  } else if (urlSetViaMdc) {
    message = 'Launcher URL set. Switch the panel’s source to URL Launcher.';
  } else {
    message =
      'Set this up once on the panel: Home → URL Launcher Settings → Install ' +
      'Web App, enter the address below, then open URL Launcher. After that, ' +
      'every cast updates the screen automatically.';
  }

  return {
    playerUrl,
    urlSetViaMdc,
    sourceSwitched,
    needsManualSetup,
    reachable,
    message,
  };
}
