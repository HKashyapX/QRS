# QRS Two-Device Optical Test

This procedure validates v0.1.1 automatic optical acquisition. It does not validate encryption,
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
6. Leave **Auto-track outer frame** enabled and minimum contrast at `24` initially.
7. Open **Send a file** on the display device and select `payload.txt`.
8. Select `300 ms` phase duration for the first acquisition, then work down the timing ladder.
9. Enter fullscreen matrix mode.

## Acquisition

The receiver detects the complete outer white square, smooths its four corners, and projectively
maps the inner 64×64 data matrix. The three-cell white margin and some of the black guard around it
must remain visible on all four sides. This remains true in fullscreen mode.

1. Hold the camera approximately 25–45 cm from the display.
2. Point the camera so the complete white square and a thin black surround are visible; exact
   alignment is not required.
3. Move and tilt the camera slowly. The overlay should follow the four frame corners.
4. A green tracked quadrilateral and increasing marker-lock count indicate successful acquisition.
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
| Phase-pilot errors dominate | Motion blur, rolling shutter, or a phase transition was captured | Increase phase duration or move farther from a PWM-limited display |
| Only phase A or phase B increases | Camera misses one temporal phase | Increase phase duration to 300 ms |
| Marker locks rise but valid frames remain zero | Sampling is unstable, blurred, or phase timing is mismatched | Move closer, slow the phase duration, and reduce camera motion |
| Valid frames rise but manifest remains zero | Manifest frames were missed | Continue holding steady; the sender repeats the manifest every 20 frames |
| Manifest locks but resolved count does not rise | Data frames fail CRC or session matching | Reduce glare, stabilize devices, and increase phase duration |
| Resolved count rises slowly | High optical erasure rate | Continue transmission; fountain repair symbols can still complete recovery |
| Cell contrast errors dominate | Exposure, focus, glare, or display PWM problem | Change distance/brightness and try a slower phase duration |

## Test ladder

Run tests in this order and stop at the first failure:

1. Existing 23-byte `payload.txt` at 300 ms, windowed.
2. Repeat the 23-byte file at 300 ms in fullscreen. The black guard must remain visible.
3. Repeat at 220, 150, and 100 ms; use the fastest duration that does not sharply raise errors.
4. A 1 KB text file at the chosen duration.
5. A 10 KB image or binary file at the chosen duration.
6. Try 67, 50, and 33 ms only as channel-limit probes; record actual camera FPS and errors.
7. Change distance and camera angle.
8. Repeat using Firefox after Chromium succeeds.

## Record after each attempt

- Sender device, browser, display brightness, and phase duration.
- Receiver device, browser, chosen camera, automatic/manual acquisition, and contrast threshold.
- Approximate distance and angle.
- Marker locks/failures.
- Tracked/missed frames and geometry pair rejects.
- Phase A/B observations.
- Valid/rejected pairs.
- Manifest/data frames.
- Resolved symbols and total symbols.
- Camera frame rate and average/maximum processing time.
- Detector runs versus reused tracks, plus the ranked top-error line.
- Whether the downloaded bytes matched the original.

These measurements determine whether the next work belongs in timing, marker detection, sampling,
or automatic homography.
