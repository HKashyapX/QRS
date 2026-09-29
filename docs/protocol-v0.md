# QRS Protocol v0 — Transport Foundation

Status: development draft. The binary transport layer and controlled 64×64 optical mapping are
implemented. Automatic grid detection and perspective correction remain experimental boundaries.

## 1. Scope

Protocol v0 defines the object manifest, data-frame envelope, session separation, corruption
detection, and development fountain codec used between the QRS transmitter and receiver.

It does not yet define encryption, camera calibration, a frozen optical marker geometry, or browser
threading. Reserved identifiers allow those features to be added without changing the base frame.

All multi-byte integers use unsigned big-endian representation.

## 2. Processing order

1. Read the input object and construct a manifest.
2. Divide the object into fixed-size source symbols.
3. Generate systematic or repair symbols using the selected FEC codec.
4. Place one manifest or data symbol in each QRS frame.
5. Append CRC-32C to the complete frame.
6. Map the serialized frame into an optical matrix.
7. Display phase A and a phase-labelled inverse phase B.
8. Detect, align, pair, and decode the optical matrices.
9. Reject invalid CRCs, sessions, lengths, frame types, and duplicates.
10. Recover the original object and verify its final digest when digest support is enabled.

## 3. Base frame

| Offset | Size | Field | Meaning |
|---:|---:|---|---|
| 0 | 4 | magic | ASCII `QRS0` |
| 4 | 1 | version | Protocol version; currently `0` |
| 5 | 1 | frame type | `1=MANIFEST`, `2=DATA`, `3=END` |
| 6 | 2 | flags | Reserved; transmit as zero |
| 8 | 8 | session ID | Random, non-zero identifier for one transfer |
| 16 | 4 | symbol ID | FEC encoding-symbol identifier |
| 20 | 2 | payload length | Number of payload octets |
| 22 | N | payload | Manifest or FEC symbol bytes |
| 22+N | 4 | CRC-32C | CRC over offsets `0..21+N` |

Receivers must reject frames with incorrect magic, version, type, length, session ID, or CRC.
Protocol v0 senders transmit all flag bits as zero.

CRC-32C uses the Castagnoli polynomial in reflected form (`0x82F63B78`), initial state
`0xFFFFFFFF`, and final bitwise inversion. The check value for ASCII `123456789` is `0xE3069283`.

CRC-32C detects optical corruption; it is not a cryptographic authentication mechanism.

## 4. Frame types

### MANIFEST (`1`)

Carries the object manifest. It should be repeated periodically because the receiver cannot
interpret data symbols before learning the object and FEC parameters.

### DATA (`2`)

Carries exactly one fixed-size FEC encoding symbol. `symbol ID` determines the source-symbol
dependencies for the selected FEC codec.

The current live schedule sends an initial four-frame manifest burst, then periodically repeats the
manifest every 24 logical frames. Between manifests, two systematic symbols are sent for every new
repair symbol. Systematic IDs cycle continuously through `0..K-1`; dense repair IDs increase from
`0x80000000`.
This schedule is required because a simplex receiver may lock after the first systematic pass and
cannot request retransmission.

### END (`3`)

Optional sender hint indicating the end of a finite transmission budget. Fountain-mode senders
may continue indefinitely and omit this frame. Completion is always determined by the receiver.

## 5. Manifest payload

| Offset | Size | Field | Meaning |
|---:|---:|---|---|
| 0 | 8 | object size | Exact original object length in octets |
| 8 | 2 | symbol size | Fixed source/encoding-symbol size |
| 10 | 4 | source count | `ceil(object size / symbol size)` |
| 14 | 1 | FEC codec | `1=deterministic LT`, `2=RaptorQ` reserved |
| 15 | 1 | crypto suite | `0=none`, `1=AES-256-GCM`, `2=XChaCha20-Poly1305` |
| 16 | 2 | filename length | Filename length in octets, maximum 255 |
| 18 | 32 | SHA-256 | Object digest; all zero until digest support is enabled |
| 50 | N | filename | Sanitized UTF-8 filename without path components |

Receivers must never treat a transmitted filename as a filesystem path. Path separators,
platform-reserved characters, control bytes, empty names, `.` and `..` are replaced or rejected.

## 6. Development FEC codec (`1`)

Codec `1` is a deterministic LT-style development codec. It exists to unblock the MVP and is not
claimed to be RaptorQ or a standards-compliant LT profile. Its interface permits replacement with
RaptorQ after WASM and licensing evaluation.

