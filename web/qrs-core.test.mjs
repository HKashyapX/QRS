import assert from "node:assert/strict";
import {
  FRAME_TYPE,
  LtDecoder,
  LtEncoder,
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

console.log("All browser-core tests passed");
