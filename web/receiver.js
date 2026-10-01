import {
  FEC_CODEC,
  FRAME_TYPE,
  DISPLAY_GRID_SIZE,
  GRID_SIZE,
  QUIET_CELLS,
  LaneFrameRouter,
  LtDecoder,
  classifyOptical,
  decodeOpticalPair,
  parseManifest,
} from "./qrs-core.js?v=multilane-foundations-2";
import {
  OpticalLane,
  OpticalTracker,
  previewPointToVideoPoint,
  quadCellSize,
  quadMotion,
} from "./acquisition.js?v=multilane-foundations-2";

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
const focusMetric = document.querySelector("#focusMetric");
const download = document.querySelector("#download");
const facingModeInput = document.querySelector("#facingMode");
const cameraFrameRateInput = document.querySelector("#cameraFrameRate");
const roiSizeInput = document.querySelector("#roiSize");
const roiValue = document.querySelector("#roiValue");
const autoTrackInput = document.querySelector("#autoTrack");
const minimumContrastInput = document.querySelector("#minimumContrast");
const contrastValue = document.querySelector("#contrastValue");
const resetButton = document.querySelector("#reset");
const diagnosticsElement = document.querySelector("#diagnostics");
const transferDiagnosticsElement = document.querySelector("#transferDiagnostics");
const opticalDiagnosticsElement = document.querySelector("#opticalDiagnostics");
const cameraDiagnosticsElement = document.querySelector("#cameraDiagnostics");
const copyDiagnosticsButton = document.querySelector("#copyDiagnostics");

export function opticalCellCenter(cell, roiSize) {
  return Math.floor((cell + QUIET_CELLS + 0.5) * (roiSize / DISPLAY_GRID_SIZE));
}

let stream = null;
let cameraTrack = null;
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
let requestedCameraFrameRate = 30;
let cameraFrameRateCapability = "unknown";
let transferStartedAt = 0;
let transferCompletedAt = 0;
let consecutiveMarkerFailures = 0;
const frameRouter = new LaneFrameRouter();
const opticalLanes = [new OpticalLane({ laneId: 0 })];
const singleLane = opticalLanes[0];
let activeSession = null;
let manifest = null;
let decoder = null;
let validFrames = 0;
let downloadUrl = null;
let lastTrackedAt = -Infinity;
let lastMarkerLockAt = -Infinity;
let activeQuad = null;
let focusModes = [];
let pointFocusSupported = false;
let pointConstraintUnderstood = false;
let focusState = "not started";
let focusIndicator = null;
let focusIndicatorUntil = -Infinity;
let automaticFocusRequested = false;
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
  modulePixelsTotal: 0,
  modulePixelsMinimum: Infinity,
  modulePixelsMaximum: 0,
  focusRequests: 0,
  focusSuccesses: 0,
  focusFailures: 0,
};
const errorCounts = new Map();
let lastDiagnosticError = "none";
const DETECTION_INTERVAL_MS = 200;
const MARKER_FAILURES_BEFORE_REACQUIRE = 3;
const DIAGNOSTICS_INTERVAL_MS = 250;
const TRACK_LOCK_HOLD_MS = 500;
const MARKER_LOCK_HOLD_MS = 600;
const FOCUS_INDICATOR_MS = 900;

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

function captureCameraImage() {
  const captureStarted = performance.now();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  counters.captureTime += performance.now() - captureStarted;
  return image;
}

