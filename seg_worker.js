/**
 * seg_worker.js — person segmentation in its own thread so it runs in parallel with
 * hand tracking (which has to stay fast for snaps).
 *   in : {type:'init', multiclass, delegate}  |  {type:'frame', bitmap, id}
 *   out: {type:'ready', delegate} | {type:'error', message} | {type:'mask', mask, id, ms}
 */
importScripts('vendor/vision_bundle.js');
const { FilesetResolver, ImageSegmenter } = self.Vision;

let seg = null;
let multiclass = true;
let lastTs = 0;

async function create(fileset, delegate) {
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: new URL(multiclass ? 'models/selfie_multiclass_256x256.tflite' : 'models/selfie_segmenter_landscape.tflite', self.location.href).href,
      delegate
    },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false
  });
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    multiclass = msg.multiclass !== false;
    try {
      const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/wasm', self.location.href).href);
      let delegate = msg.delegate === 'CPU' ? 'CPU' : 'GPU';
      try { seg = await create(fileset, delegate); } catch (err) { delegate = 'CPU'; seg = await create(fileset, 'CPU'); }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }
  if (msg.type !== 'frame') return;
  const { bitmap, id } = msg;
  if (!seg) { bitmap.close(); self.postMessage({ type: 'mask', mask: null, id }); return; }
  const t0 = performance.now();
  let ts = performance.now();
  if (ts <= lastTs) ts = lastTs + 1;
  lastTs = ts;
  let data = null, w = 0, h = 0;
  try {
    seg.segmentForVideo(bitmap, ts, (result) => {
      const m = result.confidenceMasks?.[0];
      if (!m) return;
      w = m.width; h = m.height;
      const conf = m.getAsFloat32Array();
      data = new Uint8ClampedArray(w * h * 4);
      // Multiclass: mask 0 is "background", so person = 1 - background. Threshold with a
      // smooth ramp so faint background noise is exactly 0 (the engine dilates/boosts this).
      for (let i = 0, j = 0; i < conf.length; i++, j += 4) {
        const p = multiclass ? 1 - conf[i] : conf[i];
        const v = Math.min(1, Math.max(0, (p - 0.2) / 0.3));
        data[j] = data[j + 1] = data[j + 2] = 255;
        data[j + 3] = v * v * (3 - 2 * v) * 255;
      }
    });
  } catch (err) {
    console.warn('[ThanosSeg]', err);
  }
  bitmap.close();
  const mask = data ? await createImageBitmap(new ImageData(data, w, h)) : null;
  self.postMessage({ type: 'mask', mask, id, ms: Math.round(performance.now() - t0) }, mask ? [mask] : []);
};
