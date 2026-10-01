import {
  CRYPTO_SUITE,
  FEC_CODEC,
  FRAME_TYPE,
  LtEncoder,
  OpticalTransmissionSchedule,
  drawOpticalLanes,
  encodeLaneFlags,
  encodeOpticalPhase,
  opticalCanvasGrid,
  randomSessionId,
  safeFilename,
  serializeManifest,
} from "./qrs-core.js?v=acquisition-refinement-1";

const fileInput = document.querySelector("#file");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const fullscreenButton = document.querySelector("#fullscreen");
const canvas = document.querySelector("#matrix");
const status = document.querySelector("#status");
const fileMetric = document.querySelector("#fileMetric");
const symbolMetric = document.querySelector("#symbolMetric");
const phaseMetric = document.querySelector("#phaseMetric");
const displayMetric = document.querySelector("#displayMetric");
const phaseDurationInput = document.querySelector("#phaseDuration");
const laneCountInput = document.querySelector("#laneCount");
const flashAcknowledgementInput = document.querySelector("#flashAcknowledgement");
const matrixShell = document.querySelector(".matrix-shell");

const MAX_FILE_SIZE = 1024 * 1024;
const SYMBOL_SIZE = 256;

let selectedFile = null;
let running = false;
let animationFrame = null;
let wakeLock = null;

function selectedFileIsValid() {
  return Boolean(selectedFile?.size && selectedFile.size <= MAX_FILE_SIZE);
}

function updateStartAvailability() {
  startButton.disabled = running || !selectedFileIsValid() || !flashAcknowledgementInput.checked;
}

function updateDisplayMetric() {
  const bounds = canvas.getBoundingClientRect();
  const grid = opticalCanvasGrid(Number(laneCountInput.value));
  const physicalWidth = bounds.width * (window.devicePixelRatio || 1);
  displayMetric.textContent = `${(physicalWidth / grid.columns).toFixed(1)} display px/cell · ${laneCountInput.value} lane${laneCountInput.value === "1" ? "" : "s"}`;
}

function configureCanvas() {
  const laneCount = Number(laneCountInput.value);
  const grid = opticalCanvasGrid(laneCount);
  const cellPixels = 12;
  canvas.width = grid.columns * cellPixels;
  canvas.height = grid.rows * cellPixels;
  canvas.style.aspectRatio = `${grid.columns} / ${grid.rows}`;
  matrixShell.classList.toggle("dual-lane", laneCount > 1);
  updateDisplayMetric();
}

async function holdWakeLock() {
  if (!navigator.wakeLock?.request) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

function blankMatrix() {
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#071a16";
  context.font = "600 28px system-ui";
  context.textAlign = "center";
  context.fillText("QRS ready", canvas.width / 2, canvas.height / 2);
}

laneCountInput.addEventListener("change", () => {
  configureCanvas();
  blankMatrix();
});

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  selectedFile = file ?? null;
  if (!file) {
    fileMetric.textContent = "No file";
    updateStartAvailability();
    return;
  }
  if (!file.size || file.size > MAX_FILE_SIZE) {
    status.textContent = file.size ? "File exceeds the 1 MiB demo limit." : "Empty files are not supported yet.";
    updateStartAvailability();
    return;
  }
  fileMetric.textContent = `${file.name} · ${file.size.toLocaleString()} bytes`;
  status.textContent = flashAcknowledgementInput.checked
    ? "Ready. Open the receiver on a second device before starting."
    : "File ready. Confirm the rapid-flash warning to enable transmission.";
  updateStartAvailability();
});

flashAcknowledgementInput.addEventListener("change", () => {
  updateStartAvailability();
  if (selectedFileIsValid() && !running) {
    status.textContent = flashAcknowledgementInput.checked
      ? "Ready. Open the receiver on a second device before starting."
      : "File ready. Confirm the rapid-flash warning to enable transmission.";
  }
});

