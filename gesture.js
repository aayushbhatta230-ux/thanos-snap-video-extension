/**
 * gesture.js — Angle-Invariant Finger-Snap & Open-Palm Recognition
 *
 * Designed to detect snaps from ANY angle (frontal, 45°, side-profile, tilted, top-down).
 *
 * Core Enhancements for All-Angle Reliability:
 *  1. Canonical Hand Scale & Frame: Normalizes metrics by combined palm length and
 *     palm width, making feature distances invariant to perspective foreshortening
 *     when hands are tilted or viewed from the side.
 *  2. Multi-Point Contact Detection: Checks thumb tip against middle tip and middle DIP
 *     in both 3D world space and 2D projected space.
 *  3. Anatomical Slam Detection: Middle finger slams into the thenar eminence (base of thumb /
 *     lower palm) while the thumb tip pulls away.
 *  4. Angle-Invariant Open Palm: Evaluates bone-chain straightness along each individual
 *     finger chain, independent of camera tilt.
 */

const WRIST = 0,
  THUMB_CMC = 1, THUMB_MCP = 2, THUMB_IP = 3, THUMB_TIP = 4,
  INDEX_MCP = 5, INDEX_PIP = 6, INDEX_DIP = 7, INDEX_TIP = 8,
  MIDDLE_MCP = 9, MIDDLE_PIP = 10, MIDDLE_DIP = 11, MIDDLE_TIP = 12,
  RING_MCP = 13, RING_PIP = 14, RING_DIP = 15, RING_TIP = 16,
  PINKY_MCP = 17, PINKY_PIP = 18, PINKY_DIP = 19, PINKY_TIP = 20;

// 3D Euclidean distance
const d3 = (a, b) => {
  if (!a || !b) return 999;
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dy, dz);
};

