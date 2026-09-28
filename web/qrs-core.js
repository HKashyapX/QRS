export const GRID_SIZE = 64;
export const QUIET_CELLS = 3;
export const GUARD_CELLS = 3;
export const DISPLAY_GRID_SIZE = GRID_SIZE + QUIET_CELLS * 2;
export const CANVAS_GRID_SIZE = DISPLAY_GRID_SIZE + GUARD_CELLS * 2;
export const FRAME_HEADER_SIZE = 22;
export const FRAME_TRAILER_SIZE = 4;
export const FRAME_TYPE = Object.freeze({ MANIFEST: 1, DATA: 2, END: 3 });
export const FEC_CODEC = Object.freeze({ DETERMINISTIC_LT: 1, RAPTORQ: 2 });
export const CRYPTO_SUITE = Object.freeze({ NONE: 0, AES_256_GCM: 1, XCHACHA20_POLY1305: 2 });

const MAGIC = new Uint8Array([0x51, 0x52, 0x53, 0x30]);
const VERSION = 0;
const MASK64 = (1n << 64n) - 1n;

export function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = ((crc >>> 1) ^ (0x82f63b78 & mask)) >>> 0;
    }
  }
  return (~crc) >>> 0;
}

export function randomSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value === 0n ? 1n : value;
}

export function serializeFrame(frame) {
  if (frame.sessionId === 0n) throw new Error("Session ID must be non-zero");
  if (frame.payload.length > 0xffff) throw new Error("Frame payload is too large");
  const encoded = new Uint8Array(FRAME_HEADER_SIZE + frame.payload.length + FRAME_TRAILER_SIZE);
  const view = new DataView(encoded.buffer);
  encoded.set(MAGIC, 0);
  encoded[4] = VERSION;
  encoded[5] = frame.type;
  view.setUint16(6, frame.flags ?? 0, false);
  view.setBigUint64(8, frame.sessionId, false);
  view.setUint32(16, frame.symbolId >>> 0, false);
  view.setUint16(20, frame.payload.length, false);
  encoded.set(frame.payload, FRAME_HEADER_SIZE);
  view.setUint32(encoded.length - FRAME_TRAILER_SIZE,
    crc32c(encoded.subarray(0, encoded.length - FRAME_TRAILER_SIZE)), false);
  return encoded;
}

export function parseFrame(encoded) {
  if (encoded.length < FRAME_HEADER_SIZE + FRAME_TRAILER_SIZE) throw new Error("Frame is truncated");
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (encoded[i] !== MAGIC[i]) throw new Error("Invalid frame magic");
  }
  if (encoded[4] !== VERSION) throw new Error("Unsupported protocol version");
  if (encoded[5] < FRAME_TYPE.MANIFEST || encoded[5] > FRAME_TYPE.END) {
    throw new Error("Unknown frame type");
  }
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const payloadLength = view.getUint16(20, false);
  if (encoded.length !== FRAME_HEADER_SIZE + payloadLength + FRAME_TRAILER_SIZE) {
    throw new Error("Frame length mismatch");
  }
  const expectedCrc = view.getUint32(encoded.length - FRAME_TRAILER_SIZE, false);
  const actualCrc = crc32c(encoded.subarray(0, encoded.length - FRAME_TRAILER_SIZE));
  if (expectedCrc !== actualCrc) throw new Error("CRC-32C validation failed");
  const sessionId = view.getBigUint64(8, false);
  if (sessionId === 0n) throw new Error("Session ID must be non-zero");
  return {
    type: encoded[5],
    flags: view.getUint16(6, false),
    sessionId,
    symbolId: view.getUint32(16, false),
    payload: encoded.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + payloadLength),
  };
}

