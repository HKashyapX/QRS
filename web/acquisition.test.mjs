import assert from "node:assert/strict";
import {
  OrderedPhasePairer,
  OpticalTracker,
  detectOpticalQuad,
  projectPoint,
  quadMotion,
  samplePerspectiveGrid,
  squareToQuad,
} from "./acquisition.js";
import {
  FRAME_TYPE,
  GRID_SIZE,
  classifyOptical,
  decodeOpticalPair,
  encodeOpticalPhase,
} from "./qrs-core.js";

function image(width, height, value = 18) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = value;
    data[index * 4 + 1] = value;
    data[index * 4 + 2] = value;
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

function fillRect(target, x0, y0, width, height, value) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      const offset = (y * target.width + x) * 4;
      target.data[offset] = value;
      target.data[offset + 1] = value;
      target.data[offset + 2] = value;
    }
  }
}

const frame = image(320, 240);
fillRect(frame, 70, 30, 180, 180, 240);
fillRect(frame, 82, 42, 156, 156, 15);
for (let y = 0; y < 8; y += 1) {
  for (let x = 0; x < 8; x += 1) {
    if ((x + y) % 2 === 0) fillRect(frame, 82 + x * 19, 42 + y * 19, 19, 19, 235);
  }
}

const detection = detectOpticalQuad(frame);
assert.ok(detection, "white quiet-zone frame should be detected");
assert.ok(quadMotion(detection.quad, [
  { x: 70, y: 30 }, { x: 250, y: 30 }, { x: 250, y: 210 }, { x: 70, y: 210 },
]) < 0.06);

const skewed = [
  { x: 20, y: 30 }, { x: 210, y: 12 }, { x: 230, y: 180 }, { x: 5, y: 205 },
];
const transform = squareToQuad(skewed);
for (const [u, v, expected] of [[0, 0, skewed[0]], [1, 0, skewed[1]], [1, 1, skewed[2]], [0, 1, skewed[3]]]) {
  const actual = projectPoint(transform, u, v);
  assert.ok(distance(actual, expected) < 1e-6);
}

const fourCells = image(100, 100, 0);
fillRect(fourCells, 0, 0, 50, 50, 30);
fillRect(fourCells, 50, 0, 50, 50, 90);
fillRect(fourCells, 0, 50, 50, 50, 160);
fillRect(fourCells, 50, 50, 50, 50, 230);
assert.deepEqual([...samplePerspectiveGrid(fourCells, [
  { x: 0, y: 0 }, { x: 99, y: 0 }, { x: 99, y: 99 }, { x: 0, y: 99 },
], 2)], [30, 90, 160, 230]);

const tracker = new OpticalTracker({ smoothing: 0.5, maxMisses: 1 });
assert.ok(tracker.locate(frame));
assert.deepEqual(tracker.current().quad, tracker.current().quad, "current track should be reusable between detections");
assert.ok(tracker.locate(image(320, 240)), "one missed frame should use the tracked quad");
assert.equal(tracker.locate(image(320, 240)), null, "tracker should force reacquisition after its miss budget");

const pairer = new OrderedPhasePairer();
const phaseA0 = { inverted: false, id: "A0" };
const phaseB0 = { inverted: true, id: "B0" };
const phaseA1 = { inverted: false, id: "A1" };
const phaseB1 = { inverted: true, id: "B1" };
assert.equal(pairer.push(phaseB0).status, "orphan");
assert.equal(pairer.push(phaseA0).status, "armed");
assert.deepEqual(pairer.push(phaseB0).pair.map((item) => item.classification.id), ["A0", "B0"]);
assert.equal(pairer.push(phaseA0).status, "armed");
assert.equal(pairer.push(phaseA1).status, "armed", "a newer A replaces an A whose B was missed");
assert.deepEqual(pairer.push(phaseB1).pair.map((item) => item.classification.id), ["A1", "B1"]);

function renderGuardedSymbol(cells) {
  const target = image(640, 520, 24);
  const cellSize = 6;
  const symbolX = 92;
  const symbolY = 32;
  const guard = 3;
  const quiet = 3;
  fillRect(target, symbolX, symbolY, 76 * cellSize, 76 * cellSize, 0);
  fillRect(target, symbolX + guard * cellSize, symbolY + guard * cellSize,
    70 * cellSize, 70 * cellSize, 240);
  const matrixX = symbolX + (guard + quiet) * cellSize;
  const matrixY = symbolY + (guard + quiet) * cellSize;
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      fillRect(target, matrixX + x * cellSize, matrixY + y * cellSize,
        cellSize, cellSize, cells[y * GRID_SIZE + x]);
    }
  }
  return target;
}

