/* =====================================================================
 * ROW Haus — scroll-driven image sequence
 * Boot + wiring layer.
 *
 * Owns: Lenis init, preload gating, scroll -> progress mapping, overlay
 *       activation, header state, section reveals, anchor scrolling.
 * Does NOT own: drawing. js/sequence.js runs its own rAF draw loop and
 *       handles DPR / fit / crossfade / visibility. We only ever call
 *       seq.setProgress(p) and let the engine decide when to paint.
 *
 * Classic script. No modules, no bundler, no dependencies beyond the
 * globals window.Lenis and window.FrameSequence.
 * ===================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- *
   * Constants
   * ---------------------------------------------------------------- */

  /* --- Frame set ----------------------------------------------------
   * 120 files at 720x1280 decode to roughly 440 MB of bitmaps. That is
   * affordable on a laptop and emphatically not on a phone, so narrow
   * viewports take every other frame: half the memory, and at the speed a
   * thumb actually scrolls, the crossfade covers the difference.
   * ------------------------------------------------------------------ */

  var FRAME_COUNT_FULL = 120;   // files on disk: frame-001 .. frame-120
  var NARROW_MAX = 720;         // px — matches the CSS breakpoint

  // Decided once at boot. Not re-derived on resize: swapping the frame set
  // mid-session would mean re-running the whole preload.
  var frameCount = FRAME_COUNT_FULL;

  // Sequence index -> file index. Hits both endpoints exactly, so progress 0
  // is always frame 1 and progress 1 is always the last frame, whatever the
  // stride. Naive `i * 2` would strand the final frame unreachable.
  function frameFileIndex(i) {
    if (frameCount >= FRAME_COUNT_FULL || frameCount < 2) return i + 1;
    return Math.round(i * (FRAME_COUNT_FULL - 1) / (frameCount - 1)) + 1;
  }

  function frameSrc(i) {
    return 'frames/frame-' + String(frameFileIndex(i)).padStart(3, '0') + '.webp';
  }

  var CUE_HIDE_AT = 40;         // px scrolled before the scroll cue retires
  var RESIZE_DEBOUNCE = 150;    // ms
  var PRELOAD_SAFETY_MS = 1600; // hard cap on the "climb to 100%" animation

  // Source frames are 720x1280. The boat sits below the midline in every
  // frame, so a centered cover crop on a landscape window lands on sky and
  // empty water. 0.56 keeps the hull and the oar wash in the band.
  var FOCUS_Y = 0.56;

  // Device pixels per source pixel, ceiling. 720px of source stretched across
  // a 2268px-wide backing store is a 3.15x upscale and no amount of encoding
  // quality survives that. 1.6x is a mild, still-crisp enlargement; the rest
  // of the viewport is filled by the blurred backdrop layer instead.
  var MAX_UPSCALE = 1.6;

  // Backing-store width of the backdrop canvas — must match BACKDROP_W in
  // js/sequence.js, since the fill scale is derived from it.
  var BACKDROP_W = 192;

  // Padded past exact coverage so the blur's transparent edge sampling stays
  // outside the viewport instead of ringing the fill with a dark halo.
  var BACKDROP_OVERFILL = 1.18;

  /* --- Lenis tuning -------------------------------------------------
   * In Lenis v1 the wheel path passes BOTH lerp and duration/easing, and
   * the animator uses lerp whenever it is truthy — so lerp is the value
   * that actually decides how this feels. The rest is the programmatic
   * (scrollTo) fallback path.
   * ------------------------------------------------------------------ */

  // Slightly heavier than the 0.1 default. Water has drag; the sequence
  // should coast to a stop rather than stick to the wheel. Below ~0.06 it
  // starts reading as rubber-band lag instead of weight.
  var LERP = 0.08;

  // Fallback path only (programmatic scrollTo); kept close to LERP's feel.
  var DURATION = 1.15;

  // Quart-out: commits immediately, then a long decelerating tail.
  var EASING = function (t) { return 1 - Math.pow(1 - t, 4); };

  // Sub-1 so one aggressive flick can't tear through all 50 frames. The
  // stroke needs travel to read as a stroke rather than a jump cut.
  var WHEEL_MULTIPLIER = 0.85;

  // Touch is under-powered against a multi-screen track; nudge it back up.
  var TOUCH_MULTIPLIER = 1.5;

  /* ---------------------------------------------------------------- *
   * Module state (kept out here so the scroll handler allocates nothing)
   * ---------------------------------------------------------------- */

  var lenis = null;
  var seq = null;
  var rafId = 0;

  var canvasEl = null;
  var trackEl = null;
  var cueEl = null;
  var headerEl = null;
  var progressEl = null;
  var progressBarEl = null;
  var stageEl = null;
  var preloaderEl = null;
  var barEl = null;
  var pctEl = null;

  // Cached track metrics — recomputed on resize / after load, never read
  // from inside the scroll handler (no layout reads on the hot path).
  var trackTop = 0;
  var trackSpan = 1; // trackHeight - viewportHeight, floored at 1
  var trackEnd = 0;  // scroll position where the sequence is finished

  // Overlays, flattened into parallel arrays so the hot path touches no
  // DOM attributes, does no parseFloat, and creates no objects.
  var overlayEls = [];
  var overlayStart = null;  // Float64Array
  var overlayEnd = null;    // Float64Array
  var overlayOn = null;     // Uint8Array — last applied state

  var cueRetired = false;
  var lastProgress = -1;
  var headerSolid = false;
  var stageRetired = false;
  var viewportH = 0;

  var scrollLocked = false;
  var savedHtmlOverflow = '';
  var savedBodyOverflow = '';

  var resizeTimer = 0;
  var reducedMotion = false;
  var motionQuery = null;

  var revealObserver = null;
  var destroyed = false;

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */

  function currentScroll() {
    // lenis.scroll is the smoothed value the page is actually rendered at,
    // which is what the frame index must follow. Fall back to the native
    // value before Lenis exists / after it is torn down.
    return lenis ? lenis.scroll : (window.pageYOffset || 0);
  }

  /* ---------------------------------------------------------------- *
   * Scroll lock (during preload)
   * ---------------------------------------------------------------- */

  function lockScroll() {
    if (scrollLocked) return;
    scrollLocked = true;

    var html = document.documentElement;
    var body = document.body;

    html.classList.add('is-loading');
    body.classList.add('is-loading');

    savedHtmlOverflow = html.style.overflow;
    savedBodyOverflow = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';

    if (lenis) lenis.stop();
  }

  function unlockScroll() {
    if (!scrollLocked) return;
    scrollLocked = false;

    var html = document.documentElement;
    var body = document.body;

    html.classList.remove('is-loading');
    body.classList.remove('is-loading');

    html.style.overflow = savedHtmlOverflow;
    body.style.overflow = savedBodyOverflow;

    if (lenis) lenis.start();
  }

  /* ---------------------------------------------------------------- *
   * Track metrics
   * ---------------------------------------------------------------- */

  // The backdrop canvas is laid out at BACKDROP_W CSS px and transformed up to
  // fill the stage, so the blur stays cheap. Uniform scale is enough because
  // its backing store already carries the stage's aspect ratio.
  function sizeBackdrop() {
    if (!stageEl) return;
    var w = stageEl.clientWidth || window.innerWidth || 1;
    stageEl.style.setProperty('--backdrop-scale', (w / BACKDROP_W) * BACKDROP_OVERFILL);
  }

  function measure() {
    sizeBackdrop();
    if (!trackEl) return;

    var rect = trackEl.getBoundingClientRect();
    trackTop = rect.top + (window.pageYOffset || 0);

    viewportH = window.innerHeight || document.documentElement.clientHeight;
    var span = rect.height - viewportH;

    // Guard against a degenerate track (span <= 0) producing Infinity/NaN.
    trackSpan = span > 1 ? span : 1;
    trackEnd = trackTop + trackSpan;

    // Lenis caches document height too; keep the two in sync.
    if (lenis && typeof lenis.resize === 'function') lenis.resize();
  }

  /* ---------------------------------------------------------------- *
   * Hot path — must stay allocation-free and layout-read-free
   * ---------------------------------------------------------------- */

  function applyScroll() {
    var y = currentScroll();

    // Sequence progress is measured against the track's own scrollable span,
    // NOT lenis.progress: there is a whole page of content after the track,
    // so document progress would never reach 1.0 while the sequence is still
    // on screen and the final frames would be unreachable.
    var p = (y - trackTop) / trackSpan;
    if (p < 0) p = 0; else if (p > 1) p = 1;

    if (p !== lastProgress) {
      lastProgress = p;
      if (seq) seq.setProgress(p);
      // scaleX rather than width: no layout, composited on the GPU.
      if (progressBarEl) progressBarEl.style.width = (p * 100) + '%';
    }

    // Past the end of the track the overlays are still `position: fixed` and
    // p is pinned at 1, so the final beat would otherwise hang over the
    // content sections forever. Gate every overlay off once the track is done.
    var pastTrack = y > trackEnd;

    // Overlays — write only on actual state changes.
    for (var i = 0; i < overlayEls.length; i++) {
      var on = (!pastTrack && p >= overlayStart[i] && p <= overlayEnd[i]) ? 1 : 0;
      if (on !== overlayOn[i]) {
        overlayOn[i] = on;
        if (on) overlayEls[i].classList.add('is-active');
        else overlayEls[i].classList.remove('is-active');
      }
    }

    // Header goes solid once the content has taken over from the sequence.
    var solid = y > trackEnd - 40;
    if (solid !== headerSolid) {
      headerSolid = solid;
      if (headerEl) headerEl.classList.toggle('is-solid', solid);
      // The sequence progress rail is meaningless past the track.
      if (progressEl) progressEl.classList.toggle('is-hidden', solid);
    }

    // Retire the fixed canvas layer once the content has fully covered it.
    // It is a full-viewport composited surface; keeping it alive under an
    // opaque page costs real fill rate while the user reads the sections.
    var stageOff = y > trackEnd + viewportH;
    if (stageOff !== stageRetired) {
      stageRetired = stageOff;
      if (stageEl) stageEl.classList.toggle('is-retired', stageOff);
    }

    // Scroll cue — one-way, then we stop touching it entirely.
    if (!cueRetired && y > CUE_HIDE_AT) {
      cueRetired = true;
      if (cueEl) {
        cueEl.classList.add('is-hidden');
        cueEl = null;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Lenis lifecycle
   * ---------------------------------------------------------------- */

  function buildLenis() {
    reducedMotion = !!(motionQuery && motionQuery.matches);

    lenis = new window.Lenis({
      // Reduced motion: hand scrolling back to the browser. lerp of 1 +
      // smoothWheel off means Lenis stops interpolating and just mirrors
      // native scroll — the sequence still tracks position exactly.
      duration: reducedMotion ? 0 : DURATION,
      easing: EASING,
      lerp: reducedMotion ? 1 : LERP,
      wheelMultiplier: reducedMotion ? 1 : WHEEL_MULTIPLIER,
      touchMultiplier: reducedMotion ? 1 : TOUCH_MULTIPLIER,
      smoothWheel: !reducedMotion,
      orientation: 'vertical',
      gestureOrientation: 'vertical'
    });

    lenis.on('scroll', applyScroll);

    if (scrollLocked) lenis.stop();
  }

  function tearDownLenis() {
    if (!lenis) return;
    try { lenis.destroy(); } catch (e) { /* noop */ }
    lenis = null;
  }

  function onMotionPreferenceChange() {
    if (destroyed) return;
    // Cheap enough to just rebuild: scroll position is owned by the document,
    // not by Lenis, so swapping instances doesn't move the page.
    tearDownLenis();
    buildLenis();
    measure();
    lastProgress = -1; // force a resync through the new instance
    applyScroll();
  }

  /* ---------------------------------------------------------------- *
   * Anchor links
   * Native anchor jumps bypass Lenis entirely and desync the smoothed
   * scroll value from the document, which strands the sequence on a
   * stale frame. Route them through Lenis instead.
   * ---------------------------------------------------------------- */

  function onDocumentClick(e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;

    var hash = a.getAttribute('href');
    if (!hash || hash === '#') return;

    var target = hash === '#top' ? 0 : document.querySelector(hash);
    if (target === null) return;

    e.preventDefault();
    if (lenis) {
      lenis.scrollTo(target, { offset: 0, duration: reducedMotion ? 0 : 1.4 });
    } else if (target !== 0) {
      target.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }

  /* ---------------------------------------------------------------- *
   * Section reveals
   * ---------------------------------------------------------------- */

  function setupReveals() {
    var nodes = document.querySelectorAll('.reveal');
    if (!nodes.length) return;

    if (reducedMotion || typeof IntersectionObserver !== 'function') {
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.add('is-in');
      return;
    }

    revealObserver = new IntersectionObserver(function (entries) {
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        // One-shot: nothing here should re-animate on the way back up.
        revealObserver.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 });

    for (var k = 0; k < nodes.length; k++) revealObserver.observe(nodes[k]);
  }

  /* ---------------------------------------------------------------- *
   * Resize (debounced)
   * ---------------------------------------------------------------- */

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = 0;
      if (destroyed) return;
      // The track is viewport-relative, so its span changes with height.
      measure();
      lastProgress = -1;
      applyScroll();
    }, RESIZE_DEBOUNCE);
  }

  /* ---------------------------------------------------------------- *
   * rAF — scroll integration only. Never used for drawing frames.
   * ---------------------------------------------------------------- */

  function tick(time) {
    rafId = window.requestAnimationFrame(tick);
    if (lenis) lenis.raf(time);
  }

  /* ---------------------------------------------------------------- *
   * Preloader
   * ---------------------------------------------------------------- */

  var pctTarget = 0;      // where loading actually is, 0..100
  var pctShown = 0;       // smoothed, monotonic
  var pctRaf = 0;
  var loadSettled = false;
  var preloaderDone = false;
  var safetyTimer = 0;

  function setLoadProgress(loaded, total) {
    var next = total > 0 ? (loaded / total) * 100 : 0;
    // Never let the readout walk backwards, even if the engine reports out
    // of order (it loads with 7 workers, so it does).
    if (next > pctTarget) pctTarget = next;
  }

  function pctTick() {
    // Ease toward the real value so the number climbs instead of snapping
    // between the 2% steps that 50 discrete frames produce.
    var delta = pctTarget - pctShown;
    pctShown += delta * 0.14;

    // Guarantee forward motion so it never visually stalls on a slow decode.
    if (delta > 0.05 && pctShown < pctTarget) pctShown += 0.12;
    if (pctShown > pctTarget) pctShown = pctTarget;

    var shown = Math.floor(pctShown);
    if (shown > 100) shown = 100;
    // Hold at 99 until loading has actually settled — 100% must mean done.
    if (!loadSettled && shown > 99) shown = 99;

    if (barEl) barEl.style.width = shown + '%';
    if (pctEl) pctEl.textContent = shown + '%';

    if (loadSettled && shown >= 100) {
      finishPreloader();
      return;
    }

    pctRaf = window.requestAnimationFrame(pctTick);
  }

  function finishPreloader() {
    if (preloaderDone) return;
    preloaderDone = true;

    if (pctRaf) { window.cancelAnimationFrame(pctRaf); pctRaf = 0; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0; }

    if (barEl) barEl.style.width = '100%';
    if (pctEl) pctEl.textContent = '100%';
    if (preloaderEl) preloaderEl.classList.add('is-hidden');
  }

  function settleLoad() {
    loadSettled = true;
    pctTarget = 100;
    // Don't let a stalled easing curve hold the page hostage.
    if (!safetyTimer) {
      safetyTimer = setTimeout(finishPreloader, PRELOAD_SAFETY_MS);
    }
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  function init() {
    if (!window.Lenis) {
      console.error('[rowhaus] window.Lenis is missing — lib/lenis.min.js must load before js/main.js. Aborting.');
      return;
    }
    if (!window.FrameSequence) {
      console.error('[rowhaus] window.FrameSequence is missing — js/sequence.js must load before js/main.js. Aborting.');
      return;
    }

    canvasEl = document.getElementById('sequence-canvas');
    if (!canvasEl) {
      console.error('[rowhaus] #sequence-canvas not found in the DOM. Aborting.');
      return;
    }

    trackEl = document.getElementById('scroll-track');
    if (!trackEl) {
      console.error('[rowhaus] #scroll-track not found — cannot map scroll to sequence progress. Aborting.');
      return;
    }

    cueEl = document.getElementById('scroll-cue');
    headerEl = document.getElementById('site-header');
    stageEl = document.querySelector('.canvas-stage');
    progressBarEl = document.getElementById('seq-progress-bar');
    progressEl = progressBarEl ? progressBarEl.parentNode : null;
    preloaderEl = document.getElementById('preloader');
    barEl = document.getElementById('preloader-bar');
    pctEl = document.getElementById('preloader-pct');

    // --- Overlays: parse once, flatten into typed arrays --------------
    var nodes = document.querySelectorAll('.overlay');
    var n = nodes.length;
    overlayStart = new Float64Array(n);
    overlayEnd = new Float64Array(n);
    overlayOn = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var el = nodes[i];
      var s = parseFloat(el.getAttribute('data-start'));
      var e = parseFloat(el.getAttribute('data-end'));
      overlayEls.push(el);
      overlayStart[i] = isNaN(s) ? 0 : s;
      overlayEnd[i] = isNaN(e) ? 0 : e;
      // Start from a known-clean state so the first tick's diff is honest.
      el.classList.remove('is-active');
    }

    // --- Motion preference -------------------------------------------
    if (window.matchMedia) {
      motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (motionQuery.addEventListener) {
        motionQuery.addEventListener('change', onMotionPreferenceChange);
      } else if (motionQuery.addListener) {
        motionQuery.addListener(onMotionPreferenceChange); // Safari < 14
      }
    }

    // --- Lock, then wire up -------------------------------------------
    lockScroll();          // set before Lenis exists; buildLenis honours it
    buildLenis();
    measure();
    setupReveals();

    rafId = window.requestAnimationFrame(tick);

    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('click', onDocumentClick, false);
    // Layout can still shift after DOMContentLoaded (fonts, late CSS).
    window.addEventListener('load', function () {
      if (!destroyed) { measure(); lastProgress = -1; applyScroll(); }
    });

    // --- Preload ------------------------------------------------------
    pctRaf = window.requestAnimationFrame(pctTick);

    frameCount = window.innerWidth <= NARROW_MAX
      ? Math.ceil(FRAME_COUNT_FULL / 2)
      : FRAME_COUNT_FULL;

    seq = new window.FrameSequence({
      canvas: canvasEl,
      frameCount: frameCount,
      getSrc: frameSrc,
      onProgress: setLoadProgress,
      crossfade: true,
      maxCrop: 1,
      maxUpscale: MAX_UPSCALE,
      backdrop: document.getElementById('seq-backdrop'),
      focusY: FOCUS_Y,
      background: '#050d10'
    });

    seq.load().then(function () {
      release();
    })['catch'](function (err) {
      // A missing frame must not leave the page permanently unscrollable.
      console.error('[rowhaus] frame preload failed; releasing scroll anyway.', err);
      release();
    });
  }

  function release() {
    if (destroyed) return;

    unlockScroll();
    settleLoad();

    // The track is viewport-relative, and the preload lock may have
    // perturbed layout — re-measure before the first real sync.
    measure();

    // Sync to wherever the browser restored the scroll position to, so a
    // refresh mid-page shows the right frame instead of frame 0.
    lastProgress = -1;
    applyScroll();
  }

  function destroy() {
    destroyed = true;

    if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    if (pctRaf) { window.cancelAnimationFrame(pctRaf); pctRaf = 0; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = 0; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0; }

    window.removeEventListener('resize', onResize);
    document.removeEventListener('click', onDocumentClick, false);

    if (motionQuery) {
      if (motionQuery.removeEventListener) {
        motionQuery.removeEventListener('change', onMotionPreferenceChange);
      } else if (motionQuery.removeListener) {
        motionQuery.removeListener(onMotionPreferenceChange);
      }
    }

    if (revealObserver) { revealObserver.disconnect(); revealObserver = null; }

    unlockScroll();
    tearDownLenis();

    if (seq) { seq.destroy(); seq = null; }
  }

  /* ---------------------------------------------------------------- *
   * Entry — the only global we leak.
   * ---------------------------------------------------------------- */

  window.RowHaus = {
    destroy: destroy,
    get lenis() { return lenis; },
    get sequence() { return seq; },
    get frameCount() { return frameCount; },
    get frameCountFull() { return FRAME_COUNT_FULL; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
