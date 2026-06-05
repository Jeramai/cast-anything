# Cast Anything

A small Expo (React Native) app that casts **video, music, and photos** from your
phone to a **Samsung TV** (or any DLNA media renderer) on the same Wi‑Fi network.

It discovers the TV with **SSDP/UPnP**, serves the picked file from a tiny HTTP
server running on the phone, and drives playback with **DLNA AVTransport**
(play / pause / stop / seek / volume).

---

## ⚠️ What this can and can't do (read first)

Samsung TVs run **Tizen**, not Android TV, so they **do not support Chromecast**.
This app uses **DLNA**, which Samsung TVs *do* support. That has real limits:

| Goal | Supported? | Notes |
| --- | --- | --- |
| Cast a video / song / photo **file** from the phone | ✅ Yes | This app. |
| Cast a media **URL** (http/https) | ✅ Yes | Paste it in the URL box. |
| **Mirror your whole screen** (anything on screen) | ❌ No | Needs OS‑level mirroring (Miracast / Samsung Smart View). Use your phone's built‑in *Screen Mirroring* / *Smart View* for that. |
| Relay **Netflix / YouTube / Disney+** etc. | ❌ No | DRM‑protected; those apps use their own cast SDKs. |

The TV also has to **support the file's codec/container** (e.g. H.264 MP4 plays
everywhere; MKV/HEVC may not on older sets). DLNA only delivers the bytes — the
TV decodes them.

---

## Requirements

- A **development build** — this app uses native modules (UDP sockets, a native
  HTTP server), so **Expo Go will not work**.