// 2D Euclidean distance (screen projection)
const d2 = (a, b) => {
  if (!a || !b) return 999;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

/**
 * Extract robust, angle-invariant features from 3D world landmarks and 2D landmarks
 */
export function handFeatures(worldLm, normLm = null) {
  if (!worldLm || worldLm.length < 21) return null;

  // 1. Stable hand scale factor: combines palm length and palm width
  const palmLen = d3(worldLm[WRIST], worldLm[MIDDLE_MCP]) || 0.08;
  const palmWidth = d3(worldLm[INDEX_MCP], worldLm[PINKY_MCP]) || 0.06;
  const s = Math.max(palmLen, palmWidth * 1.25, 0.04);

  // 2. Anatomical Palm Landing Target:
  // When a human snaps, the middle finger slams into the thenar eminence (base of thumb / lower palm).
  const thenarBase = {
    x: (worldLm[THUMB_CMC].x + worldLm[THUMB_MCP].x + worldLm[WRIST].x) / 3,
    y: (worldLm[THUMB_CMC].y + worldLm[THUMB_MCP].y + worldLm[WRIST].y) / 3,
    z: (worldLm[THUMB_CMC].z + worldLm[THUMB_MCP].z + worldLm[WRIST].z) / 3
  };

  const palmCenter = {
    x: (worldLm[WRIST].x + worldLm[INDEX_MCP].x + worldLm[MIDDLE_MCP].x + worldLm[RING_MCP].x + worldLm[PINKY_MCP].x) / 5,
    y: (worldLm[WRIST].y + worldLm[INDEX_MCP].y + worldLm[MIDDLE_MCP].y + worldLm[RING_MCP].y + worldLm[PINKY_MCP].y) / 5,
    z: (worldLm[WRIST].z + worldLm[INDEX_MCP].z + worldLm[MIDDLE_MCP].z + worldLm[RING_MCP].z + worldLm[PINKY_MCP].z) / 5
  };

  // 3. Pinch Contact Detection:
  // Strictly between THUMB TIP and Middle tip / Middle DIP (or Index tip).
  const thumbTipToMiddleTip = d3(worldLm[THUMB_TIP], worldLm[MIDDLE_TIP]) / s;
  const thumbTipToMiddleDip = d3(worldLm[THUMB_TIP], worldLm[MIDDLE_DIP]) / s;
  const thumbTipToIndexTip = d3(worldLm[THUMB_TIP], worldLm[INDEX_TIP]) / s;

  let pinch3D = Math.min(thumbTipToMiddleTip, thumbTipToMiddleDip * 1.05);

  let pinch2D = 999;
  if (normLm && normLm.length >= 21) {
    const s2d = Math.max(d2(normLm[WRIST], normLm[MIDDLE_MCP]), d2(normLm[INDEX_MCP], normLm[PINKY_MCP]) * 1.2, 0.05);
    const p2d_tm = d2(normLm[THUMB_TIP], normLm[MIDDLE_TIP]) / s2d;
    const p2d_tmdip = d2(normLm[THUMB_TIP], normLm[MIDDLE_DIP]) / s2d;
    pinch2D = Math.min(p2d_tm, p2d_tmdip);
  }

  // Blended pinch metric: if fingers contact in 3D or 2D projection, count as contact
  const effectivePinch = Math.min(pinch3D, pinch2D * 1.1);

  // 4. Middle finger curl / slam measurement:
  // Distance to the thenar landing base and palm center
  const middleToThenar = d3(worldLm[MIDDLE_TIP], thenarBase) / s;
  const middleToPalm = d3(worldLm[MIDDLE_TIP], palmCenter) / s;
  const effectiveSlamDist = Math.min(middleToThenar, middleToPalm);

  // 5. Angle-Invariant Finger Extension:
  // Evaluates extension along each finger's bone chain
  const isStraight = (tip, pip, mcp) => {
    const tipMcp = d3(worldLm[tip], worldLm[mcp]);
    const pipMcp = d3(worldLm[pip], worldLm[mcp]) || 1e-6;
    return tipMcp / pipMcp;
  };

  const extIndex = isStraight(INDEX_TIP, INDEX_PIP, INDEX_MCP);
  const extMiddle = isStraight(MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP);
  const extRing = isStraight(RING_TIP, RING_PIP, RING_MCP);
  const extPinky = isStraight(PINKY_TIP, PINKY_PIP, PINKY_MCP);

  // Thumb out: distance from thumb tip to pinky knuckle
  const thumbOut = d3(worldLm[THUMB_TIP], worldLm[PINKY_MCP]) / s;
  const fingerSpread = d3(worldLm[INDEX_TIP], worldLm[PINKY_TIP]) / s;

  return {
    thumbMiddle: thumbTipToMiddleTip,
    effectivePinch,
    pinch3D,
    pinch2D,
    middleToPalm,
    middleToThenar,
    effectiveSlamDist,
    thumbOut,
    spread: fingerSpread,
    extIndex,
    extMiddle,
    extRing,
    extPinky
  };
}

export class GestureTracker {
  constructor({ sensitivity = 65, palmHoldMs = 3000 } = {}) {
    this.palmHoldMs = palmHoldMs;
    this.setSensitivity(sensitivity);
    this.hands = new Map();
    this.lastSnapAt = -1e9;
    this.palmStart = null;
    this.palmLastSeen = -1e9;
    this.palmFired = false;
  }

  setSensitivity(v) {
    const k = Math.max(0, Math.min(100, Number(v))) / 100;
    this.sensitivity = k * 100;

    // Contact threshold (generous to accommodate steep viewing angles & side profiles)
    this.pinchMax = 0.44 + 0.16 * k;        // ~0.54 at 65%

    // Slam threshold: landing distance of middle finger to thenar/palm
    this.slamMax = 0.52 + 0.16 * k;         // ~0.62 at 65%

    // Minimum separation: thumb and middle must pull apart during the snap
    this.separationMin = 0.50 - 0.10 * k;   // ~0.43 at 65%

    // Dynamic drop requirement
    this.dropMin = 0.18 - 0.08 * k;         // ~0.13 at 65%

    // Time window: allow holding the armed pinch up to 1000ms while preparing to snap
    this.armedWindowMs = 650 + 350 * k;     // up to 880ms

    // Hand tracking dropout resilience (motion blur during snap)
    this.dropoutMs = 600;
  }

  update(hands, now, appState) {
    const events = [];
    let status = hands && hands.length ? 'Hand tracked' : 'No hand in view';
    const debug = [];
    let anyOpenPalm = false;
    const seen = new Set();

    for (const h of (hands || [])) {
      if (!h || !h.world) continue;
      const f = handFeatures(h.world, h.landmarks);
      if (!f) continue;

      const key = h.label || 'hand1';
      seen.add(key);

      let st = this.hands.get(key);
      if (!st) {
        st = {
          lastArmedAt: -1e9,
          lastSeenAt: now,
          armPinchDist: 999,
          peakSlamDist: 0,
          hist: [],
          phase: 'idle'
        };
        this.hands.set(key, st);
      }
      st.lastSeenAt = now;

      // -----------------------------------------------------------------
      // 1. OPEN PALM RECOGNITION (Angle-Invariant Bone-Chain Straightness)
      // -----------------------------------------------------------------
      const isIndexStraight = f.extIndex > 1.25;
      const isMiddleStraight = f.extMiddle > 1.25;
      const isRingStraight = f.extRing > 1.18;
      const isPinkyStraight = f.extPinky > 1.12;

      const openPalm = isIndexStraight && isMiddleStraight && isRingStraight && isPinkyStraight &&
                       f.effectivePinch > 0.60 && f.thumbOut > 0.70;

      if (openPalm) {
        anyOpenPalm = true;
      }

      // -----------------------------------------------------------------
      // 2. FINGER SNAP GESTURE (Angle-Invariant Multi-Point Kinematics)
      // -----------------------------------------------------------------
      const isPinching = f.effectivePinch < this.pinchMax && !openPalm;

      if (isPinching) {
        st.lastArmedAt = now;
        st.armPinchDist = f.effectivePinch;
        st.peakSlamDist = Math.max(st.peakSlamDist || 0, f.effectiveSlamDist);
      }

      st.hist.push({ t: now, dist: f.effectiveSlamDist });
      st.hist = st.hist.filter((item) => now - item.t <= 450);
      const recentMaxSlamDist = st.hist.reduce((m, item) => Math.max(m, item.dist), st.peakSlamDist || 0);

      const isArmed = (now - st.lastArmedAt) <= this.armedWindowMs;

      let currentPhase = 'idle';
      if (isArmed) {
        currentPhase = isPinching ? 'armed' : 'releasing';
      }

      // Snap occurs when thumb and middle separate while middle lands in palm/thenar
      const hasSeparated = f.effectivePinch >= this.separationMin || (f.effectivePinch - st.armPinchDist >= 0.18);
      const isLandedInPalm = f.effectiveSlamDist < this.slamMax;
      const hasSlammedDown = (recentMaxSlamDist - f.effectiveSlamDist) >= this.dropMin;

      const snapTriggered = isArmed && !isPinching && (
        (hasSeparated && isLandedInPalm) ||
        (hasSeparated && hasSlammedDown) ||
        (isLandedInPalm && hasSlammedDown)
      );

      if (snapTriggered) {
        currentPhase = 'snap';
        st.lastArmedAt = -1e9;
        st.peakSlamDist = 0;
        st.hist = [];

        if (now - this.lastSnapAt > 1100) {
          this.lastSnapAt = now;
          events.push('snap');
        }
      }

      st.phase = currentPhase;
      debug.push({
        label: key,
        phase: currentPhase,
        thumbMiddle: f.thumbMiddle,
        effectivePinch: f.effectivePinch,
        middleToPalm: f.middleToPalm,
        effectiveSlamDist: f.effectiveSlamDist,
        extIndex: f.extIndex,
        extMiddle: f.extMiddle,
        extRing: f.extRing,
        extPinky: f.extPinky
      });
    }

    for (const [key, st] of this.hands) {
      if (!seen.has(key) && now - st.lastSeenAt > this.dropoutMs) {
        this.hands.delete(key);
      }
    }

    // -----------------------------------------------------------------
    // 3. OPEN PALM RECOVERY TIMER (3 Seconds while Vanished)
    // -----------------------------------------------------------------
    let palmProgress = 0;
    if (appState === 'gone' && anyOpenPalm) {
      if (this.palmStart === null) {
        this.palmStart = now;
        this.palmFired = false;
      }
      this.palmLastSeen = now;
    } else if (this.palmStart !== null && now - this.palmLastSeen > 400) {
      this.palmStart = null;
    }

    if (this.palmStart !== null && appState === 'gone') {
      palmProgress = Math.min(1.0, (now - this.palmStart) / this.palmHoldMs);
      if (palmProgress >= 1.0 && !this.palmFired) {
        this.palmFired = true;
        events.push('palm');
      }
    }

    const phases = debug.map((d) => d.phase);
    if (phases.includes('snap')) {
      status = '💥 Snap!';
    } else if (phases.includes('armed') || phases.includes('releasing')) {
      status = '🤌 Ready — snap anytime!';
    } else if (palmProgress > 0) {
      status = `✋ Hold palm… ${((1 - palmProgress) * (this.palmHoldMs / 1000)).toFixed(1)}s`;
    }

    return { events, status, palm: palmProgress, debug };
  }
}
