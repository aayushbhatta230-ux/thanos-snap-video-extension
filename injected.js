/**
 * injected.js — MAIN world. Wraps getUserMedia so any call site (Meet, Zoom web, Teams,
 * Discord, Jitsi…) receives the processed camera track, and shows a small in-call HUD.
 * The HUD lives in a closed shadow root and is built without innerHTML, so page CSS
 * and Trusted Types policies can't break it.
 */
(function () {
  'use strict';
  if (window.__THANOS_SNAP__) return;
  window.__THANOS_SNAP__ = true;

  const settings = { enabled: true, hudVisible: true, duration: 2400, mirrorVideo: true, sensitivity: 60 };
  const engines = new Set();
  const current = () => [...engines].pop() || null;
  const baseUrl = () => document.documentElement.dataset.thanosExtensionUrl || '';

  // ---------------------------------------------------------------- getUserMedia hook
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const realGUM = md.getUserMedia.bind(md);
    md.getUserMedia = async function (constraints) {
      const stream = await realGUM(constraints);
      if (!settings.enabled || !constraints || !constraints.video || !window.ThanosEngine || !baseUrl()) return stream;
      const camTrack = stream.getVideoTracks()[0];
      if (!camTrack) return stream;
      try {
        return new MediaStream([await wrapTrack(camTrack), ...stream.getAudioTracks()]);
      } catch (err) {
        console.error('[ThanosSnap] processing failed, using raw camera', err);
        return stream;
      }
    };
  }

  async function wrapTrack(cam) {
    const engine = new window.ThanosEngine({
      baseUrl: baseUrl(),
      mirror: settings.mirrorVideo,
      duration: settings.duration,
      sensitivity: settings.sensitivity,
      onState: (s) => engine === current() && hud.setState(s),
      onStatus: (t) => engine === current() && hud.setStatus(t),
      onPalm: (p) => engine === current() && hud.setPalm(p),
      onCoverage: (c, locked) => engine === current() && hud.setCoverage(c, locked)
    });
    const out = await engine.start(cam);
    engines.add(engine);

    const realStop = out.stop.bind(out);
    let stopped = false;
    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      engines.delete(engine);
      engine.destroy();
      try { realStop(); } catch (_) {}
      try { cam.stop(); } catch (_) {}
      if (!engines.size) hud.hide();
    };
    // Make the processed track look and behave like the real camera to the call app.
    const define = (name, value) => { try { Object.defineProperty(out, name, { value, configurable: true }); } catch (_) {} };
    define('stop', stopAll);
    define('getSettings', () => Object.assign({}, cam.getSettings(), { width: engine.W || cam.getSettings().width, height: engine.H || cam.getSettings().height }));
    define('getCapabilities', () => (cam.getCapabilities ? cam.getCapabilities() : {}));
    define('getConstraints', () => cam.getConstraints());
    define('applyConstraints', (c) => cam.applyConstraints(c));
    try { Object.defineProperty(out, 'label', { get: () => cam.label, configurable: true }); } catch (_) {}
    cam.addEventListener('ended', stopAll);

    hud.show();
    hud.setState('live');
    return out;
  }

  // ---------------------------------------------------------------- HUD
  const hud = (() => {
    let host = null, els = null, minimized = false;

    const h = (tag, props = {}, ...kids) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
      for (const kid of kids) el.append(kid);
      return el;
    };

    const CSS = `
      :host { all: initial; }
      .wrap { position: fixed; right: 20px; bottom: 96px; z-index: 2147483647; font: 500 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #ede9fe; user-select: none; }
      .card { width: 232px; background: rgba(17, 12, 32, .92); border: 1px solid rgba(167, 139, 250, .35); border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.45); backdrop-filter: blur(12px); overflow: hidden; transition: border-color .3s, box-shadow .3s; }
      .card.gone { border-color: rgba(251, 146, 60, .6); box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 24px rgba(251,146,60,.25); }
      .head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px; cursor: grab; }
      .head:active { cursor: grabbing; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 8px #34d399; flex: none; }
      .gone .dot, .vanishing .dot, .returning .dot { background: #fb923c; box-shadow: 0 0 8px #fb923c; }
      .title { font-weight: 700; letter-spacing: .2px; flex: 1; }
      .state { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: #c4b5fd; }
      .mini { all: unset; cursor: pointer; width: 20px; height: 20px; border-radius: 6px; text-align: center; color: #a5b4fc; }
      .mini:hover { background: rgba(255,255,255,.08); }
      .body { padding: 0 12px 12px; display: grid; gap: 8px; }
      .min .body { display: none; }
      .status { background: rgba(255,255,255,.06); border-radius: 8px; padding: 6px 8px; color: #ddd6fe; min-height: 16px; }
      .bar { height: 4px; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; display: none; }
      .bar > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #34d399, #a3e635); transition: width .1s linear; }
      .gone .bar { display: block; }
      .hint { color: #a1a1aa; font-size: 11px; }
      .row { display: flex; gap: 6px; }
      button.act { all: unset; flex: 1; text-align: center; cursor: pointer; padding: 7px 0; border-radius: 8px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #7c3aed, #a855f7); }
      button.act:hover { filter: brightness(1.1); }
      button.act:active { transform: scale(.97); }
      button.act[hidden] { display: none; }
      button.restore { background: linear-gradient(135deg, #059669, #10b981); }
      button.ghost { background: rgba(255,255,255,.1); font-weight: 600; }
      .hint.warn { color: #fbbf24; }
    `;

    function build() {
      host = h('div');
      const root = host.attachShadow({ mode: 'closed' });
      root.append(h('style', {}, CSS));
      els = {};
      els.state = h('span', { class: 'state' }, 'live');
      els.status = h('div', { class: 'status' }, 'Starting…');
      els.barFill = h('i');
      els.hint = h('div', { class: 'hint' }, '');
      els.snap = h('button', { class: 'act', title: 'Alt+Shift+S', onclick: () => current()?.snap() }, 'Snap');
      els.restore = h('button', { class: 'act restore', title: 'Alt+Shift+R', onclick: () => current()?.restore(), hidden: '' }, 'Restore');
      els.capture = h('button', { class: 'act ghost', title: 'Step out of frame so it learns the room behind you', onclick: () => current()?.captureRoom() }, 'Capture room');
      const mini = h('button', { class: 'mini', title: 'Minimise', onclick: (e) => { e.stopPropagation(); minimized = !minimized; els.card.classList.toggle('min', minimized); mini.textContent = minimized ? '+' : '–'; } }, '–');
      els.head = h('div', { class: 'head' }, h('span', { class: 'dot' }), h('span', { class: 'title' }, 'Thanos Snap'), els.state, mini);
      els.card = h('div', { class: 'card' },
        els.head,
        h('div', { class: 'body' }, els.status, h('div', { class: 'bar' }, els.barFill), els.hint, h('div', { class: 'row' }, els.capture, els.snap, els.restore)));
      els.wrap = h('div', { class: 'wrap' }, els.card);
      root.append(els.wrap);
      draggable(els.wrap, els.head);
    }

    function draggable(el, handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const r = el.getBoundingClientRect();
        const ox = e.clientX - r.left, oy = e.clientY - r.top;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          el.style.left = Math.max(4, Math.min(innerWidth - r.width - 4, ev.clientX - ox)) + 'px';
          el.style.top = Math.max(4, Math.min(innerHeight - 40, ev.clientY - oy)) + 'px';
          el.style.right = el.style.bottom = 'auto';
        };
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }

    const labels = { live: 'live', vanishing: 'snapping', gone: 'vanished', returning: 'returning' };
    return {
      show() {
        if (!host) build();
        if (!host.isConnected) document.documentElement.append(host);
        host.style.display = settings.hudVisible ? '' : 'none';
      },
      hide() { host?.remove(); },
      refreshVisibility() { if (host) host.style.display = settings.hudVisible ? '' : 'none'; },
      setState(s) {
        if (!els) return;
        els.card.classList.remove('live', 'vanishing', 'gone', 'returning');
        els.card.classList.add(s);
        els.state.textContent = labels[s] || s;
        els.snap.hidden = s !== 'live';
        els.capture.hidden = s !== 'live';
        els.restore.hidden = s !== 'gone';
        if (s === 'gone') els.status.textContent = 'Vanished. Snap again or hold an open palm 3s.';
        if (s !== 'gone') els.barFill.style.width = '0';
      },
      setStatus(t) { if (els && current()?.state !== 'gone') els.status.textContent = t; else if (els && /palm/i.test(t)) els.status.textContent = t; },
      setPalm(p) { if (els) els.barFill.style.width = `${Math.round(p * 100)}%`; },
      setCoverage(c, locked) {
        if (!els) return;
        els.hint.textContent = locked ? 'Room locked ✓ — you will vanish completely' : c >= 0.97 ? 'Room fully captured ✓' : `Room captured ${Math.round(c * 100)}% — press Capture room and step out of frame, or the spot behind you will look smudged.`;
        els.hint.classList.toggle('warn', !locked);
      }
    };
  })();

  // ---------------------------------------------------------------- messages from the extension
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.type !== 'string' || !e.data.type.startsWith('THANOS_')) return;
    const eng = current();
    switch (e.data.type) {
      case 'THANOS_TRIGGER_SNAP': eng?.toggle(); break;
      case 'THANOS_RESTORE_VIDEO': eng?.restore(); break;
      case 'THANOS_UPDATE_SETTINGS': {
        Object.assign(settings, e.data.payload || {});
        for (const en of engines) en.setOptions({ mirror: settings.mirrorVideo, duration: settings.duration, sensitivity: settings.sensitivity });
        hud.refreshVisibility();
        break;
      }
    }
  });
})();
