/**
 * Background Service Worker - Thanos Snap Video Extension
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ThanosSnap] Extension installed successfully.');
  // Initialize default settings
  chrome.storage.sync.get(['enabled', 'sensitivity', 'soundEnabled', 'hudVisible', 'duration'], (res) => {
    chrome.storage.sync.set({
      enabled: res.enabled !== undefined ? res.enabled : true,
      sensitivity: res.sensitivity !== undefined ? res.sensitivity : 75,
      soundEnabled: res.soundEnabled !== undefined ? res.soundEnabled : true,
      hudVisible: res.hudVisible !== undefined ? res.hudVisible : true,
      duration: res.duration !== undefined ? res.duration : 2400
    });
  });
});

// Handle keyboard command shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  if (command === 'trigger_snap') {
    chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_SNAP' }).catch(() => {});
  } else if (command === 'restore_video') {
    chrome.tabs.sendMessage(tab.id, { action: 'RESTORE_VIDEO' }).catch(() => {});
  }
});
