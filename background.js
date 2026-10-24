/** Background service worker — routes keyboard shortcuts to the active tab. */
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const action = command === 'trigger_snap' ? 'TRIGGER_SNAP' : command === 'restore_video' ? 'RESTORE_VIDEO' : null;
  if (action) chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
});
