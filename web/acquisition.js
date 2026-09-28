const DEFAULTS = Object.freeze({
  downsampleTarget: 160,
  minimumAreaRatio: 0.025,
  maximumAreaRatio: 0.82,
  smoothing: 0.34,
  maxMisses: 2,
});

function luminance(data, offset) {
  return (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) >> 8;
}

function polygonArea(quad) {
  let area = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const next = (index + 1) % quad.length;
    area += quad[index].x * quad[next].y - quad[next].x * quad[index].y;
  }
  return Math.abs(area) / 2;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function otsuThreshold(values) {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value] += 1;
  let totalSum = 0;
  for (let value = 0; value < 256; value += 1) totalSum += value * histogram[value];
  let backgroundCount = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 127;
  for (let value = 0; value < 255; value += 1) {
    backgroundCount += histogram[value];
    if (!backgroundCount) continue;
    const foregroundCount = values.length - backgroundCount;
    if (!foregroundCount) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundCount;
    const foregroundMean = (totalSum - backgroundSum) / foregroundCount;
    const variance = backgroundCount * foregroundCount * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = value;
    }
  }
  return bestThreshold;
}

function downsampleLuminance(imageData, target) {
  const { width, height, data } = imageData;
  const stride = Math.max(1, Math.ceil(Math.max(width, height) / target));
  const smallWidth = Math.ceil(width / stride);
  const smallHeight = Math.ceil(height / stride);
  const values = new Uint8Array(smallWidth * smallHeight);
  for (let y = 0; y < smallHeight; y += 1) {
    const sourceY = Math.min(height - 1, y * stride + Math.floor(stride / 2));
    for (let x = 0; x < smallWidth; x += 1) {
      const sourceX = Math.min(width - 1, x * stride + Math.floor(stride / 2));
      values[y * smallWidth + x] = luminance(data, (sourceY * width + sourceX) * 4);
    }
  }
  return { values, width: smallWidth, height: smallHeight, stride };
}

function componentQuad(points, stride) {
  const scaled = points.map((point) => ({
    x: Math.min(point.x * stride + stride / 2, point.sourceWidth - 1),
    y: Math.min(point.y * stride + stride / 2, point.sourceHeight - 1),
  }));
  return [scaled[0], scaled[1], scaled[2], scaled[3]];
}

export function detectOpticalQuad(imageData, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const small = downsampleLuminance(imageData, settings.downsampleTarget);
  const threshold = otsuThreshold(small.values);
  const visited = new Uint8Array(small.values.length);
  const queue = new Int32Array(small.values.length);
  const minimumPixels = Math.max(24, Math.floor(small.values.length * settings.minimumAreaRatio * 0.12));
  let best = null;

  for (let start = 0; start < small.values.length; start += 1) {
    if (visited[start] || small.values[start] <= threshold) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let count = 0;
    let minimumSum = { value: Infinity };
    let maximumSum = { value: -Infinity };
    let minimumDifference = { value: Infinity };
    let maximumDifference = { value: -Infinity };
    let touches = 0;

    while (head < tail) {
      const index = queue[head++];
      const x = index % small.width;
      const y = Math.floor(index / small.width);
      count += 1;
      const sum = x + y;
      const difference = x - y;
      if (sum < minimumSum.value) minimumSum = { value: sum, x, y };
      if (sum > maximumSum.value) maximumSum = { value: sum, x, y };
      if (difference < minimumDifference.value) minimumDifference = { value: difference, x, y };
      if (difference > maximumDifference.value) maximumDifference = { value: difference, x, y };
      if (x === 0 || y === 0 || x === small.width - 1 || y === small.height - 1) touches += 1;

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextY < 0 || nextX >= small.width || nextY >= small.height) continue;
          const next = nextY * small.width + nextX;
          if (!visited[next] && small.values[next] > threshold) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }

    if (count < minimumPixels) continue;
    const quad = componentQuad([
      minimumSum,
      maximumDifference,
      maximumSum,
      minimumDifference,
    ].map((point) => ({
      ...point,
      sourceWidth: imageData.width,
      sourceHeight: imageData.height,
    })), small.stride);
    const area = polygonArea(quad);
    const areaRatio = area / (imageData.width * imageData.height);
    if (areaRatio < settings.minimumAreaRatio || areaRatio > settings.maximumAreaRatio) continue;
    const edges = quad.map((point, index) => distance(point, quad[(index + 1) % 4]));
    const shortest = Math.min(...edges);
    const longest = Math.max(...edges);
    if (shortest < 40 || longest / shortest > 3.2) continue;
    const diagonalBalance = Math.min(distance(quad[0], quad[2]), distance(quad[1], quad[3]))
      / Math.max(distance(quad[0], quad[2]), distance(quad[1], quad[3]));
    const borderPenalty = Math.min(0.7, touches / Math.max(1, count));
    const score = areaRatio * diagonalBalance * (1 - borderPenalty) * Math.sqrt(count);
    if (!best || score > best.score) best = { quad, score, areaRatio, threshold };
  }

  if (!best) return null;
  return {
    quad: best.quad,
    confidence: Math.max(0, Math.min(1, best.areaRatio * 3 + 0.15)),
    threshold: best.threshold,
  };
}