The object is zero-padded to `K` source symbols of `T` octets. The receiver trims the recovered
object to the exact manifest length.

### Systematic symbols

For symbol IDs `0 <= ID < K`, the symbol payload is source symbol `ID` unchanged.

### Repair symbols

For `K <= ID < 0x80000000`, initialize a 64-bit SplitMix64 state as:

```text
state = 0x5152532D4C542D30 XOR ID
```

Each random value uses the standard SplitMix64 transition:

```text
state += 0x9E3779B97F4A7C15
z = state
z = (z XOR (z >> 30)) * 0xBF58476D1CE4E5B9
z = (z XOR (z >> 27)) * 0x94D049BB133111EB
result = z XOR (z >> 31)
```

Using `roll = next() mod 100`, select degree:

| Roll | Degree |
|---:|---:|
| 0–44 | 1 |
| 45–79 | 2 |
| 80–93 | 3 |
| 94–99 | Uniformly selected from 4 through `min(8,K)` |

The degree is capped at `K`. Repeatedly select `next() mod K`, discarding duplicate indices, until
the degree is reached. Sort the selected indices and XOR the corresponding source symbols.

For `ID >= 0x80000000`, initialize the same SplitMix64 state. Begin with `ceil(K / 2)` and, when
that value is even and below `K`, add one so the fixed row weight is odd. Select that many distinct
dependencies with repeated `next() mod K` draws. These dense repair rows are reserved for tail
recovery. The browser schedule emits increasing dense IDs beginning at `0x80000000`.

The receiver uses peeling propagation first, rejects duplicate symbol IDs, and bounds stored
equations. When at most 64 source symbols remain and at least that many equations are retained, it
performs GF(2) elimination on the tail system and resumes peeling.

## 7. Session rules

- Each transfer uses a freshly generated, random, non-zero 64-bit session ID.
- The receiver binds to one accepted manifest session.
- Frames from other sessions are ignored.
- Repeated symbol IDs within a session are ignored.
- A later encrypted protocol revision may increase the session identifier width or bind it as AEAD
  additional authenticated data.

## 8. Optical matrix

Each phase is a 64×64 monochrome cell matrix. Four 9×9 corner anchors and the remaining outer
border cells are reserved. The other cells are filled in row-major order, providing 448 full
payload bytes. Unused data cells are zero in phase A.

Each corner anchor has a one-cell white separator, black outer ring, white inner ring, and unique
3×3 identifier. In top-left, top-right, bottom-left, bottom-right order the row-major identifiers
are `000000000`, `111100000`, `110011000`, and `101010100`. Anchor and timing-border cells remain
unchanged between phases so orientation can be recognized independently of phase polarity.

For reserved outer-border cells not inside a corner marker, phase-A value is one when
`((3*x + 5*y) mod 7) < 3`, otherwise zero.

Two 16-cell outer-border spans carry the 32-bit phase pilot
`10110100111001011000101100101110`; the pilot and data cells invert in phase B. The receiver
evaluates all four rotations, mirrored and unmirrored, against the static anchors, then uses the
pilot to label the normalized phase.
After normalization, a data bit is one when its phase-A intensity is greater than its phase-B
intensity. Cells below the configured difference threshold cause the frame to be erased.

The displayed envelope adds a three-cell white quiet zone and a three-cell black guard band around
the 64×64 matrix. The black guard makes the white boundary observable even when the sender is
fullscreen. The browser receiver automatically detects that 70×70 white symbol boundary, reuses a
tracked projective mapping between detector runs, and retains manual alignment as a fallback.

## 9. Automatic optical-layer boundary

The original Phase 1 `absdiff(data, inverse)` method cannot recover bit polarity because both bit
transitions produce the same absolute magnitude. The corrected layer must use signed temporal
difference plus an unambiguous phase label.

Before freezing cell positions, the optical simulator must demonstrate:

- Reliable phase A/B pairing with dropped and duplicated camera frames.
- Orientation under all four rotations and mirrored camera input.
- Ordered homography corners.
- Cell confidence scoring and erasure rejection.
- Recovery under blur, glare, exposure drift, perspective distortion, and rolling shutter.
- A payload capacity large enough for the 22-byte header, one FEC symbol, and four-byte CRC.

## 10. Security boundary

Protocol v0 currently uses crypto suite `0` and provides no confidentiality. CRC-32C and future
SHA-256 checks do not prevent deliberate modification or recorded-footage recovery.

The planned security layer encrypts the object before FEC encoding and binds the public manifest
fields as authenticated additional data. Until implemented, QRS must display an unencrypted
prototype warning.
