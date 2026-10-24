# 🫰 Thanos Snap

Snap your fingers on a video call and your body crumbles into dust. Your actual room stays behind.
Snap again, or hold an open palm for 3 seconds, and you reassemble.

Works anywhere a site asks for your camera: Google Meet, Zoom (web), Teams, Discord, Jitsi and so on.
It doesn't need the microphone; everything is done with vision.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. If it was already loaded, click the reload icon on its card, then **reload the call tab**.

## Use

1. Join the call with your camera on. A small **Thanos Snap** HUD appears in the bottom-right.
2. **Teach it your room:** lean out of frame for a second or two. The HUD shows `Room captured %`.
   The extension learns the room from every pixel where you *aren't*. Anything it never saw gets
   filled in from the surroundings, which is convincing but not perfect.
3. **Snap:** press thumb and middle finger together, then snap so the middle finger slaps into your palm.
   Keep your hand roughly facing the camera.
4. **Come back:** snap again, or hold an open palm (all five fingers spread) for 3 s.

Shortcuts: `Alt+Shift+S` snap / come back, `Alt+Shift+R` restore. The HUD has buttons too.

## Test arena

Popup → **Open test arena**. It runs the same engine against your camera or a video file, with a debug
overlay of hand landmarks and the live detector values (`thumb↔middle`, `middle→palm`).
If snaps are missed, raise **Snap sensitivity**. If it fires by accident, lower it.

## How it works

| Piece | Job |
|---|---|
| `injected.js` (page) | Wraps `getUserMedia`, hands the call a processed camera track, draws the HUD (shadow DOM, Trusted-Types safe). |
| `thanos_engine.js` (page) | Frame pipeline (`MediaStreamTrackProcessor` → canvas → `MediaStreamTrackGenerator`, so it keeps running when the tab is in the background). Learns a background plate of the room, fills unseen areas (push-pull + scanline fill), replaces your body with it, and renders the 20-layer dust animation. |
| `vision.html` / `vision.js` (hidden extension iframe) | MediaPipe Tasks: `HandLandmarker` + `ImageSegmenter`, GPU with CPU fallback. Runs in the extension's origin, so Meet's CSP / Trusted Types can't block the WASM. |
| `gesture.js` | Snap = thumb–middle contact followed, within ~400 ms, by the middle fingertip dropping sharply into the palm (tuned on recorded snaps; uses 3-D world landmarks, so distance to camera doesn't matter). Open palm = all fingers extended and spread. |
| `content_bridge.js`, `background.js`, `popup.*` | Settings, shortcuts, popup. |

Settings (popup): enable, snap sensitivity, dust speed, mirror outgoing video, show HUD.
Enable and mirror changes apply the next time the call turns the camera on.
