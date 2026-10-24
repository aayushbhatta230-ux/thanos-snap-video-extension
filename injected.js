/**
 * Injected.js - Main World Stream Interceptor & In-Call HUD Controller
 * Intercepts navigator.mediaDevices.getUserMedia() to pipe webcam through
 * ThanosEngine (mirrored video, body-only disintegration, vision gesture recognition).
 * ZERO DEPENDENCE ON MICROPHONE.
 */

(function () {
  'use strict';

  if (window.__THANOS_SNAP_INJECTED__) return;
  window.__THANOS_SNAP_INJECTED__ = true;

  console.log('[ThanosSnap] 🌌 Injected interceptor active in MAIN world (Vision-driven, Mirrored, Body-Only).');

  let activeEngine = null;
  let originalMediaStream = null;
  let processedMediaStream = null;

  // Settings
  const settings = {
    enabled: true,
    hudVisible: true,
    duration: 2400,
    mirrorVideo: true
  };

  // Obtain extension base URL for loading wasm and models
  const getExtensionBaseUrl = () => {
    return document.documentElement.dataset.thanosExtensionUrl || '';
  };

  // -------------------------------------------------------------
  // 1. WEBRTC STREAM INTERCEPTION
  // -------------------------------------------------------------
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      console.log('[ThanosSnap] getUserMedia intercepted with constraints:', constraints);

      // Acquire hardware stream
      const stream = await originalGetUserMedia(constraints);

      // If Thanos is disabled or no video requested, return original stream
      if (!settings.enabled || !constraints || !constraints.video) {
        return stream;
      }

      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length === 0) return stream;

      try {
        originalMediaStream = stream;

        const originalVideoTrack = videoTracks[0];
        const trackSettings = originalVideoTrack.getSettings ? originalVideoTrack.getSettings() : {};
        const width = trackSettings.width || 1280;
        const height = trackSettings.height || 720;

        if (activeEngine) {
          activeEngine.destroy();
        }

        const baseUrl = getExtensionBaseUrl();

        activeEngine = new window.ThanosEngine({
          width: width,
          height: height,
          duration: settings.duration,
          mirrorVideo: settings.mirrorVideo,
          baseExtensionUrl: baseUrl,
          enableSound: false, // User has no mic/wants vision only
          onSnap: () => {
            updateHudState('SNAPPED');
          },
          onRestore: () => {
            updateHudState('LIVE');
          }
        });

        // Set up gesture detector listener callbacks on engine
        if (activeEngine.gestureDetector) {
          activeEngine.gestureDetector.onStatusChange = (status) => {
            updateHudGestureStatus(status);
          };
        }

        await activeEngine.attachStream(stream);

        // Capture processed, mirrored 30fps canvas stream
        const canvasStream = activeEngine.getCaptureStream(30);
        const processedVideoTrack = canvasStream.getVideoTracks()[0];

        // Cloak track so Google Meet, Zoom, Teams accept it seamlessly
        proxyTrackProperties(processedVideoTrack, originalVideoTrack);

        // Include original audio track if present (without modifying it or needing mic for detection)
        const compositeTracks = [processedVideoTrack];
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          compositeTracks.push(audioTracks[0]);
        }

        processedMediaStream = new MediaStream(compositeTracks);

        originalVideoTrack.addEventListener('ended', () => {
          if (processedVideoTrack) processedVideoTrack.stop();
        });

        injectCallHud();
        updateHudState('LIVE');

        return processedMediaStream;
      } catch (err) {
        console.error('[ThanosSnap] Failed to process media stream:', err);
        return stream;
      }
    };
  }

  function proxyTrackProperties(fakeTrack, realTrack) {
    try {
      Object.defineProperty(fakeTrack, 'label', {
        get: () => realTrack.label || 'HD Camera (Thanos Mirrored)'
      });

      const origGetSettings = fakeTrack.getSettings.bind(fakeTrack);
      fakeTrack.getSettings = function () {
        const fakeSettings = origGetSettings();
        const realSettings = realTrack.getSettings ? realTrack.getSettings() : {};
        return Object.assign({}, realSettings, fakeSettings, {
          deviceId: realSettings.deviceId || 'thanos-virtual-cam'
        });
      };

      if (realTrack.getCapabilities) {
        fakeTrack.getCapabilities = realTrack.getCapabilities.bind(realTrack);
      }
    } catch (e) {
      console.warn('[ThanosSnap] Proxy warning:', e);
    }
  }

  // -------------------------------------------------------------
  // 2. FLOATING IN-CALL HUD
  // -------------------------------------------------------------
  function injectCallHud() {
    if (document.getElementById('thanos-hud-container')) return;
    if (!settings.hudVisible) return;

    const hud = document.createElement('div');
    hud.id = 'thanos-hud-container';
    hud.innerHTML = `
      <div id="thanos-hud-badge">
        <div id="thanos-hud-drag-handle">
          <span class="thanos-icon">🤌</span>
          <span class="thanos-title">Thanos Snap</span>
          <span class="thanos-mirror-tag">🪞 Mirrored</span>
        </div>
        <div id="thanos-gesture-status" title="Current Gesture Status">
          Scanning for gestures...
        </div>
        <div id="thanos-hud-actions">
          <button id="thanos-snap-btn" class="thanos-btn snap" title="Trigger Snap (or pinch fingers)">
            Snap! 💨
          </button>
          <button id="thanos-restore-btn" class="thanos-btn restore" title="Restore Video (or hold palm 3s)" style="display:none;">
            Restore 🔄
          </button>
          <button id="thanos-minimize-btn" class="thanos-btn-mini" title="Minimize">_</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.id = 'thanos-hud-styles';
    style.textContent = `
      #thanos-hud-container {
        position: fixed;
        bottom: 80px;
        right: 24px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        user-select: none;
      }
      #thanos-hud-badge {
        background: rgba(14, 10, 26, 0.9);
        border: 1px solid rgba(168, 85, 247, 0.45);
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 16px rgba(168, 85, 247, 0.3);
        backdrop-filter: blur(14px);
        padding: 9px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 190px;
        color: #f3e8ff;
        transition: border-color 0.3s ease, box-shadow 0.3s ease;
      }
      #thanos-hud-badge.snapped {
        border-color: rgba(239, 68, 68, 0.65);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 18px rgba(239, 68, 68, 0.45);
      }
      #thanos-hud-drag-handle {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: grab;
        font-size: 13px;
        font-weight: 600;
      }
      #thanos-hud-drag-handle:active {
        cursor: grabbing;
      }
      .thanos-icon {
        font-size: 16px;
      }
      .thanos-title {
        flex-grow: 1;
        background: linear-gradient(135deg, #f3e8ff, #c084fc);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .thanos-mirror-tag {
        font-size: 10px;
        color: #d8b4fe;
        background: rgba(168, 85, 247, 0.2);
        padding: 2px 5px;
        border-radius: 4px;
      }
      #thanos-gesture-status {
        font-size: 11px;
        color: #94a3b8;
        background: rgba(255, 255, 255, 0.05);
        padding: 4px 6px;
        border-radius: 6px;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #thanos-hud-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .thanos-btn {
        flex-grow: 1;
        border: none;
        outline: none;
        cursor: pointer;
        padding: 6px 10px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        transition: transform 0.15s;
      }
      .thanos-btn:active {
        transform: scale(0.96);
      }
      .thanos-btn.snap {
        background: linear-gradient(135deg, #7e22ce, #9333ea);
        color: #ffffff;
      }
      .thanos-btn.restore {
        background: linear-gradient(135deg, #15803d, #16a34a);
        color: #ffffff;
      }
      .thanos-btn-mini {
        background: rgba(255, 255, 255, 0.08);
        border: none;
        color: #94a3b8;
        cursor: pointer;
        border-radius: 6px;
        width: 22px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #thanos-hud-badge.minimized #thanos-hud-actions,
      #thanos-hud-badge.minimized #thanos-gesture-status {
        display: none;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(hud);

    setupDraggable(hud, document.getElementById('thanos-hud-drag-handle'));

    const snapBtn = document.getElementById('thanos-snap-btn');
    const restoreBtn = document.getElementById('thanos-restore-btn');
    const minBtn = document.getElementById('thanos-minimize-btn');
    const badge = document.getElementById('thanos-hud-badge');

    snapBtn.addEventListener('click', () => {
      if (activeEngine) activeEngine.triggerSnap();
    });

    restoreBtn.addEventListener('click', () => {
      if (activeEngine) activeEngine.restore();
    });

    minBtn.addEventListener('click', () => {
      badge.classList.toggle('minimized');
      minBtn.textContent = badge.classList.contains('minimized') ? '+' : '_';
    });
  }

  function updateHudState(status) {
    const badge = document.getElementById('thanos-hud-badge');
    const snapBtn = document.getElementById('thanos-snap-btn');
    const restoreBtn = document.getElementById('thanos-restore-btn');
    if (!badge || !snapBtn || !restoreBtn) return;

    if (status === 'SNAPPED') {
      badge.classList.add('snapped');
      snapBtn.style.display = 'none';
      restoreBtn.style.display = 'block';
    } else {
      badge.classList.remove('snapped');
      snapBtn.style.display = 'block';
      restoreBtn.style.display = 'none';
    }
  }

  function updateHudGestureStatus(statusText) {
    const el = document.getElementById('thanos-gesture-status');
    if (el) el.textContent = statusText;
  }

  function setupDraggable(element, handle) {
    let isDragging = false;
    let startX = 0, startY = 0, initLeft = 0, initTop = 0;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = element.getBoundingClientRect();
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      initLeft = rect.left;
      initTop = rect.top;

      const onMouseMove = (ev) => {
        if (!isDragging) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        element.style.left = `${Math.max(10, Math.min(window.innerWidth - 200, initLeft + dx))}px`;
        element.style.top = `${Math.max(10, Math.min(window.innerHeight - 80, initTop + dy))}px`;
      };

      const onMouseUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // -------------------------------------------------------------
  // 3. SHORTCUTS & MESSAGING
  // -------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (activeEngine) {
        if (activeEngine.state === 'PASSTHROUGH') activeEngine.triggerSnap();
        else activeEngine.restore();
      }
    }
    if (e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      if (activeEngine) activeEngine.restore();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.type) return;

    if (event.data.type === 'THANOS_TRIGGER_SNAP') {
      if (activeEngine) activeEngine.triggerSnap();
    } else if (event.data.type === 'THANOS_RESTORE_VIDEO') {
      if (activeEngine) activeEngine.restore();
    } else if (event.data.type === 'THANOS_SET_BASE_URL') {
      if (activeEngine) activeEngine.setBaseUrl(event.data.url);
    } else if (event.data.type === 'THANOS_UPDATE_SETTINGS') {
      const payload = event.data.payload || {};
      Object.assign(settings, payload);
      if (activeEngine && typeof payload.duration !== 'undefined') {
        activeEngine.duration = payload.duration;
      }
      const hud = document.getElementById('thanos-hud-container');
      if (hud) hud.style.display = settings.hudVisible ? 'block' : 'none';
    }
  });

  window.__THANOS_ACTIVE_ENGINE__ = () => activeEngine;
})();
