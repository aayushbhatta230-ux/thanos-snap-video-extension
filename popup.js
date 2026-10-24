const DEFAULTS = { enabled: true, hudVisible: true, duration: 2400, mirrorVideo: true, sensitivity: 60 };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('hudVisible').checked = s.hudVisible;
  $('mirrorVideo').checked = s.mirrorVideo;
  $('duration').value = String(s.duration);
  $('sensitivity').value = s.sensitivity;
  badge(s.enabled);
});

function badge(on) {
  $('badge').textContent = on ? 'on' : 'off';
  $('badge').className = 'badge' + (on ? '' : ' off');
}

function save() {
  const s = {
    enabled: $('enabled').checked,
    hudVisible: $('hudVisible').checked,
    mirrorVideo: $('mirrorVideo').checked,
    duration: Number($('duration').value),
    sensitivity: Number($('sensitivity').value)
  };
  chrome.storage.sync.set(s);
  badge(s.enabled);
}
for (const id of ['enabled', 'hudVisible', 'mirrorVideo', 'duration', 'sensitivity']) $(id).addEventListener('change', save);

const toTab = (action) => chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
});
$('snap').onclick = () => toTab('TRIGGER_SNAP');
$('restore').onclick = () => toTab('RESTORE_VIDEO');
$('arena').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('test.html') });
