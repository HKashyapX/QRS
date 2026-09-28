#include "qrs/optical.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

namespace qrs {
namespace {

using Marker = std::array<std::string_view, 7>;

constexpr Marker kTopLeft{
    "1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"};
constexpr Marker kTopRight{
    "1111111", "1000001", "1011001", "1001101", "1010011", "1000001", "1111111"};
constexpr Marker kBottomLeft{
    "1111111", "1011101", "1000101", "1110101", "1000101", "1011101", "1111111"};
constexpr Marker kBottomRight{
    "1111111", "1100011", "1010101", "1001001", "1010101", "1100011", "1111111"};

bool in_corner(const std::size_t x, const std::size_t y) {
    const bool edge_x = x < 7 || x >= kOpticalGridSize - 7;
    const bool edge_y = y < 7 || y >= kOpticalGridSize - 7;
    return edge_x && edge_y;
}

bool reserved_cell(const std::size_t x, const std::size_t y) {
    return in_corner(x, y) || x == 0 || y == 0 || x == kOpticalGridSize - 1 ||
           y == kOpticalGridSize - 1;
}

bool marker_bit(const std::size_t x, const std::size_t y) {
    if (x < 7 && y < 7) return kTopLeft[y][x] == '1';
    if (x >= kOpticalGridSize - 7 && y < 7) {
        return kTopRight[y][x - (kOpticalGridSize - 7)] == '1';
    }
    if (x < 7 && y >= kOpticalGridSize - 7) {
        return kBottomLeft[y - (kOpticalGridSize - 7)][x] == '1';
    }
    if (x >= kOpticalGridSize - 7 && y >= kOpticalGridSize - 7) {
        return kBottomRight[y - (kOpticalGridSize - 7)][x - (kOpticalGridSize - 7)] == '1';
    }
    return ((x * 3U + y * 5U) % 7U) < 3U;
}

std::pair<std::size_t, std::size_t> map_coordinate(std::size_t x, std::size_t y,
                                                   const OpticalTransform transform) {
    if (transform.mirrored) x = kOpticalGridSize - 1 - x;
    switch (transform.clockwise_quarters % 4U) {
        case 0: return {x, y};
        case 1: return {kOpticalGridSize - 1 - y, x};
        case 2: return {kOpticalGridSize - 1 - x, kOpticalGridSize - 1 - y};
        default: return {y, kOpticalGridSize - 1 - x};
    }
}

struct Classification {
    OpticalTransform transform;
    bool inverted{false};
    std::size_t errors{std::numeric_limits<std::size_t>::max()};
};

Classification classify(const OpticalMatrix& observed) {
    Classification best;
    for (std::uint8_t rotation = 0; rotation < 4; ++rotation) {
        for (const bool mirrored : {false, true}) {
            for (const bool inverted : {false, true}) {
                std::size_t errors = 0;
                for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
                    for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
                        if (!reserved_cell(x, y)) continue;
                        const auto [observed_x, observed_y] =
                            map_coordinate(x, y, {rotation, mirrored});
                        const bool actual = observed.at(observed_x, observed_y) >= 128;
                        const bool expected = marker_bit(x, y) != inverted;
                        if (actual != expected) ++errors;
                    }
                }
                if (errors < best.errors) best = {{rotation, mirrored}, inverted, errors};
            }
        }
    }

    std::size_t reserved_count = 0;
    for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
        for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
            if (reserved_cell(x, y)) ++reserved_count;
        }
    }
    if (best.errors > reserved_count / 5U) {
        throw OpticalError("optical orientation markers are not reliable enough");
    }
    return best;
}

OpticalMatrix normalize(const OpticalMatrix& observed, const OpticalTransform transform) {
    OpticalMatrix canonical;
    for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
        for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
            const auto [observed_x, observed_y] = map_coordinate(x, y, transform);
            canonical.at(x, y) = observed.at(observed_x, observed_y);
        }
    }
    return canonical;
}

