/*!
 * FrameSequence — scroll-driven image-sequence renderer.
 * Classic script. Defines exactly one global: window.FrameSequence.
 * No dependencies. Safe from file:// and http(s).
 */
(function (global) {
  'use strict';

  var DEFAULT_FRAME_COUNT = 50;
  var DEFAULT_CONCURRENCY = 7;
  var MAX_DPR = 2;
  // Fractional-position deadband: below this, the crossfade alpha rounds to the
  // same 8-bit value on screen, so the second draw is a no-op.
  var FRAC_EPS = 1 / 512;

  // Backing-store width of the blurred backdrop layer. It is only ever seen
  // through a heavy blur, so anything past a couple hundred pixels is detail
  // that gets destroyed before it reaches the screen.
  var BACKDROP_W = 192;

  function defaultGetSrc(i) {
    return 'frames/frame-' + String(i + 1).padStart(3, '0') + '.webp';
  }

  function clamp01(v) {
    if (!(v >= 0)) return 0; // also catches NaN
    if (v > 1) return 1;
    return v;
  }

  function FrameSequence(options) {
    var opts = options || {};

    if (!opts.canvas || !opts.canvas.getContext) {
      throw new Error('FrameSequence: options.canvas must be an HTMLCanvasElement');
    }

    this.canvas = opts.canvas;
    this.frameCount = opts.frameCount > 0 ? (opts.frameCount | 0) : DEFAULT_FRAME_COUNT;
    this.getSrc = typeof opts.getSrc === 'function' ? opts.getSrc : defaultGetSrc;
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    this.crossfade = opts.crossfade !== false;
    this.loaded = false;

    // Fraction of the source allowed to be cropped away on the overflowing
    // axis before the fit gives up on filling and letterboxes instead. 1 =
    // always cover, 0 = always contain. See _computeRect.
    this.maxCrop = typeof opts.maxCrop === 'number' ? clamp01(opts.maxCrop) : 1;

    // Where the crop is anchored, as a fraction of the SOURCE. 0.5/0.5 is a
    // plain centered cover. These frames are 720x1280 portrait and the boat
    // sits below center, so the vertical anchor is pushed down — otherwise a
    // landscape viewport crops to a band of sky with no subject in it.
    this.focusX = typeof opts.focusX === 'number' ? clamp01(opts.focusX) : 0.5;
    this.focusY = typeof opts.focusY === 'number' ? clamp01(opts.focusY) : 0.5;

    // Hard ceiling on how far the sharp layer may be scaled up, in device
    // pixels per source pixel. The source is 720x1280 — the most this footage
    // will ever be — so a full-bleed cover on a wide desktop asks for a >3x
    // upscale and the result reads as mush no matter how clean the file is.
    // Capping the scale keeps the subject crisp; whatever the capped frame no
    // longer reaches is filled by the blurred backdrop below.
    this.maxUpscale = opts.maxUpscale > 0 ? +opts.maxUpscale : Infinity;

    // Optional second canvas painted with a cover-fit copy of the same frame.
    // It is blurred in CSS, so it fills the viewport without ever showing the
    // source's resolution. When absent the renderer letterboxes as before.
    this.backdrop = opts.backdrop && opts.backdrop.getContext ? opts.backdrop : null;

    // Painted behind the frame whenever the fit letterboxes. Must match the
    // page background or the bars read as a rendering bug.
    this.background = opts.background || '#050d10';
    this._letterboxed = false;

    this._concurrency = opts.concurrency > 0 ? (opts.concurrency | 0) : DEFAULT_CONCURRENCY;

    // Frame storage. _frames holds ImageBitmap (preferred) or HTMLImageElement.
    // Dimensions live in parallel typed arrays so the draw path never touches
    // properties that could trigger layout or boxing.
    this._frames = new Array(this.frameCount);
    this._fw = new Int32Array(this.frameCount);
    this._fh = new Int32Array(this.frameCount);
    this._isBitmap = new Uint8Array(this.frameCount);
    this._nearest = null; // Int16Array built once loading settles

    // With a backdrop the sharp layer no longer paints every pixel, so it has
    // to composite over what is behind it — alpha is required. Without one it
    // stays opaque, which is the cheaper path.
    var wantAlpha = !!this.backdrop;
    this._ctx = this.canvas.getContext('2d', { alpha: wantAlpha, desynchronized: true }) ||
      this.canvas.getContext('2d');
    if (this._ctx) {
      this._ctx.imageSmoothingEnabled = true;
      this._ctx.imageSmoothingQuality = 'high';
    }

    this._bctx = null;
    this._bw = 0; this._bh = 0;
    this._bdx = 0; this._bdy = 0; this._bdw = 0; this._bdh = 0;
    this._brectSrcW = 0; this._brectSrcH = 0;
    if (this.backdrop) {
      this._bctx = this.backdrop.getContext('2d', { alpha: false }) ||
        this.backdrop.getContext('2d');
      if (this._bctx) {
        this._bctx.imageSmoothingEnabled = true;
        this._bctx.imageSmoothingQuality = 'low'; // it is about to be blurred
      }
    }

    this._progress = 0;
    this._drawnProgress = -1; // -1 => nothing painted yet
    this._dirty = false;
    this._pendingResize = false;
    this._destroyed = false;
    this._firstPainted = false;
    this._loadPromise = null;
    this._settled = 0;

    // Backing-store size in device pixels.
    this._cw = 0;
    this._ch = 0;
    // Precomputed draw rect (device px) + the source dims it was computed for.
    this._dx = 0; this._dy = 0; this._dw = 0; this._dh = 0;
    this._rectSrcW = 0; this._rectSrcH = 0;

    this._rafId = 0;
    this._tick = this._tick.bind(this);
    this._onResizeEvent = this._onResizeEvent.bind(this);
    this._onVisibility = this._onVisibility.bind(this);

    this._ro = null;
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(this._onResizeEvent);
      this._ro.observe(this.canvas);
    }
    global.addEventListener('resize', this._onResizeEvent, { passive: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility, false);
    }

    this._applyResize();
    this._rafId = global.requestAnimationFrame(this._tick);
  }

  /* ------------------------------------------------------------------ *
   * Loading
   * ------------------------------------------------------------------ */

  FrameSequence.prototype.load = function () {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._runLoad();
    return this._loadPromise;
  };

  FrameSequence.prototype._runLoad = function () {
    var self = this;
    var n = this.frameCount;

    this._applyResize();

    // Frame 0 first, painted immediately, so the hero is never blank while the
    // remaining frames stream in.
    return this._loadOne(0).then(function () {
      if (self._destroyed) return;
      self._dirty = true;
      self._drawNow();

      var next = 1;
      var workerCount = Math.min(self._concurrency, Math.max(1, n - 1));
      var workers = new Array(workerCount);

      function worker() {
        if (self._destroyed || next >= n) return null;
        var i = next++;
        return self._loadOne(i).then(worker);
      }

      for (var k = 0; k < workerCount; k++) workers[k] = worker();
      return Promise.all(workers);
    }).then(function () {
      if (self._destroyed) return;
      self._buildNearestMap();
      self.loaded = true;
      self._dirty = true;
      self._drawNow();
    });
  };

  // Never rejects: a dead frame is recorded as a hole and the renderer falls
  // back to the nearest neighbour that did load.
  FrameSequence.prototype._loadOne = function (i) {
    var self = this;

    if (this._destroyed || this._frames[i]) {
      return Promise.resolve();
    }

    var src;
    try {
      src = this.getSrc(i);
    } catch (e) {
      this._settleOne();
      return Promise.resolve();
    }

    var img = new Image();
    img.decoding = 'async';

    // Handlers are attached before .src so a cache hit cannot race us.
    var settledPromise = new Promise(function (resolve, reject) {
      img.onload = function () { resolve(); };
      img.onerror = function () { reject(new Error('frame load failed: ' + src)); };
    });

    img.src = src;

    // decode() is the fast path, but it must be RACED against onload, not
    // chained with .catch. In a hidden/background tab Chromium defers image
    // decoding indefinitely: decode() neither resolves nor rejects, so a
    // .catch fallback never fires and the whole preload stalls at 0% until
    // the tab is focused. onload still fires while hidden, and a loaded
    // image is already drawable, so whichever settles first is enough.
    var ready = typeof img.decode === 'function'
      ? Promise.race([
          img.decode().catch(function () { return settledPromise; }),
          settledPromise
        ])
      : settledPromise;

    return ready.then(function () {
      if (self._destroyed) return;
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('frame has zero size: ' + src);

      // ImageBitmap draws considerably cheaper than an HTMLImageElement.
      // It throws SecurityError on origin-unclean images (common on file://),
      // in which case the element itself is a perfectly good drawable.
      if (typeof global.createImageBitmap === 'function') {
        return global.createImageBitmap(img).then(function (bmp) {
          if (self._destroyed) {
            if (bmp && bmp.close) bmp.close();
            return;
          }
          self._store(i, bmp, bmp.width || w, bmp.height || h, 1);
        }, function () {
          if (!self._destroyed) self._store(i, img, w, h, 0);
        });
      }
      self._store(i, img, w, h, 0);
    }).catch(function () {
      // Swallow: hole stays empty, nearest-neighbour fallback covers it.
    }).then(function () {
      self._settleOne();
    });
  };

  FrameSequence.prototype._store = function (i, drawable, w, h, isBitmap) {
    this._frames[i] = drawable;
    this._fw[i] = w;
    this._fh[i] = h;
    this._isBitmap[i] = isBitmap;
    this._nearest = null; // a new frame invalidates the neighbour map
  };

  // Counts *settled* frames (loaded or permanently failed) so the reported
  // count is monotonic, order-independent, and always reaches the total —
  // a loading UI must not hang on one dead JPG.
  FrameSequence.prototype._settleOne = function () {
    if (this._destroyed) return;
    this._settled++;
    if (this._settled > this.frameCount) this._settled = this.frameCount;
    if (this.onProgress) {
      try {
        this.onProgress(this._settled, this.frameCount);
      } catch (e) { /* a throwing callback must not stall the loader */ }
    }
  };

  // For every index, the closest index that actually has a frame.
  FrameSequence.prototype._buildNearestMap = function () {
    var n = this.frameCount;
    var frames = this._frames;
    var map = new Int16Array(n);
    var i, last;

    last = -1;
    for (i = 0; i < n; i++) {
      if (frames[i]) last = i;
      map[i] = last; // nearest available at or before i
    }

    last = -1;
    for (i = n - 1; i >= 0; i--) {
      if (frames[i]) last = i;
      var before = map[i];
      if (before < 0) {
        map[i] = last;
      } else if (last >= 0 && (last - i) < (i - before)) {
        map[i] = last;
      }
    }
    this._nearest = map;
  };

  FrameSequence.prototype._resolve = function (i) {
    var frames = this._frames;
    if (!frames) return -1;
    if (frames[i]) return i;
    if (this._nearest) return this._nearest[i];

    // Loading still in flight: scan outward. Integer-only, no allocations.
    var n = this.frameCount;
    for (var d = 1; d < n; d++) {
      var a = i - d;
      if (a >= 0 && frames[a]) return a;
      var b = i + d;
      if (b < n && frames[b]) return b;
    }
    return -1;
  };

  /* ------------------------------------------------------------------ *
   * Public control
   * ------------------------------------------------------------------ */

  // Hot path: store + mark dirty only. Never draws synchronously.
  FrameSequence.prototype.setProgress = function (p) {
    if (this._destroyed) return;
    p = clamp01(+p);
    this._progress = p;
    if (this._needsDraw(p)) this._dirty = true;
  };

  FrameSequence.prototype._needsDraw = function (p) {
    if (this._drawnProgress < 0) return true;
    var n = this.frameCount;
    if (n < 2) return false;
    if (this.crossfade) {
      var d = p - this._drawnProgress;
      if (d < 0) d = -d;
      // One unit of fractional frame position === one crossfade alpha step.
      return d * (n - 1) >= FRAC_EPS;
    }
    return Math.round(p * (n - 1)) !== Math.round(this._drawnProgress * (n - 1));
  };

  // Re-anchor the crop at runtime (used when the layout switches between the
  // landscape band crop and the near-native portrait fit).
  FrameSequence.prototype.setFocus = function (x, y) {
    if (this._destroyed) return;
    var fx = typeof x === 'number' ? clamp01(x) : this.focusX;
    var fy = typeof y === 'number' ? clamp01(y) : this.focusY;
    if (fx === this.focusX && fy === this.focusY) return;
    this.focusX = fx;
    this.focusY = fy;
    this._rectSrcW = 0; // invalidate the cached rect
    this._computeRect(this._fw[0] || 0, this._fh[0] || 0);
    this._dirty = true;
    this._drawNow();
  };

  FrameSequence.prototype.resize = function () {
    if (this._destroyed) return;
    this._applyResize();
  };

  FrameSequence.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this.loaded = false;

    if (this._rafId) {
      global.cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    global.removeEventListener('resize', this._onResizeEvent);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility, false);
    }

    var frames = this._frames;
    if (frames) {
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        if (f && this._isBitmap[i] && f.close) f.close();
        frames[i] = null;
      }
    }
    this._frames = null;
    this._nearest = null;
    this._ctx = null;
  };

  /* ------------------------------------------------------------------ *
   * Layout
   * ------------------------------------------------------------------ */

  FrameSequence.prototype._onResizeEvent = function () {
    // Coalesce bursts: the rAF loop applies at most one resize per frame.
    this._pendingResize = true;
  };

  FrameSequence.prototype._onVisibility = function () {
    if (this._destroyed) return;
    if (document.hidden) return;
    // rAF is paused while hidden, so whatever scroll happened meanwhile was
    // never painted. Force a redraw and make sure the loop is running again.
    this._dirty = true;
    if (!this._rafId) this._rafId = global.requestAnimationFrame(this._tick);
    this._drawNow();
  };

  FrameSequence.prototype._applyResize = function () {
    if (this._destroyed) return;
    this._pendingResize = false;

    var canvas = this.canvas;
    var cssW = canvas.clientWidth;
    var cssH = canvas.clientHeight;

    // If stylesheet-driven sizing has not produced a box (detached canvas, or
    // page loaded without CSS), fall back to the viewport and set the CSS size
    // ourselves — kept strictly separate from the backing-store size below.
    if (!cssW || !cssH) {
      cssW = global.innerWidth || 1;
      cssH = global.innerHeight || 1;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }

    var dpr = global.devicePixelRatio || 1;
    if (dpr > MAX_DPR) dpr = MAX_DPR; // 3x DPR on a fullscreen canvas is wasted fill rate
    if (dpr < 1) dpr = 1;

    var bw = Math.max(1, Math.round(cssW * dpr));
    var bh = Math.max(1, Math.round(cssH * dpr));

    var changed = false;
    // Assigning width/height clears the canvas, so only touch on real change.
    if (canvas.width !== bw) { canvas.width = bw; changed = true; }
    if (canvas.height !== bh) { canvas.height = bh; changed = true; }

    this._cw = bw;
    this._ch = bh;

    // Backdrop backing store tracks the stage's aspect at a fixed small width.
    if (this.backdrop) {
      var nbw = BACKDROP_W;
      var nbh = Math.max(1, Math.round(BACKDROP_W * bh / bw));
      if (this.backdrop.width !== nbw || this.backdrop.height !== nbh) {
        this.backdrop.width = nbw;
        this.backdrop.height = nbh;
        this._bw = nbw;
        this._bh = nbh;
        this._brectSrcW = 0; // invalidate
        if (this._bctx) {
          this._bctx.imageSmoothingEnabled = true;
          this._bctx.imageSmoothingQuality = 'low';
          this._bctx.globalAlpha = 1;
        }
        changed = true;
      }
    }

    if (changed) {
      var ctx = this._ctx;
      if (ctx) {
        // Context state resets when the backing store is resized.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.globalAlpha = 1;
      }
      this._rectSrcW = 0; // invalidate draw rect
      this._computeRect(this._fw[0] || 0, this._fh[0] || 0);
      this._dirty = true;
      // Draw synchronously here (not on the scroll path) so a resize does not
      // flash an empty backing store for a frame.
      this._drawNow();
    }
  };

  // Crop-limited cover, anchored at (focusX, focusY).
  //
  // Plain `object-fit: cover` scales by the LARGER axis ratio so the shorter
  // axis overflows instead of letterboxing, and always centers the overflow.
  // Both halves of that need control here. The source is 720x1280 portrait; a
  // 16:9 desktop window therefore crops ~70% of the HEIGHT, and a centered
  // crop of this particular footage lands on empty water — the longship sits
  // below the midline. So the overflow is anchored at focusY instead.
  //
  // maxCrop then bounds how far the fill is allowed to go: holding at least
  // (1 - maxCrop) of an axis visible caps the scale at contain / (1 - maxCrop);
  // past that we letterbox against `background`. At maxCrop = 1 this is a plain
  // anchored cover and the clamp never engages.
  FrameSequence.prototype._computeRect = function (sw, sh) {
    if (!sw || !sh || !this._cw || !this._ch) return;
    var sx = this._cw / sw;
    var sy = this._ch / sh;
    var cover = sx > sy ? sx : sy;
    var contain = sx < sy ? sx : sy;

    var s = cover;
    if (this.maxCrop < 1) {
      var limit = contain / (1 - this.maxCrop);
      if (s > limit) s = limit;
    }
    // Quality ceiling. Applied last so it always wins: past this the image is
    // being invented by the resampler rather than read off the source.
    if (s > this.maxUpscale) s = this.maxUpscale;

    var dw = sw * s;
    var dh = sh * s;
    this._dw = dw;
    this._dh = dh;

    // (cw - dw) is negative when the axis overflows, so multiplying by the
    // focus fraction slides the crop window; it stays a plain centered fit at
    // 0.5. When the axis letterboxes instead, the same expression is positive
    // and would shove the bars off-balance — so letterboxed axes force 0.5.
    this._dx = dw > this._cw ? (this._cw - dw) * this.focusX : (this._cw - dw) * 0.5;
    this._dy = dh > this._ch ? (this._ch - dh) * this.focusY : (this._ch - dh) * 0.5;

    this._rectSrcW = sw;
    this._rectSrcH = sh;

    // Sub-pixel slack: a rect within 0.5 device px of the edge still covers.
    this._letterboxed = (dw < this._cw - 0.5) || (dh < this._ch - 0.5);

    this._buildFeather();
  };

  // Edge feather.
  //
  // Once the scale is capped the sharp frame stops reaching the sides, and the
  // butt-join against the blurred fill reads as a video dropped in a box. These
  // gradients erase the frame's own edges so it dissolves into the blur.
  // Built once per layout change — allocating a gradient per draw would show up
  // on the scroll path.
  FrameSequence.prototype._buildFeather = function () {
    this._featherX = null;
    this._featherY = null;
    if (!this.backdrop || !this._ctx) return;

    var ctx = this._ctx;
    var g, fade;

    if (this._dw < this._cw - 0.5) {
      // Generous but bounded: too narrow and the seam is still legible.
      fade = Math.min(this._dw * 0.22, this._cw * 0.12);
      if (fade > 1) {
        g = ctx.createLinearGradient(this._dx, 0, this._dx + fade, 0);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        var g2 = ctx.createLinearGradient(this._dx + this._dw - fade, 0, this._dx + this._dw, 0);
        g2.addColorStop(0, 'rgba(0,0,0,0)');
        g2.addColorStop(1, 'rgba(0,0,0,1)');
        this._featherX = { fade: fade, left: g, right: g2 };
      }
    }

    if (this._dh < this._ch - 0.5) {
      fade = Math.min(this._dh * 0.22, this._ch * 0.12);
      if (fade > 1) {
        g = ctx.createLinearGradient(0, this._dy, 0, this._dy + fade);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        var g3 = ctx.createLinearGradient(0, this._dy + this._dh - fade, 0, this._dy + this._dh);
        g3.addColorStop(0, 'rgba(0,0,0,0)');
        g3.addColorStop(1, 'rgba(0,0,0,1)');
        this._featherY = { fade: fade, top: g, bottom: g3 };
      }
    }
  };

  FrameSequence.prototype._applyFeather = function () {
    var fx = this._featherX;
    var fy = this._featherY;
    if (!fx && !fy) return;

    var ctx = this._ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';

    if (fx) {
      ctx.fillStyle = fx.left;
      ctx.fillRect(this._dx, 0, fx.fade, this._ch);
      ctx.fillStyle = fx.right;
      ctx.fillRect(this._dx + this._dw - fx.fade, 0, fx.fade, this._ch);
    }
    if (fy) {
      ctx.fillStyle = fy.top;
      ctx.fillRect(0, this._dy, this._cw, fy.fade);
      ctx.fillStyle = fy.bottom;
      ctx.fillRect(0, this._dy + this._dh - fy.fade, this._cw, fy.fade);
    }

    ctx.globalCompositeOperation = 'source-over';
  };

  // The backdrop always covers, and always at the same focus anchor, so the
  // blurred fill stays visually continuous with the sharp frame in front.
  FrameSequence.prototype._computeBackdropRect = function (sw, sh) {
    if (!sw || !sh || !this._bw || !this._bh) return;
    var sx = this._bw / sw;
    var sy = this._bh / sh;
    var s = sx > sy ? sx : sy;

    var dw = sw * s;
    var dh = sh * s;
    this._bdw = dw;
    this._bdh = dh;
    this._bdx = dw > this._bw ? (this._bw - dw) * this.focusX : (this._bw - dw) * 0.5;
    this._bdy = dh > this._bh ? (this._bh - dh) * this.focusY : (this._bh - dh) * 0.5;
    this._brectSrcW = sw;
    this._brectSrcH = sh;
  };

  /* ------------------------------------------------------------------ *
   * Render loop
   * ------------------------------------------------------------------ */

  FrameSequence.prototype._tick = function () {
    if (this._destroyed) { this._rafId = 0; return; }
    this._rafId = global.requestAnimationFrame(this._tick);

    if (this._pendingResize) this._applyResize();
    if (!this._dirty) return;
    // Stay dirty while hidden so the visibilitychange handler repaints.
    if (typeof document !== 'undefined' && document.hidden) return;
    this._draw();
  };

  FrameSequence.prototype._drawNow = function () {
    if (this._destroyed || !this._dirty) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this._draw();
  };

  FrameSequence.prototype._draw = function () {
    var ctx = this._ctx;
    if (!ctx || !this._frames) return;
    if (!this._cw || !this._ch) {
      this._applyResize();
      if (!this._cw || !this._ch) return;
    }

    // When the fit letterboxes, the frame no longer repaints every pixel, so
    // the base draw can't be relied on to erase the previous one. Clear or
    // fill first, depending on whether a blurred backdrop is showing through.
    // Skipped in the common covering case to avoid a wasted full-canvas pass.
    if (this._letterboxed) {
      ctx.globalAlpha = 1;
      if (this.backdrop) {
        ctx.clearRect(0, 0, this._cw, this._ch);
      } else {
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, this._cw, this._ch);
      }
    }

    var n = this.frameCount;
    var p = this._progress;

    // Float frame position: progress 0..1 maps across frame 0..n-1.
    var f = n > 1 ? p * (n - 1) : 0;

    if (!this.crossfade) {
      if (!this._drawFrame(Math.round(f), 1)) return;
      ctx.globalAlpha = 1;
      this._applyFeather();
      if (this._bctx) {
        this._drawBackdropFrame(Math.round(f), 1);
        this._bctx.globalAlpha = 1;
      }
      this._drawnProgress = p;
      this._dirty = false;
      this._firstPainted = true;
      return;
    }

    var i0 = f | 0; // f >= 0, so truncation === floor
    var frac = f - i0;

    // Snap the ends of the interval: at frac ~1 the next frame is effectively
    // opaque, so promote it and skip the blend entirely.
    if (frac >= 1 - FRAC_EPS) { i0 = i0 + 1 < n ? i0 + 1 : i0; frac = 0; }
    else if (frac <= FRAC_EPS) { frac = 0; }

    var painted = this._drawFrame(i0, 1);
    if (frac > 0 && i0 + 1 < n) {
      painted = this._drawFrame(i0 + 1, frac) || painted;
    }
    ctx.globalAlpha = 1;
    if (painted) this._applyFeather();

    // Same two frames, same blend, into the tiny backdrop surface.
    if (this._bctx) {
      this._drawBackdropFrame(i0, 1);
      if (frac > 0 && i0 + 1 < n) this._drawBackdropFrame(i0 + 1, frac);
      this._bctx.globalAlpha = 1;
    }

    if (!painted) return; // nothing available yet — stay dirty, retry next frame
    this._drawnProgress = p;
    this._dirty = false;
    this._firstPainted = true;
  };

  // Returns true if something was actually painted.
  FrameSequence.prototype._drawFrame = function (i, alpha) {
    var r = this._resolve(i);
    if (r < 0) return false;
    var img = this._frames[r];
    if (!img) return false;

    var sw = this._fw[r];
    var sh = this._fh[r];
    if (sw !== this._rectSrcW || sh !== this._rectSrcH) {
      this._computeRect(sw, sh);
      if (!this._dw) return false;
    }

    var ctx = this._ctx;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, this._dx, this._dy, this._dw, this._dh);
    return true;
  };

  // Cover-fit copy into the small backdrop surface. Cheap enough to run every
  // draw: the destination is ~192px wide and it is opaque, so there is no
  // clear pass and the second (crossfade) draw covers the first exactly.
  FrameSequence.prototype._drawBackdropFrame = function (i, alpha) {
    var r = this._resolve(i);
    if (r < 0) return false;
    var img = this._frames[r];
    if (!img) return false;

    var sw = this._fw[r];
    var sh = this._fh[r];
    if (sw !== this._brectSrcW || sh !== this._brectSrcH) {
      this._computeBackdropRect(sw, sh);
      if (!this._bdw) return false;
    }

    var bctx = this._bctx;
    bctx.globalAlpha = alpha;
    bctx.drawImage(img, this._bdx, this._bdy, this._bdw, this._bdh);
    return true;
  };

  global.FrameSequence = FrameSequence;
})(typeof window !== 'undefined' ? window : this);
