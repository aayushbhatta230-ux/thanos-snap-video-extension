/* Test arena: runs the same engine the extension injects into calls. */
const $ = (id) => document.getElementById(id);
const out = $('out'), overlay = $('overlay'), octx = overlay.getContext('2d');
let engine = null, srcTrack = null, srcVideo = null, lastDebug = null;

const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function setState(s) {
  $('statePill').textContent = s;
  $('statePill').className = 'pill' + (s === 'live' ? '' : ' off');
  $('snap').disabled = s !== 'live';
  $('restore').disabled = s !== 'gone';
  $('capture').disabled = s !== 'live';
}

async function run(track) {
  stop();
  srcTrack = track;
  engine = new ThanosEngine({
    baseUrl: new URL('./', location.href).href,
    mirror: $('mirror').checked,
    duration: Number($('dur').value),
    sensitivity: Number($('sens').value),
    delegate: new URLSearchParams(location.search).get('delegate') || '',
    onState: setState,
    onStatus: (t) => ($('status').textContent = t),
    onPalm: (p) => ($('palm').style.width = `${p * 100}%`),
    onCoverage: (c, locked) => ($('cov').textContent = locked ? 'Room locked ✓ — you will vanish completely' : `Room captured: ${Math.round(c * 100)}% — press Capture room`),
    onDebug: (d) => (lastDebug = d),
    onReady: (delegate) => console.log('[test] vision ready', delegate)
  });
  window.engine = engine;
  out.srcObject = new MediaStream([await engine.start(track)]);
  $('empty').hidden = true;
  setState('live');
}

function stop() {
  engine?.destroy();
  engine = null;
  srcTrack?.stop();
  srcTrack = null;
}

$('cam').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    run(s.getVideoTracks()[0]);
  } catch (err) {
    $('status').textContent = 'Camera unavailable: ' + err.message;
  }
};

async function runVideoUrl(url) {
  srcVideo?.pause();
  srcVideo = document.createElement('video');
  srcVideo.src = url;
  srcVideo.muted = true; srcVideo.loop = true; srcVideo.playsInline = true; srcVideo.crossOrigin = 'anonymous';
  await srcVideo.play();
  run(srcVideo.captureStream().getVideoTracks()[0]);
}
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) runVideoUrl(URL.createObjectURL(f)); };
window.runVideoUrl = runVideoUrl;

$('snap').onclick = () => engine?.snap();
$('restore').onclick = () => engine?.restore();
$('capture').onclick = () => engine?.captureRoom();
$('sens').oninput = () => engine?.setOptions({ sensitivity: Number($('sens').value) });
$('dur').onchange = () => engine?.setOptions({ duration: Number($('dur').value) });
$('mirror').onchange = () => engine?.setOptions({ mirror: $('mirror').checked });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 's' || e.key === 'S') engine?.toggle();
  if (e.key === 'd' || e.key === 'D') $('dbg').checked = !$('dbg').checked;
});

// Debug overlay — landmark coords are normalised to the (already mirrored) frame.
function draw() {
  requestAnimationFrame(draw);
  const r = overlay.getBoundingClientRect();
  if (overlay.width !== r.width * devicePixelRatio) { overlay.width = r.width * devicePixelRatio; overlay.height = r.height * devicePixelRatio; }
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!$('dbg').checked || !lastDebug || !out.videoWidth) return;
  const vw = out.videoWidth, vh = out.videoHeight;
  const scale = Math.min(overlay.width / vw, overlay.height / vh);
  const ox = (overlay.width - vw * scale) / 2, oy = (overlay.height - vh * scale) / 2;
  const P = ([x, y]) => [ox + x * vw * scale, oy + y * vh * scale];
  lastDebug.hands.forEach((lm, i) => {
    const phase = lastDebug.debug[i]?.phase;
    octx.strokeStyle = phase === 'armed' || phase === 'releasing' ? '#fb923c' : phase === 'snap' ? '#f43f5e' : 'rgba(167,139,250,.9)';
    octx.lineWidth = 2 * devicePixelRatio;
    for (const [a, b] of BONES) { const [x1, y1] = P(lm[a]); const [x2, y2] = P(lm[b]); octx.beginPath(); octx.moveTo(x1, y1); octx.lineTo(x2, y2); octx.stroke(); }
    octx.fillStyle = '#fff';
    for (const p of lm) { const [x, y] = P(p); octx.fillRect(x - 2, y - 2, 4, 4); }
  });
  $('feat').textContent = lastDebug.debug.length
    ? lastDebug.debug.map((d) => `${d.label}: ${d.phase}\n  thumb↔middle ${d.thumbMiddle.toFixed(2)}  middle→palm ${d.middleToPalm.toFixed(2)}\n  ext I/M/R/P ${[d.extIndex, d.extMiddle, d.extRing, d.extPinky].map((v) => v.toFixed(2)).join(' ')}`).join('\n')
    : 'no hand';
}
draw();
