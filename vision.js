/**
 * vision.js — runs inside a hidden extension iframe (extension origin + extension CSP),
 * so MediaPipe's WASM loads even on sites like Google Meet whose CSP / Trusted Types
 * would block it in the page itself.
 *
 * Protocol (over a MessageChannel handed in with {type:'thanos-init'}):
 *   in : {type:'frame', bitmap, state}   |  {type:'settings', sensitivity}
 *   out: {type:'ready', delegate}  |  {type:'error', message}
 *        {type:'result', mask, maskW, maskH, events, status, palm, hands, debug}
 */
import { FilesetResolver, HandLandmarker, ImageSegmenter } from './vendor/vision_bundle.mjs';
import { GestureTracker } from './gesture.js';

let port = null;
let hand = null;
let seg = null;
let lastTs = 0;
let frameNo = 0;
const tracker = new GestureTracker();

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'thanos-init' || !e.ports?.[0] || port) return;
  port = e.ports[0];
  port.onmessage = onMessage;
  if (e.data.sensitivity != null) tracker.setSensitivity(e.data.sensitivity);
  init().catch((err) => port.postMessage({ type: 'error', message: String(err?.message || err) }));
});

const PREFERRED = new URLSearchParams(location.search).get('delegate') === 'CPU' ? 'CPU' : 'GPU';

async function createWithFallback(Task, fileset, options) {
  if (PREFERRED === 'CPU') {
    return { task: await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } }), delegate: 'CPU' };
  }
  try {
    return { task: await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } }), delegate: 'GPU' };
  } catch (err) {
    console.warn('[ThanosVision] GPU delegate failed, using CPU', err);
    return { task: await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } }), delegate: 'CPU' };
  }
}

async function init() {
  const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/wasm', location.href).href);
  const h = await createWithFallback(HandLandmarker, fileset, {
    baseOptions: { modelAssetPath: new URL('models/hand_landmarker.task', location.href).href },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.4
  });
  const s = await createWithFallback(ImageSegmenter, fileset, {
    baseOptions: { modelAssetPath: new URL('models/selfie_segmenter_landscape.tflite', location.href).href },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false
  });
  hand = h.task;
  seg = s.task;
  port.postMessage({ type: 'ready', delegate: `${h.delegate}/${s.delegate}` });
}

async function onMessage(e) {
  const msg = e.data;
  if (msg.type === 'settings') {
    if (msg.sensitivity != null) tracker.setSensitivity(msg.sensitivity);
    return;
  }
  if (msg.type !== 'frame') return;
  const bitmap = msg.bitmap;
  if (!hand || !seg) { bitmap.close(); port.postMessage({ type: 'result', events: [], status: 'Loading models…' }); return; }

  try {
    let ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;

    const t0 = performance.now();
    const hr = hand.detectForVideo(bitmap, ts);
    const t1 = performance.now();
    const hands = (hr.worldLandmarks || []).map((world, i) => ({
      world,
      label: `hand${i + 1}`
    }));
    const g = tracker.update(hands, ts, msg.state);

    let maskData = null, maskW = 0, maskH = 0;
    // Hand tracking every frame (snaps are fast); the person mask can run at half rate.
    if (frameNo++ % 2 === 0) seg.segmentForVideo(bitmap, ts, (result) => {
      const m = result.confidenceMasks?.[0];
      if (!m) return;
      maskW = m.width; maskH = m.height;
      const conf = m.getAsFloat32Array();
      maskData = new Uint8ClampedArray(maskW * maskH * 4);
      for (let i = 0, j = 3; i < conf.length; i++, j += 4) {
        maskData[j - 3] = maskData[j - 2] = maskData[j - 1] = 255;
        maskData[j] = conf[i] * 255;
      }
    });
    bitmap.close();
    const t2 = performance.now();

    const mask = maskData ? await createImageBitmap(new ImageData(maskData, maskW, maskH)) : null;
    port.postMessage({
      type: 'result',
      mask, maskW, maskH,
      events: g.events,
      status: g.status,
      palm: g.palm,
      hands: (hr.landmarks || []).map((lm) => lm.map((p) => [p.x, p.y])),
      debug: g.debug,
      ms: [Math.round(t1 - t0), Math.round(t2 - t1), Math.round(performance.now() - t2)]
    }, mask ? [mask] : []);
  } catch (err) {
    try { bitmap.close(); } catch (_) {}
    port.postMessage({ type: 'result', events: [], status: 'Vision error', error: String(err?.message || err) });
  }
}