function acquireEnvelope(image, now) {
  if (!autoTrackInput.checked) {
    return { quad: manualQuad(), confidence: 1, stale: false };
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
  return acquisition;
}

function sampleLane(image, acquisition, lane) {
  const samplingStarted = performance.now();
  const cells = lane.sample(image, acquisition.quad, GRID_SIZE, QUIET_CELLS);
  counters.samplingTime += performance.now() - samplingStarted;
  return cells;
}

function acquireGrid(now, lane = singleLane) {
  const image = captureCameraImage();
  const acquisition = acquireEnvelope(image, now);
  return { ...acquisition, cells: sampleLane(image, acquisition, lane), lane };
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
  if (focusIndicator && now <= focusIndicatorUntil) {
    context.strokeStyle = "#60a5fa";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(focusIndicator.x, focusIndicator.y, 24, 0, Math.PI * 2);
    context.moveTo(focusIndicator.x - 32, focusIndicator.y);
    context.lineTo(focusIndicator.x - 16, focusIndicator.y);
    context.moveTo(focusIndicator.x + 16, focusIndicator.y);
    context.lineTo(focusIndicator.x + 32, focusIndicator.y);
    context.moveTo(focusIndicator.x, focusIndicator.y - 32);
    context.lineTo(focusIndicator.x, focusIndicator.y - 16);
    context.moveTo(focusIndicator.x, focusIndicator.y + 16);
    context.lineTo(focusIndicator.x, focusIndicator.y + 32);
    context.stroke();
  }
}

function quadCentre(quad) {
  return quad.reduce((centre, point) => ({
    x: centre.x + point.x / quad.length,
    y: centre.y + point.y / quad.length,
  }), { x: 0, y: 0 });
}

function focusConstraint(mode, point = null) {
  const constraint = {};
  if (mode) constraint.focusMode = mode;
  if (point && pointFocusSupported) constraint.pointsOfInterest = [point];
  return constraint;
}

async function applyFocusConstraint(constraint) {
  if (!cameraTrack || !Object.keys(constraint).length) return false;
  const current = { ...(cameraTrack.getConstraints?.() ?? {}) };
  delete current.advanced;
  // Focus is an optical hint, not a hard stream requirement. Keeping these
  // constraints non-exact prevents a rejected focus point from stopping an
  // otherwise usable camera track.
  if (constraint.focusMode) current.focusMode = constraint.focusMode;
  if (constraint.pointsOfInterest) {
    current.pointsOfInterest = constraint.pointsOfInterest;
  }
  await cameraTrack.applyConstraints(current);
  return true;
}

async function configureCameraFocus() {
  const capabilities = cameraTrack?.getCapabilities?.() ?? {};
  const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  pointConstraintUnderstood = Boolean(supported.pointsOfInterest);
  // getSupportedConstraints() is browser-wide. Only getCapabilities() tells us
  // whether this selected camera track can actually accept a focus point.
  pointFocusSupported = capabilities.pointsOfInterest === true;
  if (focusModes.includes("continuous")) {
    try {
      await applyFocusConstraint(focusConstraint("continuous"));
      focusState = "continuous";
    } catch (error) {
      focusState = `browser-managed (${error.name ?? "constraint error"})`;
    }
  } else {
    focusState = focusModes.length ? focusModes.join(",") : "browser-managed";
  }
  focusMetric.textContent = pointFocusSupported
    ? "Focus: tap the matrix"
    : "Focus: camera automatic";
}

async function focusCameraAt(canvasPoint) {
  if (!running || !cameraTrack) return;
  const mode = focusModes.includes("single-shot")
    ? "single-shot"
    : (focusModes.includes("continuous") ? "continuous" : null);
  if (!pointFocusSupported && !mode) {
    focusState = focusModes.length
      ? `browser-managed (${focusModes.join(",")})`
      : "browser-managed";
    focusMetric.textContent = "Focus: camera automatic";
    updateDiagnostics(true);
    return;
  }
  counters.focusRequests += 1;
  focusIndicator = canvasPoint;
  focusIndicatorUntil = performance.now() + FOCUS_INDICATOR_MS;
  const point = previewPointToVideoPoint(canvasPoint, {
    width: canvas.width,
    height: canvas.height,
  }, {
    width: video.videoWidth,
    height: video.videoHeight,
  });
  const requested = focusConstraint(mode, point);
  try {
    if (!await applyFocusConstraint(requested)) throw new Error("Camera exposes no focus controls");
    counters.focusSuccesses += 1;
    focusState = `${mode ?? "3A"} @ ${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    focusMetric.textContent = "Focus: point accepted";
  } catch (pointError) {
    try {
      if (!mode || !await applyFocusConstraint(focusConstraint(mode))) throw pointError;
      counters.focusSuccesses += 1;
      focusState = `${mode} (centre fallback)`;
      focusMetric.textContent = "Focus: centre sweep";
    } catch (error) {
      counters.focusFailures += 1;
      const failedConstraint = error.constraint ? `: ${error.constraint}` : "";
      focusState = `unavailable (${error.name ?? error.message}${failedConstraint})`;
      focusMetric.textContent = "Focus: browser did not expose control";
    }
  }
  updateDiagnostics(true);
}

function acceptFrame(frame) {
  if (frame.type === FRAME_TYPE.MANIFEST) {
    const nextManifest = parseManifest(frame.payload);
    if (![FEC_CODEC.DETERMINISTIC_LT, FEC_CODEC.DENSE_LT_GF2].includes(nextManifest.fecCodec)) {
      throw new Error("Unsupported FEC codec");
    }
    const route = frameRouter.accept(frame);
    if (!route.accepted) return;
    counters.manifests += 1;
    if (route.newSession) {
      activeSession = frame.sessionId;
      manifest = nextManifest;
      decoder = new LtDecoder(manifest);
      transferStartedAt = performance.now();
      transferCompletedAt = 0;
      progress.value = 0;
      sessionMetric.textContent = `${manifest.filename} · session ${activeSession.toString(16).slice(-8)}`;
      status.textContent = "Manifest locked. Collecting data symbols…";
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      download.hidden = true;
    }
    return;
  }
  if (frame.type !== FRAME_TYPE.DATA || !decoder) return;
  const route = frameRouter.accept(frame);
  if (!route.accepted) return;
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
    transferCompletedAt = performance.now();
    status.textContent = "Transfer complete. Download the reconstructed file.";
    progress.value = 100;
  }
}

function processOpticalGrid(lane, cells, acquisition) {
  counters.sampled += 1;
  const modulePixels = quadCellSize(acquisition.quad, DISPLAY_GRID_SIZE);
  counters.modulePixelsTotal += modulePixels;
  counters.modulePixelsMinimum = Math.min(counters.modulePixelsMinimum, modulePixels);
  counters.modulePixelsMaximum = Math.max(counters.modulePixelsMaximum, modulePixels);
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
  const pairing = lane.pairer.push(classification, {
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
      lane.pairer.complete();
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
  const markerLockRate = counters.sampled ? counters.markerLocks / counters.sampled : 0;
  const resolvedBytes = decoder && manifest
    ? Math.min(manifest.objectSize, decoder.resolvedCount * manifest.symbolSize)
    : 0;
  const transferElapsedSeconds = transferStartedAt
    ? Math.max(0.001, ((transferCompletedAt || diagnosticsNow) - transferStartedAt) / 1000)
    : 0;
  const transferGoodput = transferElapsedSeconds ? resolvedBytes / transferElapsedSeconds : 0;
  const remainingBytes = manifest ? Math.max(0, manifest.objectSize - resolvedBytes) : 0;
  const estimatedRemaining = transferGoodput > 0 && !transferCompletedAt
    ? formatDuration(remainingBytes / transferGoodput)
    : (transferCompletedAt ? "complete" : "unknown");
  const observedPairs = validFrames + counters.pairRejects;
  const pairAcceptance = observedPairs ? validFrames / observedPairs : 0;
  const duplicateRate = counters.dataFrames ? counters.duplicateSymbols / counters.dataFrames : 0;
  const commonErrors = [...errorCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([message, count]) => `${count}× ${message}`)
    .join(" | ") || "none";
  const laneSnapshot = frameRouter.snapshot();
  const opticalBottleneck = counters.sampled < 30
    ? "collecting evidence"
    : (markerLockRate < 0.2
      ? "orientation sampling/focus"
      : (validRate < 0.5 ? "phase pairing/cell contrast" : "transport recovery"));
  const transferLines = [
    `file: ${manifest ? `${manifest.filename} · ${manifest.objectSize.toLocaleString()} bytes` : "waiting for manifest"}`,
    `state: ${transferCompletedAt ? "complete" : (manifest ? "receiving" : "waiting")}`,
    `transfer time: ${transferStartedAt ? formatDuration(transferElapsedSeconds) : "not started"}`,
    `rough remaining time: ${estimatedRemaining}`,
    `progress: ${decoder ? `${progress.value.toFixed(1)}% · ${decoder.resolvedCount}/${decoder.sourceSymbolCount} symbols` : "0.0%"}`,
    `resolved bytes/goodput: ${resolvedBytes.toLocaleString()} / ${transferGoodput.toFixed(1)} bytes/s`,
    `valid/rejected pairs: ${validFrames}/${counters.pairRejects} (${(pairAcceptance * 100).toFixed(1)}% accepted · ${validRate.toFixed(2)} valid/s)`,
    `manifest/data frames: ${counters.manifests}/${counters.dataFrames}`,
    `unique/duplicate data symbols: ${counters.uniqueSymbols}/${counters.duplicateSymbols} (${(duplicateRate * 100).toFixed(1)}% duplicate)`,
    `accepted source/repair frames: ${counters.systematicDataFrames}/${counters.repairDataFrames}`,
    `optical bottleneck: ${opticalBottleneck}`,
  ];
  const cameraLines = [
    `camera frames/rate: ${counters.cameraFrames} / ${observedFps.toFixed(1)} fps`,
    `camera fps requested/granted: ${requestedCameraFrameRate} / ${cameraTrack?.getSettings?.()?.frameRate ?? "unknown"}`,
    `camera fps capability: ${cameraFrameRateCapability}`,
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
    `focus modes/point support: ${focusModes.join(",") || "none"}/${pointFocusSupported ? "track yes" : `track no (browser ${pointConstraintUnderstood ? "yes" : "no"})`}`,
    `focus requests/successes/failures: ${counters.focusRequests}/${counters.focusSuccesses}/${counters.focusFailures}`,
    `focus state: ${focusState}`,
  ];
  const opticalLines = [
    `sampled grids: ${counters.sampled}`,
    `marker locks/failures: ${counters.markerLocks}/${counters.markerFailures}`,
    `marker lock rate: ${(markerLockRate * 100).toFixed(1)}%`,
    `marker contrast avg/min: ${counters.markerLocks
      ? `${(counters.markerContrastTotal / counters.markerLocks).toFixed(1)}/${counters.markerContrastMinimum}`
      : "0/0"}`,
    `tracked camera pixels/cell avg/min/max: ${counters.sampled
      ? `${(counters.modulePixelsTotal / counters.sampled).toFixed(1)}/${counters.modulePixelsMinimum.toFixed(1)}/${counters.modulePixelsMaximum.toFixed(1)}`
      : "0/0/0"}`,
    `phase A/B observations: ${counters.phaseA}/${counters.phaseB}`,
    `valid/rejected pairs: ${validFrames}/${counters.pairRejects} (${validRate.toFixed(2)} valid/s)`,
    `pair observations/retries/recovered: ${counters.phasePairObservations}/${counters.phasePairRetries}/${counters.recoveredAfterRetry}`,
    `accepted weak cells avg/max: ${validFrames
      ? `${(counters.acceptedWeakCells / validFrames).toFixed(1)}/${counters.acceptedWeakCellsMaximum}`
      : "0/0"}`,
    `optical lanes configured/active: ${opticalLanes.length}/${laneSnapshot.laneCount || 1}`,
    `routed frames by lane: ${laneSnapshot.framesByLane.join("/") || "0"}`,
    `acquisition: ${autoTrackInput.checked ? "automatic" : `manual ${roiSizeInput.value}px`}`,
    `tracked/missed frames: ${counters.acquisitions}/${counters.acquisitionMisses}`,
    `detections/reused tracks: ${counters.detectionRuns}/${counters.reusedTracks}`,
    `geometry pair rejects: ${counters.geometryRejects}`,
    `orphan/duplicate phase B: ${counters.orphanPhaseB}/${counters.duplicatePhaseB}`,
    `minimum contrast: ${minimumContrastInput.value}`,
    `optical bottleneck: ${opticalBottleneck}`,
    `last pair error: ${lastDiagnosticError}`,
    `top errors: ${commonErrors}`,
  ];
  transferDiagnosticsElement.textContent = transferLines.join("\n");
  opticalDiagnosticsElement.textContent = opticalLines.join("\n");
  cameraDiagnosticsElement.textContent = cameraLines.join("\n");
  diagnosticsElement.textContent = [
    "TRANSFER DETAILS", ...transferLines,
    "", "OPTICAL QUALITY", ...opticalLines,
    "", "CAMERA PERFORMANCE", ...cameraLines,
  ].join("\n");
}

function formatDuration(seconds) {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return minutes ? `${minutes}m ${remainder.toString().padStart(2, "0")}s` : `${remainder}s`;
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
      if (!automaticFocusRequested) {
        automaticFocusRequested = true;
        void focusCameraAt(quadCentre(acquisition.quad));
      }
      processOpticalGrid(acquisition.lane, acquisition.cells, acquisition);
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
    requestedCameraFrameRate = Number(cameraFrameRateInput.value);
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingModeInput.value },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: requestedCameraFrameRate },
        advanced: [{ focusMode: "continuous" }],
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    [cameraTrack] = stream.getVideoTracks();
    const capabilities = cameraTrack?.getCapabilities?.() ?? {};
    cameraFrameRateCapability = capabilities.frameRate
      ? `${capabilities.frameRate.min ?? "?"}-${capabilities.frameRate.max ?? "?"} fps`
      : "not exposed";
    await configureCameraFocus();
    const settings = cameraTrack?.getSettings?.() ?? {};
    cameraSettings = `${settings.width ?? video.videoWidth}×${settings.height ?? video.videoHeight}`
      + `${settings.frameRate ? ` @ ${settings.frameRate} fps` : ""}`
      + `${settings.facingMode ? ` · ${settings.facingMode}` : ""}`
      + `${settings.focusMode ? ` · focus ${settings.focusMode}` : ""}`;
    running = true;
    cameraButton.disabled = true;
    facingModeInput.disabled = true;
    cameraFrameRateInput.disabled = true;
    stopButton.disabled = false;
    status.textContent = `Camera active at ${settings.frameRate ?? "unknown"} FPS (${requestedCameraFrameRate} requested). Keep the complete white square and some black surround visible.`;
    scheduleVideoFrame();
  } catch (error) {
    status.textContent = `Camera could not start: ${error.message}`;
  }
});

function resetTransfer() {
  opticalLanes.forEach((lane) => lane.reset());
  frameRouter.reset();
  activeSession = null;
  manifest = null;
  decoder = null;
  validFrames = 0;
  lastTrackedAt = -Infinity;
  lastMarkerLockAt = -Infinity;
  activeQuad = null;
  focusIndicator = null;
  focusIndicatorUntil = -Infinity;
  automaticFocusRequested = false;
  tracker.reset();
  errorCounts.clear();
  lastPresentedFrame = -1;
  lastDetectionAt = -Infinity;
  firstCameraFrameAt = 0;
  lastCameraFrameAt = 0;
  processingTotal = 0;
  processingMaximum = 0;
  transferStartedAt = 0;
  transferCompletedAt = 0;
  lastDiagnosticsAt = -Infinity;
  consecutiveMarkerFailures = 0;
  Object.keys(counters).forEach((key) => { counters[key] = 0; });
  counters.markerContrastMinimum = 255;
  counters.modulePixelsMinimum = Infinity;
  lastDiagnosticError = "none";
  progress.value = 0;
  sessionMetric.textContent = "Waiting for manifest";
  frameMetric.textContent = "0 valid frames";
  confidenceMetric.textContent = "No lock";
  focusMetric.textContent = running ? "Focus: tap the matrix" : "Focus: not started";
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
    "QRS v0.1.6 multi-lane-foundations diagnostics",
    `captured: ${new Date().toISOString()}`,
    `browser: ${navigator.userAgent}`,
    diagnosticsElement.textContent,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(report);
    copyDiagnosticsButton.textContent = "Copied";
    window.setTimeout(() => { copyDiagnosticsButton.textContent = "Copy full diagnostics"; }, 1600);
  } catch (error) {
    status.textContent = `Could not copy diagnostics: ${error.message}`;
  }
});
roiSizeInput.addEventListener("input", () => {
  roiValue.textContent = `${roiSizeInput.value} px`;
  opticalLanes.forEach((lane) => lane.reset());
});
autoTrackInput.addEventListener("change", () => {
  roiSizeInput.disabled = autoTrackInput.checked;
  tracker.reset();
  activeQuad = null;
  opticalLanes.forEach((lane) => lane.reset());
  status.textContent = autoTrackInput.checked
    ? "Automatic tracking enabled. Keep the complete white square and black surround in view."
    : "Manual fallback enabled. Align the outer white square inside the guide.";
});
minimumContrastInput.addEventListener("input", () => {
  contrastValue.textContent = minimumContrastInput.value;
});

canvas.addEventListener("pointerdown", (event) => {
  const bounds = canvas.getBoundingClientRect();
  const point = {
    x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height,
  };
  void focusCameraAt(point);
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
  cameraTrack = null;
  automaticFocusRequested = false;
  video.srcObject = null;
  cameraButton.disabled = false;
  facingModeInput.disabled = false;
  cameraFrameRateInput.disabled = false;
  stopButton.disabled = true;
  focusMetric.textContent = "Focus: stopped";
  status.textContent = "Camera stopped.";
});

context.fillStyle = "#020807";
context.fillRect(0, 0, canvas.width, canvas.height);
drawGuide();
updateDiagnostics(true);
