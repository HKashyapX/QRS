#include "qrs/manifest.hpp"

#include <algorithm>
#include <limits>

namespace qrs {
namespace {

inline constexpr std::size_t kFixedManifestSize = 50;
inline constexpr std::size_t kMaximumFilenameSize = 255;

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
    for (std::size_t i = 0; i < 4; ++i) value = (value << 8U) | bytes[offset + i];
    return value;
}

std::uint64_t read_u64(const std::span<const std::uint8_t> bytes, const std::size_t offset) {
    std::uint64_t value = 0;
    for (std::size_t i = 0; i < 8; ++i) value = (value << 8U) | bytes[offset + i];
    return value;
}

void validate_dimensions(const Manifest& manifest) {
    if (manifest.symbol_size == 0) throw ManifestError("symbol size must be non-zero");
    const auto expected = manifest.object_size == 0
                              ? 0ULL
                              : (manifest.object_size + manifest.symbol_size - 1ULL) /
                                    manifest.symbol_size;
    if (expected != manifest.source_symbol_count) {
        throw ManifestError("source symbol count does not match object and symbol sizes");
    }
}

}  // namespace

std::string safe_filename(const std::string_view filename) {
    const auto separator = filename.find_last_of("/\\");
    const auto basename = separator == std::string_view::npos ? filename : filename.substr(separator + 1);

    std::string safe;
    safe.reserve(std::min(basename.size(), kMaximumFilenameSize));
    constexpr std::string_view forbidden = "<>:\"/\\|?*";
    for (const unsigned char ch : basename) {
        if (safe.size() == kMaximumFilenameSize) break;
        safe.push_back(ch < 32 || forbidden.find(static_cast<char>(ch)) != std::string_view::npos
                           ? '_'
                           : static_cast<char>(ch));
    }
    if (safe.empty() || safe == "." || safe == "..") return "received.bin";
    return safe;
}

std::vector<std::uint8_t> serialize_manifest(const Manifest& manifest) {
    validate_dimensions(manifest);
    const auto filename = safe_filename(manifest.filename);

    std::vector<std::uint8_t> encoded;
    encoded.reserve(kFixedManifestSize + filename.size());
    append_u64(encoded, manifest.object_size);
    append_u16(encoded, manifest.symbol_size);
    append_u32(encoded, manifest.source_symbol_count);
    encoded.push_back(static_cast<std::uint8_t>(manifest.fec_codec));
    encoded.push_back(static_cast<std::uint8_t>(manifest.crypto_suite));
    append_u16(encoded, static_cast<std::uint16_t>(filename.size()));
    encoded.insert(encoded.end(), manifest.sha256.begin(), manifest.sha256.end());
    encoded.insert(encoded.end(), filename.begin(), filename.end());
    return encoded;
}

Manifest parse_manifest(const std::span<const std::uint8_t> encoded) {
    if (encoded.size() < kFixedManifestSize) throw ManifestError("manifest is truncated");
    const auto filename_size = static_cast<std::size_t>(read_u16(encoded, 16));
    if (filename_size > kMaximumFilenameSize || encoded.size() != kFixedManifestSize + filename_size) {
        throw ManifestError("manifest filename length is invalid");
    }

    Manifest manifest;
    manifest.object_size = read_u64(encoded, 0);
    manifest.symbol_size = read_u16(encoded, 8);
    manifest.source_symbol_count = read_u32(encoded, 10);
    manifest.fec_codec = static_cast<FecCodec>(encoded[14]);
    manifest.crypto_suite = static_cast<CryptoSuite>(encoded[15]);
    std::copy_n(encoded.begin() + 18, manifest.sha256.size(), manifest.sha256.begin());
    manifest.filename.assign(encoded.begin() + static_cast<std::ptrdiff_t>(kFixedManifestSize),
                             encoded.end());

    if (manifest.fec_codec != FecCodec::deterministic_lt &&
        manifest.fec_codec != FecCodec::raptorq) {
        throw ManifestError("unknown FEC codec");
    }
    if (manifest.crypto_suite != CryptoSuite::none &&
        manifest.crypto_suite != CryptoSuite::aes_256_gcm &&
        manifest.crypto_suite != CryptoSuite::xchacha20_poly1305) {
        throw ManifestError("unknown crypto suite");
    }
    if (manifest.filename != safe_filename(manifest.filename)) {
        throw ManifestError("manifest contains an unsafe filename");
    }
    validate_dimensions(manifest);
    return manifest;
}

}  // namespace qrs
