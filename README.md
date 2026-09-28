# QRS

QRS is an experimental simplex optical file-transfer protocol. A sender displays a stream of
binary matrices and a receiver reconstructs the transmitted object from camera frames without
network acknowledgements.

The repository currently contains two generations of code:

- `phase1.cpp` and `phase2.cpp`: original optical and fountain-code experiments.
- `qrs_core`: the versioned Protocol v0 transport foundation under active development.

## Current milestone

The Protocol v0 core provides:

- Versioned, bounds-checked binary frames.
- Per-frame CRC-32C validation.
- Session IDs and frame types.
- A compact object manifest with reserved encryption identifiers.
- A deterministic LT-style development codec with systematic symbols.
- Duplicate-symbol rejection and exact-length recovery.
- Offline recovery after simulated frame loss.
- A 64×64 optical matrix with phase inversion and orientation markers.
- Rotation and mirror recovery across all eight grid orientations.
- A dependency-free static browser transmitter and aligned-camera receiver.

Automatic perspective correction, SHA-256 implementation, and encryption are not implemented yet.

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
3. Align the exact matrix boundary inside the receiver's green/yellow guide.
4. Start transmission and hold both devices stable until the receiver exposes the download.

The current receiver deliberately uses manual alignment. It is the controlled MVP used to collect
camera evidence before automatic contour detection and homography are added.

Follow the complete [two-device test procedure](docs/two-device-test.md) and retain the receiver
diagnostics from each attempt.

To build the original OpenCV prototype as `qrs_phase1`:

```bash
cmake -S . -B build -DQRS_BUILD_LEGACY=ON
```

## Protocol

The current transport specification is documented in
[`docs/protocol-v0.md`](docs/protocol-v0.md). Protocol v0 is not yet stable and must not be used
for sensitive data. Frames are currently unencrypted.
