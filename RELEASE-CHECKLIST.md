# Cast Anything — Play release checklist

Status as of 2026-07-19. `ai.jeram.castanything`, personal Play account (gameout-501508).

## ✅ Done (automated via `fastlane android update_listing`)
- Main store listing **title**, **short description**, **full description**
- **App icon** 512×512, **feature graphic** 1024×500
- **6 phone screenshots** 2160×3840
- **6 tablet screenshots** 2560×1600, in both the 7" and 10" slots
- Filled for **both languages**: `en-GB` (the listing's **default** language) and `en-US`.

> ⚠️ Gotcha for next time: this app's listing default language is **en-GB**. Play grades
> completeness on the default language, so content uploaded only to `en-US` leaves the
> Console saying "fill in the app details". Keep `fastlane/metadata/android/en-GB/`
> populated (it currently mirrors en-US), or switch the default to en-US in
> **Store settings → App details**.

Re-run any time after editing copy/art: `bundle exec fastlane android update_listing`.

## 🧪 Closed testing — staged, needs activation
A **draft** release of **vc 5 / 1.0.4** is now on the **Closed testing (alpha)** track
with release notes (`fastlane/metadata/android/{en-US,en-GB}/changelogs/5.txt`). The
internal track is untouched and nothing is rolled out. To make it live to testers and
start the 14-day clock:

1. **Finish App content** (see below) — Play blocks rollout to *any* track until content
   rating, data safety, privacy policy, target audience, ads, app access, and the
   foreground-service / photo-&-video declarations are done.
2. **Add testers** to the closed track: *Testing → Closed testing → Alpha → Testers* —
   an email list or Google Group with **≥12 testers** (the personal-account gate).
3. **Roll out the draft**: open the Alpha release and *Start rollout*, or set
   `release_status: "completed"` in the `closed_testing` lane and re-run
   `bundle exec fastlane android closed_testing`.
4. Testers opt in via the closed-testing link, install, and the **14-day** period runs.

## ⛔ Remaining — Play Console only (can't be done via the API)

Ordered by what blocks a Production rollout. Recommended answers are based on how the
app actually behaves (no accounts, no ads, no analytics/trackers, LAN-only).

1. **Privacy policy URL** *(required)*
   - Host `docs/privacy-policy.html` — simplest is GitHub Pages: repo **Settings → Pages → Deploy from branch → `main` / `/docs`**, which serves it at
     `https://jeramai.github.io/cast-anything/privacy-policy.html`.
   - First replace `REPLACE_WITH_CONTACT_EMAIL` in that file with the address you want public.
   - Put the URL in **Store settings → Store listing contact / App content → Privacy policy**.

2. **Store settings**
   - **Category:** *Video Players & Editors* (best fit) — or *Tools*.
   - **Contact email** (required), website/phone optional.
   - Tags: casting, DLNA, media player.

3. **App content** (each is a required form)
   - **Content rating** (IARC questionnaire): utility, no objectionable content → expect **Everyone / PEGI 3**.
   - **Target audience & content:** 13+/adults; **not** designed for children.
   - **Data safety:** recommended **"No data collected" / "No data shared"** — the app has no accounts, ads, analytics or trackers, and doesn't send data to the developer. ⚠️ Judgement call: the optional subtitle search sends the title you type to **subdl.com** (a third party you don't control). Most treat this user-initiated lookup as not "collection," but declare it however you read Play's policy.
   - **Ads:** No.
   - **App access:** All functionality is available without special access (no login).
   - **Foreground service** *(required — the app uses one)*: declare type **mediaPlayback**; justification: *"Shows playback controls in a notification / on the lock screen and keeps casting the selected media to the TV while the screen is off."*
   - **Photo & video permissions:** the app's core purpose is casting user-selected photos/videos, an eligible use — complete the access declaration accordingly.

4. **Countries / regions** — pick where to distribute.

5. **Pricing** — Free.

6. ⚠️ **Testing requirement (personal accounts):** Google requires personal developer accounts created after 13 Nov 2023 to run **closed testing with ≥12 testers for 14 days** before Production access unlocks. If this account is subject to it, that must happen first. (Your build is already on the **internal** track — you may need to move to **closed testing** to satisfy this.)

7. **Create the Production release**
   - Confirm the AAB targets a current API level (Expo SDK 56 → targetSdk 35, which meets Play's minimum).
   - Promote the existing **vc 5 / 1.0.4** build (currently internal) to **Production**, add release notes, set rollout %, review, and roll out.
   - This is the actual public go‑live — a deliberate step to take once 1–6 are green. It can be done in the Console, or scripted with a `track: "production"` supply call.

## Nice-to-have (not blocking)
- Localized listings (currently en-US only).
- A promo video.