export function safeFilename(input) {
  const basename = String(input).split(/[\\/]/).pop() ?? "";
  const safe = [...basename].map((character) => {
    const code = character.codePointAt(0);
    return code < 32 || /[<>:"/\\|?*]/.test(character) ? "_" : character;
  }).join("").slice(0, 255);
  return !safe || safe === "." || safe === ".." ? "received.bin" : safe;
}

export function serializeManifest(manifest) {
  const filename = new TextEncoder().encode(safeFilename(manifest.filename));
  if (filename.length > 255) throw new Error("Filename is too long");
  const encoded = new Uint8Array(50 + filename.length);
  const view = new DataView(encoded.buffer);
  view.setBigUint64(0, BigInt(manifest.objectSize), false);
  view.setUint16(8, manifest.symbolSize, false);
  view.setUint32(10, manifest.sourceSymbolCount, false);
  encoded[14] = manifest.fecCodec ?? FEC_CODEC.DETERMINISTIC_LT;
  encoded[15] = manifest.cryptoSuite ?? CRYPTO_SUITE.NONE;
  view.setUint16(16, filename.length, false);
  encoded.set(manifest.sha256 ?? new Uint8Array(32), 18);
  encoded.set(filename, 50);
  return encoded;
}

export function parseManifest(encoded) {
  if (encoded.length < 50) throw new Error("Manifest is truncated");
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const filenameLength = view.getUint16(16, false);
  if (filenameLength > 255 || encoded.length !== 50 + filenameLength) {
    throw new Error("Manifest filename length is invalid");
  }
  const manifest = {
    objectSize: Number(view.getBigUint64(0, false)),
    symbolSize: view.getUint16(8, false),
    sourceSymbolCount: view.getUint32(10, false),
    fecCodec: encoded[14],
    cryptoSuite: encoded[15],
    sha256: encoded.slice(18, 50),
    filename: new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(50)),
  };
  const expectedCount = manifest.objectSize === 0
    ? 0
    : Math.ceil(manifest.objectSize / manifest.symbolSize);
  if (!manifest.symbolSize || expectedCount !== manifest.sourceSymbolCount) {
    throw new Error("Manifest dimensions are inconsistent");
  }
  if (safeFilename(manifest.filename) !== manifest.filename) throw new Error("Unsafe manifest filename");
  return manifest;
}

function nextSplitMix64(state) {
  state.value = (state.value + 0x9e3779b97f4a7c15n) & MASK64;
  let value = state.value;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (value ^ (value >> 31n)) & MASK64;
}

function dependenciesFor(symbolId, sourceCount) {
  if (sourceCount === 0) return [];
  if (symbolId < sourceCount) return [symbolId];
  const state = { value: (0x5152532d4c542d30n ^ BigInt(symbolId)) & MASK64 };
  const roll = Number(nextSplitMix64(state) % 100n);
  let degree = roll < 45 ? 1 : roll < 80 ? 2 : roll < 94 ? 3 : 4;
  if (roll >= 94) {
    const maximum = Math.min(8, sourceCount);
    degree = maximum <= 4 ? maximum : 4 + Number(nextSplitMix64(state) % BigInt(maximum - 3));
  }
  degree = Math.min(degree, sourceCount);
  const dependencies = [];
  while (dependencies.length < degree) {
    const candidate = Number(nextSplitMix64(state) % BigInt(sourceCount));
    if (!dependencies.includes(candidate)) dependencies.push(candidate);
  }
  return dependencies.sort((a, b) => a - b);
}

function xorInto(destination, source) {
  for (let i = 0; i < destination.length; i += 1) destination[i] ^= source[i];
}

export class LtEncoder {
  constructor(object, symbolSize = 256) {
    if (!symbolSize || symbolSize > 0xffff) throw new Error("Invalid symbol size");
    this.objectSize = object.length;
    this.symbolSize = symbolSize;
    this.sourceSymbolCount = object.length === 0 ? 0 : Math.ceil(object.length / symbolSize);
    this.sourceSymbols = Array.from({ length: this.sourceSymbolCount }, () => new Uint8Array(symbolSize));
    for (let i = 0; i < object.length; i += 1) {
      this.sourceSymbols[Math.floor(i / symbolSize)][i % symbolSize] = object[i];
    }
  }

