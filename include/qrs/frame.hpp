#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

namespace qrs {

inline constexpr std::array<std::uint8_t, 4> kFrameMagic{'Q', 'R', 'S', '0'};
inline constexpr std::uint8_t kProtocolVersion = 0;
inline constexpr std::size_t kFrameHeaderSize = 22;
inline constexpr std::size_t kFrameTrailerSize = 4;

enum class FrameType : std::uint8_t {
    manifest = 1,
    data = 2,
    end = 3,
};

struct Frame {
    FrameType type{FrameType::data};
    std::uint16_t flags{0};
    std::uint64_t session_id{0};
    std::uint32_t symbol_id{0};
    std::vector<std::uint8_t> payload;

    [[nodiscard]] bool operator==(const Frame&) const = default;
};

class FrameError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

[[nodiscard]] std::vector<std::uint8_t> serialize_frame(const Frame& frame);
[[nodiscard]] Frame parse_frame(std::span<const std::uint8_t> encoded);

}  // namespace qrs
