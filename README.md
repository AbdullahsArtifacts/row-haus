# ROW Haus — scroll-driven image sequence

Single-page site for an indoor rowing studio. The hero is a 300-frame canvas
image sequence of a crew rowing a longboat through a fjord, scrubbed by scroll
position. Plain HTML/CSS/JS, no build step, runs offline from a static server.

```bash
python -m http.server 5181 --directory "C:\Users\user\OneDrive\Desktop\CC-Folder\websites\projects\row-haus-scroll"
```

Also registered as `row-haus-scroll` in `.claude/launch.json` (port 5181).

## Files

| Path | What it is |
| --- | --- |
| `index.html` | Markup. Script order matters: lenis → sequence → main. |
| `css/styles.css` | Base, header, loader, the scene and its overlay beats. |
| `css/sections.css` | Content sections below the scene. |
| `js/sequence.js` | `FrameSequence` — preloading and canvas drawing. |
| `js/main.js` | Lenis, the rAF loop, scroll progress, beats, loader. |
| `lib/lenis.min.js` | Lenis 1.1.18 UMD (`globalThis.Lenis`). Vendored, no CDN. |
| `frames/` | `ezgif-frame-001.jpg` … `-300.jpg`, 720×1280, ~11 MB total. |

## How it works

**Preload.** All 300 frames load up front through a 12-at-a-time queue, each
with `img.decode()` so no decode happens mid-scroll. `decode()` rejections fall
back to the `onload` path — one failure never aborts the batch. Scrolling is
blocked (`lenis.stop()` + `overflow: hidden`) until every frame is in.

**Sync.** One rAF loop drives `lenis.raf()` and the sequence together — never
two loops. It reads layout once per tick, derives progress from `#scene`'s
rect, and maps it to `round(p * 299)`. `render()` returns early when neither
the frame index nor the canvas size changed, so a tick with no new frame costs
nothing.

**Draw quality.** The source is portrait (720×1280) and the viewport usually
isn't. Full-bleed `cover` on a 1280px-wide desktop would be a 1.78× upscale and
on a 1512px screen 3.1× — that upscale, not the encoding, is what makes this
footage look mushy. So:

- the sharp layer's scale is capped at **1.6×** (`maxUpscale`);
- the vertical crop is anchored at **`focusY: 0.56`**, because the boat sits
  below the midline and a centred crop shows empty water;
- the remainder is filled by a second, blurred canvas of the same frame;
- the sharp layer's edges are feathered with `destination-out` gradients so the
  seam against the backdrop disappears.

The backdrop canvas is laid out **small** (320px) and CSS `transform: scale()`d
up. A CSS filter is evaluated in the element's own coordinate space, so blurring
a small element is both far cheaper and gives the correct visual radius.

On narrow/portrait viewports the cover scale is under the cap, the sharp layer
fills the screen, and the backdrop is simply never visible.

Canvases are sized by `devicePixelRatio` capped at 2, re-laid out on a debounced
`ResizeObserver`.

## Things that will bite you

- **Never put `overflow-x: hidden` on `html`/`body`.** It forces `overflow-y` to
  compute to `auto`, which makes them scroll containers and silently kills
  `position: sticky` on the pin — the whole scene then scrolls past instead of
  the sequence scrubbing in place, with no error anywhere. Use `overflow-x:
  clip`: it clips identically but pairs with `visible`, so no scroll container
  is created. Assert on it with `getComputedStyle(html).overflowY === 'visible'`
  and by checking the pin's `getBoundingClientRect().top` stays 0 while
  scrolling.
- **Don't gate the preloader purely on image events.** A hidden or never-painted
  tab can finish an image without dispatching `load`, and `img.decode()` there
  may never settle at all — either one strands the loader at 0% forever. The
  queue gates on `decode()` only while visible and polls `img.complete` as a
  backstop.
- **The overlay gate.** Beats live in a sticky pin and progress pins at 1, so
  without the explicit `rect.bottom <= vh` check the last beat hangs over the
  content sections forever. Do not remove it.
- **Don't read `lenis.scroll` outside Lenis's own rAF.** It only advances when
  `lenis.raf()` runs, so it reads 0 anywhere else — that silently pinned the
  progress bar at `scaleX(0)`. Page-level scroll reads use `window.scrollY`.
- **CSS must not transition anything JS writes per frame** — beat
  opacity/transform, canvas size, the progress bar's `scaleX`. It fights the
  rAF loop.
- **`.beat` inline styles.** JS owns `opacity` and `transform` on every beat, so
  `.beat--center` is centred with `left/right` + padding, never `translateX`.
- **Verifying in a hidden tab is meaningless.** rAF is throttled to ~nothing
  when the browser pane isn't compositing, so `await requestAnimationFrame`
  never resolves and canvas timings are fiction. Drive `window.rowHaus.update()`
  synchronously and assert on state (frame index, pixel signatures, rects)
  instead.

`window.rowHaus = { seq, lenis, update }` is exposed deliberately for exactly
that kind of state-based verification.

## Note on the source frames

`frames/` is a 300-frame ezgif export. The underlying clip is 240 frames at
24fps; a 300-frame export of it is that source resampled to 30fps, which makes
roughly every fifth frame a near-duplicate of its neighbour. All 300 are
preloaded and mapped as-is, by request. If the motion ever looks like it hitches
on a regular period, that resampling is why — not the scroll engine.
