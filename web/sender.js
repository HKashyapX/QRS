import {
  CRYPTO_SUITE,
  FEC_CODEC,
  FRAME_TYPE,
  LtEncoder,
  drawOpticalMatrix,
  encodeOpticalPhase,
  randomSessionId,
  safeFilename,
  serializeManifest,
} from "./qrs-core.js";

const fileInput = document.querySelector("#file");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const fullscreenButton = document.querySelector("#fullscreen");
const canvas = document.querySelector("#matrix");
const status = document.querySelector("#status");
const fileMetric = document.querySelector("#fileMetric");
const symbolMetric = document.querySelector("#symbolMetric");
const phaseMetric = document.querySelector("#phaseMetric");
const phaseDurationInput = document.querySelector("#phaseDuration");

const MAX_FILE_SIZE = 100 * 1024;
const SYMBOL_SIZE = 256;

let selectedFile = null;
let running = false;
let timer = null;

function blankMatrix() {
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#071a16";
  context.font = "600 28px system-ui";
  context.textAlign = "center";
  context.fillText("QRS ready", canvas.width / 2, canvas.height / 2);
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  selectedFile = file ?? null;
  if (!file) {
    startButton.disabled = true;
    fileMetric.textContent = "No file";
    return;
  }
  if (!file.size || file.size > MAX_FILE_SIZE) {
    startButton.disabled = true;
    status.textContent = file.size ? "File exceeds the 100 KB controlled-demo limit." : "Empty files are not supported yet.";
    return;
  }
  startButton.disabled = false;
  fileMetric.textContent = `${file.name} · ${file.size.toLocaleString()} bytes`;
  status.textContent = "Ready. Open the receiver on a second device before starting.";
});

startButton.addEventListener("click", async () => {
  if (!selectedFile || running) return;
  const object = new Uint8Array(await selectedFile.arrayBuffer());
  const encoder = new LtEncoder(object, SYMBOL_SIZE);
  const sessionId = randomSessionId();
  const manifestPayload = serializeManifest({
    objectSize: object.length,
    symbolSize: SYMBOL_SIZE,
    sourceSymbolCount: encoder.sourceSymbolCount,
    fecCodec: FEC_CODEC.DETERMINISTIC_LT,
    cryptoSuite: CRYPTO_SUITE.NONE,
    sha256: new Uint8Array(32),
    filename: safeFilename(selectedFile.name),
  });
  const manifestFrame = { type: FRAME_TYPE.MANIFEST, flags: 0, sessionId, symbolId: 0, payload: manifestPayload };

  running = true;
  startButton.disabled = true;
  stopButton.disabled = false;
  fullscreenButton.disabled = false;
  status.textContent = `Transmitting unencrypted session ${sessionId.toString(16).padStart(16, "0")}.`;

  let dataSymbolId = 0;
  let logicalFrameNumber = 0;
  let inverted = false;
  let currentFrame = manifestFrame;

  const tick = () => {
    if (!running) return;
    drawOpticalMatrix(canvas, encodeOpticalPhase(currentFrame, inverted));
    phaseMetric.textContent = inverted ? "Phase B" : "Phase A";
    symbolMetric.textContent = `${dataSymbolId.toLocaleString()} data symbols generated`;

    if (inverted) {
      logicalFrameNumber += 1;
      if (logicalFrameNumber % 20 === 0) {
        currentFrame = manifestFrame;
      } else {
        currentFrame = {
          type: FRAME_TYPE.DATA,
          flags: 0,
          sessionId,
          symbolId: dataSymbolId,
          payload: encoder.encode(dataSymbolId),
        };
        dataSymbolId += 1;
      }
    }
    inverted = !inverted;
    timer = window.setTimeout(tick, Number(phaseDurationInput.value));
  };
  tick();
});

stopButton.addEventListener("click", () => {
  running = false;
  if (timer) window.clearTimeout(timer);
  timer = null;
  stopButton.disabled = true;
  startButton.disabled = !selectedFile;
  fullscreenButton.disabled = true;
  phaseMetric.textContent = "Stopped";
  status.textContent = "Transmission stopped. The sender receives no completion acknowledgement.";
});

fullscreenButton.addEventListener("click", async () => {
  if (canvas.requestFullscreen) await canvas.requestFullscreen();
});

blankMatrix();
