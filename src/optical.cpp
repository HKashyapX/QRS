#include "qrs/optical.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

namespace qrs {
namespace {

constexpr std::size_t kMarkerSize = 9;
constexpr std::array<std::string_view, 4> kMarkerCodes{
    "000000000", "111100000", "110011000", "101010100"};
constexpr std::string_view kPhaseWord = "10110100111001011000101100101110";

struct CornerCell {
    std::size_t marker;
    std::size_t x;
    std::size_t y;
};

std::optional<CornerCell> corner_cell(const std::size_t x, const std::size_t y) {
    if (x < kMarkerSize && y < kMarkerSize) return CornerCell{0, x, y};
    if (x >= kOpticalGridSize - kMarkerSize && y < kMarkerSize) {
        return CornerCell{1, x - (kOpticalGridSize - kMarkerSize), y};
    }
    if (x < kMarkerSize && y >= kOpticalGridSize - kMarkerSize) {
        return CornerCell{2, x, y - (kOpticalGridSize - kMarkerSize)};
    }
    if (x >= kOpticalGridSize - kMarkerSize && y >= kOpticalGridSize - kMarkerSize) {
        return CornerCell{3, x - (kOpticalGridSize - kMarkerSize),
                          y - (kOpticalGridSize - kMarkerSize)};
    }
    return std::nullopt;
}

std::optional<std::size_t> phase_pilot_index(const std::size_t x, const std::size_t y) {
    if (y == 0 && x >= 12 && x < 28) return x - 12;
    if (y == kOpticalGridSize - 1 && x >= 36 && x < 52) return 16 + x - 36;
    return std::nullopt;
}

bool in_corner(const std::size_t x, const std::size_t y) {
    const bool edge_x = x < kMarkerSize || x >= kOpticalGridSize - kMarkerSize;
    const bool edge_y = y < kMarkerSize || y >= kOpticalGridSize - kMarkerSize;
    return edge_x && edge_y;
}

bool reserved_cell(const std::size_t x, const std::size_t y) {
    return in_corner(x, y) || x == 0 || y == 0 || x == kOpticalGridSize - 1 ||
           y == kOpticalGridSize - 1;
}

bool marker_bit(const std::size_t x, const std::size_t y) {
    if (const auto corner = corner_cell(x, y)) {
        const auto local_x = corner->x;
        const auto local_y = corner->y;
        if (local_x == 0 || local_x == 8 || local_y == 0 || local_y == 8) return true;
        if (local_x == 1 || local_x == 7 || local_y == 1 || local_y == 7) return false;
        if (local_x == 2 || local_x == 6 || local_y == 2 || local_y == 6) return true;
        const auto code_index = (local_y - 3) * 3 + local_x - 3;
        return kMarkerCodes[corner->marker][code_index] == '1';
    }
    return ((x * 3U + y * 5U) % 7U) < 3U;
}

bool orientation_cell(const std::size_t x, const std::size_t y) {
    return reserved_cell(x, y) && !phase_pilot_index(x, y).has_value();
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
    std::size_t errors{std::numeric_limits<std::size_t>::max()};
};

Classification classify(const OpticalMatrix& observed) {
    Classification best;
    for (std::uint8_t rotation = 0; rotation < 4; ++rotation) {
        for (const bool mirrored : {false, true}) {
            std::size_t errors = 0;
            for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
                for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
                    if (!orientation_cell(x, y)) continue;
                    const auto [observed_x, observed_y] =
                        map_coordinate(x, y, {rotation, mirrored});
                    const bool actual = observed.at(observed_x, observed_y) >= 128;
                    if (actual != marker_bit(x, y)) ++errors;
                }
            }
            if (errors < best.errors) best = {{rotation, mirrored}, errors};
        }
    }

    std::size_t reserved_count = 0;
    for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
        for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
            if (orientation_cell(x, y)) ++reserved_count;
        }
    }
    if (best.errors > reserved_count / 5U) {
        throw OpticalError("optical orientation markers are not reliable enough");
    }
    return best;
}

bool phase_is_inverted(const OpticalMatrix& canonical) {
    std::size_t normal_errors = 0;
    std::size_t inverted_errors = 0;
    for (std::size_t y = 0; y < kOpticalGridSize; ++y) {
        for (std::size_t x = 0; x < kOpticalGridSize; ++x) {
            const auto index = phase_pilot_index(x, y);
            if (!index) continue;
            const bool actual = canonical.at(x, y) >= 128;
            const bool expected = kPhaseWord[*index] == '1';
            if (actual != expected) ++normal_errors;
            if (actual == expected) ++inverted_errors;
        }
    }
    if (std::min(normal_errors, inverted_errors) > kPhaseWord.size() / 3U) {
        throw OpticalError("optical phase pilot is not reliable enough");
    }
    return inverted_errors < normal_errors;
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
            if (reserved_cell(x, y)) {
                const auto pilot = phase_pilot_index(x, y);
                const bool value = pilot ? ((kPhaseWord[*pilot] == '1') != inverted)
                                         : marker_bit(x, y);
                matrix.at(x, y) = value ? 255 : 0;
            }
        }
    }
    for (std::size_t bit = 0; bit < coordinates.size(); ++bit) {
        bool value = false;
        if (bit < encoded.size() * 8U) {
            value = ((encoded[bit / 8U] >> (7U - (bit % 8U))) & 1U) != 0;
        }
        const auto [x, y] = coordinates[bit];
        matrix.at(x, y) = (value != inverted) ? 255 : 0;
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
    const auto normalized_first = normalize(first, first_classification.transform);
    const auto normalized_second = normalize(second, second_classification.transform);
    const auto first_inverted = phase_is_inverted(normalized_first);
    const auto second_inverted = phase_is_inverted(normalized_second);
    if (first_inverted == second_inverted) {
        throw OpticalError("optical pair contains two copies of the same phase");
    }
    const auto& phase_a = first_inverted ? normalized_second : normalized_first;
    const auto& phase_b = first_inverted ? normalized_first : normalized_second;

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
