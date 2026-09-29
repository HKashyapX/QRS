import {
  FEC_CODEC,
  FRAME_TYPE,
  DISPLAY_GRID_SIZE,
  GRID_SIZE,
  QUIET_CELLS,
  LtDecoder,
  classifyOptical,
  decodeOpticalPair,
  parseManifest,
} from "./qrs-core.js?v=tail-motion-2";
import {
  OpticalTracker,
  OrderedPhasePairer,
  quadMotion,
  samplePerspectiveGrid,
} from "./acquisition.js?v=tail-motion-1";

const cameraButton = document.querySelector("#camera");
const stopButton = document.querySelector("#stop");
const video = document.querySelector("#video");
const canvas = document.querySelector("#preview");
const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
const status = document.querySelector("#status");
const progress = document.querySelector("#progress");
const sessionMetric = document.querySelector("#sessionMetric");
const frameMetric = document.querySelector("#frameMetric");
const confidenceMetric = document.querySelector("#confidenceMetric");
const download = document.querySelector("#download");
const facingModeInput = document.querySelector("#facingMode");
const roiSizeInput = document.querySelector("#roiSize");
const roiValue = document.querySelector("#roiValue");
const autoTrackInput = document.querySelector("#autoTrack");
const minimumContrastInput = document.querySelector("#minimumContrast");
const contrastValue = document.querySelector("#contrastValue");
const resetButton = document.querySelector("#reset");
const diagnosticsElement = document.querySelector("#diagnostics");
const copyDiagnosticsButton = document.querySelector("#copyDiagnostics");

export function opticalCellCenter(cell, roiSize) {
  return Math.floor((cell + QUIET_CELLS + 0.5) * (roiSize / DISPLAY_GRID_SIZE));
}

let stream = null;
let running = false;
let frameCallback = null;
let lastPresentedFrame = -1;
let lastDetectionAt = -Infinity;
let firstCameraFrameAt = 0;
let lastCameraFrameAt = 0;
let processingTotal = 0;
let processingMaximum = 0;
let lastDiagnosticsAt = -Infinity;
let cameraSettings = "not started";
let consecutiveMarkerFailures = 0;
const phasePairer = new OrderedPhasePairer();
let activeSession = null;
let manifest = null;
let decoder = null;
let validFrames = 0;
let downloadUrl = null;
let lastTrackedAt = -Infinity;
let lastMarkerLockAt = -Infinity;
let activeQuad = null;
const tracker = new OpticalTracker();
const sampledCells = new Uint8Array(GRID_SIZE * GRID_SIZE);
const counters = {
  sampled: 0,
  markerLocks: 0,
  markerFailures: 0,
  phaseA: 0,
  phaseB: 0,
  pairRejects: 0,
  manifests: 0,
  dataFrames: 0,
  uniqueSymbols: 0,
  duplicateSymbols: 0,
  systematicDataFrames: 0,
  repairDataFrames: 0,
  acquisitions: 0,
  acquisitionMisses: 0,
  geometryRejects: 0,
  orphanPhaseB: 0,
  duplicatePhaseB: 0,
  phasePairObservations: 0,
  phasePairRetries: 0,
  recoveredAfterRetry: 0,
  cameraFrames: 0,
  duplicateCallbacks: 0,
  detectionRuns: 0,
  reusedTracks: 0,
  captureTime: 0,
  detectionTime: 0,
  samplingTime: 0,
  classificationTime: 0,
  pairTime: 0,
  markerContrastTotal: 0,
  markerContrastMinimum: 255,
  acceptedWeakCells: 0,
  acceptedWeakCellsMaximum: 0,
};
const errorCounts = new Map();
let lastDiagnosticError = "none";
const DETECTION_INTERVAL_MS = 200;
const MARKER_FAILURES_BEFORE_REACQUIRE = 3;
const DIAGNOSTICS_INTERVAL_MS = 250;
const TRACK_LOCK_HOLD_MS = 500;
const MARKER_LOCK_HOLD_MS = 600;

function currentRoi() {
  const size = Number(roiSizeInput.value);
  return { size, x: (canvas.width - size) / 2, y: (canvas.height - size) / 2 };
}

function manualQuad() {
  const roi = currentRoi();
  return [
    { x: roi.x, y: roi.y },
    { x: roi.x + roi.size, y: roi.y },
    { x: roi.x + roi.size, y: roi.y + roi.size },
    { x: roi.x, y: roi.y + roi.size },
  ];
}

