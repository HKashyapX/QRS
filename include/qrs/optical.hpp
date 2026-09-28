#pragma once

#include "qrs/frame.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace qrs {

inline constexpr std::size_t kOpticalGridSize = 64;
inline constexpr std::size_t kOpticalCellCount = kOpticalGridSize * kOpticalGridSize;

struct OpticalMatrix {
    std::array<std::uint8_t, kOpticalCellCount> cells{};

    std::uint8_t& at(std::size_t x, std::size_t y);
    [[nodiscard]] std::uint8_t at(std::size_t x, std::size_t y) const;
};

struct OpticalTransform {
    std::uint8_t clockwise_quarters{0};
    bool mirrored{false};
};

class OpticalError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

[[nodiscard]] std::size_t optical_payload_capacity_bytes();
[[nodiscard]] OpticalMatrix encode_optical_phase(const Frame& frame, bool inverted);
[[nodiscard]] OpticalMatrix transform_optical_matrix(const OpticalMatrix& canonical,
                                                     OpticalTransform transform);
[[nodiscard]] Frame decode_optical_pair(const OpticalMatrix& first,
                                        const OpticalMatrix& second,
                                        std::uint8_t minimum_contrast = 64);

}  // namespace qrs
