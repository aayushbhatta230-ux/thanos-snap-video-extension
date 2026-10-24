# 🤌 Thanos Snap - Video Disintegrator (Chrome Extension)

Turn your body into cosmic ash Thanos-style when you snap your fingers, while keeping your room background visible. Built with computer vision hand gesture recognition and real-time person segmentation—**100% independent of microphone audio**.

---

## 🌟 New Capabilities Added

1. **🚫 Zero Mic Dependency:**
   - Microphone audio is **never required**. The extension is 100% vision-driven.
2. **🤌 Vision-Based Finger Snap Recognition:**
   - Real-time hand landmark tracking detects when your thumb and middle finger pinch together and snap open.
3. **🪞 Mirrored Video Everywhere:**
   - Horizontally flips video output (`scale(-1, 1)`) across all platforms (Google Meet, Zoom Web, Teams, Discord, test sandbox) so hand movements and your video feed feel completely natural like a real mirror.
4. **🏠 Body-Only Disintegration (Room Background Stays Active):**
   - Neural person segmentation isolates your body from the room.
   - When snapped, **only your body** decomposes into drifting ash particles and fades out over 2.4s.
   - The camera **does NOT go off or black**—your room background remains completely visible!
5. **✋ 3-Second Open Palm Recovery:**
   - Show an open palm (all 5 fingers extended and spread) to the camera.
   - A glowing countdown ring charges up on screen (`3.0s... 2.0s... 1.0s...`).
   - After holding for 3 seconds, your body smoothly materializes back into the video feed!

---

## 📂 Project Structure

- [`manifest.json`](manifest.json): Extension configuration (Manifest V3).
- [`libs/`](libs/): Bundled local MediaPipe neural models (`selfie_segmentation` and `hands`).
- [`person_segmenter.js`](person_segmenter.js): Body vs. room background neural segmentation & background plate persistence.
- [`gesture_detector.js`](gesture_detector.js): Vision hand tracking for Pinch-Snap and 3-second Open Palm hold.
- [`thanos_engine.js`](thanos_engine.js): Horizontal video mirroring, body particle physics, and on-screen recovery ring.
- [`injected.js`](injected.js): `navigator.mediaDevices.getUserMedia` interceptor in the MAIN world with in-call floating HUD.
- [`content_bridge.js`](content_bridge.js): Extension storage and URL bridge in the ISOLATED world.
- [`popup.html`](popup.html), [`popup.js`](popup.js), [`popup.css`](popup.css): Mirrored camera sandbox and gesture status monitor.
- [`test.html`](test.html), [`test.js`](test.js): Standalone full-screen testing arena with real-time palm hold meter.

---

## 🚀 How to Load & Test in Chrome

1. Open Google Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left) and select:
   ```text
   C:\Users\joshi\.gemini\antigravity\scratch\thanos-snap-video-extension
   ```
4. If you already had it loaded, click the **Reload 🔄** icon on the extension card.
5. Open [`test.html`](test.html) or join a Google Meet call:
   - Your video is automatically mirrored.
   - **Snap your fingers (pinch thumb & middle finger, then snap open)** -> Your body disintegrates into ash while your room stays visible!
   - **Show your open palm for 3 seconds** -> Watch the glowing circular countdown ring charge up and your body materialize back!
   - Hotkeys: <kbd>Alt+Shift+S</kbd> to snap, <kbd>Alt+Shift+R</kbd> to restore.
