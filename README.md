# ROW Haus — scroll-driven image sequence

Single-page site for an indoor rowing studio. The hero is a 120-frame image
sequence (a crew rowing a wooden boat through a Norwegian fjord) painted to a
canvas and indexed off scroll position, with Lenis smoothing the scroll.

Runs offline. No build step, no bundler, no CDN, no web fonts, no dependencies
beyond a vendored copy of Lenis. Open `index.html` directly, or serve the folder:

```bash
python -m http.server 5179
```

> **This is a demo, not a real business.** ROW Haus is invented. The studio, the
> address in Bergen, the phone number, the prices and the membership tiers are
> all fabricated placeholder copy for a portfolio piece. Don't call the number
> and don't try to book a class.

**Hero footage:** the frames are stills from an AI-generated video clip. They are
included so the demo runs standalone — check the terms of whatever generated a
clip before reusing these frames in your own work. The interesting part of this
repo is the renderer, not the footage.

The techniques here are meant to be lifted for any scroll-driven sequence:
crop-limited focus-anchored fitting, an upscale ceiling with a blurred backdrop
fill, sub-frame crossfading, and a dirty-flag draw loop. See
[The fit](#the-fit) and [Performance notes](#performance-notes).

## Files

| Path | What it owns |
| --- | --- |
| `index.html` | Structure and all copy |
| `js/sequence.js` | `window.FrameSequence` — preload, fit, crossfade, draw loop |
| `js/main.js` | Lenis, preload gating, scroll → progress, overlays, reveals |
| `css/styles.css` | Tokens, reset, preloader, fixed hero stage, overlays |
| `css/sections.css` | Below-the-fold sections (stats, classes, tiers, footer) |
| `frames/` | 120 WebPs, `frame-001.webp` … `-120.webp`, 720×1280 |
| `lib/lenis.min.js` | Lenis v1.1.18, vendored |
| `context/copy-deck.md` | Brand voice + every on-page string |
| `build-single-file.py` | Bundles the whole build into one portable HTML |

## Single-file build

`Desktop/user interface/rowing.html` is a self-contained copy — both
stylesheets, Lenis, the engine, the boot layer and all 50 frames (as base64
data URIs) inlined into one **16.2 MB** file that opens by double-clicking.

The bundler discovers the frame set from disk and validates it is a contiguous
`1..N` run with no zero-byte files, so a regenerated sequence of any length is
picked up whole. It also asserts that `FRAME_COUNT_FULL` in `js/main.js` matches
the number of frames on disk — the browser can't enumerate a directory, so that
constant is the one place still coupled to the frame set, and a mismatch would
otherwise ship a build indexing frames that don't exist.

```bash
python websites/projects/row-haus/build-single-file.py
```

**This folder is the source of truth.** Edit here, then re-run the script;
edits made directly to `rowing.html` are lost on the next build. Every
substitution in the script is asserted and the output is scanned for surviving
`css/`, `js/`, `lib/` or `frames/` references, so a silent miss fails the build
instead of shipping a half-loading file.

Data URIs are same-origin, so `createImageBitmap` still succeeds and the single
file keeps the fast draw path — unlike relative `file://` images, which taint
the canvas and fall back to `HTMLImageElement`.

## How the scroll mapping works

`#scroll-track` is an empty 700vh block (520vh under 720px). Sequence progress
is the scroll position measured against **that element's own scrollable span**,
not `lenis.progress` — there is a full page of content after the track, so
document progress would never reach 1.0 while the sequence was still on screen
and the last frames would be unreachable.

Progress 0→1 maps linearly onto frame 0→49. Verified: at scroll fractions
0/.25/.5/.75/1 the frame position lands exactly on 0 / 12.25 / 24.5 / 36.75 / 49.

Overlay copy blocks declare their own range via `data-start` / `data-end` in
the HTML; `main.js` flattens those into typed arrays at boot so the scroll
handler does no `parseFloat`, no attribute reads, and no allocation.

## Performance notes

- **Preload is gated.** Scroll is locked until all 50 frames settle. Frame 0
  loads first and paints immediately so the hero is never blank.
- **7 parallel loaders.** The counter tracks *settled* (loaded **or** failed)
  frames, so a dead JPG can't hang the loading UI at 98%.
- **`createImageBitmap`** where available — draws considerably cheaper than an
  `HTMLImageElement`. Falls back to the element on `SecurityError` (`file://`).
- **`decode()` is raced against `onload`, not chained.** In a background tab
  Chromium defers decoding indefinitely, so `decode().catch(...)` never settles
  and the preload stalls at 0% until the tab is focused.
- **Dirty-flag draw loop.** `setProgress` only stores and marks dirty; a single
  rAF decides when to paint. Sub-frame moves smaller than one 8-bit alpha step
  are skipped entirely.
- **Per-draw cost is not reliably measurable from an automated browser.** The
  context is created `desynchronized`, and in a tab that isn't compositing the
  draw commands queue without being flushed — timings there swing between
  ~15 ms and ~0.08 ms for identical work, and 0.08 ms is far too fast for a
  3 MP scaled `drawImage` to have actually happened. Earlier revisions of this
  file quoted figures from that setup; they were measuring queueing, not
  rendering. Judge smoothness by scrolling it in a real browser, or profile
  with DevTools on a visible tab.
- **DPR is capped at 2.** A 3× backing store on a fullscreen canvas is wasted
  fill rate.
- **The hero stage is retired** (`visibility: hidden`) once content has fully
  covered it, so a full-viewport composited layer isn't kept alive while the
  user reads.
- **Memory is the real constraint, and it is arithmetic rather than measured:**
  120 × 720×1280 RGBA ≈ **442 MB** of decoded bitmaps. Decoded size is set by
  pixel count, so the WebP switch cut transfer, not memory.
- Narrow viewports (≤720 px) therefore load a **strided half-set — 60 frames,
  ≈221 MB**. See `frameFileIndex` in `js/main.js`: it maps sequence index to
  file index hitting both endpoints exactly, so progress 0 is frame 1 and
  progress 1 is frame 120 at either stride. A naive `i * 2` would leave the
  final frame unreachable.
- Transfer is 12.1 MB for the frame set. It is a gated preload, so it costs
  time-to-interactive on a slow connection — the levers are frame count and
  WebP quality in the extraction step, not anything at runtime.
- If memory ever needs to come down, drop the frame count; the crossfade
  interpolates between frames, so the fall-off in perceived smoothness is much
  gentler than the linear saving in memory.

## Frame provenance

The frames are re-extracted from `Downloads/make_it_a_little_more_realistc.mp4`
(720×1280, 24fps, 10.0s, 240 frames) — the original clip. **720×1280 is the
ceiling for this footage; there is no higher-resolution master.**

Sets exported through ezgif measure **35.8 dB PSNR** against the original —
visible generational loss on top of an already small source. The current set is
**120 frames** sampled evenly across all 240, encoded straight from lossless PNG
to **WebP q88 ≈ 41.5–42 dB** (≈98 KB each, 12.1 MB total). No sharpening is
applied; the goal is fidelity to the source.

**Beware of resampled exports.** A 300-frame ezgif set of this clip is not 300
distinct frames — it is the 240-frame source pushed to 30fps, so every 5th frame
is a duplicate. The tell is a periodic collapse in the frame-to-frame difference:
58 near-identical consecutive pairs, with the minima landing on an exact 5-frame
period. More files, no more information, and a subtle stutter if used as-is.
240 is the ceiling.

To regenerate at a different count or quality, extract with ffmpeg and re-encode
— `imageio-ffmpeg` provides a static binary if ffmpeg isn't on PATH.

## The fit

Two separate problems, two separate mechanisms.

**Framing.** The boat sits below the midline, so a centered crop on a landscape
window lands on empty water with the subject cut off. `_computeRect` takes a
**focus-anchored cover**: `focusY: 0.56` slides the crop window down. Only an
overflowing axis uses the anchor; a letterboxed axis always re-centers.

**Resolution.** A 1512×900 window at DPR 1.5 is a 2253×1350 backing store, so a
full-bleed cover asks for a **3.13× upscale** of a 720px-wide source. Nothing
survives that — it was the real cause of the footage looking mushy. So:

- `maxUpscale: 1.6` caps the sharp layer at a mild, still-crisp enlargement.
- Whatever it no longer reaches is filled by `#seq-backdrop`, a second canvas
  carrying a cover-fit copy of the same frame, blurred past legibility in CSS.
- The butt-join between the two would read as a video dropped in a box, so
  `_applyFeather` erases the sharp layer's edges with cached `destination-out`
  gradients (~22% of the panel width) and it dissolves into the blur.

The backdrop canvas is laid out at **192 px and transform-scaled up**, not
stretched to 100%. A CSS filter is evaluated in the element's own coordinate
space, so `blur(7px)` on a small box costs a fraction of the same visual result
computed across the full viewport.

This is adaptive, not a desktop special-case. Phones never see it: at 390×844
DPR 2 the cover scale is 1.32×, under the cap, so the frame covers edge to edge
and neither the backdrop nor the feather engages.

## Gotchas

- **Overlays are `position: fixed` and progress pins at 1.** Without gating,
  the final beat hangs over the content sections forever. `applyScroll` forces
  every overlay off once `y > trackEnd`.
- **Verifying in an automated browser:** a tab driven headlessly reports
  `document.hidden === true` and rAF stops firing, so screenshots show stale
  paints and `_drawnProgress` freezes. That's the engine correctly deferring
  work, not a bug. Assert against `_progress` / DOM state, or front the tab.
- **Reduced motion** keeps the sequence (it only moves when the user moves) but
  drops the looping scroll cue, the overlay translate, and all reveals, and
  hands scrolling back to the browser with `lerp: 1` + `smoothWheel: false`.
