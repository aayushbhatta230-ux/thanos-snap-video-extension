/**
 * gesture.js — finger-snap + open-palm recognition from MediaPipe hand landmarks.
 *
 * A real snap has a distinctive shape over ~100–300 ms:
 *   1. ARM:     thumb tip pressed against middle fingertip (held for a couple of frames)
 *   2. RELEASE: thumb slides off and the middle finger slams into the palm
 * The hand often blurs out of tracking during step 2, so the armed state survives
 * short dropouts instead of resetting.
 *
 * Distances use MediaPipe's metric world landmarks, normalised by palm size,
 * so they don't depend on how far you sit from the camera or how the hand is rotated.
 */

const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_PIP = 6, INDEX_TIP = 8,
  MIDDLE_MCP = 9, MIDDLE_PIP = 10, MIDDLE_TIP = 12, RING_MCP = 13, RING_PIP = 14, RING_TIP = 16,
  PINKY_MCP = 17, PINKY_PIP = 18, PINKY_TIP = 20;

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

export function handFeatures(lm) {
  const s = d3(lm[WRIST], lm[MIDDLE_MCP]) || 1e-6;
  const palm = {
    x: (lm[WRIST].x + lm[INDEX_MCP].x + lm[MIDDLE_MCP].x + lm[RING_MCP].x + lm[PINKY_MCP].x) / 5,
    y: (lm[WRIST].y + lm[INDEX_MCP].y + lm[MIDDLE_MCP].y + lm[RING_MCP].y + lm[PINKY_MCP].y) / 5,
    z: (lm[WRIST].z + lm[INDEX_MCP].z + lm[MIDDLE_MCP].z + lm[RING_MCP].z + lm[PINKY_MCP].z) / 5
  };
  const ext = (tip, pip) => d3(lm[tip], lm[WRIST]) / (d3(lm[pip], lm[WRIST]) || 1e-6);
  return {
    thumbMiddle: d3(lm[THUMB_TIP], lm[MIDDLE_TIP]) / s,
    thumbIndex: d3(lm[THUMB_TIP], lm[INDEX_TIP]) / s,
    middleToPalm: d3(lm[MIDDLE_TIP], palm) / s,
    thumbOut: d3(lm[THUMB_TIP], lm[PINKY_MCP]) / s,
    spread: d3(lm[INDEX_TIP], lm[PINKY_TIP]) / s,
    extIndex: ext(INDEX_TIP, INDEX_PIP),
    extMiddle: ext(MIDDLE_TIP, MIDDLE_PIP),
    extRing: ext(RING_TIP, RING_PIP),
    extPinky: ext(PINKY_TIP, PINKY_PIP)
  };
}

export class GestureTracker {
  constructor({ sensitivity = 60, palmHoldMs = 3000 } = {}) {
    this.palmHoldMs = palmHoldMs;
    this.setSensitivity(sensitivity);
    this.hands = new Map(); // handedness -> snap state
    this.lastSnapAt = -1e9;
    this.palmStart = null;
    this.palmLastSeen = -1e9;
    this.palmFired = false;
  }

  setSensitivity(v) {
    const k = Math.max(0, Math.min(100, Number(v))) / 100;
    this.sensitivity = k * 100;
    // Tuned on recorded snaps: armed pose ≈ thumb↔middle 0.35–0.44, middle→palm ≈ 0.75;
    // the snap itself drops middle→palm to 0.25–0.45 within 1–2 frames.
    this.pinchMax = 0.35 + 0.15 * k;      // thumb–middle distance that counts as "pressed"
    this.slamMax = 0.42 + 0.15 * k;       // middle tip must land this close to the palm
    this.dropMin = 0.32 - 0.12 * k;       // ...having dropped at least this much
    this.dropWindowMs = 300;              // ...within this much time
    this.windowMs = 250 + 250 * k;        // max time between thumb contact and the slam
    this.dropoutMs = 700;                 // forget a hand after this long out of view
  }

  /**
   * @param hands  [{ world: 21 landmarks (metres), label }] — label is a stable per-slot key, not
   *               handedness (MediaPipe flips Left/Right mid-snap on blurry frames)
   * @param now    ms timestamp
   * @param appState 'live' | 'vanishing' | 'gone' | 'returning'
   */
  update(hands, now, appState) {
    const events = [];
    let status = hands.length ? 'Hand tracked' : 'No hand in view';
    const debug = [];
    let anyPalm = false;
    const seen = new Set();

    for (const h of hands) {
      const f = handFeatures(h.world);
      const key = h.label || 'hand';
      seen.add(key);
      let st = this.hands.get(key);
      if (!st) { st = { lastArmAt: -1e9, lastSeenAt: now, hist: [] }; this.hands.set(key, st); }
      st.lastSeenAt = now;

      const openPalm = f.extIndex > 1.2 && f.extMiddle > 1.2 && f.extRing > 1.15 && f.extPinky > 1.1 &&
        f.spread > 0.75 && f.thumbOut > 1.0 && f.thumbMiddle > 1.0;
      if (f.thumbMiddle < this.pinchMax && !openPalm) st.lastArmAt = now;

      // Peak middle→palm distance over the last few hundred ms (the "cocked" finger).
      st.hist = st.hist.filter((p) => now - p.t <= this.dropWindowMs);
      const peak = st.hist.reduce((m, p) => Math.max(m, p.mp), 0);
      st.hist.push({ t: now, mp: f.middleToPalm });

      const armed = now - st.lastArmAt <= this.windowMs;
      let phase = armed ? 'armed' : 'idle';
      if (armed && f.middleToPalm < this.slamMax && peak - f.middleToPalm >= this.dropMin) {
        phase = 'snap';
        st.lastArmAt = -1e9;
        st.hist = [];
        if (now - this.lastSnapAt > 1200) {
          this.lastSnapAt = now;
          events.push('snap');
        }
      }
      if (openPalm) anyPalm = true;
      debug.push({ label: key, phase, ...f });
    }
    // Forget hands that disappeared for too long; keep armed ones briefly (snap blur).
    for (const [key, st] of this.hands) {
      if (!seen.has(key) && now - st.lastSeenAt > this.dropoutMs) this.hands.delete(key);
    }

    // ---- Open palm hold (only meaningful while vanished) ----
    let palm = 0;
    if (appState === 'gone' && anyPalm) {
      if (this.palmStart === null) { this.palmStart = now; this.palmFired = false; }
      this.palmLastSeen = now;
    } else if (this.palmStart !== null && now - this.palmLastSeen > 350) {
      this.palmStart = null;
    }
    if (this.palmStart !== null && appState === 'gone') {
      palm = Math.min(1, (now - this.palmStart) / this.palmHoldMs);
      if (palm >= 1 && !this.palmFired) { this.palmFired = true; events.push('palm'); }
    }

    const phases = debug.map((d) => d.phase);
    if (phases.includes('snap')) status = 'Snap!';
    else if (phases.includes('armed')) status = 'Ready — snap!';
    else if (palm > 0) status = `Hold palm… ${((1 - palm) * this.palmHoldMs / 1000).toFixed(1)}s`;
    return { events, status, palm, debug };
  }
}
