// Generates the app icons from a single SVG design.
//   bun run scripts/gen-icons.mjs
// Concept: a play triangle with broadcast waves radiating from it ("press play →
// cast out") on a bright, near-white tile so the icon stays a crisp, defined square
// on any home screen (it used to be dark navy and faded into black wallpapers).
//
// Besides the default blue set, this emits one full opaque variant per theme accent
// into assets/icons/, so the launcher icon can follow the chosen accent (wired via
// @howincodes/expo-dynamic-app-icon). The pale tile + mark are both derived from the
// accent; light accents (lime, amber…) get a darkened mark so they stay readable.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { ACCENTS, mix, hexToRgb } from "../src/theme/themes.ts";

const BRAND = "#4f8cff"; // the "blue" accent — drives the default icon set

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b; // 0..255
}

// Pure white tile — the accent lives entirely in the mark. Clean on any light UI.
function tileStops(_hex) {
  return ["#ffffff", "#ffffff", "#ffffff"];
}
// Mark gradient: vivid accent for medium/dark accents; darkened for light ones so it
// keeps contrast against the pale tile.
function markStops(hex) {
  const L = luminance(hex);
  let mid = hex;
  if (L > 150) mid = mix(hex, "#000000", Math.min(0.62, (L - 150) / 120 + 0.2));
  return [mix(mid, "#ffffff", 0.2), mid, mix(mid, "#000000", 0.42)];
}

function stops(id, x2, y2, arr) {
  const s = arr.map((c, i) => `<stop offset="${i / (arr.length - 1)}" stop-color="${c}"/>`).join("");
  return `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${s}</linearGradient>`;
}
function defs(hex) {
  return `<defs>${stops("bg", 0.6, 1, tileStops(hex))}${stops("mark", 0.9, 1, markStops(hex))}</defs>`;
}

const background = `<rect width="1024" height="1024" fill="url(#bg)"/>`;

// Play triangle (rounded via a same-paint round-join stroke) + 3 broadcast arcs.
function glyph({ paint = "url(#mark)", scale = 1 } = {}) {
  const arcs = `
    <g fill="none" stroke="${paint}" stroke-width="36" stroke-linecap="round">
      <path d="M581 446 A78 78 0 0 1 581 578"/>
      <path d="M619 384 A150 150 0 0 1 619 640" opacity="0.8"/>
      <path d="M658 322 A222 222 0 0 1 658 702" opacity="0.6"/>
    </g>`;
  const triangle = `<path d="M300 330 L300 694 L540 512 Z" fill="${paint}" stroke="${paint}" stroke-width="44" stroke-linejoin="round"/>`;
  return `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)"><g transform="translate(-18 0)">${arcs}${triangle}</g></g>`;
}

const svg = (body, hex = BRAND) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${defs(hex)}${body}</svg>`;

function render(svgStr, size, out) {
  const png = new Resvg(svgStr, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  })
    .render()
    .asPng();
  writeFileSync(out, png);
  console.log(`wrote ${out} (${size}px)`);
}

// ---- Default brand icon set (blue) ----
const full = svg(background + glyph());
render(full, 1024, "assets/icon.png");
render(full, 1024, "assets/splash-icon.png");
render(full, 64, "assets/favicon.png");
render(svg(background), 1024, "assets/android-icon-background.png");
render(svg(glyph({ scale: 0.82 })), 1024, "assets/android-icon-foreground.png");
render(svg(glyph({ paint: "#ffffff", scale: 0.82 })), 1024, "assets/android-icon-monochrome.png");

// ---- Per-accent variants (for the dynamic launcher icon) ----
//   icons/<key>.png    — full opaque square (iOS alternate icon)
//   icons/<key>-fg.png — transparent foreground only (Android adaptive, on tileSolid)
mkdirSync("assets/icons", { recursive: true });
for (const a of ACCENTS) {
  render(svg(background + glyph(), a.color), 1024, `assets/icons/${a.key}.png`);
  render(svg(glyph({ scale: 0.82 }), a.color), 1024, `assets/icons/${a.key}-fg.png`);
}
console.log(`wrote ${ACCENTS.length} accent variants (opaque + adaptive fg)`);

// ---- Notification status-bar icon (white silhouette on transparent) ----
// Android tints the small icon, so it must be a single-color/alpha glyph. Lives in
// the cast-keep-alive module's res so it survives `expo prebuild` (which wipes /android).
const NOTIF_RES = "modules/cast-keep-alive/android/src/main/res";
const NOTIF_DPIS = {
  "drawable-mdpi": 24,
  "drawable-hdpi": 36,
  "drawable-xhdpi": 48,
  "drawable-xxhdpi": 72,
  "drawable-xxxhdpi": 96,
};
for (const [dir, px] of Object.entries(NOTIF_DPIS)) {
  mkdirSync(`${NOTIF_RES}/${dir}`, { recursive: true });
  render(svg(glyph({ paint: "#ffffff", scale: 0.92 })), px, `${NOTIF_RES}/${dir}/ic_stat_cast.png`);
}
console.log("wrote notification icon (ic_stat_cast) at 5 densities");

// NOTE: the Android adaptive backgroundColor for every variant is white (#ffffff),
// set in app.json. If you ever reintroduce a tinted tile, update app.json's
// android.adaptiveIcon backgroundColor and each per-accent backgroundColor to match.
