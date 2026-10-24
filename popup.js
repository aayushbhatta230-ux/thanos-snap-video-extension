/**
 * Thanos Snap - Extension Popup Controller (Vision Gesture Driven)
 */

document.addEventListener('DOMContentLoaded', () => {
  const masterBadge = document.getElementById('master-status-badge');
  const toggleEnabled = document.getElementById('toggle-enabled');
  const toggleMirror = document.getElementById('toggle-mirror');
  const toggleHud = document.getElementById('toggle-hud');
  const selectDuration = document.getElementById('select-duration');
  const gestureLivePill = document.getElementById('gesture-live-pill');

  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const btnTestSnap = document.getElementById('btn-test-snap');
  const btnTestRestore = document.getElementById('btn-test-restore');
  const previewCanvas = document.getElementById('popup-canvas');
  const previewPlaceholder = document.getElementById('preview-placeholder');

  let localStream = null;
  let localEngine = null;
  let isCamActive = false;

  chrome.storage.sync.get(
    {
      enabled: true,
      mirrorVideo: true,
      hudVisible: true,
      duration: 2400
    },
    (items) => {
      toggleEnabled.checked = items.enabled;
      toggleMirror.checked = items.mirrorVideo;
      toggleHud.checked = items.hudVisible;
      selectDuration.value = String(items.duration);
      updateStatusBadge(items.enabled);
    }
  );

  function updateStatusBadge(active) {
    if (active) {
      masterBadge.textContent = 'ACTIVE';
      masterBadge.className = 'badge active';
    } else {
      masterBadge.textContent = 'PAUSED';
      masterBadge.className = 'badge disabled';
    }
  }

  function saveAndBroadcast() {
    const settings = {
      enabled: toggleEnabled.checked,
      mirrorVideo: toggleMirror.checked,
      hudVisible: toggleHud.checked,
      duration: Number(selectDuration.value)
    };

    chrome.storage.sync.set(settings);
    updateStatusBadge(settings.enabled);

    if (localEngine) {
      localEngine.mirrorVideo = settings.mirrorVideo;
      localEngine.duration = settings.duration;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'UPDATE_SETTINGS',
          settings: settings
        }).catch(() => {});
      }
    });
  }

  toggleEnabled.addEventListener('change', saveAndBroadcast);
  toggleMirror.addEventListener('change', saveAndBroadcast);
  toggleHud.addEventListener('change', saveAndBroadcast);
  selectDuration.addEventListener('change', saveAndBroadcast);

  // Live Cam Sandbox
  btnToggleCam.addEventListener('click', async () => {
    if (isCamActive) {
      stopLocalCam();
    } else {
      await startLocalCam();
    }
  });

  async function startLocalCam() {
    try {
      btnToggleCam.textContent = 'Starting...';
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 },
        audio: false // Zero mic dependency!
      });

      previewPlaceholder.style.display = 'none';

      localEngine = new window.ThanosEngine({
        width: 640,
        height: 360,
        duration: Number(selectDuration.value),
        mirrorVideo: toggleMirror.checked,
        enableSound: false,
        onSnap: () => {
          gestureLivePill.textContent = '💥 Snapped! Body Disintegrating...';
        },
        onRestore: () => {
          gestureLivePill.textContent = '✨ Restored! Body Materialized.';
        }
      });

      if (localEngine.gestureDetector) {
        localEngine.gestureDetector.onStatusChange = (status) => {
          gestureLivePill.textContent = status;
        };
      }

      previewCanvas.parentNode.replaceChild(localEngine.canvas, previewCanvas);
      localEngine.canvas.id = 'popup-canvas';

      await localEngine.attachStream(localStream);

      btnToggleCam.textContent = 'Stop Cam';
      isCamActive = true;
    } catch (err) {
      console.warn('Could not access camera in popup:', err);
      btnToggleCam.textContent = 'Start Cam';
      previewPlaceholder.innerHTML = '<span>Cam permission needed.<br>Open <a href="test.html" target="_blank" style="color:#c084fc;">Test Arena</a></span>';
    }
  }

  function stopLocalCam() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (localEngine) {
      localEngine.destroy();
      localEngine = null;
    }
    previewPlaceholder.style.display = 'flex';
    previewPlaceholder.textContent = 'Click "Start Cam" to test';
    btnToggleCam.textContent = 'Start Cam';
    isCamActive = false;
    gestureLivePill.textContent = 'Vision Tracking: Ready ✋';
  }

  btnTestSnap.addEventListener('click', () => {
    if (localEngine) localEngine.triggerSnap();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_SNAP' }).catch(() => {});
      }
    });
  });

  btnTestRestore.addEventListener('click', () => {
    if (localEngine) localEngine.restore();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'RESTORE_VIDEO' }).catch(() => {});
      }
    });
  });
});