function drawVideoCover() {
  const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

function acquireGrid(now) {
  const captureStarted = performance.now();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  counters.captureTime += performance.now() - captureStarted;
  if (!autoTrackInput.checked) {
    const quad = manualQuad();
    const samplingStarted = performance.now();
    const cells = samplePerspectiveGrid(image, quad, GRID_SIZE, QUIET_CELLS, sampledCells);
    counters.samplingTime += performance.now() - samplingStarted;
    return { cells, quad, confidence: 1, stale: false };
  }
  let acquisition = tracker.current();
  if (!acquisition || now - lastDetectionAt >= DETECTION_INTERVAL_MS) {
    counters.detectionRuns += 1;
    lastDetectionAt = now;
    const detectionStarted = performance.now();
    acquisition = tracker.locate(image);
    counters.detectionTime += performance.now() - detectionStarted;
  } else {
    counters.reusedTracks += 1;
  }
  if (!acquisition) {
    counters.acquisitionMisses += 1;
    throw new Error("Optical frame not found");
  }
  counters.acquisitions += 1;
  const samplingStarted = performance.now();
  const cells = samplePerspectiveGrid(image, acquisition.quad, GRID_SIZE, QUIET_CELLS, sampledCells);
  counters.samplingTime += performance.now() - samplingStarted;
  return {
    ...acquisition,
    cells,
  };
}

function drawGuide(now = performance.now(), quad = null) {
  const guide = quad ?? manualQuad();
  const trackedRecently = autoTrackInput.checked && now - lastTrackedAt <= TRACK_LOCK_HOLD_MS;
  const decodedRecently = now - lastMarkerLockAt <= MARKER_LOCK_HOLD_MS;
  context.strokeStyle = trackedRecently ? "#6ee7b7" : "#fbbf24";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(guide[0].x, guide[0].y);
  for (let index = 1; index < guide.length; index += 1) context.lineTo(guide[index].x, guide[index].y);
  context.closePath();
  context.stroke();
  const top = Math.max(32, Math.min(...guide.map((point) => point.y)));
  context.fillStyle = "rgba(0,0,0,.62)";
  context.fillRect(0, top - 30, canvas.width, 26);
  context.fillStyle = "#ffffff";
  context.font = "600 15px system-ui";
  context.textAlign = "center";
  const message = autoTrackInput.checked
    ? (trackedRecently
      ? (decodedRecently ? "Frame tracked — decoding clean phases" : "Frame tracked — waiting for a clean phase")
      : "Show the complete white square and black surround")
    : "Manual fallback: align the outer white square inside this guide";
  context.fillText(message, canvas.width / 2, top - 11);
}

function acceptFrame(frame) {
  if (frame.type === FRAME_TYPE.MANIFEST) {
    counters.manifests += 1;
    const nextManifest = parseManifest(frame.payload);
    if (![FEC_CODEC.DETERMINISTIC_LT, FEC_CODEC.DENSE_LT_GF2].includes(nextManifest.fecCodec)) {
      throw new Error("Unsupported FEC codec");
    }
    if (activeSession !== frame.sessionId) {
      activeSession = frame.sessionId;
      manifest = nextManifest;
      decoder = new LtDecoder(manifest);
      progress.value = 0;
      sessionMetric.textContent = `${manifest.filename} · session ${activeSession.toString(16).slice(-8)}`;
      status.textContent = "Manifest locked. Collecting data symbols…";
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      download.hidden = true;
    }
    return;
  }
  if (frame.type !== FRAME_TYPE.DATA || frame.sessionId !== activeSession || !decoder) return;
  counters.dataFrames += 1;
  if (frame.symbolId < decoder.sourceSymbolCount) counters.systematicDataFrames += 1;
  else counters.repairDataFrames += 1;
  if (decoder.add(frame.symbolId, frame.payload)) counters.uniqueSymbols += 1;
  else counters.duplicateSymbols += 1;
  progress.value = decoder.sourceSymbolCount
    ? Math.min(100, (decoder.resolvedCount / decoder.sourceSymbolCount) * 100)
    : 100;
  if (!decoder.complete) {
    status.textContent = progress.value >= 90
      ? "Final recovery phase. Collecting the last missing source symbols and repair equations…"
      : "Receiving data symbols…";
  }
  if (decoder.complete && download.hidden) {
    const object = decoder.recover();
    downloadUrl = URL.createObjectURL(new Blob([object], { type: "application/octet-stream" }));
    download.href = downloadUrl;
    download.download = manifest.filename;
    download.hidden = false;
    status.textContent = "Transfer complete. Download the reconstructed file.";
    progress.value = 100;
  }
}

function processOpticalGrid(cells, acquisition) {
  counters.sampled += 1;
  const classificationStarted = performance.now();
  let classification;
  try {
    classification = classifyOptical(cells);
  } finally {
    counters.classificationTime += performance.now() - classificationStarted;
  }
  consecutiveMarkerFailures = 0;
  lastMarkerLockAt = performance.now();
  counters.markerLocks += 1;
  counters.markerContrastTotal += classification.contrast;
  counters.markerContrastMinimum = Math.min(counters.markerContrastMinimum, classification.contrast);
  confidenceMetric.textContent = `Marker errors ${classification.errors} · contrast ${classification.contrast}`;
  if (classification.inverted) counters.phaseB += 1;
  else counters.phaseA += 1;
  const pairing = phasePairer.push(classification, {
    quad: acquisition.quad,
    capturedAt: performance.now(),
  });
  if (pairing.status === "orphan") {
    counters.orphanPhaseB += 1;
    return false;
  }
  if (pairing.status === "duplicate") {
    counters.duplicatePhaseB += 1;
    return true;
  }
  if (!pairing.pairs.length) return true;
  counters.phasePairObservations += 1;
  if (pairing.attempt > 1) counters.phasePairRetries += 1;

  let lastError = null;
  let geometryCandidates = 0;
  const pairStarted = performance.now();
  for (const [phaseA, phaseB] of pairing.pairs) {
    if (quadMotion(phaseA.quad, phaseB.quad) > 0.055) continue;
    geometryCandidates += 1;
    try {
      const frame = decodeOpticalPair(phaseA.classification, phaseB.classification, Number(minimumContrastInput.value));
      counters.acceptedWeakCells += frame.opticalWeakCells;
      counters.acceptedWeakCellsMaximum = Math.max(counters.acceptedWeakCellsMaximum, frame.opticalWeakCells);
      acceptFrame(frame);
      phasePairer.complete();
      validFrames += 1;
      if (pairing.attempt > 1) counters.recoveredAfterRetry += 1;
      frameMetric.textContent = `${validFrames} valid frames`;
      lastDiagnosticError = "none";
      counters.pairTime += performance.now() - pairStarted;
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!geometryCandidates) {
    counters.pairTime += performance.now() - pairStarted;
    counters.geometryRejects += 1;
    lastDiagnosticError = "Camera moved between differential phases";
    return false;
  }
  counters.pairRejects += 1;
  counters.pairTime += performance.now() - pairStarted;
  recordError(lastError ?? new Error("Optical pair could not be decoded"));
  return false;
}

function updateDiagnostics(force = false) {
  const diagnosticsNow = performance.now();
  if (!force && diagnosticsNow - lastDiagnosticsAt < DIAGNOSTICS_INTERVAL_MS) return;
  lastDiagnosticsAt = diagnosticsNow;
  const elapsedSeconds = Math.max(0.001, (lastCameraFrameAt - firstCameraFrameAt) / 1000);
  const observedFps = counters.cameraFrames > 1 ? (counters.cameraFrames - 1) / elapsedSeconds : 0;
  const averageProcessing = counters.cameraFrames ? processingTotal / counters.cameraFrames : 0;
  const validRate = validFrames / elapsedSeconds;
  const resolvedBytes = decoder && manifest
    ? Math.min(manifest.objectSize, decoder.resolvedCount * manifest.symbolSize)
    : 0;
  const commonErrors = [...errorCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([message, count]) => `${count}× ${message}`)
    .join(" | ") || "none";
  diagnosticsElement.textContent = [
    `camera frames/rate: ${counters.cameraFrames} / ${observedFps.toFixed(1)} fps`,
    `camera settings: ${cameraSettings}`,
    `duplicate camera callbacks: ${counters.duplicateCallbacks}`,
    `processing avg/max: ${averageProcessing.toFixed(1)} / ${processingMaximum.toFixed(1)} ms`,
    `processing load: ${observedFps ? (averageProcessing * observedFps).toFixed(0) : 0} ms/s`,
    `hot path avg capture/detect/sample/classify/pair: ${[
      counters.cameraFrames ? counters.captureTime / counters.cameraFrames : 0,
      counters.detectionRuns ? counters.detectionTime / counters.detectionRuns : 0,
      counters.sampled ? counters.samplingTime / counters.sampled : 0,
      counters.sampled ? counters.classificationTime / counters.sampled : 0,
      counters.phasePairObservations ? counters.pairTime / counters.phasePairObservations : 0,
    ].map((value) => value.toFixed(1)).join("/")} ms`,
    `sampled grids: ${counters.sampled}`,
    `marker locks/failures: ${counters.markerLocks}/${counters.markerFailures}`,
    `marker contrast avg/min: ${counters.markerLocks
      ? `${(counters.markerContrastTotal / counters.markerLocks).toFixed(1)}/${counters.markerContrastMinimum}`
      : "0/0"}`,
    `phase A/B observations: ${counters.phaseA}/${counters.phaseB}`,
    `valid/rejected pairs: ${validFrames}/${counters.pairRejects} (${validRate.toFixed(2)} valid/s)`,
    `pair observations/retries/recovered: ${counters.phasePairObservations}/${counters.phasePairRetries}/${counters.recoveredAfterRetry}`,
    `accepted weak cells avg/max: ${validFrames
      ? `${(counters.acceptedWeakCells / validFrames).toFixed(1)}/${counters.acceptedWeakCellsMaximum}`
      : "0/0"}`,
    `manifest/data frames: ${counters.manifests}/${counters.dataFrames}`,
    `accepted source/repair frames: ${counters.systematicDataFrames}/${counters.repairDataFrames}`,
    `unique/duplicate data symbols: ${counters.uniqueSymbols}/${counters.duplicateSymbols}`,
    `resolved symbols: ${decoder ? `${decoder.resolvedCount}/${decoder.sourceSymbolCount}` : "0/0"}`,
    `estimated resolved goodput: ${(resolvedBytes / elapsedSeconds).toFixed(1)} bytes/s`,
    `acquisition: ${autoTrackInput.checked ? "automatic" : `manual ${roiSizeInput.value}px`}`,
    `tracked/missed frames: ${counters.acquisitions}/${counters.acquisitionMisses}`,
    `detections/reused tracks: ${counters.detectionRuns}/${counters.reusedTracks}`,
    `geometry pair rejects: ${counters.geometryRejects}`,
    `orphan/duplicate phase B: ${counters.orphanPhaseB}/${counters.duplicatePhaseB}`,
    `minimum contrast: ${minimumContrastInput.value}`,
    `last pair error: ${lastDiagnosticError}`,
    `top errors: ${commonErrors}`,
  ].join("\n");
}

function recordError(error) {
  const message = error instanceof Error ? error.message : String(error);
  lastDiagnosticError = message;
  errorCounts.set(message, (errorCounts.get(message) ?? 0) + 1);
}

function scheduleVideoFrame() {
  if (!running) return;
  if (typeof video.requestVideoFrameCallback === "function") {
    frameCallback = video.requestVideoFrameCallback(processVideoFrame);
  } else {
    frameCallback = requestAnimationFrame((now) => processVideoFrame(now, {}));
  }
}

function processVideoFrame(now, metadata) {
  if (!running) return;
  if (metadata.presentedFrames !== undefined && metadata.presentedFrames === lastPresentedFrame) {
    counters.duplicateCallbacks += 1;
    scheduleVideoFrame();
    return;
  }
  if (metadata.presentedFrames !== undefined) lastPresentedFrame = metadata.presentedFrames;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    const processingStart = performance.now();
    counters.cameraFrames += 1;
    if (!firstCameraFrameAt) firstCameraFrameAt = now;
    lastCameraFrameAt = now;
    drawVideoCover();
    try {
      const acquisition = acquireGrid(now);
      activeQuad = acquisition.quad;
      lastTrackedAt = now;
      processOpticalGrid(acquisition.cells, acquisition);
    } catch (error) {
      counters.markerFailures += 1;
      consecutiveMarkerFailures += 1;
      recordError(error);
      confidenceMetric.textContent = now - lastTrackedAt <= TRACK_LOCK_HOLD_MS
        ? "Frame tracked · waiting for clean phase"
        : "No optical frame lock";
      if (/frame not found/i.test(lastDiagnosticError)
        || consecutiveMarkerFailures >= MARKER_FAILURES_BEFORE_REACQUIRE) {
        lastDetectionAt = -Infinity;
        consecutiveMarkerFailures = 0;
      }
    }
    drawGuide(now, activeQuad);
    const processingTime = performance.now() - processingStart;
    processingTotal += processingTime;
    processingMaximum = Math.max(processingMaximum, processingTime);
    updateDiagnostics();
  }
  scheduleVideoFrame();
}

cameraButton.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingModeInput.value }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    cameraSettings = `${settings.width ?? video.videoWidth}×${settings.height ?? video.videoHeight}`
      + `${settings.frameRate ? ` @ ${settings.frameRate} fps` : ""}`
      + `${settings.facingMode ? ` · ${settings.facingMode}` : ""}`;
    running = true;
    cameraButton.disabled = true;
    stopButton.disabled = false;
    status.textContent = "Camera active. Keep the complete white square and some black surround visible; tracking handles perspective and hand movement.";
    scheduleVideoFrame();
  } catch (error) {
    status.textContent = `Camera could not start: ${error.message}`;
  }
});

