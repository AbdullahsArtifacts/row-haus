/* ROW Haus — page wiring: Lenis smooth scroll, scroll progress, overlay beats.
 * One rAF loop drives Lenis and the frame sequence together. */
(function () {
  'use strict';

  var scene = document.getElementById('scene');
  var canvas = document.getElementById('seq-canvas');
  var blurCanvas = document.getElementById('seq-blur');
  var pin = document.querySelector('.scene__pin');
  var loader = document.getElementById('loader');
  var loaderBar = document.getElementById('loader-bar');
  var loaderPct = document.getElementById('loader-pct');
  var progressBar = document.getElementById('scroll-progress');
  var header = document.querySelector('.site-header');
  var beats = Array.prototype.slice.call(document.querySelectorAll('.beat'));

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* --------------------------------------------------------------- beats */

  var beatState = beats.map(function (el) {
    return {
      el: el,
      from: parseFloat(el.dataset.from),
      to: parseFloat(el.dataset.to),
      alpha: -1,
      y: 0,
      active: false
    };
  });

  function setBeat(b, alpha, y) {
    // Only touch the DOM when the value actually moved.
    if (Math.abs(alpha - b.alpha) < 0.004 && Math.abs(y - b.y) < 0.25) return;
    b.alpha = alpha;
    b.y = y;
    b.el.style.opacity = alpha.toFixed(3);
    b.el.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0)';
    var on = alpha > 0.01;
    if (on !== b.active) {
      b.active = on;
      b.el.classList.toggle('is-active', on);
    }
  }

  function updateBeats(p, gated) {
    for (var i = 0; i < beatState.length; i++) {
      var b = beatState[i];
      if (gated) { setBeat(b, 0, 18); continue; }
      var local = (p - b.from) / (b.to - b.from);
      if (local <= 0 || local >= 1) { setBeat(b, 0, local <= 0 ? 18 : -18); continue; }
      var fin = smoothstep(0, 0.22, local);
      var fout = 1 - smoothstep(0.78, 1, local);
      setBeat(b, fin * fout, 18 * (1 - fin) - 18 * (1 - fout));
    }
  }

  /* --------------------------------------------------------------- sequence */

  var seq = new window.FrameSequence({
    canvas: canvas,
    blurCanvas: blurCanvas,
    pin: pin,
    frameCount: 300
  });

  /* --------------------------------------------------------------- scroll */

  var lenis = null;
  var running = false;
  var rafId = 0;

  // Lenis scrolls the window itself, so the real scroll position is always
  // correct — and unlike lenis.scroll it's valid before Lenis's raf has run.
  function scrollTop() {
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  function update() {
    var rect = scene.getBoundingClientRect();          // one layout read per tick
    var vh = window.innerHeight;
    var denom = rect.height - vh;
    var p = denom > 0 ? clamp(-rect.top / denom, 0, 1) : 0;

    seq.render(p);

    // Overlay gate: the beats live in a sticky pin and progress pins at 1, so
    // without this the last beat hangs over the sections below forever.
    var gated = rect.bottom <= vh || rect.top > vh;
    updateBeats(p, gated);

    var doc = document.documentElement;
    var max = doc.scrollHeight - vh;
    var pageP = max > 0 ? clamp(scrollTop() / max, 0, 1) : 0;
    progressBar.style.transform = 'scaleX(' + pageP.toFixed(4) + ')';

    if (header) header.classList.toggle('is-scrolled', scrollTop() > 40);
  }

  function tick(time) {
    if (lenis) lenis.raf(time);
    update();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stop();
    } else {
      // A hidden tab throttles rAF to ~nothing, so force a fresh draw on
      // resume rather than assuming the loop kept up.
      seq.layoutDirty = true;
      start();
    }
  });

  /* --------------------------------------------------------------- boot */

  document.documentElement.classList.add('is-loading');

  if (!reduceMotion) {
    lenis = new window.Lenis({
      lerp: 0.09,
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.6,
      orientation: 'vertical',
      gestureOrientation: 'vertical'
    });
    lenis.stop();
  }

  // Smooth-scroll the nav rather than letting the browser jump.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href');
    if (id.length < 2) return;
    var target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: 0, duration: 1.4 });
    else target.scrollIntoView({ behavior: 'smooth' });
  });

  seq.observe();
  start();

  seq.load(function (loaded, total) {
    var pct = Math.round((loaded / total) * 100);
    loaderBar.style.width = pct + '%';
    loaderPct.textContent = String(pct);
  }).then(function () {
    seq.resize();
    seq.drawIndex(0);
    loader.classList.add('is-done');
    document.documentElement.classList.remove('is-loading');
    if (lenis) lenis.start();
    setTimeout(function () { loader.setAttribute('hidden', ''); }, 900);
  });

  window.rowHaus = { seq: seq, lenis: lenis, update: update };
})();
