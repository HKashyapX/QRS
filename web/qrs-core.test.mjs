import assert from "node:assert/strict";
import {
  FRAME_TYPE,
  LtDecoder,
  LtEncoder,
  OpticalTransmissionSchedule,
  classifyOptical,
  crc32c,
  decodeOpticalPair,
  encodeOpticalPhase,
  parseFrame,
  serializeFrame,
  transformOpticalMatrix,
} from "./qrs-core.js";

const crcVector = new TextEncoder().encode("123456789");
assert.equal(crc32c(crcVector), 0xe3069283);

const originalFrame = {
  type: FRAME_TYPE.DATA,
  flags: 0,
  sessionId: 0x1122334455667788n,
  symbolId: 42,
  payload: Uint8Array.from({ length: 256 }, (_, index) => (index * 29 + 7) & 0xff),
};
const parsedFrame = parseFrame(serializeFrame(originalFrame));
assert.equal(parsedFrame.sessionId, originalFrame.sessionId);
assert.equal(parsedFrame.symbolId, originalFrame.symbolId);
assert.deepEqual(parsedFrame.payload, originalFrame.payload);

const phaseA = encodeOpticalPhase(originalFrame, false);
const phaseB = encodeOpticalPhase(originalFrame, true);
const canonicalA = classifyOptical(phaseA);
const canonicalB = classifyOptical(phaseB);
assert.equal(canonicalA.inverted, false, "phase pilot should identify phase A");
assert.equal(canonicalB.inverted, true, "phase pilot should identify phase B");
assert.equal(canonicalA.rotation, canonicalB.rotation, "static anchors should give both phases the same orientation");
assert.equal(canonicalA.mirrored, canonicalB.mirrored, "static anchors should give both phases the same reflection");

const compressedA = Uint8Array.from(phaseA, (value) => (value ? 130 : 110));
assert.equal(classifyOptical(compressedA).inverted, false,
  "orientation should survive a camera-compressed 20-level luminance range");

const locallyWeakB = phaseB.slice();
for (let y = 20; y < 30; y += 1) {
  for (let x = 20; x < 30; x += 1) {
    locallyWeakB[y * 64 + x] = phaseA[y * 64 + x] > phaseB[y * 64 + x] ? 235 : 20;
  }
}
const weakButValid = decodeOpticalPair(canonicalA, classifyOptical(locallyWeakB), 24);
assert.deepEqual(weakButValid.payload, originalFrame.payload,
  "a bounded number of correctly signed weak cells should defer to the frame CRC");

const weakAndWrongB = phaseB.slice();
let corruptedCell = -1;
for (let x = 9; x < 55 && corruptedCell < 0; x += 1) {
  const index = 64 + x;
  if (phaseA[index] === 255) corruptedCell = index;
}
assert.ok(corruptedCell >= 0, "test frame should expose an early white data bit");
weakAndWrongB[corruptedCell] = phaseA[corruptedCell];
assert.throws(() => decodeOpticalPair(canonicalA, classifyOptical(weakAndWrongB), 24),
  /frame|CRC/i, "weak-cell tolerance must not bypass frame integrity");

const noisyMarkers = phaseA.slice();
for (const [x, y] of [[3, 3], [60, 3], [3, 60], [60, 60], [1, 20], [62, 40]]) {
  noisyMarkers[y * 64 + x] = 255 - noisyMarkers[y * 64 + x];
}
assert.equal(classifyOptical(noisyMarkers).inverted, false, "a few damaged anchor cells should be tolerated");
for (let rotation = 0; rotation < 4; rotation += 1) {
  for (const mirrored of [false, true]) {
    const observedA = classifyOptical(transformOpticalMatrix(phaseA, rotation, mirrored));
    const observedB = classifyOptical(transformOpticalMatrix(phaseB, rotation, mirrored));
    const decoded = decodeOpticalPair(observedA, observedB);
    assert.equal(decoded.sessionId, originalFrame.sessionId);
    assert.equal(decoded.symbolId, originalFrame.symbolId);
    assert.deepEqual(decoded.payload, originalFrame.payload);
  }
}

const input = Uint8Array.from({ length: 10000 }, (_, index) => (index * 131 + 17) & 0xff);
const encoder = new LtEncoder(input, 64);
const manifest = {
  objectSize: input.length,
  symbolSize: encoder.symbolSize,
  sourceSymbolCount: encoder.sourceSymbolCount,
};
const decoder = new LtDecoder(manifest);
let symbolId = 0;
while (!decoder.complete && symbolId < 100000) {
  const payload = encoder.encode(symbolId);
  if (symbolId % 10 >= 3) decoder.add(symbolId, payload);
  symbolId += 1;
}
assert.equal(decoder.complete, true);
assert.deepEqual(decoder.recover(), input);

const vectorEncoder = new LtEncoder(Uint8Array.from({ length: 32 }, (_, index) => index), 4);
assert.deepEqual(vectorEncoder.encode(8), new Uint8Array([4, 4, 4, 4]));
assert.deepEqual(vectorEncoder.encode(11), new Uint8Array([16, 16, 16, 16]));

const schedule = new OpticalTransmissionSchedule(3);
assert.deepEqual(Array.from({ length: 4 }, () => schedule.next().type),
  ["manifest", "manifest", "manifest", "manifest"]);
const scheduledData = Array.from({ length: 8 }, () => schedule.next());
assert.deepEqual(scheduledData.map((entry) => entry.type), Array(8).fill("data"));
assert.deepEqual(scheduledData.map((entry) => entry.symbolId), [0, 1, 3, 2, 1, 4, 2, 0]);
assert.deepEqual(scheduledData.map((entry) => entry.systematic),
  [true, true, false, true, true, false, true, true]);
while (schedule.logicalFrames < 24) schedule.next();
assert.equal(schedule.next().type, "manifest", "the manifest should remain periodically recoverable");

const lateInput = Uint8Array.from({ length: 59 * 32 }, (_, index) => (index * 43 + 19) & 0xff);
const lateEncoder = new LtEncoder(lateInput, 32);
const lateDecoder = new LtDecoder({
  objectSize: lateInput.length,
  symbolSize: 32,
  sourceSymbolCount: lateEncoder.sourceSymbolCount,
});
const lateSchedule = new OpticalTransmissionSchedule(lateEncoder.sourceSymbolCount);
for (let frameNumber = 0; frameNumber < 6000 && !lateDecoder.complete; frameNumber += 1) {
  const entry = lateSchedule.next();
  if (entry.type === "data" && frameNumber >= 120 && (frameNumber * 17) % 10 < 3) {
    lateDecoder.add(entry.symbolId, lateEncoder.encode(entry.symbolId));
  }
}
assert.equal(lateDecoder.complete, true, "late lock plus 70% loss should recover from the ongoing schedule");
assert.deepEqual(lateDecoder.recover(), lateInput);

console.log("All browser-core tests passed");
