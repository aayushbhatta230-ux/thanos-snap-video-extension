/**
 * ContentBridge.js - Isolated World Content Script
 * Passes extension URLs and storage settings to the Main World.
 */

(function () {
  'use strict';

  // Inject extension base URL onto root element for MAIN world scripts
  const baseUrl = chrome.runtime.getURL('');
  document.documentElement.dataset.thanosExtensionUrl = baseUrl;
  window.postMessage({ type: 'THANOS_SET_BASE_URL', url: baseUrl }, '*');

  // Load saved settings from extension storage
  chrome.storage.sync.get(
    {
      enabled: true,
      hudVisible: true,
      duration: 2400,
      mirrorVideo: true
    },
    (items) => {
      window.postMessage({ type: 'THANOS_UPDATE_SETTINGS', payload: items }, '*');
    }
  );

  // Listen for messages from extension popup or background service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return;

    if (message.action === 'TRIGGER_SNAP') {
      window.postMessage({ type: 'THANOS_TRIGGER_SNAP' }, '*');
      sendResponse({ status: 'ok' });
    } else if (message.action === 'RESTORE_VIDEO') {
      window.postMessage({ type: 'THANOS_RESTORE_VIDEO' }, '*');
      sendResponse({ status: 'ok' });
    } else if (message.action === 'UPDATE_SETTINGS') {
      window.postMessage({ type: 'THANOS_UPDATE_SETTINGS', payload: message.settings }, '*');
      sendResponse({ status: 'ok' });
    }
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    const updated = {};
    for (const [key, change] of Object.entries(changes)) {
      updated[key] = change.newValue;
    }
    window.postMessage({ type: 'THANOS_UPDATE_SETTINGS', payload: updated }, '*');
  });
})();
