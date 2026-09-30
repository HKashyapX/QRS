# QRS

QRS is an experimental simplex optical file-transfer protocol. A sender displays a stream of
binary matrices and a receiver reconstructs the transmitted object from camera frames without
network acknowledgements.

The repository currently contains two generations of code:

- `phase1.cpp` and `phase2.cpp`: original optical and fountain-code experiments.
- `qrs_core`: the versioned Protocol v0 transport foundation under active development.

## Current milestone: v0.1.5 Mobile Optics

The Protocol v0 core provides:

- Versioned, bounds-checked binary frames.
- Per-frame CRC-32C validation.
- Session IDs and frame types.
- A compact object manifest with reserved encryption identifiers.
- A deterministic LT-style development codec with systematic symbols.
- Duplicate-symbol rejection and exact-length recovery.
- Offline recovery after simulated frame loss.
- A 64×64 optical matrix with static 9×9 orientation anchors and an explicit phase pilot.
- Rotation and mirror recovery across all eight grid orientations.
- A dependency-free static browser transmitter and camera receiver.
- Automatic outer-frame detection and four-corner tracking.
- Perspective-corrected cell sampling with temporal corner smoothing.
- A fullscreen-safe black guard around the detected white symbol boundary.
- Camera-frame-synchronized processing and tracked-homography reuse.
- Retryable A/B phase windows that retain clean A candidates until a B observation decodes.
- Allocation-light perspective sampling with cached coordinate lookup tables and a reusable cell buffer.
- CRC-guarded tolerance for a bounded number of weak differential cells.
- A camera-range marker classifier backed by marker errors, phase pilot checks, and frame CRC.
- Continuous systematic-symbol cycling mixed with fresh fountain repair symbols.
- Bounded GF(2) elimination that closes final LT stopping sets after fast peeling stalls.
- Initial manifest bursts so receivers can bind before the systematic stream advances.
- Geometry-aware rejection when the camera moves between differential phases.
- A manual alignment fallback and expanded acquisition diagnostics.
- Tracking-state feedback that does not flicker when a single optical phase is rejected.
- Capability-aware continuous focus and tap-to-focus with a visible focus reticle.
- Automatic one-shot focus at the first detected matrix centre and a square high-resolution preview.
- Camera pixels-per-cell and sender display pixels-per-cell diagnostics for phone-to-phone tests.
- A screen wake lock request while a phone is transmitting.

SHA-256 implementation, encryption, adaptive grid density, and colour symbols are not implemented
yet. The colour work is deliberately isolated until acquisition is measured across real devices.

## Build

Requirements:

- CMake 3.20 or newer.
- A C++20 compiler.
- OpenCV only when explicitly building the legacy Phase 1 prototype.

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

Run the offline transfer demonstration:

```bash
./build/qrs_offline_demo payload.txt recovered_payload.txt 30
cmp payload.txt recovered_payload.txt
```

The final argument is the simulated percentage of dropped data frames.

## Browser demo

Serve the static application locally:

```bash
python3 -m http.server 8000 --directory web
```

Open `http://localhost:8000`. Localhost is accepted as a secure browser context for camera access.
For a second physical device, deploy the `web/` directory to an HTTPS static host such as
Cloudflare Pages or GitHub Pages; camera access normally does not work from a plain HTTP LAN URL.

1. Open `send.html` on the display device and select a file below 10 KB for the first test.
2. Open `receive.html` on the camera device and permit camera access.
3. Tap the matrix once to request focus, then keep the complete white square and some black surround visible. Green means the outer frame is
   being tracked; individual noisy phases may still be rejected without losing alignment.
4. Start transmission and hold both devices stable until the receiver exposes the download.

Automatic tracking is the default. The 384 px alignment box is not used in this mode. If a device
cannot acquire the outer frame, open **Advanced acquisition controls**, disable automatic tracking,
and use the alignment-box slider as a controlled fallback.

Follow the complete [two-device test procedure](docs/two-device-test.md) and retain the receiver
diagnostics from each attempt.

The current field-test rationale and acceptance targets are recorded in
[`docs/v0.1.5-mobile-optics.md`](docs/v0.1.5-mobile-optics.md).

To build the original OpenCV prototype as `qrs_phase1`:

```bash
cmake -S . -B build -DQRS_BUILD_LEGACY=ON
```

## Protocol

The current transport specification is documented in
[`docs/protocol-v0.md`](docs/protocol-v0.md). Protocol v0 is not yet stable and must not be used
for sensitive data. Frames are currently unencrypted.

The design sources and the separate five-colour research plan are documented in
[`docs/v0.1-optical-acquisition.md`](docs/v0.1-optical-acquisition.md).