function resetTransfer() {
  phasePairer.reset();
  activeSession = null;
  manifest = null;
  decoder = null;
  validFrames = 0;
  lastTrackedAt = -Infinity;
  lastMarkerLockAt = -Infinity;
  activeQuad = null;
  tracker.reset();
  errorCounts.clear();
  lastPresentedFrame = -1;
  lastDetectionAt = -Infinity;
  firstCameraFrameAt = 0;
  lastCameraFrameAt = 0;
  processingTotal = 0;
  processingMaximum = 0;
  lastDiagnosticsAt = -Infinity;
  consecutiveMarkerFailures = 0;
  Object.keys(counters).forEach((key) => { counters[key] = 0; });
  counters.markerContrastMinimum = 255;
  lastDiagnosticError = "none";
  progress.value = 0;
  sessionMetric.textContent = "Waiting for manifest";
  frameMetric.textContent = "0 valid frames";
  confidenceMetric.textContent = "No lock";
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  download.hidden = true;
  status.textContent = running
    ? "Transfer state reset. Keep the matrix aligned to acquire a new manifest."
    : "Transfer state reset. Start the camera when ready.";
  updateDiagnostics(true);
}

resetButton.addEventListener("click", resetTransfer);
copyDiagnosticsButton.addEventListener("click", async () => {
  updateDiagnostics(true);
  const report = [
    "QRS v0.1.4 tail-motion diagnostics",
    `captured: ${new Date().toISOString()}`,
    `browser: ${navigator.userAgent}`,
    diagnosticsElement.textContent,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(report);
    copyDiagnosticsButton.textContent = "Copied";
    window.setTimeout(() => { copyDiagnosticsButton.textContent = "Copy diagnostics"; }, 1600);
  } catch (error) {
    status.textContent = `Could not copy diagnostics: ${error.message}`;
  }
});
roiSizeInput.addEventListener("input", () => {
  roiValue.textContent = `${roiSizeInput.value} px`;
  phasePairer.reset();
});
autoTrackInput.addEventListener("change", () => {
  roiSizeInput.disabled = autoTrackInput.checked;
  tracker.reset();
  activeQuad = null;
  phasePairer.reset();
  status.textContent = autoTrackInput.checked
    ? "Automatic tracking enabled. Keep the complete white square and black surround in view."
    : "Manual fallback enabled. Align the outer white square inside the guide.";
});
minimumContrastInput.addEventListener("input", () => {
  contrastValue.textContent = minimumContrastInput.value;
});

stopButton.addEventListener("click", () => {
  running = false;
  if (frameCallback !== null) {
    if (typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(frameCallback);
    else cancelAnimationFrame(frameCallback);
  }
  frameCallback = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  cameraButton.disabled = false;
  stopButton.disabled = true;
  status.textContent = "Camera stopped.";
});

context.fillStyle = "#020807";
context.fillRect(0, 0, canvas.width, canvas.height);
drawGuide();
updateDiagnostics(true);
