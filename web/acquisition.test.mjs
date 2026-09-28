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

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

console.log("All optical-acquisition tests passed");
