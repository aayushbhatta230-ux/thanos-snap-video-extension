/**
 * Test Arena Controller - Thanos Snap Vision & Body Disintegration
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnStart = document.getElementById('btn-start');
  const btnActionSnap = document.getElementById('btn-action-snap');
  const btnActionRestore = document.getElementById('btn-action-restore');
  const screenPlaceholder = document.getElementById('screen-placeholder');
  const initialCanvas = document.getElementById('screen-canvas');

  const palmMeterBar = document.getElementById('palm-meter-bar');
  const palmTimerText = document.getElementById('palm-timer-text');
  const gestureStatusPill = document.getElementById('gesture-status-pill');
  const statusBadge = document.getElementById('status-badge');

  let mediaStream = null;
  let engine = null;

  btnStart.addEventListener('click', async () => {
    try {
      btnStart.textContent = 'Requesting Camera Access...';
      // ZERO MIC DEPENDENCY
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false
      });

      screenPlaceholder.style.display = 'none';

      // Initialize Thanos Engine (Mirrored, Body-Only, Vision Gestures)
      engine = new window.ThanosEngine({
        width: 1280,
        height: 720,
        duration: 2400,
        mirrorVideo: true,
        enableSound: false,
        onSnap: () => {
          statusBadge.textContent = 'BODY SNAPPED 💨';
          statusBadge.style.background = 'rgba(239, 68, 68, 0.2)';
          statusBadge.style.color = '#ef4444';
          statusBadge.style.borderColor = 'rgba(239, 68, 68, 0.5)';
        },
        onRestore: () => {
          statusBadge.textContent = 'RESTORED 🟢';
          statusBadge.style.background = 'rgba(34, 197, 94, 0.15)';
          statusBadge.style.color = '#22c55e';
          statusBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
        }
      });

      if (engine.gestureDetector) {
        engine.gestureDetector.onStatusChange = (status) => {
          gestureStatusPill.textContent = status;
        };

        engine.gestureDetector.onPalmProgress = (progress, elapsed) => {
          palmMeterBar.style.width = `${Math.min(100, Math.floor(progress * 100))}%`;
          palmTimerText.textContent = `${(elapsed / 1000).toFixed(1)}s / 3.0s`;
        };
      }

      initialCanvas.parentNode.replaceChild(engine.canvas, initialCanvas);
      engine.canvas.id = 'screen-canvas';

      await engine.attachStream(mediaStream);

      statusBadge.textContent = 'CAMERA MIRRORED 🟢';
      gestureStatusPill.textContent = 'Ready! Pinch thumb & middle finger to snap.';
    } catch (err) {
      console.error('Camera error:', err);
      btnStart.textContent = 'Permission Denied - Retry';
    }
  });

  btnActionSnap.addEventListener('click', () => {
    if (engine) engine.triggerSnap();
  });

  btnActionRestore.addEventListener('click', () => {
    if (engine) engine.restore();
  });

  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (engine) {
        if (engine.state === 'PASSTHROUGH') engine.triggerSnap();
        else engine.restore();
      }
    }
    if (e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      if (engine) engine.restore();
    }
  });
});