std::vector<std::pair<std::size_t, std::size_t>> data_coordinates() {
    std::vector<std::pair<std::size_t, std::size_t>> coordinates;
    for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
        for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
            if (!reserved_cell(x, y)) coordinates.emplace_back(x, y);
        }
    }
    return coordinates;
}

}  // namespace

std::uint8_t& OpticalMatrix::at(const std::size_t x, const std::size_t y) {
    return cells.at(y * kOpticalGridSize + x);
}

std::uint8_t OpticalMatrix::at(const std::size_t x, const std::size_t y) const {
    return cells.at(y * kOpticalGridSize + x);
}

std::size_t optical_payload_capacity_bytes() { return data_coordinates().size() / 8U; }

OpticalMatrix encode_optical_phase(const Frame& frame, const bool inverted) {
    const auto encoded = serialize_frame(frame);
    const auto coordinates = data_coordinates();
    if (encoded.size() * 8U > coordinates.size()) {
        throw OpticalError("serialized frame exceeds optical matrix capacity");
    }

    OpticalMatrix matrix;
    for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
        for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
            if (reserved_cell(x, y)) matrix.at(x, y) = marker_bit(x, y) ? 255 : 0;
        }
    }
    for (std::size_t bit = 0; bit < coordinates.size(); ++bit) {
        bool value = false;
        if (bit < encoded.size() * 8U) {
            value = ((encoded[bit / 8U] >> (7U - (bit % 8U))) & 1U) != 0;
        }
        const auto [x, y] = coordinates[bit];
        matrix.at(x, y) = value ? 255 : 0;
    }
    if (inverted) {
        for (auto& cell : matrix.cells) cell = static_cast<std::uint8_t>(255U - cell);
    }
    return matrix;
}

OpticalMatrix transform_optical_matrix(const OpticalMatrix& canonical,
                                       const OpticalTransform transform) {
    OpticalMatrix observed;
    for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
        for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
            const auto [observed_x, observed_y] = map_coordinate(x, y, transform);
            observed.at(observed_x, observed_y) = canonical.at(x, y);
        }
    }
    return observed;
}

Frame decode_optical_pair(const OpticalMatrix& first, const OpticalMatrix& second,
                          const std::uint8_t minimum_contrast) {
    const auto first_classification = classify(first);
    const auto second_classification = classify(second);
    if (first_classification.inverted == second_classification.inverted) {
        throw OpticalError("optical pair contains two copies of the same phase");
    }

    const auto normalized_first = normalize(first, first_classification.transform);
    const auto normalized_second = normalize(second, second_classification.transform);
    const auto& phase_a = first_classification.inverted ? normalized_second : normalized_first;
    const auto& phase_b = first_classification.inverted ? normalized_first : normalized_second;

    const auto coordinates = data_coordinates();
    std::vector<std::uint8_t> decoded(coordinates.size() / 8U, 0);
    const auto usable_bits = decoded.size() * 8U;
    for (std::size_t bit = 0; bit < usable_bits; ++bit) {
        const auto [x, y] = coordinates[bit];
        const auto a = static_cast<int>(phase_a.at(x, y));
        const auto b = static_cast<int>(phase_b.at(x, y));
        if (std::abs(a - b) < minimum_contrast) {
            throw OpticalError("optical cell contrast is below the acceptance threshold");
        }
        if (a > b) decoded[bit / 8U] |= static_cast<std::uint8_t>(1U << (7U - bit % 8U));
    }

    if (decoded.size() < kFrameHeaderSize + kFrameTrailerSize) {
        throw OpticalError("optical matrix cannot contain a complete frame");
    }
    const auto payload_size = (static_cast<std::size_t>(decoded[20]) << 8U) | decoded[21];
    const auto frame_size = kFrameHeaderSize + payload_size + kFrameTrailerSize;
    if (frame_size > decoded.size()) throw OpticalError("optical frame length exceeds capacity");
    decoded.resize(frame_size);
    return parse_frame(decoded);
}

}  // namespace qrs
