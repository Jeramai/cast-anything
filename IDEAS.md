# Cast Anything — Ideas backlog

Fun features to build next. Each note points at the existing infrastructure it can
reuse (on-phone TCP media server, live FFmpeg HLS→MPEG-TS pipeline, queue engine,
WebSocket + served player page, image casting, keep-alive foreground service).

## Quick wins
- [ ] **Sleep timer** — stop casting after N minutes, or at the end of the current
      item. Builds on the existing playback controls + the `backgroundSleep` timer
      (so it survives screen-off). Cozy fall-asleep-to-a-show feature.
- [ ] **"Surprise me" / shuffle-all** — cast a random playable file from a folder,
      or shuffle the whole phone into a personal TV channel. Builds on the folder
      picker + queue + shuffle order.
- [ ] **QR code for "Stream via URL"** — the file is already served over HTTP; render
      a QR of that URL so anyone can scan and open it on a laptop/tablet/VLC.

## Bigger fun
- [ ] **Ambient photo-frame mode** — auto-advancing image slideshow with a slow
      Ken Burns pan/zoom and optional queued background music. Turns the TV into a
      classy digital photo frame. Reuses image-cast + queue + audio.
- [ ] **Party jukebox** — extend the on-phone web server + WebSocket + served player
      page so anyone on the Wi-Fi opens a small page (via a shown QR) and adds
      songs/videos to the queue. Crowd-controlled playback that auto-plays on the TV.
      The architecture is ~70% there already.
- [ ] **IPTV / M3U channels** — parse an `.m3u` playlist into a channel list and
      reuse the live HLS→MPEG-TS remux pipeline (now screen-off-safe) to play live
      channels. Effectively a live-TV player.
- [ ] **Now-Playing screen for audio** — casting music currently shows a black TV.
      Serve a themed now-playing card (artwork + title + progress bar, in the current
      accent theme) so audio looks intentional.

## Deferred / tracked
- [ ] **reanimated + gesture-handler migration** — replace `Animated` / `PanResponder`
      (the NowPlayingSheet drag and QueueRow swipe) with `react-native-reanimated` +
      `react-native-gesture-handler`. Clears the last 2 React Doctor findings (→ 100).
      Adds native deps + babel plugin + `GestureHandlerRootView`; needs a rebuild and
      a full on-device gesture/animation retest. Do on its own branch.
