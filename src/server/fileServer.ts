import StaticServer, {
  STATES,
} from '@dr.pogodin/react-native-static-server';
import {
  CachesDirectoryPath,
  copyFile,
  exists,
  mkdir,
  readDir,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import * as Network from 'expo-network';
import { getWsPort } from '../ws/wsServer';

/**
 * Serves locally-picked media over HTTP so a TV on the same Wi-Fi can stream it.
 * Uses a native Lighttpd server (handles HTTP Range requests, so video seeking
 * works).
 *
 * The native server is a singleton thread guarded by a *static* field, and it
 * survives a JS reload (its thread can't be stopped from JS once our module
 * reference is gone). So instead of fighting that, we run on a FIXED PORT and
 * reuse any server already listening there — whether it's ours or one orphaned
 * by a previous reload. Both serve the same SHARE_DIR, so reuse is transparent.
 */

const SHARE_DIR = `${CachesDirectoryPath}/cast-share`;
// Fixed, uncommon port (private range) so we can detect & reuse a running server
// across JS reloads instead of colliding with it.
const SERVER_PORT = 51799;
const PROBE_TIMEOUT_MS = 1500;

let server: StaticServer | null = null;
let origin: string | null = null;
let startPromise: Promise<string> | null = null;

async function ensureShareDir(): Promise<void> {
  if (!(await exists(SHARE_DIR))) {
    await mkdir(SHARE_DIR);
  }
}

async function getLanIp(): Promise<string> {
  try {
    const ip = await Network.getIpAddressAsync();
    if (ip && ip !== '0.0.0.0') return ip;
  } catch {
    /* fall through */
  }
  return '127.0.0.1';
}

/** True if something is already answering HTTP at `originUrl` (server is up). */
async function isServerUp(originUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Any HTTP response (even 403/404) means a server is listening.
    await fetch(`${originUrl}/?cast-probe=1`, {
      method: 'GET',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Create + start a fresh server bound to the LAN IP on the fixed port. */
async function launch(ip: string): Promise<string> {
  await ensureShareDir();
  const next = new StaticServer({
    fileDir: SHARE_DIR,
    hostname: ip, // bind to the LAN IP (TV-reachable); ignores `nonLocal`
    port: SERVER_PORT,
    stopInBackground: false,
  });
  // If the native server dies later, drop our cached handle so the next cast
  // re-resolves (reuse or restart) instead of using a dead reference.
  next.addStateListener((state) => {
    if (state === STATES.CRASHED && server === next) {
      server = null;
      origin = null;
    }
  });
  const url = await next.start();
  server = next;
  return url.replace(/\/$/, '');
}

/**
 * Start (or reuse) the file server and return its LAN origin. Idempotent and
 * reload-safe: if a server is already listening on the fixed port — including
 * one orphaned by a JS reload — we reuse it rather than starting a colliding
 * instance, so the user never has to restart the app.
 */
export async function startFileServer(): Promise<string> {
  if (origin && server && server.state === STATES.ACTIVE) return origin;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    await ensureShareDir();
    const ip = await getLanIp();
    const candidate = `http://${ip}:${SERVER_PORT}`;

    // Reuse a server already on our port (e.g. survivor of a JS reload).
    if (await isServerUp(candidate)) {
      origin = candidate;
      return origin;
    }

    try {
      origin = await launch(ip);
      return origin;
    } catch (err) {
      // Race: nothing answered the probe, but start still collided with a
      // lingering instance. If one is now reachable, reuse it.
      console.warn('[fileServer] start failed; checking for existing server:', err);
      if (await isServerUp(candidate)) {
        origin = candidate;
        return origin;
      }
      throw err;
    }
  })();

  try {
    return await startPromise;
  } catch (e) {
    server = null;
    origin = null;
    throw e;
  } finally {
    startPromise = null;
  }
}

export async function stopFileServer(): Promise<void> {
  if (server) {
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
  }
  server = null;
  origin = null;
}

export function getServerOrigin(): string | null {
  return origin;
}

// Shown in the on-screen status so you can tell which player a panel is running.
const PLAYER_VERSION = 9;
const WS_PORT = getWsPort();

// Fullscreen player loaded by the panel's URL Launcher. Event-driven over a
// WebSocket to the phone (instant media/controls + streams playback status
// back); falls back to polling current.json for media if the socket is down.
// Forces muted autoplay (the only kind kiosk browsers allow), then tries to
// unmute once it's playing.
const PLAYER_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cast Anything</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
#stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000}
video,img{width:100%;height:100%;object-fit:contain}
#idle{color:#888;font-family:sans-serif;font-size:3vh;text-align:center;padding:4vh}
#status{position:fixed;left:10px;bottom:8px;color:#555;font-family:monospace;font-size:2.2vh;z-index:9}
</style></head><body>
<div id="stage"><div id="idle">Cast Anything &mdash; waiting for media&hellip;</div></div>
<div id="status"></div>
<script>
(function(){
  var PV=${PLAYER_VERSION},WSPORT=${WS_PORT};
  var stage=document.getElementById('stage'),statusEl=document.getElementById('status');
  var cur=null,mediaEl=null,ws=null,wsOk=false;
  function setStatus(s){statusEl.textContent='v'+PV+(wsOk?' •':' ∘')+' '+s;}
  function sendStatus(){
    if(!ws||ws.readyState!==1||!mediaEl||mediaEl.tagName==='IMG')return;
    try{ws.send(JSON.stringify({type:'status',
      state:mediaEl.paused?'paused':'playing',
      position:mediaEl.currentTime||0,
      duration:isFinite(mediaEl.duration)?mediaEl.duration:0}));}catch(e){}
  }
  // Muted autoplay — the only kind this kiosk browser allows. (We confirmed it
  // blocks autoplay-with-sound, and signage offers no user gesture to unlock it.)
  function playMedia(el,url){
    mediaEl=el;
    el.muted=true;el.setAttribute('muted','');el.autoplay=true;el.setAttribute('playsinline','');
    function tryPlay(){try{var q=el.play();if(q&&q.catch)q.catch(function(){});}catch(e){}}
    el.oncanplay=tryPlay;el.onloadeddata=tryPlay;
    el.onplaying=function(){setStatus('playing (muted)');sendStatus();};
    el.onpause=function(){sendStatus();};
    el.ontimeupdate=sendStatus;
    el.onerror=function(){var c=el.error&&el.error.code;setStatus('error '+c+' - format not supported (use H.264 MP4)');};
    el.src=url;stage.innerHTML='';stage.appendChild(el);setStatus('loading\\u2026');
    tryPlay();
  }
  function render(m){
    if(m.kind==='video'){var v=document.createElement('video');v.loop=true;playMedia(v,m.url);}
    else if(m.kind==='audio'){var a=document.createElement('audio');a.controls=true;playMedia(a,m.url);}
    else{mediaEl=null;stage.innerHTML='';var i=document.createElement('img');i.src=m.url;i.onload=function(){setStatus('image');};i.onerror=function(){setStatus('image failed to load');};stage.appendChild(i);}
  }
  function maybeRender(m){if(m&&m.url&&m.v!==cur){cur=m.v;render(m);}}
  function applyControl(c){
    if(!mediaEl)return;var a=c.action;
    try{
      if(a==='play'){if(mediaEl.tagName==='VIDEO')mediaEl.loop=true;mediaEl.play&&mediaEl.play();}
      else if(a==='pause'){mediaEl.pause&&mediaEl.pause();}
      else if(a==='seekBy'){mediaEl.currentTime=Math.max(0,(mediaEl.currentTime||0)+(c.value||0));}
      else if(a==='seekTo'){mediaEl.currentTime=Math.max(0,c.value||0);}
    }catch(e){}
    sendStatus();
  }
  function connectWs(){
    try{ws=new WebSocket('ws://'+location.hostname+':'+WSPORT);}catch(e){setTimeout(connectWs,2000);return;}
    ws.onopen=function(){wsOk=true;setStatus('connected');};
    ws.onmessage=function(ev){var m;try{m=JSON.parse(ev.data);}catch(e){return;}
      if(m.type==='media'){maybeRender(m);}else if(m.type==='control'){applyControl(m);}};
    ws.onclose=function(){wsOk=false;ws=null;setTimeout(connectWs,1500);};
    ws.onerror=function(){try{ws.close();}catch(e){}};
  }
  // Media fallback if the socket is unavailable.
  function poll(){fetch('./current.json?ts='+Date.now(),{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(maybeRender).catch(function(){});}
  connectWs();
  setInterval(poll,2500);poll();
  setInterval(sendStatus,1000);
})();
</script></body></html>`;

/**
 * Ensure the player page is served and return its URL. Written as `index.html`
 * so the panel can reach it at the bare origin (`http://ip:port`) — far less to
 * type on a TV remote.
 */
export async function writePlayerPage(): Promise<string> {
  const baseOrigin = await startFileServer();
  await ensureShareDir();
  await writeFile(`${SHARE_DIR}/index.html`, PLAYER_HTML, 'utf8');
  return baseOrigin;
}

/**
 * Write current.json — the media fallback the player polls if the WebSocket is
 * down. `v` is the cast token (shared with the WS push) so the player de-dupes.
 */
export async function setCurrentMedia(media: {
  url: string;
  kind: string;
  title: string;
  v: string;
}): Promise<void> {
  await ensureShareDir();
  await writeFile(`${SHARE_DIR}/current.json`, JSON.stringify(media), 'utf8');
}

/** Keep filenames URL/filesystem-safe while preserving the extension. */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned.replace(/^_+|_+$/g, '') || `media-${Date.now()}`;
}

async function clearShareDir(): Promise<void> {
  try {
    const entries = await readDir(SHARE_DIR);
    await Promise.all(entries.map((e) => unlink(e.path).catch(() => {})));
  } catch {
    /* dir may not exist yet */
  }
}

/**
 * Copy a picked local file into the served directory and return the URL the TV
 * should stream from. Replaces any previously shared file (we only cast one
 * item at a time, so this keeps the cache small).
 */
export async function shareLocalFile(
  localUri: string,
  displayName: string,
): Promise<string> {
  const baseOrigin = await startFileServer();
  await ensureShareDir();
  await clearShareDir();

  const safeName = sanitizeFileName(displayName);
  const destPath = `${SHARE_DIR}/${safeName}`;
  const fromPath = localUri.replace(/^file:\/\//, '');

  if (await exists(destPath)) {
    await unlink(destPath).catch(() => {});
  }
  await copyFile(fromPath, destPath);

  return `${baseOrigin}/${encodeURIComponent(safeName)}`;
}
