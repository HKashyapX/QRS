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
} from "./qrs-core.js?v=optical-envelope-1";
import {
  OpticalTracker,
  OrderedPhasePairer,
  quadMotion,
  samplePerspectiveGrid,
} from "./acquisition.js?v=optical-envelope-1";

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
const phasePairer = new OrderedPhasePairer();
let activeSession = null;
let manifest = null;
let decoder = null;
let validFrames = 0;
let downloadUrl = null;
let markerLocked = false;
let activeQuad = null;
const tracker = new OpticalTracker();
const counters = {
  sampled: 0,
  markerLocks: 0,
  markerFailures: 0,
  phaseA: 0,
  phaseB: 0,
  pairRejects: 0,
  manifests: 0,
  dataFrames: 0,
  acquisitions: 0,
  acquisitionMisses: 0,
  geometryRejects: 0,
  orphanPhaseB: 0,
  cameraFrames: 0,
  duplicateCallbacks: 0,
  detectionRuns: 0,
  reusedTracks: 0,
};
const errorCounts = new Map();
let lastDiagnosticError = "none";
const DETECTION_INTERVAL_MS = 100;

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
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  if (!autoTrackInput.checked) {
    const quad = manualQuad();
    return { cells: samplePerspectiveGrid(image, quad, GRID_SIZE, QUIET_CELLS), quad, confidence: 1, stale: false };
  }
  let acquisition = tracker.current();
  if (!acquisition || now - lastDetectionAt >= DETECTION_INTERVAL_MS) {
    counters.detectionRuns += 1;
    lastDetectionAt = now;
    acquisition = tracker.locate(image);
  } else {
    counters.reusedTracks += 1;
  }
  if (!acquisition) {
    counters.acquisitionMisses += 1;
    throw new Error("Optical frame not found");
  }
  counters.acquisitions += 1;
  return {
    ...acquisition,
    cells: samplePerspectiveGrid(image, acquisition.quad, GRID_SIZE, QUIET_CELLS),
  };
}

function drawGuide(locked = false, quad = null) {
  const guide = quad ?? manualQuad();
  context.strokeStyle = locked ? "#6ee7b7" : "#fbbf24";
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
    ? (quad ? "Optical frame tracked — normal hand movement is okay" : "Show the complete white square and black surround")
    : "Manual fallback: align the outer white square inside this guide";
  context.fillText(message, canvas.width / 2, top - 11);
}

function acceptFrame(frame) {
  if (frame.type === FRAME_TYPE.MANIFEST) {
    counters.manifests += 1;
    const nextManifest = parseManifest(frame.payload);
    if (nextManifest.fecCodec !== FEC_CODEC.DETERMINISTIC_LT) throw new Error("Unsupported FEC codec");
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
  decoder.add(frame.symbolId, frame.payload);
  progress.value = decoder.sourceSymbolCount
    ? Math.min(100, (decoder.resolvedCount / decoder.sourceSymbolCount) * 100)
    : 100;
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
  const classification = classifyOptical(cells);
  markerLocked = true;
  counters.markerLocks += 1;
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
  if (!pairing.pair) return true;
  const [phaseA, phaseB] = pairing.pair;

  if (quadMotion(phaseA.quad, phaseB.quad) > 0.055) {
    counters.geometryRejects += 1;
    lastDiagnosticError = "Camera moved between differential phases";
    return false;
  }

  try {
    const frame = decodeOpticalPair(phaseA.classification, phaseB.classification, Number(minimumContrastInput.value));
    acceptFrame(frame);
    validFrames += 1;
    frameMetric.textContent = `${validFrames} valid frames`;
    lastDiagnosticError = "none";
  } catch (error) {
    counters.pairRejects += 1;
    recordError(error);
  }
  return true;
}

function updateDiagnostics() {
  const elapsedSeconds = Math.max(0.001, (lastCameraFrameAt - firstCameraFrameAt) / 1000);
  const observedFps = counters.cameraFrames > 1 ? (counters.cameraFrames - 1) / elapsedSeconds : 0;
  const averageProcessing = counters.cameraFrames ? processingTotal / counters.cameraFrames : 0;
  const commonErrors = [...errorCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([message, count]) => `${count}× ${message}`)
    .join(" | ") || "none";
  diagnosticsElement.textContent = [
    `camera frames/rate: ${counters.cameraFrames} / ${observedFps.toFixed(1)} fps`,
    `duplicate camera callbacks: ${counters.duplicateCallbacks}`,
    `processing avg/max: ${averageProcessing.toFixed(1)} / ${processingMaximum.toFixed(1)} ms`,
    `sampled grids: ${counters.sampled}`,
    `marker locks/failures: ${counters.markerLocks}/${counters.markerFailures}`,
    `phase A/B observations: ${counters.phaseA}/${counters.phaseB}`,
    `valid/rejected pairs: ${validFrames}/${counters.pairRejects}`,
    `manifest/data frames: ${counters.manifests}/${counters.dataFrames}`,
    `resolved symbols: ${decoder ? `${decoder.resolvedCount}/${decoder.sourceSymbolCount}` : "0/0"}`,
    `acquisition: ${autoTrackInput.checked ? "automatic" : `manual ${roiSizeInput.value}px`}`,
    `tracked/missed frames: ${counters.acquisitions}/${counters.acquisitionMisses}`,
    `detections/reused tracks: ${counters.detectionRuns}/${counters.reusedTracks}`,
    `geometry pair rejects: ${counters.geometryRejects}`,
    `orphan phase B drops: ${counters.orphanPhaseB}`,
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
      processOpticalGrid(acquisition.cells, acquisition);
    } catch (error) {
      markerLocked = false;
      counters.markerFailures += 1;
      recordError(error);
      confidenceMetric.textContent = "No marker lock";
      // A bad classification often means the geometry drifted. Re-run the
      // detector on the next camera frame instead of trusting the stale quad.
      if (/orientation|frame not found/i.test(lastDiagnosticError)) lastDetectionAt = -Infinity;
    }
    drawGuide(markerLocked, activeQuad);
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
  markerLocked = false;
  activeQuad = null;
  tracker.reset();
  errorCounts.clear();
  lastPresentedFrame = -1;
  lastDetectionAt = -Infinity;
  firstCameraFrameAt = 0;
  lastCameraFrameAt = 0;
  processingTotal = 0;
  processingMaximum = 0;
  Object.keys(counters).forEach((key) => { counters[key] = 0; });
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
  updateDiagnostics();
}

resetButton.addEventListener("click", resetTransfer);
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
drawGuide(false);
updateDiagnostics();
