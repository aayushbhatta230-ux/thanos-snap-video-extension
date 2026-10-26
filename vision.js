/**
 * vision.js — runs inside a hidden extension iframe (extension origin + extension CSP),
 * so MediaPipe's WASM loads even on sites like Google Meet whose CSP / Trusted Types
 * would block it in the page itself.
 *
 * Hand tracking runs here on every frame (snaps are fast). Person segmentation runs in
 * seg_worker.js in parallel and takes whichever frame is current when it's free.
 *
 * Protocol (over a MessageChannel handed in with {type:'thanos-init'}):
 *   in : {type:'frame', bitmap, id, state}  |  {type:'settings', sensitivity}
 *   out: {type:'ready', delegate}  |  {type:'error', message}
 *        {type:'result', events, status, palm, hands, debug, ms}
 *        {type:'mask', mask, id, ms}      (mask is for frame `id`)
 */
import { FilesetResolver, HandLandmarker } from './vendor/vision_bundle.mjs';
import { GestureTracker } from './gesture.js';

const params = new URLSearchParams(location.search);
// Multiclass model segments the whole body (hair, skin, clothes) far better than the
// head-and-shoulders selfie model, which misses laps/legs. ?seg=fast picks the light model.
const MULTICLASS = params.get('seg') !== 'fast';
const PREFERRED = params.get('delegate') === 'CPU' ? 'CPU' : 'GPU';

let port = null;
let hand = null;
let lastTs = 0;
let segWorker = null;
let segReady = false;
let segBusy = false;
const tracker = new GestureTracker();

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'thanos-init' || !e.ports?.[0] || port) return;
  port = e.ports[0];
  port.onmessage = onMessage;
  if (e.data.sensitivity != null) tracker.setSensitivity(e.data.sensitivity);
  init().catch((err) => port.postMessage({ type: 'error', message: String(err?.message || err) }));
});

async function createHand(fileset, delegate) {
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('models/hand_landmarker.task', location.href).href, delegate },
    runningMode: 'VIDEO',
    numHands: 2, // Track both hands so either hand or sudden switches don't drop tracking
    minHandDetectionConfidence: 0.35, // Relaxed from 0.5: allows detecting hands at steep angles and side profiles
    minHandPresenceConfidence: 0.35,  // Keeps hand tracked when tilted or partially foreshortened
    minTrackingConfidence: 0.3        // Survives rapid snap motion and slight blur
  });
}

async function init() {
  segWorker = new Worker('seg_worker.js');
  const segUp = new Promise((resolve, reject) => {
    segWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { segReady = true; resolve(m.delegate); }
      else if (m.type === 'error') reject(new Error(m.message));
      else if (m.type === 'mask') {
        segBusy = false;
        port.postMessage(m, m.mask ? [m.mask] : []);
      }
    };
  });
  segWorker.postMessage({ type: 'init', multiclass: MULTICLASS, delegate: PREFERRED });

  const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/wasm', location.href).href);
  let handDelegate = PREFERRED;
  try {
    hand = await createHand(fileset, handDelegate);
  } catch (err) {
    console.warn('[ThanosVision] GPU delegate failed, using CPU', err);
    handDelegate = 'CPU';
    hand = await createHand(fileset, 'CPU');
  }
  const segDelegate = await segUp;
  port.postMessage({ type: 'ready', delegate: `hand:${handDelegate} seg:${segDelegate}` });
}

function onMessage(e) {
  const msg = e.data;
  if (msg.type === 'settings') {
    if (msg.sensitivity != null) tracker.setSensitivity(msg.sensitivity);
    return;
  }
  if (msg.type !== 'frame') return;
  const bitmap = msg.bitmap;
  if (!hand) { bitmap.close(); port.postMessage({ type: 'result', events: [], status: 'Loading models…' }); return; }

  try {
    let ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    const t0 = performance.now();
    const hr = hand.detectForVideo(bitmap, ts);
    const handMs = Math.round(performance.now() - t0);

    // Hand the same frame to the segmenter if it's free (transfer, no copy).
    if (segReady && !segBusy) {
      segBusy = true;
      segWorker.postMessage({ type: 'frame', bitmap, id: msg.id }, [bitmap]);
    } else {
      bitmap.close();
    }

    // Pass both 3D worldLandmarks and 2D normalized landmarks for angle-invariant cross-verification
    const hands = (hr.worldLandmarks || []).map((world, i) => ({
      world,
      landmarks: hr.landmarks ? hr.landmarks[i] : null,
      label: `hand${i + 1}`
    }));

    const g = tracker.update(hands, ts, msg.state);
    port.postMessage({
      type: 'result',
      events: g.events,
      status: g.status,
      palm: g.palm,
      hands: (hr.landmarks || []).map((lm) => lm.map((p) => [p.x, p.y])),
      debug: g.debug,
      ms: handMs
    });
  } catch (err) {
    try { bitmap.close(); } catch (_) {}
    port.postMessage({ type: 'result', events: [], status: 'Vision error', error: String(err?.message || err) });
  }
}
