import {
  FEC_CODEC,
  FRAME_TYPE,
  GRID_SIZE,
  LtDecoder,
  classifyOptical,
  decodeOpticalPair,
  parseManifest,
} from "./qrs-core.js";
import {
  OpticalTracker,
  quadMotion,
  samplePerspectiveGrid,
} from "./acquisition.js";

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

// The sender draws the 64x64 matrix inside a three-cell quiet zone on every
// side. The alignment guide encloses that complete 70x70-cell optical symbol,
// so camera sampling must skip the quiet zone before locating data cells.
const QUIET_CELLS = 3;
const DISPLAY_GRID_SIZE = GRID_SIZE + QUIET_CELLS * 2;

export function opticalCellCenter(cell, roiSize) {
  return Math.floor((cell + QUIET_CELLS + 0.5) * (roiSize / DISPLAY_GRID_SIZE));
}

let stream = null;
let running = false;
let lastProcessed = 0;
let phaseA = null;
let phaseB = null;
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
};
let lastDiagnosticError = "none";

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

function acquireGrid() {
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  if (!autoTrackInput.checked) {
    const quad = manualQuad();
    return { cells: samplePerspectiveGrid(image, quad, GRID_SIZE, QUIET_CELLS), quad, confidence: 1, stale: false };
  }
  const acquisition = tracker.locate(image);
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
    ? (quad ? "Optical frame tracked — normal hand movement is okay" : "Point the camera at the complete white outer frame")
    : "Manual fallback: align the outer white frame inside this guide";
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
  if (classification.inverted) {
    phaseB = { classification, quad: acquisition.quad, capturedAt: performance.now() };
    counters.phaseB += 1;
  } else {
    phaseA = { classification, quad: acquisition.quad, capturedAt: performance.now() };
    counters.phaseA += 1;
  }
  if (!phaseA || !phaseB) return true;

  if (quadMotion(phaseA.quad, phaseB.quad) > 0.055) {
    counters.geometryRejects += 1;
    lastDiagnosticError = "Camera moved between differential phases";
    if (phaseA.capturedAt < phaseB.capturedAt) phaseA = null;
    else phaseB = null;
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
    lastDiagnosticError = error.message;
    // A phase from the previous logical frame commonly pairs with the next frame first.
    // CRC validation rejects that transient mismatch.
  }
  return true;
}

function updateDiagnostics() {
  diagnosticsElement.textContent = [
    `sampled grids: ${counters.sampled}`,
    `marker locks/failures: ${counters.markerLocks}/${counters.markerFailures}`,
    `phase A/B observations: ${counters.phaseA}/${counters.phaseB}`,
    `valid/rejected pairs: ${validFrames}/${counters.pairRejects}`,
    `manifest/data frames: ${counters.manifests}/${counters.dataFrames}`,
    `resolved symbols: ${decoder ? `${decoder.resolvedCount}/${decoder.sourceSymbolCount}` : "0/0"}`,
    `acquisition: ${autoTrackInput.checked ? "automatic" : `manual ${roiSizeInput.value}px`}`,
    `tracked/missed frames: ${counters.acquisitions}/${counters.acquisitionMisses}`,
    `geometry pair rejects: ${counters.geometryRejects}`,
    `minimum contrast: ${minimumContrastInput.value}`,
    `last pair error: ${lastDiagnosticError}`,
  ].join("\n");
}

function render(now) {
  if (!running) return;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawVideoCover();
    if (now - lastProcessed >= 75) {
      lastProcessed = now;
      try {
        const acquisition = acquireGrid();
        activeQuad = acquisition.quad;
        processOpticalGrid(acquisition.cells, acquisition);
      } catch (error) {
        markerLocked = false;
        activeQuad = null;
        counters.markerFailures += 1;
        lastDiagnosticError = error.message;
        confidenceMetric.textContent = "No marker lock";
      }
      updateDiagnostics();
    }
    drawGuide(markerLocked, activeQuad);
  }
  requestAnimationFrame(render);
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
    status.textContent = "Camera active. Keep the complete white outer frame visible; tracking handles perspective and hand movement.";
    requestAnimationFrame(render);
  } catch (error) {
    status.textContent = `Camera could not start: ${error.message}`;
  }
});

function resetTransfer() {
  phaseA = null;
  phaseB = null;
  activeSession = null;
  manifest = null;
  decoder = null;
  validFrames = 0;
  markerLocked = false;
  activeQuad = null;
  tracker.reset();
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
  phaseA = null;
  phaseB = null;
});
autoTrackInput.addEventListener("change", () => {
  roiSizeInput.disabled = autoTrackInput.checked;
  tracker.reset();
  activeQuad = null;
  phaseA = null;
  phaseB = null;
  status.textContent = autoTrackInput.checked
    ? "Automatic tracking enabled. Keep the complete white outer frame in view."
    : "Manual fallback enabled. Align the outer frame inside the guide.";
});
minimumContrastInput.addEventListener("input", () => {
  contrastValue.textContent = minimumContrastInput.value;
});

stopButton.addEventListener("click", () => {
  running = false;
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