  encode(symbolId) {
    if (!this.sourceSymbolCount) throw new Error("Empty object has no encoding symbols");
    const payload = new Uint8Array(this.symbolSize);
    for (const dependency of dependenciesFor(symbolId, this.sourceSymbolCount)) {
      xorInto(payload, this.sourceSymbols[dependency]);
    }
    return payload;
  }
}

export class LtDecoder {
  constructor(manifest) {
    this.objectSize = manifest.objectSize;
    this.symbolSize = manifest.symbolSize;
    this.sourceSymbolCount = manifest.sourceSymbolCount;
    this.resolved = Array(this.sourceSymbolCount).fill(null);
    this.equations = [];
    this.seen = new Set();
    this.resolvedCount = 0;
  }

  get complete() { return this.resolvedCount === this.sourceSymbolCount; }

  add(symbolId, payload) {
    if (this.complete || this.seen.has(symbolId)) return false;
    if (payload.length !== this.symbolSize) throw new Error("Incorrect encoding-symbol size");
    this.seen.add(symbolId);
    const equation = { dependencies: dependenciesFor(symbolId, this.sourceSymbolCount), payload: payload.slice() };
    equation.dependencies = equation.dependencies.filter((dependency) => {
      if (!this.resolved[dependency]) return true;
      xorInto(equation.payload, this.resolved[dependency]);
      return false;
    });
    if (equation.dependencies.length) this.equations.push(equation);
    this.propagate();
    return true;
  }

  propagate() {
    while (true) {
      const index = this.equations.findIndex((equation) => equation.dependencies.length === 1);
      if (index < 0) break;
      const [equation] = this.equations.splice(index, 1);
      const resolvedIndex = equation.dependencies[0];
      if (!this.resolved[resolvedIndex]) {
        this.resolved[resolvedIndex] = equation.payload;
        this.resolvedCount += 1;
      }
      for (const other of this.equations) {
        const dependencyIndex = other.dependencies.indexOf(resolvedIndex);
        if (dependencyIndex >= 0) {
          xorInto(other.payload, this.resolved[resolvedIndex]);
          other.dependencies.splice(dependencyIndex, 1);
        }
      }
      this.equations = this.equations.filter((item) => item.dependencies.length);
    }
  }

  recover() {
    if (!this.complete) throw new Error("Object is incomplete");
    const output = new Uint8Array(this.objectSize);
    let offset = 0;
    for (const symbol of this.resolved) {
      const length = Math.min(symbol.length, output.length - offset);
      output.set(symbol.subarray(0, length), offset);
      offset += length;
    }
    return output;
  }
}

const MARKER_SIZE = 9;
const MARKER_CODES = ["000000000", "111100000", "110011000", "101010100"];
const PHASE_WORD = "10110100111001011000101100101110";

function cornerMarker(x, y) {
  if (x < MARKER_SIZE && y < MARKER_SIZE) return { index: 0, x, y };
  if (x >= GRID_SIZE - MARKER_SIZE && y < MARKER_SIZE) {
    return { index: 1, x: x - (GRID_SIZE - MARKER_SIZE), y };
  }
  if (x < MARKER_SIZE && y >= GRID_SIZE - MARKER_SIZE) {
    return { index: 2, x, y: y - (GRID_SIZE - MARKER_SIZE) };
  }
  if (x >= GRID_SIZE - MARKER_SIZE && y >= GRID_SIZE - MARKER_SIZE) {
    return { index: 3, x: x - (GRID_SIZE - MARKER_SIZE), y: y - (GRID_SIZE - MARKER_SIZE) };
  }
  return null;
}

function inCorner(x, y) {
  return cornerMarker(x, y) !== null;
}

function reservedCell(x, y) {
  return inCorner(x, y) || x === 0 || y === 0 || x === GRID_SIZE - 1 || y === GRID_SIZE - 1;
}

function phasePilotIndex(x, y) {
  if (y === 0 && x >= 12 && x < 28) return x - 12;
  if (y === GRID_SIZE - 1 && x >= 36 && x < 52) return 16 + x - 36;
  return -1;
}

function orientationCell(x, y) {
  return reservedCell(x, y) && phasePilotIndex(x, y) < 0;
}

