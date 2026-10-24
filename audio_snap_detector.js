/**
 * AudioSnapDetector - Acoustic Finger Snap Recognition Engine
 * Detects the acoustic signature of a finger snap in real-time using Web Audio API.
 */

(function (window) {
  'use strict';

  class AudioSnapDetector {
    constructor(options = {}) {
      this.sensitivity = options.sensitivity || 75; // 0 (hardest) to 100 (easiest)
      this.enabled = options.enabled !== false;
      this.onSnap = options.onSnap || null;
      this.onLevelChange = options.onLevelChange || null;

      this.audioCtx = null;
      this.sourceNode = null;
      this.scriptNode = null;
      this.analyser = null;

      // Detection state
      this.isListening = false;
      this.lastSnapTime = 0;
      this.cooldownMs = 1600; // Prevent rapid duplicate triggers

      // Adaptive background noise tracking (Exponential Weighted Moving Average)
      this.backgroundEnergy = 0.005;
      this.prevEnergy = 0.005;
      this.recentPeakEnergy = 0;

      // Real-time meter metrics for visualizer
      this.currentLevel = 0; // 0 to 1
      this.currentSnapProbability = 0; // 0 to 1
    }

    /**
     * Start listening to an incoming audio MediaStream (e.g. from microphone)
     */
    start(mediaStream) {
      if (!mediaStream || mediaStream.getAudioTracks().length === 0) {
        console.warn('[AudioSnapDetector] No audio tracks found in stream.');
        return false;
      }

      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          console.error('[AudioSnapDetector] Web Audio API not supported.');
          return false;
        }

        // Use low latency interactive audio context
        this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
        this.sourceNode = this.audioCtx.createMediaStreamSource(mediaStream);

        // Analyser for real-time visualization & frequency bins
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.3;

        // Bandpass filter to isolate the finger snap frequencies (2.2 kHz - 5.5 kHz)
        this.snapBandpass = this.audioCtx.createBiquadFilter();
        this.snapBandpass.type = 'bandpass';
        this.snapBandpass.frequency.setValueAtTime(3400, this.audioCtx.currentTime);
        this.snapBandpass.Q.setValueAtTime(2.2, this.audioCtx.currentTime);

        // Lowpass filter to detect desk thumps / low-frequency noise (to suppress false positives)
        this.lowpass = this.audioCtx.createBiquadFilter();
        this.lowpass.type = 'lowpass';
        this.lowpass.frequency.setValueAtTime(600, this.audioCtx.currentTime);

        // ScriptProcessorNode for sample-accurate transient detection (512 samples = ~11ms at 48kHz)
        const bufferSize = 512;
        this.scriptNode = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);

        // Connect graph
        this.sourceNode.connect(this.analyser);
        this.sourceNode.connect(this.snapBandpass);
        this.snapBandpass.connect(this.scriptNode);
        
        // Prevent audio from playing back into local speakers to avoid feedback
        const silentGain = this.audioCtx.createGain();
        silentGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
        this.scriptNode.connect(silentGain);
        silentGain.connect(this.audioCtx.destination);

        // Process audio frames
        const freqData = new Uint8Array(this.analyser.frequencyBinCount);
        this.scriptNode.onaudioprocess = (e) => {
          if (!this.enabled) return;

          const inputData = e.inputBuffer.getChannelData(0);
          this.processAudioBuffer(inputData, freqData);
        };

        this.isListening = true;
        return true;
      } catch (err) {
        console.error('[AudioSnapDetector] Error starting audio detector:', err);
        return false;
      }
    }

    /**
     * Analyze audio samples for acoustic snap fingerprint
     */
    processAudioBuffer(samples, freqData) {
      const now = performance.now();
      const n = samples.length;

      let sumSquare = 0;
      let peak = 0;

      for (let i = 0; i < n; i++) {
        const val = Math.abs(samples[i]);
        if (val > peak) peak = val;
        sumSquare += val * val;
      }

      const rms = Math.sqrt(sumSquare / n);
      this.currentLevel = Math.min(1.0, peak * 2.5);

      // Track ambient background noise floor
      if (rms < this.backgroundEnergy * 2.0) {
        this.backgroundEnergy = 0.96 * this.backgroundEnergy + 0.04 * rms;
      }
      this.backgroundEnergy = Math.max(0.002, this.backgroundEnergy);

      // Calculate transient dynamics
      const energyDelta = rms - this.prevEnergy;
      this.prevEnergy = rms;

      // Crest factor: peak-to-RMS ratio (sharp transient has high crest factor)
      const crestFactor = rms > 0.001 ? peak / rms : 0;

      // Get frequency spectrum to verify high frequency concentration
      this.analyser.getByteFrequencyData(freqData);
      const binCount = freqData.length;
      
      // Low bins (0 to ~800 Hz): bin indices 0 to ~9 (for 512 FFT at 48kHz, bin = ~93Hz)
      let lowEnergy = 0;
      for (let b = 0; b < 9; b++) {
        lowEnergy += freqData[b];
      }
      lowEnergy /= 9;

      // High snap bins (2.2 kHz to 5.5 kHz): bin indices ~24 to ~60
      let highEnergy = 0;
      let highCount = 0;
      for (let b = 24; b < Math.min(60, binCount); b++) {
        highEnergy += freqData[b];
        highCount++;
      }
      highEnergy = highCount > 0 ? highEnergy / highCount : 0;

      // Spectral Ratio: ratio of high snap frequencies to low rumble frequencies
      const highToLowRatio = lowEnergy > 5 ? highEnergy / lowEnergy : highEnergy / 5;

      // Dynamic threshold calculated from user sensitivity (0 to 100)
      // Sensitivity 100 -> minPeak ~0.15, ratio ~1.3
      // Sensitivity 50  -> minPeak ~0.35, ratio ~1.8
      // Sensitivity 0   -> minPeak ~0.65, ratio ~2.8
      const sensFactor = (100 - this.sensitivity) / 100;
      const minPeakThreshold = 0.12 + sensFactor * 0.45;
      const minRatioThreshold = 1.2 + sensFactor * 1.5;
      const minCrestFactor = 2.4 + sensFactor * 1.8;

      // Snap confidence score (0 to 1)
      let score = 0;
      if (peak > minPeakThreshold) score += 0.35;
      if (highToLowRatio > minRatioThreshold) score += 0.35;
      if (crestFactor > minCrestFactor) score += 0.30;
      this.currentSnapProbability = score;

      if (typeof this.onLevelChange === 'function') {
        this.onLevelChange({
          level: this.currentLevel,
          peak: peak,
          rms: rms,
          highToLowRatio: highToLowRatio,
          score: score
        });
      }

      // Check if snap criteria met and cooldown elapsed
      if (
        score >= 0.70 &&
        peak >= minPeakThreshold &&
        highToLowRatio >= minRatioThreshold &&
        crestFactor >= minCrestFactor &&
        now - this.lastSnapTime > this.cooldownMs
      ) {
        this.lastSnapTime = now;
        this.triggerSnapEvent();
      }
    }

    /**
     * Dispatch snap event
     */
    triggerSnapEvent() {
      console.log('[AudioSnapDetector] ✨ FINGER SNAP DETECTED! Triggering Thanos Disintegration...');
      if (typeof this.onSnap === 'function') {
        this.onSnap();
      }

      window.dispatchEvent(new CustomEvent('thanos-audio-snap-detected', {
        detail: { timestamp: performance.now(), probability: this.currentSnapProbability }
      }));
    }

    /**
     * Update sensitivity dynamically
     */
    setSensitivity(value) {
      this.sensitivity = Math.max(0, Math.min(100, Number(value) || 75));
    }

    /**
     * Enable / Disable detection
     */
    setEnabled(bool) {
      this.enabled = Boolean(bool);
    }

    /**
     * Stop and cleanup
     */
    stop() {
      this.isListening = false;
      if (this.scriptNode) {
        this.scriptNode.onaudioprocess = null;
        try { this.scriptNode.disconnect(); } catch (e) {}
      }
      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch (e) {}
      }
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        try { this.audioCtx.close(); } catch (e) {}
      }
    }
  }

  // Export globally
  window.AudioSnapDetector = AudioSnapDetector;
})(typeof window !== 'undefined' ? window : this);
