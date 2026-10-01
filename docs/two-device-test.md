# QRS Two-Device Optical Test

This procedure validates v0.1.5 automatic optical acquisition, mobile focus control, recovery-tail scheduling, and motion feedback. It does not validate encryption,
colour symbols, or hostile lighting performance.

## Equipment

- Display device: laptop or tablet running the QRS sender.
- Camera device: phone or laptop running the QRS receiver.
- A small non-sensitive test file. Start with `payload.txt` from this repository.
- Stable indoor lighting without direct reflections on the transmitting display.

Both devices should use a current Chromium-based browser for the first test. Cross-browser testing
starts only after the baseline succeeds.

## Preparation

1. Open the HTTPS QRS deployment on both devices.
2. Keep browser zoom at 100%.
3. Set the sender display brightness to approximately 80–100%.
4. Open **Receive a file** on the camera device and allow camera access.
5. Select the rear camera.
6. Leave the receiver at **30 FPS** for the baseline. If the camera track exposes point focus, tap
   the centre of the matrix; otherwise leave browser-managed focus active.
7. Leave **Auto-track outer frame** enabled. Minimum contrast remains `24` under **Advanced
   acquisition controls**.
8. Open **Send a file** on the display device and select `payload.txt`.
9. Read and acknowledge the rapid-flash warning. The current temporal carrier is for shielded lab
   testing only; keep the transmitting display facing the camera and do not stare at it.
10. Start at the validated `50 ms` baseline. Use `67 ms` as the compatibility reference, then test
    `40 ms` and `33 ms` only as channel-limit probes.
11. Enter fullscreen matrix mode only after confirming that the black guard remains visible.

## Acquisition

The receiver detects the complete outer white square, smooths its four corners, and projectively
maps the inner 64×64 data matrix. The three-cell white margin and some of the black guard around it
must remain visible on all four sides. This remains true in fullscreen mode.

1. Hold the camera approximately 25–45 cm from the display.
2. Point the camera so the complete white square and a thin black surround are visible; exact
   alignment is not required.
3. Move and tilt the camera slowly. The overlay should follow the four frame corners.
4. A green quadrilateral means the outer frame remains tracked. The text distinguishes a recently
   decoded phase from a tracked frame waiting for a clean phase.
5. If automatic detection never locks, disable it and use the alignment slider as a fallback. Record
   that fallback in the test results.

## Transmission

1. Start the receiver camera first.
2. Start transmission on the sender.
3. Hold both devices stable.
4. Wait for **Manifest locked**.
5. Confirm that `resolved symbols` begins increasing in diagnostics.
6. When **Transfer complete** appears, download the recovered file.
7. Compare its contents with the original.

The transmitter continues because QRS has no acknowledgement channel. Stop it manually after the
receiver completes.

## Diagnostic interpretation

| Observation | Likely cause | Action |
|---|---|---|
| Tracked count remains zero | Outer white frame is cropped, too small, or merged into a bright background | Show all four sides, move closer, or place the sender against a darker background |
| Tracking rises but marker locks remain zero | Detected quadrilateral is not the QRS frame or sampling is distorted | Reduce glare, move closer, or try manual fallback |
| Phase-pilot errors dominate | Motion blur, rolling shutter, or a phase transition was captured | Try the 67 ms reference or the experimental 60 FPS camera request |
| Only phase A or phase B increases | Camera misses one temporal phase | Try the 67 ms reference and compare 30 versus 60 FPS acquisition |
| Marker locks rise but valid frames remain zero | Sampling is unstable, blurred, or phase timing is mismatched | Move closer, try 67 ms, and reduce camera motion |
| Valid frames rise but manifest remains zero | Manifest frames were missed | Continue holding steady; the sender repeats the manifest every 24 logical frames |
| Manifest locks but resolved count does not rise | Data frames fail CRC or session matching | Reduce glare, stabilize devices, and increase phase duration |
| Final 10% resolves slowly | Remaining source symbols were erased and need a repeat or useful repair equation | Continue transmission and record source/repair plus duplicate-symbol diagnostics |
| Cell contrast errors dominate | Exposure, focus, glare, or display PWM problem | Change distance/brightness and compare against the 67 ms reference |
| Camera pixels/cell stays below 4 | The matrix is too small in the camera image | Move the receiver closer while keeping the black guard visible |

## Test ladder

Run tests in this order and stop at the first failure:

1. Small non-sensitive file at 50 ms, windowed, with the receiver at 30 FPS.
2. Repeat in fullscreen. The black guard must remain visible.
3. Run the same file at 67, 40, and 33 ms; stop if the optical-pair rate falls or exposure to the
   rapid flashing becomes uncomfortable.
4. Repeat 50 ms with the receiver requesting 60 FPS. Record requested, granted, and capability FPS.
5. A 10 KB binary file at the best measured combination.
6. A 150 KB binary file only after the smaller transfer completes reliably.
7. Change distance and camera angle.
8. Repeat using another browser after the Chromium baseline succeeds.

## Record after each attempt

Read **Transfer details** during a run. Expand **Optical quality** or **Camera performance** only when
needed, then use **Copy full diagnostics** after each run. The copied report includes every section.

- Sender device, browser, display brightness, and phase duration.
- Receiver device, browser, chosen camera, automatic/manual acquisition, and contrast threshold.
- Approximate distance and angle.
- Marker locks/failures.
- Tracked/missed frames and geometry pair rejects.
- Phase A/B observations.
- Valid/rejected pairs.
- Manifest/data frames, accepted source/repair frames, and unique/duplicate data symbols.
- Resolved symbols and total symbols.
- Camera frame rate and average/maximum processing time.
- Hot-path capture, detection, sampling, classification, and pairing time.
- Camera pixels per cell, focus capabilities/state, and focus request result.
- Detector runs versus reused tracks, plus the ranked top-error line.
- Whether the downloaded bytes matched the original.

These measurements determine whether the next work belongs in timing, marker detection, sampling,
or automatic homography.