function markerBit(x, y) {
  const marker = cornerMarker(x, y);
  if (marker) {
    // White separator, black outer ring, white inner ring, then a 3x3 ID.
    if (marker.x === 0 || marker.y === 0 || marker.x === 8 || marker.y === 8) return true;
    if (marker.x === 1 || marker.y === 1 || marker.x === 7 || marker.y === 7) return false;
    if (marker.x === 2 || marker.y === 2 || marker.x === 6 || marker.y === 6) return true;
    return MARKER_CODES[marker.index][(marker.y - 3) * 3 + marker.x - 3] === "1";
  }
  return ((x * 3 + y * 5) % 7) < 3;
}

function mapCoordinate(x, y, rotation, mirrored) {
  if (mirrored) x = GRID_SIZE - 1 - x;
  if (rotation === 0) return [x, y];
  if (rotation === 1) return [GRID_SIZE - 1 - y, x];
  if (rotation === 2) return [GRID_SIZE - 1 - x, GRID_SIZE - 1 - y];
  return [y, GRID_SIZE - 1 - x];
}

const DATA_COORDINATES = [];
let ORIENTATION_COUNT = 0;
for (let y = 0; y < GRID_SIZE; y += 1) {
  for (let x = 0; x < GRID_SIZE; x += 1) {
    if (!reservedCell(x, y)) DATA_COORDINATES.push([x, y]);
    if (orientationCell(x, y)) ORIENTATION_COUNT += 1;
  }
}

export const OPTICAL_CAPACITY_BYTES = Math.floor(DATA_COORDINATES.length / 8);

export function encodeOpticalPhase(frame, inverted = false) {
  const bytes = serializeFrame(frame);
  if (bytes.length > OPTICAL_CAPACITY_BYTES) throw new Error("Frame exceeds optical capacity");
  const cells = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      if (reservedCell(x, y)) cells[y * GRID_SIZE + x] = markerBit(x, y) ? 255 : 0;
    }
  }
  DATA_COORDINATES.forEach(([x, y], bit) => {
    const value = bit < bytes.length * 8
      ? (bytes[Math.floor(bit / 8)] >> (7 - (bit % 8))) & 1
      : 0;
    const transmitted = inverted ? !value : value;
    cells[y * GRID_SIZE + x] = transmitted ? 255 : 0;
  });
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const pilot = phasePilotIndex(x, y);
      if (pilot < 0) continue;
      const value = PHASE_WORD[pilot] === "1";
      cells[y * GRID_SIZE + x] = (value !== inverted) ? 255 : 0;
    }
  }
  return cells;
}

export function transformOpticalMatrix(canonical, rotation = 0, mirrored = false) {
  const observed = new Uint8Array(canonical.length);
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const [observedX, observedY] = mapCoordinate(x, y, rotation, mirrored);
      observed[observedY * GRID_SIZE + observedX] = canonical[y * GRID_SIZE + x];
    }
  }
  return observed;
}