function renderPerspectiveSymbol(cells, quad) {
  const target = image(640, 520, 24);
  const transform = squareToQuad(quad);
  const minimumX = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.x))));
  const maximumX = Math.min(target.width - 1, Math.ceil(Math.max(...quad.map((point) => point.x))));
  const minimumY = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.y))));
  const maximumY = Math.min(target.height - 1, Math.ceil(Math.max(...quad.map((point) => point.y))));
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const aa = transform.a - x * transform.g;
      const ab = transform.b - x * transform.h;
      const ba = transform.d - y * transform.g;
      const bb = transform.e - y * transform.h;
      const determinant = aa * bb - ab * ba;
      if (Math.abs(determinant) < 1e-9) continue;
      const rightX = x - transform.c;
      const rightY = y - transform.f;
      const u = (rightX * bb - ab * rightY) / determinant;
      const v = (aa * rightY - rightX * ba) / determinant;
      if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
      const gridX = Math.floor(u * 76);
      const gridY = Math.floor(v * 76);
      let value = 0;
      if (gridX >= 3 && gridX < 73 && gridY >= 3 && gridY < 73) value = 240;
      if (gridX >= 6 && gridX < 70 && gridY >= 6 && gridY < 70) {
        value = cells[(gridY - 6) * GRID_SIZE + gridX - 6];
      }
      const offset = (y * target.width + x) * 4;
      target.data[offset] = value;
      target.data[offset + 1] = value;
      target.data[offset + 2] = value;
    }
  }
  return target;
}

const opticalFrame = {
  type: FRAME_TYPE.DATA,
  flags: 0,
  sessionId: 0x1020304050607080n,
  symbolId: 17,
  payload: Uint8Array.from({ length: 128 }, (_, index) => (index * 37 + 11) & 0xff),
};
const renderedA = renderGuardedSymbol(encodeOpticalPhase(opticalFrame, false));
const renderedB = renderGuardedSymbol(encodeOpticalPhase(opticalFrame, true));
const acquiredA = detectOpticalQuad(renderedA);
const acquiredB = detectOpticalQuad(renderedB);
assert.ok(acquiredA && acquiredB, "guarded symbols should be detected in both phases");
const classifiedA = classifyOptical(samplePerspectiveGrid(renderedA, acquiredA.quad, GRID_SIZE, 3));
const classifiedB = classifyOptical(samplePerspectiveGrid(renderedB, acquiredB.quad, GRID_SIZE, 3));
const recoveredFrame = decodeOpticalPair(classifiedA, classifiedB, 24);
assert.equal(recoveredFrame.sessionId, opticalFrame.sessionId);
assert.equal(recoveredFrame.symbolId, opticalFrame.symbolId);
assert.deepEqual(recoveredFrame.payload, opticalFrame.payload);

const perspectiveQuad = [
  { x: 108, y: 68 }, { x: 532, y: 34 }, { x: 568, y: 454 }, { x: 72, y: 486 },
];
const perspectiveA = renderPerspectiveSymbol(encodeOpticalPhase(opticalFrame, false), perspectiveQuad);
const perspectiveB = renderPerspectiveSymbol(encodeOpticalPhase(opticalFrame, true), perspectiveQuad);
const perspectiveDetectionA = detectOpticalQuad(perspectiveA);
const perspectiveDetectionB = detectOpticalQuad(perspectiveB);
assert.ok(perspectiveDetectionA && perspectiveDetectionB, "perspective symbols should be detected");
const perspectiveClassificationA = classifyOptical(samplePerspectiveGrid(
  perspectiveA, perspectiveDetectionA.quad, GRID_SIZE, 3,
));
const perspectiveClassificationB = classifyOptical(samplePerspectiveGrid(
  perspectiveB, perspectiveDetectionB.quad, GRID_SIZE, 3,
));
const perspectiveRecovered = decodeOpticalPair(perspectiveClassificationA, perspectiveClassificationB, 24);
assert.equal(perspectiveRecovered.sessionId, opticalFrame.sessionId);
assert.deepEqual(perspectiveRecovered.payload, opticalFrame.payload);

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

console.log("All optical-acquisition tests passed");
