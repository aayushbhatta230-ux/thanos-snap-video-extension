/**
 * thanos_engine.js — turns a camera track into a processed track where your body
 * can turn to dust and disappear, leaving your actual room behind.
 *
 * Pipeline per frame:
 *   camera frame ─► (mirror) ─► cur
 *     cur ─► vision iframe (hand landmarks + person mask, async)
 *     mask + frame ─► background plate (room pixels learned wherever you're NOT)
 *     plate ─► push-pull hole fill (patches never-seen room behind you)
 *   output = cur, with the person region replaced by the filled plate when vanished,
 *            plus a layered dust animation during the snap.
 *
 * Uses MediaStreamTrackProcessor/Generator when available (keeps running when the
 * call tab is in the background), otherwise falls back to canvas.captureStream().
 */
(function () {
  'use strict';
  if (window.ThanosEngine) return;

  const ANALYSIS_W = 640;
  const DUST_LAYERS = 20;
  const DUST_MAX_W = 960;

  const mkCanvas = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  class ThanosEngine {
    constructor(opts = {}) {
      this.baseUrl = (opts.baseUrl || '').replace(/\/?$/, '/');
      this.mirror = opts.mirror !== false;
      this.duration = opts.duration || 2400;
      this.sensitivity = opts.sensitivity ?? 60;
      this.delegate = opts.delegate || '';
      this.cb = {
        state: opts.onState || null,
        status: opts.onStatus || null,
        palm: opts.onPalm || null,
        debug: opts.onDebug || null,
        ready: opts.onReady || null,
        coverage: opts.onCoverage || null
      };
      this.state = 'live';
      this.W = 0; this.H = 0;
      this.port = null;
      this.visionReady = false;
      this.busy = false;
      this.busySince = 0;
      this.hasMask = false;
      this.plateSeeded = false;
      this.dust = null;
      this.anim = null;
      this.frameCount = 0;
      this.destroyed = false;
    }

    // ------------------------------------------------------------------ public API

    async start(inputTrack) {
      this.input = inputTrack;
      this._initVision();
      if (typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined') {
        return this._startBreakout(inputTrack);
      }
      return this._startCanvasFallback(inputTrack);
    }

    setOptions(o = {}) {
      if (o.mirror !== undefined) this.mirror = !!o.mirror;
      if (o.duration) this.duration = Number(o.duration);
      if (o.sensitivity !== undefined) {
        this.sensitivity = Number(o.sensitivity);
        this.port?.postMessage({ type: 'settings', sensitivity: this.sensitivity });
      }
    }

    toggle() {
      if (this.state === 'live') this.snap();
      else if (this.state === 'gone') this.restore();
    }

    snap() {
      if (this.state !== 'live' || this.destroyed) return false;
      if (!this.hasMask) { this._status('Still loading the vision models…'); return false; }
      this._fillPlate();
      this.dust = this._buildDust(this.cur);
      this.anim = { start: performance.now() };
      this._setState('vanishing');
      return true;
    }

    restore() {
      if (this.state !== 'gone' || this.destroyed) return false;
      this.dust = this._buildDust(this.cur);
      this.anim = { start: performance.now() };
      this._setState('returning');
      return true;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      try { this.reader?.cancel(); } catch (_) {}
      try { this.writer?.close(); } catch (_) {}
      try { this.port?.close(); } catch (_) {}
      this.iframe?.remove();
      if (this.fallbackVideo) this.fallbackVideo.srcObject = null;
      this.dust = null;
    }

    // ------------------------------------------------------------------ video plumbing

    _startBreakout(track) {
      const proc = new MediaStreamTrackProcessor({ track });
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      this.reader = proc.readable.getReader();
      this.writer = gen.writable.getWriter();
      (async () => {
        while (!this.destroyed) {
          let r;
          try { r = await this.reader.read(); } catch (_) { break; }
          if (r.done) break;
          const frame = r.value;
          let out = frame;
          try {
            this._ensureSize(frame.displayWidth, frame.displayHeight);
            this._render(frame);
            const init = { timestamp: frame.timestamp };
            if (frame.duration) init.duration = frame.duration;
            out = new VideoFrame(this.out, init);
            frame.close();
          } catch (err) {
            if (this.frameCount % 120 === 0) console.error('[ThanosSnap] render failed, passing frame through', err);
          }
          try { await this.writer.write(out); } catch (_) { try { out.close(); } catch (__) {} break; }
        }
      })();
      this.output = gen;
      return gen;
    }

    async _startCanvasFallback(track) {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      this.fallbackVideo = video;
      await video.play().catch(() => {});
      const s = track.getSettings ? track.getSettings() : {};
      const canvas = document.createElement('canvas');
      canvas.width = s.width || video.videoWidth || 1280;
      canvas.height = s.height || video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      const tick = () => {
        if (this.destroyed) return;
        if (video.videoWidth) {
          if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
          this._ensureSize(video.videoWidth, video.videoHeight);
          this._render(video);
          ctx.drawImage(this.out, 0, 0);
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else setTimeout(tick, 33);
      };
      tick();
      const out = canvas.captureStream(30).getVideoTracks()[0];
      this.output = out;
      return out;
    }

    _ensureSize(w, h) {
      if (w === this.W && h === this.H) return;
      this.W = w; this.H = h;
      const aw = Math.min(ANALYSIS_W, w);
      const ah = Math.round((aw * h) / w);
      this.aw = aw; this.ah = ah;
      const pair = (cw, ch, opts) => { const c = mkCanvas(cw, ch); return [c, c.getContext('2d', opts)]; };
      [this.cur, this.curCtx] = pair(w, h);
      [this.out, this.outCtx] = pair(w, h);
      [this.sent, this.sentCtx] = pair(w, h);
      [this.plate, this.plateCtx] = pair(w, h);
      [this.tmp, this.tmpCtx] = pair(w, h);
      [this.fill, this.fillCtx] = pair(w, h);
      [this.pfill, this.pfillCtx] = pair(w, h);
      [this.mRaw, this.mRawCtx] = pair(aw, ah);
      [this.mHard, this.mHardCtx] = pair(aw, ah);
      [this.mDil0, this.mDil0Ctx] = pair(aw, ah);
      [this.mDil, this.mDilCtx] = pair(aw, ah);
      [this.cov, this.covCtx] = pair(32, 18, { willReadFrequently: true });
      this.levels = [];
      let lw = Math.max(4, Math.round(w / 4)), lh = Math.max(4, Math.round(h / 4));
      while (lw >= 2 && lh >= 2) {
        const [c, ctx] = pair(lw, lh);
        this.levels.push({ c, ctx, w: lw, h: lh });
        lw = Math.floor(lw / 2); lh = Math.floor(lh / 2);
      }
      this.hasMask = false;
      this.plateSeeded = false;
      this.hasFill = false;
    }

    // ------------------------------------------------------------------ vision bridge

    _initVision() {
      const iframe = document.createElement('iframe');
      iframe.src = this.baseUrl + 'vision.html' + (this.delegate ? `?delegate=${this.delegate}` : '');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      Object.assign(iframe.style, {
        position: 'fixed', width: '2px', height: '2px', left: '-20px', top: '-20px',
        opacity: '0', border: '0', pointerEvents: 'none'
      });
      iframe.addEventListener('load', () => {
        const ch = new MessageChannel();
        this.port = ch.port1;
        ch.port1.onmessage = (e) => this._onVision(e.data);
        let origin = '*';
        try { origin = new URL(this.baseUrl).origin; } catch (_) {}
        iframe.contentWindow.postMessage({ type: 'thanos-init', sensitivity: this.sensitivity }, origin, [ch.port2]);
      }, { once: true });
      (document.body || document.documentElement).appendChild(iframe);
      this.iframe = iframe;
      this._status('Loading vision models…');
    }

    _onVision(msg) {
      if (this.destroyed) { msg.mask?.close?.(); return; }
      if (msg.type === 'ready') {
        this.visionReady = true;
        this._status('Ready — show your hand');
        this.cb.ready?.(msg.delegate);
        return;
      }
      if (msg.type === 'error') {
        console.error('[ThanosSnap] vision failed:', msg.message);
        this._status('Vision failed to load: ' + msg.message);
        return;
      }
      if (msg.type !== 'result') return;
      this.busy = false;
      if (msg.mask) {
        this._updateMask(msg.mask);
        msg.mask.close();
        this._updatePlate();
        this.hasMask = true;
        if (this.state !== 'live') this._fillPlate();
      }
      if (msg.status) this._status(msg.status);
      this.cb.palm?.(msg.palm || 0);
      this.cb.debug?.({ hands: msg.hands || [], debug: msg.debug || [], state: this.state });
      for (const ev of msg.events || []) {
        if (ev === 'snap') this.toggle();
        else if (ev === 'palm') this.restore();
      }
    }

    _maybeSend() {
      if (!this.port || !this.visionReady) return;
      const now = performance.now();
      if (this.busy && now - this.busySince < 1000) return;
      this.busy = true;
      this.busySince = now;
      // Keep the exact frame being analysed so the returned mask lines up with it.
      this.sentCtx.drawImage(this.cur, 0, 0);
      createImageBitmap(this.cur, { resizeWidth: this.aw, resizeHeight: this.ah, resizeQuality: 'medium' })
        .then((bmp) => {
          if (this.destroyed || !this.port) { bmp.close(); return; }
          this.port.postMessage({ type: 'frame', bitmap: bmp, state: this.state }, [bmp]);
        })
        .catch(() => { this.busy = false; });
    }

    // ------------------------------------------------------------------ masks & room plate

    _updateMask(bmp) {
      const { aw, ah } = this;
      const r = this.mRawCtx;
      r.globalCompositeOperation = 'copy';
      r.drawImage(bmp, 0, 0, aw, ah);

      // Hard mask: boost soft confidence so the body is fully opaque.
      const hc = this.mHardCtx;
      hc.globalCompositeOperation = 'copy';
      hc.drawImage(this.mRaw, 0, 0);
      hc.globalCompositeOperation = 'source-over';
      hc.drawImage(this.mRaw, 0, 0);
      hc.drawImage(this.mRaw, 0, 0);

      // Dilated mask: grow the body outline so no halo/edge of you leaks through when vanished.
      const rad = Math.max(3, Math.round(aw * 0.016));
      const d0 = this.mDil0Ctx;
      d0.clearRect(0, 0, aw, ah);
      d0.drawImage(this.mHard, 0, 0);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        d0.drawImage(this.mHard, Math.cos(a) * rad, Math.sin(a) * rad);
      }
      const dc = this.mDilCtx;
      dc.clearRect(0, 0, aw, ah);
      dc.filter = `blur(${Math.max(1, Math.round(rad * 0.5))}px)`;
      dc.drawImage(this.mDil0, 0, 0);
      dc.filter = 'none';
    }

    _updatePlate() {
      const { W, H } = this;
      const t = this.tmpCtx;
      t.globalCompositeOperation = 'copy';
      t.drawImage(this.sent, 0, 0);
      t.globalCompositeOperation = 'destination-out';
      t.drawImage(this.mDil, 0, 0, W, H);
      t.globalCompositeOperation = 'source-over';
      const p = this.plateCtx;
      p.globalAlpha = this.plateSeeded ? 0.4 : 1;
      p.drawImage(this.tmp, 0, 0);
      p.globalAlpha = 1;
      this.plateSeeded = true;
      if (++this.frameCount % 30 === 0) this._reportCoverage();
    }

    /** Push-pull hole filling: room areas never seen get a smooth fill from their surroundings. */
    _fillPlate() {
      const L = this.levels;
      if (!L.length) return;
      L[0].ctx.globalCompositeOperation = 'copy';
      L[0].ctx.drawImage(this.plate, 0, 0, L[0].w, L[0].h);
      for (let i = 1; i < L.length; i++) {
        L[i].ctx.globalCompositeOperation = 'copy';
        L[i].ctx.drawImage(L[i - 1].c, 0, 0, L[i].w, L[i].h);
      }
      // Make the coarsest level fully opaque: drawing a semi-transparent image over itself keeps
      // its colour but pushes alpha toward 1. Every finer level then inherits full opacity.
      const top = L[L.length - 1];
      top.ctx.globalCompositeOperation = 'source-over';
      for (let k = 0; k < 6; k++) top.ctx.drawImage(top.c, 0, 0);
      for (let i = L.length - 2; i >= 0; i--) {
        L[i].ctx.globalCompositeOperation = 'destination-over';
        L[i].ctx.drawImage(L[i + 1].c, 0, 0, L[i].w, L[i].h);
      }
      const f = this.fillCtx;
      f.globalCompositeOperation = 'copy';
      f.drawImage(L[0].c, 0, 0, this.W, this.H);
      f.globalCompositeOperation = 'source-over';
      // Scanline fill on top: each row bridges the hole with the real room colours on either
      // side, so walls/furniture continue across instead of becoming one radial blob.
      const sl = this._scanlineFill();
      if (sl) {
        f.filter = `blur(${Math.max(2, Math.round(this.W / 160))}px)`;
        f.drawImage(sl, 0, 0, this.W, this.H);
        f.filter = 'none';
      }
      f.globalCompositeOperation = 'source-over';
      f.drawImage(this.plate, 0, 0);
      this.hasFill = true;
    }

    _scanlineFill() {
      const sw = Math.max(16, Math.round(this.W / 8)), sh = Math.max(9, Math.round(this.H / 8));
      if (!this.sl || this.sl.width !== sw) {
        this.sl = mkCanvas(sw, sh);
        this.slCtx = this.sl.getContext('2d', { willReadFrequently: true });
      }
      const c = this.slCtx;
      c.globalCompositeOperation = 'copy';
      c.drawImage(this.plate, 0, 0, sw, sh);
      const img = c.getImageData(0, 0, sw, sh);
      const d = img.data;
      const known = (i) => d[i * 4 + 3] >= 128;
      for (let y = 0; y < sh; y++) {
        const row = y * sw;
        let x = 0;
        while (x < sw) {
          if (known(row + x)) { x++; continue; }
          const a = x;
          while (x < sw && !known(row + x)) x++;
          const L = a > 0 ? (row + a - 1) * 4 : -1;
          const R = x < sw ? (row + x) * 4 : -1;
          if (L < 0 && R < 0) continue; // whole row unknown — push-pull underneath covers it
          for (let k = a; k < x; k++) {
            const t = (k - a + 1) / (x - a + 1);
            const o = (row + k) * 4;
            for (let ch = 0; ch < 3; ch++) {
              const lv = L >= 0 ? d[L + ch] : d[R + ch];
              const rv = R >= 0 ? d[R + ch] : d[L + ch];
              d[o + ch] = lv + (rv - lv) * t;
            }
            d[o + 3] = 255;
          }
        }
      }
      c.putImageData(img, 0, 0);
      return this.sl;
    }

    _reportCoverage() {
      if (!this.cb.coverage) return;
      const c = this.covCtx;
      c.clearRect(0, 0, 32, 18);
      c.drawImage(this.plate, 0, 0, 32, 18);
      const d = c.getImageData(0, 0, 32, 18).data;
      let sum = 0;
      for (let i = 3; i < d.length; i += 4) sum += d[i];
      this.cb.coverage(sum / (255 * 32 * 18));
    }

    // ------------------------------------------------------------------ rendering

    _render(src) {
      const { W, H } = this;
      const c = this.curCtx;
      if (this.mirror) c.setTransform(-1, 0, 0, 1, W, 0);
      c.drawImage(src, 0, 0, W, H);
      c.setTransform(1, 0, 0, 1, 0, 0);
      this._maybeSend();

      const o = this.outCtx;
      o.globalCompositeOperation = 'copy';
      o.drawImage(this.cur, 0, 0);
      o.globalCompositeOperation = 'source-over';
      if (this.state === 'live') return;

      const now = performance.now();
      if (this.state === 'gone') {
        this._hidePerson(o, 1);
      } else if (this.state === 'vanishing') {
        const t = clamp01((now - this.anim.start) / this.duration);
        this._hidePerson(o, 1);
        this._drawDust(o, t, 1);
        if (t >= 1) { this.dust = null; this._setState('gone'); }
      } else if (this.state === 'returning') {
        const p = clamp01((now - this.anim.start) / (this.duration * 0.8));
        const k = clamp01((p - 0.7) / 0.3); // final crossfade to the live you
        this._hidePerson(o, 1 - k);
        this._drawDust(o, 1 - p, 1 - k);
        if (p >= 1) { this.dust = null; this._setState('live'); }
      }
    }

    _hidePerson(o, alpha) {
      if (!this.hasFill || alpha <= 0) return;
      const pf = this.pfillCtx;
      pf.globalCompositeOperation = 'copy';
      pf.drawImage(this.fill, 0, 0);
      pf.globalCompositeOperation = 'destination-in';
      pf.drawImage(this.mDil, 0, 0, this.W, this.H);
      pf.globalCompositeOperation = 'source-over';
      o.globalAlpha = alpha;
      o.drawImage(this.pfill, 0, 0);
      o.globalAlpha = 1;
    }

    /** Slice the person into layers of random "grains"; each layer blows away on its own schedule. */
    _buildDust(source) {
      const { W, H } = this;
      const LW = Math.min(W, DUST_MAX_W), LH = Math.round((H * LW) / W);
      const sc = mkCanvas(LW, LH);
      const sctx = sc.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(source, 0, 0, LW, LH);
      sctx.globalCompositeOperation = 'destination-in';
      sctx.drawImage(this.mHard, 0, 0, LW, LH);
      const src = sctx.getImageData(0, 0, LW, LH).data;

      let minX = LW, maxX = 0, minY = LH, maxY = 0;
      for (let y = 0; y < LH; y += 4) {
        for (let x = 0; x < LW; x += 4) {
          if (src[(y * LW + x) * 4 + 3] > 40) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX <= minX) { minX = 0; maxX = LW; minY = 0; maxY = LH; }

      // Low-frequency value noise so the dissolve eats away in organic patches.
      const GW = 9, GH = 7;
      const grid = Array.from({ length: GW * GH }, Math.random);
      const noise = (x, y) => {
        const fx = (x / LW) * (GW - 1), fy = (y / LH) * (GH - 1);
        const ix = Math.min(GW - 2, fx | 0), iy = Math.min(GH - 2, fy | 0);
        const tx = fx - ix, ty = fy - iy;
        const a = grid[iy * GW + ix], b = grid[iy * GW + ix + 1];
        const c = grid[(iy + 1) * GW + ix], d = grid[(iy + 1) * GW + ix + 1];
        return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      };

      const K = DUST_LAYERS;
      const datas = Array.from({ length: K }, () => new ImageData(LW, LH));
      const embers = [];
      const G = 2;
      const spanX = maxX - minX + 1;
      for (let y = 0; y < LH; y += G) {
        for (let x = 0; x < LW; x += G) {
          const i0 = (y * LW + x) * 4;
          if (src[i0 + 3] < 12) continue;
          const nx = (x - minX) / spanX;
          let v = 0.45 * nx + 0.55 * noise(x, y) + (Math.random() - 0.5) * 0.32;
          v = clamp01((v + 0.16) / 1.32);
          const li = Math.min(K - 1, (v * K) | 0);
          const dst = datas[li].data;
          for (let yy = y; yy < Math.min(LH, y + G); yy++) {
            for (let xx = x; xx < Math.min(LW, x + G); xx++) {
              const i = (yy * LW + xx) * 4;
              dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3];
            }
          }
          if (Math.random() < 0.006 && embers.length < 900) {
            embers.push({
              x: (x / LW) * W, y: (y / LH) * H, li,
              vx: (0.10 + Math.random() * 0.25) * W, vy: -(0.05 + Math.random() * 0.2) * H,
              s: 1 + Math.random() * 2.2, warm: Math.random() < 0.35
            });
          }
        }
      }

      const layers = datas.map((data, i) => {
        const c = mkCanvas(LW, LH);
        c.getContext('2d').putImageData(data, 0, 0);
        const ang = -0.15 - Math.random() * 0.55; // mostly up-and-right
        return {
          c,
          start: (i / K) * 0.55,
          len: 0.38 + Math.random() * 0.07,
          dx: Math.cos(ang) * (0.18 + Math.random() * 0.22) * W,
          dy: Math.sin(ang) * (0.18 + Math.random() * 0.22) * H * 1.4,
          rot: (Math.random() - 0.5) * 0.2
        };
      });
      const scratch = mkCanvas(LW, LH);
      return {
        layers, embers, scratch, scratchCtx: scratch.getContext('2d'), LW, LH,
        cx: ((minX + maxX) / 2 / LW) * W, cy: ((minY + maxY) / 2 / LH) * H
      };
    }

    _drawDust(o, t, alphaMul) {
      const D = this.dust;
      if (!D || alphaMul <= 0) return;
      const { W, H } = this;
      const s = D.scratchCtx;
      for (const L of D.layers) {
        const local = clamp01((t - L.start) / L.len);
        if (local >= 1) continue;
        const e = local * local;
        o.save();
        o.globalAlpha = Math.pow(1 - local, 1.4) * alphaMul;
        o.translate(D.cx + L.dx * e, D.cy + L.dy * e);
        o.rotate(L.rot * e);
        const sc = 1 + 0.08 * e;
        o.scale(sc, sc);
        o.translate(-D.cx, -D.cy);
        if (local > 0) {
          // Fade the grains toward ash as they blow away.
          s.globalCompositeOperation = 'copy';
          s.drawImage(L.c, 0, 0);
          s.globalCompositeOperation = 'source-atop';
          s.fillStyle = `rgba(62,48,40,${Math.min(0.75, local * 1.6)})`;
          s.fillRect(0, 0, D.LW, D.LH);
          o.drawImage(D.scratch, 0, 0, W, H);
        } else {
          o.drawImage(L.c, 0, 0, W, H);
        }
        o.restore();
      }
      o.save();
      o.globalCompositeOperation = 'lighter';
      for (const p of D.embers) {
        const L = D.layers[p.li];
        const local = clamp01((t - L.start) / (L.len * 1.4));
        if (local <= 0 || local >= 1) continue;
        const a = (1 - local) * alphaMul;
        o.fillStyle = p.warm ? `rgba(255,150,70,${a * 0.9})` : `rgba(190,170,150,${a * 0.6})`;
        const e = local * (0.6 + 0.4 * local);
        o.fillRect(p.x + p.vx * e, p.y + p.vy * e, p.s, p.s);
      }
      o.restore();
    }

    // ------------------------------------------------------------------ helpers

    _setState(s) {
      this.state = s;
      this.cb.state?.(s);
    }

    _status(text) {
      if (text === this.lastStatus) return;
      this.lastStatus = text;
      this.cb.status?.(text);
    }
  }

  window.ThanosEngine = ThanosEngine;
})();
