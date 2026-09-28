import {
  FEC_CODEC,
  FRAME_TYPE,
  GRID_SIZE,
  LtDecoder,
  classifyOptical,
  decodeOpticalPair,
  parseManifest,
} from "./qrs-core.js";

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
const minimumContrastInput = document.querySelector("#minimumContrast");
const contrastValue = document.querySelector("#contrastValue");
const resetButton = document.querySelector("#reset");
const diagnosticsElement = document.querySelector("#diagnostics");

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
const counters = {
  sampled: 0,
  markerLocks: 0,
  markerFailures: 0,
  phaseA: 0,
  phaseB: 0,
  pairRejects: 0,
  manifests: 0,
  dataFrames: 0,
};
let lastDiagnosticError = "none";

function currentRoi() {
  const size = Number(roiSizeInput.value);
  return { size, x: (canvas.width - size) / 2, y: (canvas.height - size) / 2 };
}

function drawVideoCover() {
  const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

function sampleGrid() {
  const roi = currentRoi();
  const image = context.getImageData(roi.x, roi.y, roi.size, roi.size);
  const cells = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const step = roi.size / GRID_SIZE;
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const centerX = Math.floor((x + 0.5) * step);
      const centerY = Math.floor((y + 0.5) * step);
      let sum = 0;
      let samples = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const pixel = ((centerY + offsetY) * roi.size + centerX + offsetX) * 4;
          sum += (image.data[pixel] * 77 + image.data[pixel + 1] * 150 + image.data[pixel + 2] * 29) >> 8;
          samples += 1;
        }
      }
      cells[y * GRID_SIZE + x] = Math.round(sum / samples);
    }
  }
  return cells;
}

function drawGuide(locked = false) {
  const roi = currentRoi();
  context.strokeStyle = locked ? "#6ee7b7" : "#fbbf24";
  context.lineWidth = 3;
  context.strokeRect(roi.x, roi.y, roi.size, roi.size);
  context.fillStyle = "rgba(0,0,0,.62)";
  context.fillRect(roi.x, roi.y - 30, roi.size, 26);
  context.fillStyle = "#ffffff";
  context.font = "600 15px system-ui";
  context.textAlign = "center";
  context.fillText("Align the exact matrix edge inside this square", canvas.width / 2, roi.y - 11);
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

function processOpticalGrid(cells) {
  counters.sampled += 1;
  const classification = classifyOptical(cells);
  markerLocked = true;
  counters.markerLocks += 1;
  confidenceMetric.textContent = `Marker errors ${classification.errors} · contrast ${classification.contrast}`;
  if (classification.inverted) {
    phaseB = classification;
    counters.phaseB += 1;
  } else {
    phaseA = classification;
    counters.phaseA += 1;
  }
  if (!phaseA || !phaseB) return true;

  try {
    const frame = decodeOpticalPair(phaseA, phaseB, Number(minimumContrastInput.value));
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
    `alignment box: ${roiSizeInput.value}px`,
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
        processOpticalGrid(sampleGrid());
      } catch (error) {
        markerLocked = false;
        counters.markerFailures += 1;
        lastDiagnosticError = error.message;
        confidenceMetric.textContent = "No marker lock";
      }
      updateDiagnostics();
    }
    drawGuide(markerLocked);
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
    status.textContent = "Camera active. Align the matrix precisely with the guide.";
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