export function classifyOptical(cells) {
  let best = null;
  for (let rotation = 0; rotation < 4; rotation += 1) {
    for (const mirrored of [false, true]) {
      let whiteSum = 0;
      let blackSum = 0;
      let whiteCount = 0;
      let blackCount = 0;
      for (let y = 0; y < GRID_SIZE; y += 1) {
        for (let x = 0; x < GRID_SIZE; x += 1) {
          if (!orientationCell(x, y)) continue;
          const [observedX, observedY] = mapCoordinate(x, y, rotation, mirrored);
          const value = cells[observedY * GRID_SIZE + observedX];
          if (markerBit(x, y)) { whiteSum += value; whiteCount += 1; }
          else { blackSum += value; blackCount += 1; }
        }
      }
      const whiteMean = whiteSum / whiteCount;
      const blackMean = blackSum / blackCount;
      const threshold = (whiteMean + blackMean) / 2;
      let errors = 0;
      for (let y = 0; y < GRID_SIZE; y += 1) {
        for (let x = 0; x < GRID_SIZE; x += 1) {
          if (!orientationCell(x, y)) continue;
          const [observedX, observedY] = mapCoordinate(x, y, rotation, mirrored);
          const actual = cells[observedY * GRID_SIZE + observedX] >= threshold;
          if (actual !== markerBit(x, y)) errors += 1;
        }
      }
      const contrast = whiteMean - blackMean;
      if (!best || errors < best.errors || (errors === best.errors && contrast > best.contrast)) {
        best = { rotation, mirrored, errors, contrast, threshold };
      }
    }
  }
  if (best.contrast < 28) throw new Error("Orientation marker contrast is too low");
  if (best.errors > ORIENTATION_COUNT / 4) throw new Error("Orientation markers were not recognized");
  const normalized = new Uint8Array(cells.length);
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const [observedX, observedY] = mapCoordinate(x, y, best.rotation, best.mirrored);
      normalized[y * GRID_SIZE + x] = cells[observedY * GRID_SIZE + observedX];
    }
  }
  let phaseAErrors = 0;
  let phaseBErrors = 0;
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const pilot = phasePilotIndex(x, y);
      if (pilot < 0) continue;
      const actual = normalized[y * GRID_SIZE + x] >= best.threshold;
      const expectedA = PHASE_WORD[pilot] === "1";
      if (actual !== expectedA) phaseAErrors += 1;
      if (actual === expectedA) phaseBErrors += 1;
    }
  }
  const inverted = phaseBErrors < phaseAErrors;
  const phaseErrors = Math.min(phaseAErrors, phaseBErrors);
  if (phaseErrors > PHASE_WORD.length / 3) throw new Error("Optical phase pilot was not recognized");
  return { ...best, inverted, phaseErrors, normalized, contrast: Math.round(best.contrast) };
}

export function decodeOpticalPair(firstClassification, secondClassification, minimumContrast = 32) {
  if (firstClassification.inverted === secondClassification.inverted) {
    throw new Error("Two identical optical phases cannot form a pair");
  }
  const phaseA = firstClassification.inverted ? secondClassification.normalized : firstClassification.normalized;
  const phaseB = firstClassification.inverted ? firstClassification.normalized : secondClassification.normalized;
  const decoded = new Uint8Array(OPTICAL_CAPACITY_BYTES);
  for (let bit = 0; bit < decoded.length * 8; bit += 1) {
    const [x, y] = DATA_COORDINATES[bit];
    const a = phaseA[y * GRID_SIZE + x];
    const b = phaseB[y * GRID_SIZE + x];
    if (Math.abs(a - b) < minimumContrast) throw new Error("Cell contrast is too low");
    if (a > b) decoded[Math.floor(bit / 8)] |= 1 << (7 - (bit % 8));
  }
  const payloadLength = new DataView(decoded.buffer).getUint16(20, false);
  const frameLength = FRAME_HEADER_SIZE + payloadLength + FRAME_TRAILER_SIZE;
  if (frameLength > decoded.length) throw new Error("Decoded frame length exceeds capacity");
  return parseFrame(decoded.slice(0, frameLength));
}

export function drawOpticalMatrix(canvas, cells) {
  const context = canvas.getContext("2d", { alpha: false });
  const cellSize = Math.floor(canvas.width / CANVAS_GRID_SIZE);
  const canvasGridPixels = cellSize * CANVAS_GRID_SIZE;
  const canvasOrigin = Math.floor((canvas.width - canvasGridPixels) / 2);
  const whiteOrigin = canvasOrigin + GUARD_CELLS * cellSize;
  const whiteSize = DISPLAY_GRID_SIZE * cellSize;
  const originX = whiteOrigin + QUIET_CELLS * cellSize;
  const originY = whiteOrigin + QUIET_CELLS * cellSize;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(whiteOrigin, whiteOrigin, whiteSize, whiteSize);
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      context.fillStyle = cells[y * GRID_SIZE + x] >= 128 ? "#ffffff" : "#000000";
      context.fillRect(originX + x * cellSize, originY + y * cellSize, cellSize, cellSize);
    }
  }
}
