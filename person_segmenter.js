/**
 * PersonSegmenter.js - Real-Time Body vs Background Segmentation
 * Separates the user's body from the room background so that ONLY the body
 * disintegrates into ash while the background room remains fully visible.
 */

(function (window) {
  'use strict';

  class PersonSegmenter {
    constructor(options = {}) {
      this.width = options.width || 1280;
      this.height = options.height || 720;
      this.baseExtensionUrl = options.baseExtensionUrl || '';
      this.isReady = false;
      this.model = null;

      // Offscreen canvas for segmentation mask
      this.maskCanvas = document.createElement('canvas');
      this.maskCanvas.width = this.width;
      this.maskCanvas.height = this.height;
      this.maskCtx = this.maskCanvas.getContext('2d');

      // Offscreen canvas for persistent room background plate
      this.bgCanvas = document.createElement('canvas');
      this.bgCanvas.width = this.width;
      this.bgCanvas.height = this.height;
      this.bgCtx = this.bgCanvas.getContext('2d');
      this.hasBgFrame = false;

      // Offscreen canvas for isolated person layer
      this.personCanvas = document.createElement('canvas');
      this.personCanvas.width = this.width;
      this.personCanvas.height = this.height;
      this.personCtx = this.personCanvas.getContext('2d');

      // Processing state
      this.isBusy = false;
      this.lastMaskTime = 0;
      this.useMediaPipe = true;

      this.initMediaPipe();
    }

    /**
     * Set extension base URL for loading wasm and models
     */
    setBaseUrl(url) {
      if (url && !this.baseExtensionUrl) {
        this.baseExtensionUrl = url.endsWith('/') ? url : url + '/';
        if (!this.model) {
          this.initMediaPipe();
        }
      }
    }

    /**
     * Initialize MediaPipe Selfie Segmentation
     */
    async initMediaPipe() {
      if (typeof window.SelfieSegmentation === 'undefined') {
        console.warn('[PersonSegmenter] window.SelfieSegmentation not loaded yet. Will retry or use fallback.');
        return;
      }

      try {
        const baseUrl = this.baseExtensionUrl || (document.documentElement.dataset.thanosExtensionUrl || '');
        const modelDir = baseUrl ? `${baseUrl}libs/selfie_segmentation/` : 'libs/selfie_segmentation/';

        this.model = new window.SelfieSegmentation({
          locateFile: (file) => `${modelDir}${file}`
        });

        this.model.setOptions({
          modelSelection: 1 // 1 for landscape video call optimization
        });

        this.model.onResults((results) => {
          this.handleSegmentationResults(results);
          this.isBusy = false;
        });

        this.isReady = true;
        console.log('[PersonSegmenter] 🧠 MediaPipe Selfie Segmentation initialized successfully.');
      } catch (err) {
        console.warn('[PersonSegmenter] Could not initialize MediaPipe SelfieSegmentation:', err);
        this.useMediaPipe = false;
      }
    }

    /**
     * Process an incoming video frame (already mirrored)
     */
    async processFrame(videoElement, mirroredFrameCanvas) {
      if (!this.hasBgFrame && mirroredFrameCanvas) {
        // Initial snapshot of background
        this.bgCtx.drawImage(mirroredFrameCanvas, 0, 0, this.width, this.height);
        this.hasBgFrame = true;
      }

      if (this.isReady && this.model && !this.isBusy) {
        this.isBusy = true;
        try {
          await this.model.send({ image: mirroredFrameCanvas || videoElement });
        } catch (e) {
          this.isBusy = false;
        }
      } else if (!this.isReady) {
        // Fallback simple center body prior until model is fully hot
        this.generateFallbackMask();
      }
    }

    /**
     * Handle results from MediaPipe SelfieSegmentation
     */
    handleSegmentationResults(results) {
      if (!results || !results.segmentationMask) return;

      // Draw the neural segmentation mask
      this.maskCtx.clearRect(0, 0, this.width, this.height);
      this.maskCtx.drawImage(results.segmentationMask, 0, 0, this.width, this.height);

      // Continuously update background canvas where the person is NOT present (mask is black/low)
      if (results.image) {
        this.updateBackgroundPlate(results.image);
      }
    }

    /**
     * Update background plate: accumulates parts of the room uncovered by the user
     */
    updateBackgroundPlate(sourceImage) {
      // Create inverted mask (white where person is NOT present)
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = this.width;
      tempCanvas.height = this.height;
      const tempCtx = tempCanvas.getContext('2d');

      // Draw source image
      tempCtx.drawImage(sourceImage, 0, 0, this.width, this.height);
      // Mask out the person (keep only background)
      tempCtx.globalCompositeOperation = 'destination-out';
      tempCtx.drawImage(this.maskCanvas, 0, 0, this.width, this.height);

      // Blend newly uncovered background into persistent background plate
      this.bgCtx.globalCompositeOperation = 'source-over';
      this.bgCtx.drawImage(tempCanvas, 0, 0, this.width, this.height);
    }

    /**
     * Extract only the person's pixels from the current frame
     */
    isolatePerson(sourceFrameCanvas) {
      this.personCtx.clearRect(0, 0, this.width, this.height);
      // 1. Draw source video frame
      this.personCtx.drawImage(sourceFrameCanvas, 0, 0, this.width, this.height);
      // 2. Keep only pixels overlapping the segmentation mask
      this.personCtx.globalCompositeOperation = 'destination-in';
      this.personCtx.drawImage(this.maskCanvas, 0, 0, this.width, this.height);
      this.personCtx.globalCompositeOperation = 'source-over';

      return this.personCanvas;
    }

    /**
     * Fallback mask generator (ellipse center-weighted for person shape)
     */
    generateFallbackMask() {
      this.maskCtx.clearRect(0, 0, this.width, this.height);
      const grad = this.maskCtx.createRadialGradient(
        this.width * 0.5, this.height * 0.6, this.height * 0.15,
        this.width * 0.5, this.height * 0.6, this.height * 0.55
      );
      grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
      grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.8)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      this.maskCtx.fillStyle = grad;
      this.maskCtx.fillRect(0, 0, this.width, this.height);
    }

    /**
     * Resize dimensions
     */
    resize(w, h) {
      this.width = w;
      this.height = h;
      this.maskCanvas.width = w;
      this.maskCanvas.height = h;
      this.bgCanvas.width = w;
      this.bgCanvas.height = h;
      this.personCanvas.width = w;
      this.personCanvas.height = h;
    }
  }

  // Export globally
  window.PersonSegmenter = PersonSegmenter;
})(typeof window !== 'undefined' ? window : this);