export function squareToQuad(quad) {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(denominator) < 1e-9 ? 0 : (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = Math.abs(denominator) < 1e-9 ? 0 : (dx1 * dy3 - dx3 * dy1) / denominator;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

export function projectPoint(transform, u, v) {
  const denominator = transform.g * u + transform.h * v + 1;
  return {
    x: (transform.a * u + transform.b * v + transform.c) / denominator,
    y: (transform.d * u + transform.e * v + transform.f) / denominator,
  };
}

export function samplePerspectiveGrid(imageData, quad, gridSize, quietCells = 0) {
  const fullGrid = gridSize + quietCells * 2;
  const transform = squareToQuad(quad);
  const cells = new Uint8Array(gridSize * gridSize);
  const offsets = [-0.18, 0, 0.18];
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      let sum = 0;
      let samples = 0;
      for (const offsetY of offsets) {
        for (const offsetX of offsets) {
          const u = (x + quietCells + 0.5 + offsetX) / fullGrid;
          const v = (y + quietCells + 0.5 + offsetY) / fullGrid;
          const point = projectPoint(transform, u, v);
          const sourceX = Math.max(0, Math.min(imageData.width - 1, Math.round(point.x)));
          const sourceY = Math.max(0, Math.min(imageData.height - 1, Math.round(point.y)));
          sum += luminance(imageData.data, (sourceY * imageData.width + sourceX) * 4);
          samples += 1;
        }
      }
      cells[y * gridSize + x] = Math.round(sum / samples);
    }
  }
  return cells;
}

export function quadMotion(previous, current) {
  if (!previous || !current) return Infinity;
  const scale = Math.sqrt(Math.max(1, (polygonArea(previous) + polygonArea(current)) / 2));
  return previous.reduce((sum, point, index) => sum + distance(point, current[index]), 0) / (4 * scale);
}

// The transmitter emits phase A and then its inverse, phase B. Treating the
// stream as two independent "latest phase" slots causes B(n) to be paired with
// A(n+1) once per logical frame. This small state machine only emits ordered,
// adjacent A -> B pairs and discards orphaned B observations.
export class OrderedPhasePairer {
  constructor() {
    this.pendingA = null;
  }

  reset() {
    this.pendingA = null;
  }

  push(classification, metadata = {}) {
    const observation = { classification, ...metadata };
    if (!classification.inverted) {
      this.pendingA = observation;
      return { status: "armed", pair: null };
    }
    if (!this.pendingA) return { status: "orphan", pair: null };
    const pair = [this.pendingA, observation];
    this.pendingA = null;
    return { status: "paired", pair };
  }
}

export class OpticalTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.quad = null;
    this.misses = 0;
  }

  reset() {
    this.quad = null;
    this.misses = 0;
  }

  locate(imageData) {
    const detection = detectOpticalQuad(imageData, this.options);
    if (!detection) {
      this.misses += 1;
      if (!this.quad || this.misses > this.options.maxMisses) {
        this.quad = null;
        return null;
      }
      return { quad: this.quad.map((point) => ({ ...point })), confidence: 0.2, stale: true };
    }
    this.misses = 0;
    if (!this.quad || quadMotion(this.quad, detection.quad) > 0.22) {
      this.quad = detection.quad;
    } else {
      const alpha = this.options.smoothing;
      this.quad = this.quad.map((point, index) => ({
        x: point.x * (1 - alpha) + detection.quad[index].x * alpha,
        y: point.y * (1 - alpha) + detection.quad[index].y * alpha,
      }));
    }
    return { ...detection, quad: this.quad.map((point) => ({ ...point })), stale: false };
  }
}
