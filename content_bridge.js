/**
 * content_bridge.js — ISOLATED world. Hands the extension URL and saved settings to the
 * MAIN-world hook (injected.js) and relays popup / keyboard-shortcut commands.
 */
(function () {
  'use strict';
  const DEFAULTS = { enabled: true, hudVisible: true, duration: 2400, mirrorVideo: true, sensitivity: 60 };

  document.documentElement.dataset.thanosExtensionUrl = chrome.runtime.getURL('');

  const send = (type, payload) => window.postMessage({ type, payload }, '*');
  chrome.storage.sync.get(DEFAULTS, (items) => send('THANOS_UPDATE_SETTINGS', items));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const updated = {};
    for (const [k, c] of Object.entries(changes)) updated[k] = c.newValue;
    send('THANOS_UPDATE_SETTINGS', updated);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.action === 'TRIGGER_SNAP') send('THANOS_TRIGGER_SNAP');
    else if (msg?.action === 'RESTORE_VIDEO') send('THANOS_RESTORE_VIDEO');
    else return;
    reply({ ok: true });
  });
})();
