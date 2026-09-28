#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace qrs {

enum class FecCodec : std::uint8_t {
    deterministic_lt = 1,
    raptorq = 2,
};

enum class CryptoSuite : std::uint8_t {
    none = 0,
    aes_256_gcm = 1,
    xchacha20_poly1305 = 2,
};

struct Manifest {
    std::uint64_t object_size{0};
    std::uint16_t symbol_size{0};
    std::uint32_t source_symbol_count{0};
    FecCodec fec_codec{FecCodec::deterministic_lt};
    CryptoSuite crypto_suite{CryptoSuite::none};
    std::array<std::uint8_t, 32> sha256{};
    std::string filename;

    [[nodiscard]] bool operator==(const Manifest&) const = default;
};

class ManifestError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

[[nodiscard]] std::vector<std::uint8_t> serialize_manifest(const Manifest& manifest);
[[nodiscard]] Manifest parse_manifest(std::span<const std::uint8_t> encoded);
[[nodiscard]] std::string safe_filename(std::string_view filename);

}  // namespace qrs
