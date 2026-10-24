/**
 * ThanosEngine.js - Mirrored Video & Body-Only Particle Disintegration Engine
 * Mirrors video horizontally everywhere and dissolves ONLY the user's body
 * into cosmic ash while keeping the room background fully visible.
 */

(function (window) {
  'use strict';

  class ThanosEngine {
    constructor(options = {}) {
      this.width = options.width || 1280;
      this.height = options.height || 720;
      this.duration = options.duration || 2400; // ms
      this.particleSpacing = options.particleSpacing || 5;
      this.mirrorVideo = options.mirrorVideo !== false; // Always true by default
      this.enableSound = options.enableSound !== false;
      this.baseExtensionUrl = options.baseExtensionUrl || '';

      this.onComplete = options.onComplete || null;
      this.onSnap = options.onSnap || null;
      this.onRestore = options.onRestore || null;

      // Rendering state: 'PASSTHROUGH' | 'DISINTEGRATING' | 'SNAPPED' | 'RECOVERING'
      this.state = 'PASSTHROUGH';

      // Output Canvas (returned to WebRTC call)
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

      // Mirrored video buffer canvas
      this.mirroredCanvas = document.createElement('canvas');
      this.mirroredCanvas.width = this.width;
      this.mirroredCanvas.height = this.height;
      this.mirroredCtx = this.mirroredCanvas.getContext('2d', { willReadFrequently: true });

      // Offscreen buffer for frozen body frame & slicing
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCanvas.width = this.width;
      this.offscreenCanvas.height = this.height;
      this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });

      // Video element
      this.video = document.createElement('video');
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.muted = true;

      // Person Segmenter for separating body from room background
      this.segmenter = null;
      if (typeof window.PersonSegmenter !== 'undefined') {
        this.segmenter = new window.PersonSegmenter({
          width: this.width,
          height: this.height,
          baseExtensionUrl: this.baseExtensionUrl
        });
      }

      // Gesture Detector
      this.gestureDetector = null;
      if (typeof window.GestureDetector !== 'undefined') {
        this.gestureDetector = new window.GestureDetector({
          baseExtensionUrl: this.baseExtensionUrl,
          onSnap: () => this.triggerSnap(),
          onPalmProgress: (progress, elapsed) => {
            this.palmProgress = progress;
            this.palmElapsed = elapsed;
          },
          onPalmRecover: () => this.restore()
        });
      }

      // Palm recovery UI overlay variables
      this.palmProgress = 0;
      this.palmElapsed = 0;

      // Particles & Animation variables
      this.particles = [];
      this.snapStartTime = 0;
      this.recoveryStartTime = 0;
      this.recoveryDuration = 900; // ms smooth materialize
      this.animFrameId = null;

      // Sound
      this.audioCtx = null;
      this.audioDestination = null;

      this.initRenderLoop();
    }

    setBaseUrl(url) {
      this.baseExtensionUrl = url;
      if (this.segmenter) this.segmenter.setBaseUrl(url);
      if (this.gestureDetector) this.gestureDetector.setBaseUrl(url);
    }

    /**
     * Web Audio synthesis for Thanos snap + dust whoosh
     */
    initAudio(customAudioCtx = null, destinationNode = null) {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        this.audioCtx = customAudioCtx || new AudioContextClass();
        this.audioDestination = destinationNode || this.audioCtx.destination;
      } catch (err) {
        console.warn('[ThanosEngine] Audio setup warning:', err);
      }
    }

    playThanosSound(targetDestination = null) {
      if (!this.enableSound) return;
      try {
        if (!this.audioCtx) this.initAudio();
        const ctx = this.audioCtx;
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();

        const dest = targetDestination || this.audioDestination || ctx.destination;
        const now = ctx.currentTime;

        // Click & Snap impulse
        const snapOsc = ctx.createOscillator();
        const snapGain = ctx.createGain();
        snapOsc.type = 'triangle';
        snapOsc.frequency.setValueAtTime(3200, now);
        snapOsc.frequency.exponentialRampToValueAtTime(700, now + 0.05);

        snapGain.gain.setValueAtTime(0.001, now);
        snapGain.gain.linearRampToValueAtTime(0.85, now + 0.003);
        snapGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

        snapOsc.connect(snapGain);
        snapGain.connect(dest);
        snapOsc.start(now);
        snapOsc.stop(now + 0.07);

        // Dust wind whoosh
        const bufferSize = ctx.sampleRate * 2.5;
        const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        let lastOut = 0.0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          output[i] = (lastOut + 0.02 * white) / 1.02;
          lastOut = output[i];
          output[i] *= 3.0;
        }

        const whiteNoise = ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;

        const windFilter = ctx.createBiquadFilter();
        windFilter.type = 'bandpass';
        windFilter.frequency.setValueAtTime(400, now + 0.04);
        windFilter.frequency.linearRampToValueAtTime(1300, now + 0.7);
        windFilter.frequency.exponentialRampToValueAtTime(250, now + 2.3);
        windFilter.Q.setValueAtTime(2.0, now);

        const windGain = ctx.createGain();
        windGain.gain.setValueAtTime(0.001, now + 0.04);
        windGain.gain.linearRampToValueAtTime(0.4, now + 0.4);
        windGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);

        whiteNoise.connect(windFilter);
        windFilter.connect(windGain);
        windGain.connect(dest);

        whiteNoise.start(now + 0.04);
        whiteNoise.stop(now + 2.5);
      } catch (e) {
        console.warn('[ThanosEngine] Sound error:', e);
      }
    }

    async attachStream(stream) {
      this.stream = stream;
      this.video.srcObject = stream;
      return new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          if (this.video.videoWidth && this.video.videoHeight) {
            this.width = this.video.videoWidth;
            this.height = this.video.videoHeight;
            this.canvas.width = this.width;
            this.canvas.height = this.height;
            this.mirroredCanvas.width = this.width;
            this.mirroredCanvas.height = this.height;
            this.offscreenCanvas.width = this.width;
            this.offscreenCanvas.height = this.height;
            if (this.segmenter) this.segmenter.resize(this.width, this.height);
          }
          this.video.play().then(() => resolve(true)).catch(() => resolve(false));
        };
      });
    }

    getCaptureStream(fps = 30) {
      if (this.canvas.captureStream) return this.canvas.captureStream(fps);
      if (this.canvas.mozCaptureStream) return this.canvas.mozCaptureStream(fps);
      throw new Error('Canvas captureStream not supported');
    }

    /**
     * TRIGGER SNAP: Disintegrates ONLY the user's body
     */
    triggerSnap() {
      if (this.state === 'DISINTEGRATING' || this.state === 'SNAPPED') return;

      this.state = 'DISINTEGRATING';
      this.snapStartTime = performance.now();

      // Freeze current mirrored frame & isolate person
      this.offscreenCtx.drawImage(this.mirroredCanvas, 0, 0, this.width, this.height);

      this.playThanosSound();
      this.generateBodyParticles();

      if (typeof this.onSnap === 'function') {
        this.onSnap();
      }

      window.dispatchEvent(new CustomEvent('thanos-video-snapped', {
        detail: { timestamp: this.snapStartTime }
      }));
    }

    /**
     * Generate particles ONLY from the segmented body pixels
     */
    generateBodyParticles() {
      const imgData = this.offscreenCtx.getImageData(0, 0, this.width, this.height);
      const data = imgData.data;

      // Obtain segmentation mask
      let maskData = null;
      if (this.segmenter && this.segmenter.maskCtx) {
        maskData = this.segmenter.maskCtx.getImageData(0, 0, this.width, this.height).data;
      }

      const step = Math.max(3, this.particleSpacing);
      const particles = [];
      const w = this.width;
      const h = this.height;

      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const idx = (y * w + x) * 4;

          // If segmentation mask is available, only sample where person is detected!
          if (maskData) {
            const maskVal = maskData[idx]; // White/high = person
            if (maskVal < 60) continue; // Skip room background pixels!
          } else {
            // Fallback: center-body heuristic
            const dx = (x - w * 0.5) / (w * 0.35);
            const dy = (y - h * 0.55) / (h * 0.45);
            if (dx * dx + dy * dy > 1.0) continue;
          }

          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3];
          if (a < 30) continue;

          // Sweeping wave across the body
          const distAlongWave = (x * 0.65 + y * 0.75) / (w * 0.65 + h * 0.75);
          const noise = (Math.random() - 0.5) * 0.15;
          const normalizedActivation = Math.min(1, Math.max(0, distAlongWave + noise));
          const activateAtMs = normalizedActivation * (this.duration * 0.6);

          // Upward & rightward drifting wind angle
          const windAngle = -Math.PI / 2 + (Math.random() * 0.8 - 0.2);
          const speed = 1.4 + Math.random() * 3.6;

          particles.push({
            x: x,
            y: y,
            vx: Math.cos(windAngle) * speed + (Math.random() * 1.5),
            vy: Math.sin(windAngle) * speed - (1.0 + Math.random() * 2.2),
            color: [r, g, b],
            size: step * (0.8 + Math.random() * 0.6),
            activateAtMs: activateAtMs,
            active: false,
            life: 1.0,
            decayRate: 0.012 + Math.random() * 0.022,
            turbulenceSeed: Math.random() * 100
          });
        }
      }

      this.particles = particles;
    }

    /**
     * RESTORE: Recovers user's body
     */
    restore() {
      if (this.state === 'PASSTHROUGH') return;

      this.state = 'RECOVERING';
      this.recoveryStartTime = performance.now();
      this.particles = [];
      this.palmProgress = 0;

      if (typeof this.onRestore === 'function') {
        this.onRestore();
      }
      window.dispatchEvent(new CustomEvent('thanos-video-restored'));
    }

    /**
     * Animation Loop
     */
    initRenderLoop() {
      const render = (now) => {
        // 1. Always capture and mirror camera feed horizontally
        if (this.video.readyState >= 2) {
          this.mirroredCtx.save();
          this.mirroredCtx.translate(this.width, 0);
          this.mirroredCtx.scale(-1, 1); // MIRROR VIDEO HORIZONTALLY EVERYWHERE
          this.mirroredCtx.drawImage(this.video, 0, 0, this.width, this.height);
          this.mirroredCtx.restore();

          // Pass mirrored frame to vision segmenter & gesture detector
          if (this.segmenter) {
            this.segmenter.processFrame(this.video, this.mirroredCanvas);
          }
          if (this.gestureDetector) {
            this.gestureDetector.processFrame(this.mirroredCanvas);
          }
        }

        // 2. Render state machine
        if (this.state === 'PASSTHROUGH') {
          // Normal mode: Crisp mirrored live camera feed
          this.ctx.drawImage(this.mirroredCanvas, 0, 0, this.width, this.height);
        } else if (this.state === 'DISINTEGRATING') {
          this.renderBodyDisintegration(now);
        } else if (this.state === 'SNAPPED') {
          this.renderSnappedRoom(now);
        } else if (this.state === 'RECOVERING') {
          this.renderRecovering(now);
        }

        // 3. Render 3-second open palm hold progress ring if palm is shown
        if (this.palmProgress > 0) {
          this.renderPalmProgressRing();
        }

        this.animFrameId = requestAnimationFrame(render);
      };

      this.animFrameId = requestAnimationFrame(render);
    }

    /**
     * Render body-only disintegration:
     * Room background remains visible while user's body fades and turns into ash
     */
    renderBodyDisintegration(now) {
      const elapsed = now - this.snapStartTime;
      const progress = Math.min(1.0, elapsed / this.duration);
      const bodyAlpha = Math.max(0, 1.0 - progress);

      // Layer 1: Render Room Background (camera does NOT go off!)
      if (this.segmenter && this.segmenter.hasBgFrame) {
        this.ctx.drawImage(this.segmenter.bgCanvas, 0, 0, this.width, this.height);
      } else {
        // Fallback: draw frozen frame darkened slightly
        this.ctx.drawImage(this.offscreenCanvas, 0, 0, this.width, this.height);
      }

      // Layer 2: Render fading body on top of room
      if (bodyAlpha > 0.01) {
        this.ctx.save();
        this.ctx.globalAlpha = bodyAlpha;

        if (this.segmenter) {
          const personLayer = this.segmenter.isolatePerson(this.offscreenCanvas);
          this.ctx.drawImage(personLayer, 0, 0, this.width, this.height);
        } else {
          this.ctx.drawImage(this.offscreenCanvas, 0, 0, this.width, this.height);
        }

        this.ctx.restore();
      }

      // Layer 3: Render cosmic ash particles floating away
      let activeCount = 0;
      const particleCtx = this.ctx;

      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];

        if (!p.active) {
          if (elapsed >= p.activateAtMs) {
            p.active = true;
          } else {
            continue;
          }
        }

        if (p.life <= 0) continue;
        activeCount++;

        p.life -= p.decayRate;
        const turbulence = Math.sin(elapsed * 0.003 + p.turbulenceSeed) * 1.3;
        p.x += p.vx + turbulence;
        p.y += p.vy;
        p.vy -= 0.04; // float upward

        const [r, g, b] = p.color;
        const ashFactor = 1.0 - p.life;
        const gray = (r * 0.299 + g * 0.587 + b * 0.114) * 0.4;

        const curR = Math.floor(r * (1 - ashFactor) + gray * ashFactor);
        const curG = Math.floor(g * (1 - ashFactor) + gray * ashFactor);
        const curB = Math.floor(b * (1 - ashFactor) + (gray + 15) * ashFactor);
        const alpha = Math.max(0, Math.min(1, p.life));

        particleCtx.fillStyle = `rgba(${curR}, ${curG}, ${curB}, ${alpha})`;
        const s = Math.max(1, p.size * p.life);
        particleCtx.fillRect(p.x, p.y, s, s);
      }

      if (progress >= 1.0 && activeCount === 0) {
        this.state = 'SNAPPED';
        if (typeof this.onComplete === 'function') {
          this.onComplete();
        }
        window.dispatchEvent(new CustomEvent('thanos-disintegration-complete'));
      }
    }

    /**
     * Render post-snap state: Room background remains active and visible!
     */
    renderSnappedRoom(now) {
      if (this.segmenter && this.segmenter.hasBgFrame) {
        // Show room background
        this.ctx.drawImage(this.segmenter.bgCanvas, 0, 0, this.width, this.height);
      } else {
        // Fallback room snapshot
        this.ctx.drawImage(this.offscreenCanvas, 0, 0, this.width, this.height);
      }

      // Subtle atmospheric Infinity embers drifting in the empty room
      this.ctx.fillStyle = 'rgba(168, 85, 247, 0.18)';
      const t = now * 0.001;
      for (let i = 0; i < 8; i++) {
        const x = (Math.sin(t * 0.2 + i * 2.5) * 0.45 + 0.5) * this.width;
        const y = (Math.cos(t * 0.3 + i * 1.8) * 0.45 + 0.5) * this.height;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 2.0, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }

    /**
     * Smooth materialization recovery
     */
    renderRecovering(now) {
      const elapsed = now - this.recoveryStartTime;
      const progress = Math.min(1.0, elapsed / this.recoveryDuration);

      // Layer 1: Background
      if (this.segmenter && this.segmenter.hasBgFrame) {
        this.ctx.drawImage(this.segmenter.bgCanvas, 0, 0, this.width, this.height);
      }

      // Layer 2: Person fading back in
      this.ctx.save();
      this.ctx.globalAlpha = progress;
      this.ctx.drawImage(this.mirroredCanvas, 0, 0, this.width, this.height);
      this.ctx.restore();

      if (progress >= 1.0) {
        this.state = 'PASSTHROUGH';
      }
    }

    /**
     * Render on-screen glowing countdown ring when user holds open palm for 3s
     */
    renderPalmProgressRing() {
      const cx = this.width / 2;
      const cy = this.height / 2;
      const radius = 64;
      const progress = Math.min(1.0, this.palmProgress);

      this.ctx.save();

      // Background dim circle
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      this.ctx.lineWidth = 8;
      this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      this.ctx.stroke();

      // Glowing progress arc
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      this.ctx.lineWidth = 8;
      this.ctx.strokeStyle = '#22c55e';
      this.ctx.shadowColor = '#4ade80';
      this.ctx.shadowBlur = 12;
      this.ctx.stroke();

      // Center countdown text
      const remainingSec = Math.max(0, 3.0 - (this.palmElapsed / 1000)).toFixed(1);
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = 'bold 22px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(`${remainingSec}s`, cx, cy - 6);

      this.ctx.font = '12px sans-serif';
      this.ctx.fillStyle = '#86efac';
      this.ctx.fillText('HOLD PALM', cx, cy + 16);

      this.ctx.restore();
    }

    destroy() {
      if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
      if (this.video) this.video.srcObject = null;
      if (this.gestureDetector) this.gestureDetector.destroy();
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close().catch(() => {});
      }
    }
  }

  // Export globally
  window.ThanosEngine = ThanosEngine;
})(typeof window !== 'undefined' ? window : this);