- Node 18+, the toolchain installed by `npm install`.
- **Android:** Android Studio / SDK + a device or emulator. Easiest to test.
- **iOS:** Xcode + a **real iPhone** (the simulator can't reach the TV reliably),
  **plus the multicast entitlement** — see the iOS section below.
- Your phone and the TV must be on the **same Wi‑Fi network** (and the network
  must not have "AP/client isolation" enabled).

---

## Run it

```bash
npm install

# Android (device or emulator attached via adb):
npm run android        # = expo run:android

# iOS (real device recommended):
npm run ios            # = expo run:ios
```

`expo run:*` will prebuild the native project, build a dev client, and launch it.
After the first build you can just `npm start` (= `expo start --dev-client`) and
open the dev client.

### iOS multicast entitlement (important)

SSDP discovery sends to a **multicast** address. Since iOS 14, Apple requires the
`com.apple.developer.networking.multicast` entitlement for that. It is already
declared in [`app.json`](app.json), **but Apple gates it**: you must request it
once for your Apple Developer account at
<https://developer.apple.com/contact/request/networking-multicast> and enable the
"Multicast Networking" capability on the App ID. Until then, **device discovery
will silently find nothing on iOS** (everything else still works). Android has no
such restriction.

On first launch iOS also shows a **"Cast Anything would like to find devices on
your local network"** prompt — tap **Allow**, or discovery returns nothing.

---

## How to use

1. **Scan for devices** → tap your TV in the list (Samsung sets show 📺).
2. **Pick a file** from your phone, **or** paste a media URL.
3. **Cast to device ▶** — playback starts on the TV.
4. Use **Play / Pause / Stop / ⏪15 / 15⏩** and the **🔉 − / 🔊 +** volume
   buttons. Volume steps **one notch at a time** (the readout between the
   buttons shows the TV's current 0–100 level). **Photos** only show a *Remove
   from screen* button — there's no timeline or volume to control for an image.

The first time, the Samsung TV may show an **"Allow this device to connect?"**
prompt — accept it on the TV with the remote.

---

## Background casting & the playback notification

While **any** cast is active, the app shows a **playback notification** and keeps
itself alive so controls keep working with the screen off. (A **local** file is
also *served from the phone*, so the phone genuinely has to keep running; a remote
**URL** is fetched by the TV directly, but the notification still gives you a
remote control.) Via the local native module
[`modules/cast-keep-alive`](modules/cast-keep-alive):

- **Android:** a **foreground service** that posts a **media-style notification**
  — title, **⏪15 / play-pause / 15⏩ / stop** buttons, and (for audio/video) a
  **lock-screen seek bar** — backed by a `MediaSession`, so the controls also
  appear on the lock screen and respond to Bluetooth/headset keys. Photos show
  just a *Remove* action (no timeline). Tapping a control routes back through the
  app to the matching DLNA / signage command. The service also holds a partial
  **wake lock** + a high-performance **Wi-Fi lock** so a local-file cast keeps
  serving with the screen fully off/locked.
- **iOS:** a `UIApplication` **background task** (no media notification — iOS has
  no app-controllable media controls without an active audio session). iOS does
  **not** allow an indefinite background HTTP server — it closes listening sockets
  once the app is suspended — so this only buys a **short grace window** (tens of
  seconds) after a manual lock. Keep-awake (`expo-keep-awake`) covers the common
  idle-lock case; for truly indefinite locked playback on iOS there's no
  App-Store-safe mechanism (the usual workaround is playing silent audio under the
  `audio` background mode, which this app deliberately does **not** do).

> **Rebuild required.** This adds native code (`expo-keep-awake` + the local
> `cast-keep-alive` module), so you must **`npx expo prebuild` and rebuild the
> dev client** (`npm run android` / `npm run ios`) for it to take effect. The JS
> degrades gracefully on an older binary — it just no-ops until rebuilt. On
> Android 13+ the notification needs the **POST_NOTIFICATIONS** permission to be
> visible; the service (and casting) run either way.

---

## Samsung signage panels (MDC / URL Launcher)

Samsung **commercial signage** displays (e.g. QMR series, shown as `[Signage] …`)
advertise a DLNA renderer but **reject generic DLNA push** (`SetAVTransportURI`
→ UPnP 402). They take content via MagicINFO / URL Launcher instead. So for a
device detected as signage, the app uses a different path:

1. Serves a fullscreen **player page** (as `index.html`, so the panel reaches it
   at just `http://<phone-ip>:51799`) + the media, from the phone.
2. Best-effort drives the panel over the **MDC protocol** (TCP **1515**) to set
   the launcher URL and switch source — but many panels NAK this, so the app
   also shows the URL to enter on the panel **once**, by hand.
3. The player page polls for the current media, so after the one-time setup
   every cast updates the screen live without touching the panel again.

Selecting a signage device shows a **one-time setup card** with the exact
address to enter on the panel and a warning if the phone is on an unreachable
(emulator/loopback) address.

**Playback controls (event-driven):** the player page opens a **WebSocket** back
to the phone (a tiny WS server built on `react-native-tcp-socket`, in
[src/ws/wsServer.ts](src/ws/wsServer.ts)). The app pushes media + commands
(play/pause, ±15s seek, and **tap-to-seek** on the progress bar) instantly, and
the panel streams playback **status** back, so the app shows a live progress bar
and accurate play/pause/connection state. If the socket is down, the player
falls back to polling `current.json` for media so content still shows.

**Audio:** signage URL-Launcher browsers **block audio on autoplay** and there's
no user gesture available on a panel to unlock it, so video plays **muted**
(confirmed on the QMR test unit). There are no volume/mute controls because they
can't do anything there. A panel-side setting (if any) is the only way to enable
sound; the app can't force it.

To pick up a new player build, reload the panel's URL Launcher by hand (kiosk
browsers mishandle programmatic reloads, so there's no auto-reload).

**Prerequisite (one-time, on the panel):** URL Launcher must be enabled —
**Home → URL Launcher Settings → Install Web App** (and **Menu → System → Play
via → URL Launcher** if present). If the panel's firmware won't let the app set
the launcher URL over MDC, the app shows the exact URL to paste there once;
after that, casts update live. (And as always, the phone must be a real device
on the panel's LAN, not an emulator.)

## Project layout

```
App.tsx                     UI: device list, picker, playback controls
src/
  dlna/
    ssdp.ts                 SSDP M-SEARCH discovery over UDP multicast
    device.ts               Fetch + parse the UPnP device description XML
    avtransport.ts          SOAP control: SetAVTransportURI/Play/Pause/Stop/Seek
                            /GetPositionInfo/GetTransportInfo/Get+SetVolume + DIDL-Lite
    url.ts                  Relative→absolute URL resolution (RN's URL is unreliable)
    types.ts                Shared types
    index.ts                discoverDevices() orchestration + barrel exports
  server/
    fileServer.ts           Native HTTP server (Range-capable) to stream local files
  media/
    media.ts                File picker + MIME/kind inference (+ URL helper)
  background/
    keepAlive.ts            Keep-awake + foreground/background keep-alive while casting
  hooks/
    useCast.ts              State machine tying discovery, server and playback together
modules/
  cast-keep-alive/          Local Expo module: Android foreground service / iOS bg task
```

### Key native dependencies

- `react-native-udp` — UDP sockets for SSDP. *(Flagged "unmaintained" by
  expo-doctor; it's the only viable RN UDP library and runs via the new-arch
  interop layer. The doctor warning is suppressed in `package.json`.)*
- `@dr.pogodin/react-native-static-server` + `@dr.pogodin/react-native-fs` —
  native Lighttpd server that handles **HTTP Range** requests, so video seeking
  works and large files stream without buffering through JS. (Both ship
  TurboModule specs and support the New Architecture.)
- `expo-keep-awake` — stops the screen auto-locking while a local-file cast is
  active (paired with the `cast-keep-alive` module for true background serving).
- `expo-document-picker`, `expo-network`, `expo-system-ui`,
  `react-native-safe-area-context`.

---

## Troubleshooting

- **No devices found:**
  - Phone and TV on the **same Wi‑Fi**? (Not a guest network; 2.4 vs 5 GHz on the
    same router is usually fine.)
  - Router **"AP isolation" / "client isolation"** must be **off** — it blocks
    devices from seeing each other.
  - On the TV, make sure DLNA / "external device manager" / screen‑sharing access
    is enabled.
  - **iOS:** confirm the multicast entitlement is approved and the local‑network
    permission was allowed (Settings → the app → Local Network).
  - Tap **Scan** again — some TVs answer slowly or were asleep.
- **Casting a local file fails (UPnP 716, or "the TV can't reach this device"):**
  you're almost certainly on an **emulator / simulator**. The TV pulls the file
  *from the phone*, but an emulator's NAT address (e.g. Android's `10.0.2.15`)
  isn't reachable from the LAN. **Run on a physical phone** on the same Wi-Fi.
  (Discovery and the on-screen controls still work on an emulator because those
  go phone→TV; only the TV→phone file fetch fails. To test the control path on an
  emulator, cast a **public URL** instead — the TV fetches that directly.)
- **Device found but casting fails / TV says "format not supported":** the TV
  can't decode that container/codec. Try an H.264 **.mp4** (or, for photos, a
  **.jpg/.png** — note iPhone **HEIC** photos often won't display on Samsung).
- **"Another Server instance is active" (dev only):** the native file server is
  a singleton thread that survives a JS reload, so a reload can orphan it. The
  app handles this by running on a fixed port and **reusing** a server that's
  already listening (so reloads are seamless). If you're upgrading from an older
  build that used a random port, **fully restart the app once** to clear the
  legacy orphan; after that, reloads just reuse the running server.
- **Playback stops when the phone locks / app backgrounds:** a local file is
  served *from the phone*, so the phone has to stay alive. The app now keeps it
  alive while a cast is active, with a playback notification — see
  [Background casting & the playback notification](#background-casting--the-playback-notification)
  below. Note
  this needs a **rebuild** to take effect, and **iOS can only hold a short grace
  window** when manually locked. Casting a remote **URL** never depends on the
  phone, since the TV fetches it directly from the internet.

---

## Building for distribution (optional)

Use [EAS Build](https://docs.expo.dev/build/introduction/):

```bash
npm i -g eas-cli
eas build --profile development --platform android   # or ios
```

For an iOS production/TestFlight build, the multicast entitlement must be
approved on your Apple account (see above), or App Store review will reject it.
