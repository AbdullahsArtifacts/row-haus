/* FrameSequence — scroll-driven canvas image sequence.
 *
 * Two layers: a sharp layer whose upscale is capped, and a small blurred
 * backdrop canvas scaled up behind it to keep the composition full-bleed.
 * The source here is 720x1280 portrait; a naive full-bleed cover on a wide
 * desktop is a ~3x upscale, which is what makes this kind of footage look
 * mushy. Capping the scale and blur-filling the remainder is the fix.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    frameCount: 300,
    pathFn: function (i) {
      return 'frames/ezgif-frame-' + String(i).padStart(3, '0') + '.jpg';
    },
    focusX: 0.5,
    focusY: 0.56,     // the boat sits below the midline; a centred crop shows empty water
    maxUpscale: 1.6,  // hard cap on the sharp layer's scale factor
    dprCap: 2,
    concurrency: 12,
    blurWidth: 320,   // backdrop is laid out small and transform-scaled up (see resize)
    blurOverscan: 1.08
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function noop() {}

  function FrameSequence(options) {
    var opts = options || {};
    for (var k in DEFAULTS) {
      this[k] = opts[k] !== undefined ? opts[k] : DEFAULTS[k];
    }

    this.canvas = opts.canvas;
    this.blurCanvas = opts.blurCanvas;
    this.pin = opts.pin || this.canvas.parentNode;

    this.ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.blurCtx = this.blurCanvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.blurCtx.imageSmoothingQuality = 'medium';

    this.frames = new Array(this.frameCount);
    this.loaded = 0;
    this.ready = false;

    this.lastIndex = -1;
    this.layoutDirty = true;
    this.layout = null;

    this._onResize = this._onResize.bind(this);
  }

  /* ---------------------------------------------------------------- loading */

  /* Loads every frame — all of them, no striding or per-device subsetting.
   * Images are retained for the life of the page so no frame ever re-fetches
   * mid-scroll. Concurrency is limited so 300 requests don't stampede. */
  FrameSequence.prototype.load = function (onProgress) {
    var self = this;
    var total = this.frameCount;
    var next = 0;

    function loadOne(index) {
      return new Promise(function (resolve) {
        var img = new Image();
        var settled = false;
        var poll = 0;

        img.decoding = 'async';

        function done() {
          if (settled) return;
          settled = true;
          clearTimeout(poll);
          self.frames[index] = img;
          self.loaded++;
          if (onProgress) onProgress(self.loaded, total);
          resolve();
        }

        // decode() rejects in some browsers for cached/odd cases, and in a
        // hidden document it may never settle at all — so gate on it only while
        // visible, and otherwise just warm it in the background.
        function ready() {
          if (!img.decode) {
            done();
          } else if (document.hidden) {
            img.decode().then(noop, noop);
            done();
          } else {
            img.decode().then(done, done);
          }
        }

        // Backstop: a hidden/never-painted tab can finish an image without ever
        // dispatching its load event, which would strand the queue at 0%.
        // `complete` still flips, so poll it.
        function watch() {
          if (settled) return;
          if (img.complete && img.naturalWidth > 0) { ready(); return; }
          poll = setTimeout(watch, 250);
        }

        img.onload = ready;
        img.onerror = done;
        img.src = self.pathFn(index + 1);
        watch();
      });
    }

    function worker() {
      if (next >= total) return Promise.resolve();
      var i = next++;
      return loadOne(i).then(worker);
    }

    var workers = [];
    for (var w = 0; w < Math.min(this.concurrency, total); w++) {
      workers.push(worker());
    }

    return Promise.all(workers).then(function () {
      self.ready = true;
      return self;
    });
  };

  /* ---------------------------------------------------------------- layout */

  FrameSequence.prototype.observe = function () {
    var self = this;
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self._onResize(); });
      this._ro.observe(this.pin);
    }
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
    this.resize();
  };

  FrameSequence.prototype._onResize = function () {
    var self = this;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(function () {
      self.resize();
      self.redraw();
    }, 120);
  };

  FrameSequence.prototype.resize = function () {
    var first = this.frames[0];
    var sw = (first && first.naturalWidth) || 720;
    var sh = (first && first.naturalHeight) || 1280;

    var W = this.pin.clientWidth || window.innerWidth;
    var H = this.pin.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);

    var coverScale = Math.max(W / sw, H / sh);
    var scale = Math.min(coverScale, this.maxUpscale);

    var targetW = sw * scale;
    var targetH = sh * scale;

    // The sharp canvas is the visible window into the scaled frame. When the
    // scale is capped it is smaller than the viewport and the backdrop shows.
    var cssW = Math.min(targetW, W);
    var cssH = Math.min(targetH, H);

    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    // Backdrop: laid out small, then transform-scaled. A CSS filter is
    // evaluated in the element's own coordinate space, so blurring a small
    // element and scaling it up is both cheaper and gives the right radius.
    var bw = this.blurWidth;
    var bh = Math.max(1, Math.round(bw * (H / W)));
    var bScale = (W / bw) * this.blurOverscan;

    this.blurCanvas.width = bw;
    this.blurCanvas.height = bh;
    this.blurCanvas.style.width = bw + 'px';
    this.blurCanvas.style.height = bh + 'px';
    this.blurCanvas.style.transform =
      'translate(-50%, -50%) scale(' + bScale.toFixed(4) + ')';

    var featherX = cssW < W - 0.5 ? Math.min(64, cssW * 0.07) : 0;
    var featherY = cssH < H - 0.5 ? Math.min(64, cssH * 0.07) : 0;

    this.layout = {
      sw: sw, sh: sh, dpr: dpr,
      cssW: cssW, cssH: cssH,
      targetW: targetW, targetH: targetH,
      dx: -(targetW - cssW) * this.focusX,
      dy: -(targetH - cssH) * this.focusY,
      bw: bw, bh: bh,
      featherX: featherX, featherY: featherY,
      needsBackdrop: featherX > 0 || featherY > 0
    };

    this.layoutDirty = true;
  };

  /* ---------------------------------------------------------------- drawing */

  FrameSequence.prototype.indexFor = function (p) {
    var n = this.frameCount - 1;
    return clamp(Math.round(clamp(p, 0, 1) * n), 0, n);
  };

  /* Called once per rAF tick from main.js. Bails out when neither the frame
   * nor the layout changed — this is the main per-frame saving. */
  FrameSequence.prototype.render = function (p) {
    var index = this.indexFor(p);
    if (index === this.lastIndex && !this.layoutDirty) return false;
    this.drawIndex(index);
    return true;
  };

  FrameSequence.prototype.redraw = function () {
    if (this.lastIndex >= 0) this.drawIndex(this.lastIndex);
  };

  FrameSequence.prototype.drawIndex = function (index) {
    var img = this.frames[index];
    if (!img || !img.naturalWidth) return;
    if (!this.layout) this.resize();

    var L = this.layout;
    var ctx = this.ctx;

    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.cssW, L.cssH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, L.dx, L.dy, L.targetW, L.targetH);

    if (L.needsBackdrop) {
      this.feather(ctx, L);
      this.drawBackdrop(img, L);
    }

    this.lastIndex = index;
    this.layoutDirty = false;
  };

  /* Fades the sharp layer's border to transparent so the seam against the
   * blurred backdrop disappears. Requires an alpha context. */
  FrameSequence.prototype.feather = function (ctx, L) {
    ctx.globalCompositeOperation = 'destination-out';

    var g;
    if (L.featherX > 0) {
      g = ctx.createLinearGradient(0, 0, L.featherX, 0);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, L.featherX, L.cssH);

      g = ctx.createLinearGradient(L.cssW, 0, L.cssW - L.featherX, 0);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(L.cssW - L.featherX, 0, L.featherX, L.cssH);
    }
    if (L.featherY > 0) {
      g = ctx.createLinearGradient(0, 0, 0, L.featherY);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, L.cssW, L.featherY);

      g = ctx.createLinearGradient(0, L.cssH, 0, L.cssH - L.featherY);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, L.cssH - L.featherY, L.cssW, L.featherY);
    }

    ctx.globalCompositeOperation = 'source-over';
  };

  FrameSequence.prototype.drawBackdrop = function (img, L) {
    var ctx = this.blurCtx;
    var cs = Math.max(L.bw / L.sw, L.bh / L.sh);
    var tw = L.sw * cs;
    var th = L.sh * cs;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(img, -(tw - L.bw) * this.focusX, -(th - L.bh) * this.focusY, tw, th);
  };

  window.FrameSequence = FrameSequence;
})();
