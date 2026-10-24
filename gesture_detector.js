/**
 * GestureDetector.js - Computer Vision Hand Gesture Recognition Engine
 * Detects:
 *   1. Finger Snap Gesture (Thumb + Middle finger pinch & rapid snap release)
 *   2. Open Palm Recovery Gesture (Held steadily for 3 seconds)
 * 100% vision-driven with zero dependence on a microphone.
 */

(function (window) {
  'use strict';

  class GestureDetector {
    constructor(options = {}) {
      this.baseExtensionUrl = options.baseExtensionUrl || '';
      this.onSnap = options.onSnap || null;
      this.onPalmProgress = options.onPalmProgress || null; // (progress 0..1, elapsedMs)
      this.onPalmRecover = options.onPalmRecover || null;
      this.onStatusChange = options.onStatusChange || null; // for HUD feedback

      this.isReady = false;
      this.isBusy = false;
      this.handsModel = null;

      // Gesture state machines
      // Snap State: 'IDLE' | 'PINCHING'
      this.snapState = 'IDLE';
      this.pinchStartTime = 0;
      this.lastSnapTime = 0;
      this.snapCooldownMs = 2000;

      // Palm Recovery State
      this.isPalmOpen = false;
      this.palmStartTime = 0;
      this.palmHoldRequiredMs = 3000; // 3 seconds required by user
      this.hasTriggeredRecovery = false;

      // Status
      this.currentStatus = 'Searching for hand...';
      this.handDetected = false;

      this.initMediaPipe();
    }

    setBaseUrl(url) {
      if (url && !this.baseExtensionUrl) {
        this.baseExtensionUrl = url.endsWith('/') ? url : url + '/';
        if (!this.handsModel) {
          this.initMediaPipe();
        }
      }
    }

    async initMediaPipe() {
      if (typeof window.Hands === 'undefined') {
        console.warn('[GestureDetector] window.Hands not loaded yet.');
        return;
      }

      try {
        const baseUrl = this.baseExtensionUrl || (document.documentElement.dataset.thanosExtensionUrl || '');
        const modelDir = baseUrl ? `${baseUrl}libs/hands/` : 'libs/hands/';

        this.handsModel = new window.Hands({
          locateFile: (file) => `${modelDir}${file}`
        });

        this.handsModel.setOptions({
          maxNumHands: 1,
          modelComplexity: 0, // Lite model for smooth real-time 30fps
          minDetectionConfidence: 0.55,
          minTrackingConfidence: 0.5
        });

        this.handsModel.onResults((results) => {
          this.handleHandLandmarks(results);
          this.isBusy = false;
        });

        this.isReady = true;
        console.log('[GestureDetector] 🖐️ MediaPipe Hands initialized successfully.');
      } catch (err) {
        console.warn('[GestureDetector] Could not initialize MediaPipe Hands:', err);
      }
    }

    /**
     * Send video frame for gesture analysis
     */
    async processFrame(mirroredCanvasOrVideo) {
      if (this.isReady && this.handsModel && !this.isBusy) {
        this.isBusy = true;
        try {
          await this.handsModel.send({ image: mirroredCanvasOrVideo });
        } catch (e) {
          this.isBusy = false;
        }
      }
    }

    /**
     * Analyze 21 3D hand landmarks
     */
    handleHandLandmarks(results) {
      const now = performance.now();

      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        this.handDetected = false;
        this.snapState = 'IDLE';
        this.resetPalmTimer();
        this.updateStatus('No hand visible');
        return;
      }

      this.handDetected = true;
      const landmarks = results.multiHandLandmarks[0];

      // Key landmark definitions:
      // 0: Wrist
      // 4: Thumb tip
      // 8: Index tip, 6: Index PIP
      // 12: Middle tip, 10: Middle PIP, 9: Middle MCP
      // 16: Ring tip, 14: Ring PIP
      // 20: Pinky tip, 18: Pinky PIP

      const wrist = landmarks[0];
      const thumbTip = landmarks[4];
      const indexTip = landmarks[8];
      const indexPip = landmarks[6];
      const middleTip = landmarks[12];
      const middlePip = landmarks[10];
      const ringTip = landmarks[16];
      const ringPip = landmarks[14];
      const pinkyTip = landmarks[20];
      const pinkyPip = landmarks[18];

      // Helper distance function
      const dist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);

      // Check finger extensions (tip higher/further from wrist than PIP joint)
      // Note: in normalized image coordinates, y=0 is top, y=1 is bottom
      const isIndexExtended = dist(indexTip, wrist) > dist(indexPip, wrist) * 1.15;
      const isMiddleExtended = dist(middleTip, wrist) > dist(middlePip, wrist) * 1.15;
      const isRingExtended = dist(ringTip, wrist) > dist(ringPip, wrist) * 1.15;
      const isPinkyExtended = dist(pinkyTip, wrist) > dist(pinkyPip, wrist) * 1.15;
      const isThumbExtended = dist(thumbTip, wrist) > 0.15;

      // -------------------------------------------------------------
      // 1. OPEN PALM RECOVERY GESTURE (All 5 fingers extended and open)
      // -------------------------------------------------------------
      const allFingersExtended = isIndexExtended && isMiddleExtended && isRingExtended && isPinkyExtended && isThumbExtended;
      
      // Palm openness check: distance between fingertips is spread
      const fingerSpread = dist(indexTip, pinkyTip) > 0.18;

      if (allFingersExtended && fingerSpread) {
        if (!this.isPalmOpen) {
          this.isPalmOpen = true;
          this.palmStartTime = now;
          this.hasTriggeredRecovery = false;
        }

        const elapsed = now - this.palmStartTime;
        const progress = Math.min(1.0, elapsed / this.palmHoldRequiredMs);

        this.updateStatus(`✋ Holding Open Palm (${(elapsed / 1000).toFixed(1)}s / 3.0s)`);

        if (typeof this.onPalmProgress === 'function') {
          this.onPalmProgress(progress, elapsed);
        }

        if (elapsed >= this.palmHoldRequiredMs && !this.hasTriggeredRecovery) {
          this.hasTriggeredRecovery = true;
          console.log('[GestureDetector] ✨ PALM HELD FOR 3 SECONDS! RECOVERING VIDEO...');
          if (typeof this.onPalmRecover === 'function') {
            this.onPalmRecover();
          }
          this.updateStatus('✨ Recovered! Welcome back.');
        }

        // Return early so snap detection isn't accidentally fired during open palm
        return;
      } else {
        this.resetPalmTimer();
      }

      // -------------------------------------------------------------
      // 2. FINGER SNAP GESTURE (Thumb & Middle finger pinch + snap release)
      // -------------------------------------------------------------
      const thumbMiddleDist = dist(thumbTip, middleTip);

      // Pinch threshold
      const isPinching = thumbMiddleDist < 0.085;

      if (isPinching) {
        if (this.snapState === 'IDLE') {
          this.snapState = 'PINCHING';
          this.pinchStartTime = now;
        }
        this.updateStatus('🤌 Pinching... Snap to disintegrate!');
      } else if (this.snapState === 'PINCHING') {
        // Just released the pinch!
        const pinchDuration = now - this.pinchStartTime;

        // A valid snap prep pinch lasts between 80ms and 1500ms, followed by rapid separation
        if (pinchDuration >= 80 && pinchDuration <= 1500 && (now - this.lastSnapTime > this.snapCooldownMs)) {
          this.lastSnapTime = now;
          this.snapState = 'IDLE';
          console.log('[GestureDetector] 💥 FINGER SNAP GESTURE RECOGNIZED!');
          this.updateStatus('💥 Snap Detected! Disintegrating...');
          if (typeof this.onSnap === 'function') {
            this.onSnap();
          }
        } else {
          this.snapState = 'IDLE';
        }
      } else {
        this.updateStatus('Hand Tracked ✋ (Pinch to Snap, Palm 3s to Restore)');
      }
    }

    resetPalmTimer() {
      if (this.isPalmOpen) {
        this.isPalmOpen = false;
        this.palmStartTime = 0;
        this.hasTriggeredRecovery = false;
        if (typeof this.onPalmProgress === 'function') {
          this.onPalmProgress(0, 0);
        }
      }
    }

    updateStatus(status) {
      if (this.currentStatus !== status) {
        this.currentStatus = status;
        if (typeof this.onStatusChange === 'function') {
          this.onStatusChange(status);
        }
      }
    }

    destroy() {
      if (this.handsModel) {
        try { this.handsModel.close(); } catch (e) {}
      }
    }
  }

  // Export globally
  window.GestureDetector = GestureDetector;
})(typeof window !== 'undefined' ? window : this);