startButton.addEventListener("click", async () => {
  if (!selectedFile || running) return;
  const object = new Uint8Array(await selectedFile.arrayBuffer());
  const encoder = new LtEncoder(object, SYMBOL_SIZE);
  const sessionId = randomSessionId();
  const laneCount = Number(laneCountInput.value);
  const manifestPayload = serializeManifest({
    objectSize: object.length,
    symbolSize: SYMBOL_SIZE,
    sourceSymbolCount: encoder.sourceSymbolCount,
    fecCodec: FEC_CODEC.DENSE_LT_GF2,
    cryptoSuite: CRYPTO_SUITE.NONE,
    sha256: new Uint8Array(32),
    filename: safeFilename(selectedFile.name),
  });
  const manifestFrame = (laneId) => ({
    type: FRAME_TYPE.MANIFEST,
    flags: encodeLaneFlags({ laneId, laneCount }),
    sessionId,
    symbolId: 0,
    payload: manifestPayload,
  });
  const schedule = new OpticalTransmissionSchedule(encoder.sourceSymbolCount);
  const scheduledFrame = (entry, laneId) => entry.type === "manifest" ? manifestFrame(laneId) : {
    type: FRAME_TYPE.DATA,
    flags: encodeLaneFlags({ laneId, laneCount }),
    sessionId,
    symbolId: entry.symbolId,
    payload: encoder.encode(entry.symbolId),
  };

  running = true;
  await holdWakeLock();
  startButton.disabled = true;
  flashAcknowledgementInput.disabled = true;
  laneCountInput.disabled = true;
  stopButton.disabled = false;
  fullscreenButton.disabled = false;
  status.textContent = `Transmitting ${object.length.toLocaleString()} bytes across ${laneCount} optical lane${laneCount === 1 ? "" : "s"} · ${encoder.sourceSymbolCount} source symbols · unencrypted session ${sessionId.toString(16).padStart(16, "0")}.`;

  let inverted = false;
  let currentSchedules = Array.from({ length: laneCount }, () => schedule.next());
  let currentFrames = currentSchedules.map((entry, laneId) => scheduledFrame(entry, laneId));
  let manifestFrames = 0;
  let systematicFrames = 0;
  let repairFrames = 0;
  let nextPhaseAt = performance.now();
  let phaseCount = 0;
  const startedAt = nextPhaseAt;
  let latePhases = 0;
  let maximumLateness = 0;

  const tick = (now) => {
    if (!running) return;
    if (now + 0.5 < nextPhaseAt) {
      animationFrame = requestAnimationFrame(tick);
      return;
    }
    drawOpticalLanes(canvas, currentFrames.map((frame, laneId) => (
      encodeOpticalPhase(frame, laneId % 2 === 1 ? !inverted : inverted)
    )));
    updateDisplayMetric();
    phaseCount += 1;
    const phaseRate = phaseCount > 1 ? (phaseCount - 1) / Math.max(0.001, (now - startedAt) / 1000) : 0;
    const lateness = Math.max(0, now - nextPhaseAt);
    if (lateness > 8) latePhases += 1;
    maximumLateness = Math.max(maximumLateness, lateness);
    const phaseLabel = laneCount > 1
      ? `Display ${inverted ? "B/A" : "A/B"}`
      : `Phase ${inverted ? "B" : "A"}`;
    phaseMetric.textContent = `${phaseLabel} · ${phaseRate.toFixed(1)} phases/s · ${latePhases} late (${maximumLateness.toFixed(0)} ms max)`;
    symbolMetric.textContent = `${systematicFrames} source · ${repairFrames} repair · ${manifestFrames} manifest`;

    if (inverted) {
      currentSchedules.forEach((entry) => {
        if (entry.type === "manifest") manifestFrames += 1;
        else if (entry.systematic) systematicFrames += 1;
        else repairFrames += 1;
      });
      currentSchedules = Array.from({ length: laneCount }, () => schedule.next());
      currentFrames = currentSchedules.map((entry, laneId) => scheduledFrame(entry, laneId));
    }
    inverted = !inverted;
    const duration = Number(phaseDurationInput.value);
    nextPhaseAt += duration;
    if (now - nextPhaseAt > duration) nextPhaseAt = now + duration;
    animationFrame = requestAnimationFrame(tick);
  };
  animationFrame = requestAnimationFrame(tick);
});

stopButton.addEventListener("click", () => {
  running = false;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  void wakeLock?.release();
  wakeLock = null;
  stopButton.disabled = true;
  flashAcknowledgementInput.disabled = false;
  laneCountInput.disabled = false;
  updateStartAvailability();
  fullscreenButton.disabled = true;
  phaseMetric.textContent = "Stopped";
  status.textContent = "Transmission stopped. The sender receives no completion acknowledgement.";
});

fullscreenButton.addEventListener("click", async () => {
  if (matrixShell.requestFullscreen) await matrixShell.requestFullscreen();
});

configureCanvas();
blankMatrix();
updateDisplayMetric();
window.addEventListener("resize", updateDisplayMetric);
