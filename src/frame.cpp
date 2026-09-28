#include "qrs/frame.hpp"

#include "qrs/crc32c.hpp"

#include <algorithm>
#include <limits>
#include <string>

namespace qrs {
namespace {

void append_u16(std::vector<std::uint8_t>& out, const std::uint16_t value) {
    out.push_back(static_cast<std::uint8_t>(value >> 8U));
    out.push_back(static_cast<std::uint8_t>(value));
}

void append_u32(std::vector<std::uint8_t>& out, const std::uint32_t value) {
    for (int shift = 24; shift >= 0; shift -= 8) {
        out.push_back(static_cast<std::uint8_t>(value >> static_cast<unsigned>(shift)));
    }
}

void append_u64(std::vector<std::uint8_t>& out, const std::uint64_t value) {
    for (int shift = 56; shift >= 0; shift -= 8) {
        out.push_back(static_cast<std::uint8_t>(value >> static_cast<unsigned>(shift)));
    }
}

std::uint16_t read_u16(const std::span<const std::uint8_t> bytes, const std::size_t offset) {
    return static_cast<std::uint16_t>((static_cast<std::uint16_t>(bytes[offset]) << 8U) |
                                      bytes[offset + 1]);
}

std::uint32_t read_u32(const std::span<const std::uint8_t> bytes, const std::size_t offset) {
    std::uint32_t value = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        value = (value << 8U) | bytes[offset + i];
    }
    return value;
}

std::uint64_t read_u64(const std::span<const std::uint8_t> bytes, const std::size_t offset) {
    std::uint64_t value = 0;
    for (std::size_t i = 0; i < 8; ++i) {
        value = (value << 8U) | bytes[offset + i];
    }
    return value;
}

bool valid_frame_type(const std::uint8_t value) {
    return value >= static_cast<std::uint8_t>(FrameType::manifest) &&
           value <= static_cast<std::uint8_t>(FrameType::end);
}

}  // namespace

std::vector<std::uint8_t> serialize_frame(const Frame& frame) {
    if (frame.session_id == 0) {
        throw FrameError("session ID must be non-zero");
    }
    if (frame.payload.size() > std::numeric_limits<std::uint16_t>::max()) {
        throw FrameError("frame payload exceeds 65535 bytes");
    }

    std::vector<std::uint8_t> encoded;
    encoded.reserve(kFrameHeaderSize + frame.payload.size() + kFrameTrailerSize);
    encoded.insert(encoded.end(), kFrameMagic.begin(), kFrameMagic.end());
    encoded.push_back(kProtocolVersion);
    encoded.push_back(static_cast<std::uint8_t>(frame.type));
    append_u16(encoded, frame.flags);
    append_u64(encoded, frame.session_id);
    append_u32(encoded, frame.symbol_id);
    append_u16(encoded, static_cast<std::uint16_t>(frame.payload.size()));
    encoded.insert(encoded.end(), frame.payload.begin(), frame.payload.end());
    append_u32(encoded, crc32c(encoded));
    return encoded;
}

Frame parse_frame(const std::span<const std::uint8_t> encoded) {
    if (encoded.size() < kFrameHeaderSize + kFrameTrailerSize) {
        throw FrameError("frame is shorter than the minimum frame size");
    }
    if (!std::equal(kFrameMagic.begin(), kFrameMagic.end(), encoded.begin())) {
        throw FrameError("invalid frame magic");
    }
    if (encoded[4] != kProtocolVersion) {
        throw FrameError("unsupported protocol version");
    }
    if (!valid_frame_type(encoded[5])) {
        throw FrameError("unknown frame type");
    }

    const auto payload_size = static_cast<std::size_t>(read_u16(encoded, 20));
    const auto expected_size = kFrameHeaderSize + payload_size + kFrameTrailerSize;
    if (encoded.size() != expected_size) {
        throw FrameError("frame length does not match its payload length");
    }

    const auto transmitted_crc = read_u32(encoded, encoded.size() - kFrameTrailerSize);
    const auto calculated_crc = crc32c(encoded.first(encoded.size() - kFrameTrailerSize));
    if (transmitted_crc != calculated_crc) {
        throw FrameError("CRC-32C validation failed");
    }

    Frame frame;
    frame.type = static_cast<FrameType>(encoded[5]);
    frame.flags = read_u16(encoded, 6);
    frame.session_id = read_u64(encoded, 8);
    if (frame.session_id == 0) {
        throw FrameError("session ID must be non-zero");
    }
    frame.symbol_id = read_u32(encoded, 16);
    frame.payload.assign(encoded.begin() + static_cast<std::ptrdiff_t>(kFrameHeaderSize),
                         encoded.end() - static_cast<std::ptrdiff_t>(kFrameTrailerSize));
    return frame;
}

}  // namespace qrs
