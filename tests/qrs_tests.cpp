#include "qrs/crc32c.hpp"
#include "qrs/fec.hpp"
#include "qrs/frame.hpp"
#include "qrs/manifest.hpp"
#include "qrs/optical.hpp"

#include <cstdint>
#include <exception>
#include <iostream>
#include <random>
#include <span>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace {

void require(const bool condition, const std::string_view message) {
    if (!condition) throw std::runtime_error(std::string(message));
}

template <typename Exception, typename Function>
void require_throws(Function&& function, const std::string_view message) {
    try {
        function();
    } catch (const Exception&) {
        return;
    }
    throw std::runtime_error(std::string(message));
}

void test_crc32c_vector() {
    constexpr std::string_view input = "123456789";
    const auto bytes = std::span(reinterpret_cast<const std::uint8_t*>(input.data()), input.size());
    require(qrs::crc32c(bytes) == 0xe3069283U, "CRC-32C test vector failed");
}

void test_frame_round_trip_and_corruption_rejection() {
    const qrs::Frame original{qrs::FrameType::data, 0x12, 0x1020304050607080ULL, 42,
                              {0x10, 0x20, 0x30, 0x40}};
    auto encoded = qrs::serialize_frame(original);
    require(qrs::parse_frame(encoded) == original, "frame round trip failed");

    encoded[qrs::kFrameHeaderSize + 1] ^= 0x01;
    require_throws<qrs::FrameError>([&] { static_cast<void>(qrs::parse_frame(encoded)); },
                                   "corrupted frame was accepted");
}

void test_manifest_round_trip_and_filename_safety() {
    qrs::Manifest manifest;
    manifest.object_size = 10000;
    manifest.symbol_size = 64;
    manifest.source_symbol_count = 157;
    manifest.filename = "payload.bin";
    manifest.sha256[0] = 0xaa;

    const auto encoded = qrs::serialize_manifest(manifest);
    require(qrs::parse_manifest(encoded) == manifest, "manifest round trip failed");
    require(qrs::safe_filename("../../unsafe\\payload?.bin") == "payload_.bin",
            "filename sanitization failed");
}

void test_end_to_end_with_frame_loss() {
    std::vector<std::uint8_t> input(10000);
    for (std::size_t i = 0; i < input.size(); ++i) {
        input[i] = static_cast<std::uint8_t>((i * 131U + 17U) & 0xffU);
    }

    constexpr std::uint64_t session_id = 0x1122334455667788ULL;
    qrs::LtEncoder encoder(input, 64);
    qrs::LtDecoder decoder(encoder.parameters());
    std::mt19937 loss_generator(42);

    std::uint32_t symbol_id = 0;
    std::size_t dropped = 0;
    while (!decoder.complete() && symbol_id < 100000) {
        qrs::Frame transmitted{qrs::FrameType::data, 0, session_id, symbol_id,
                               encoder.encode(symbol_id)};
        ++symbol_id;
        if (loss_generator() % 100U < 30U) {
            ++dropped;
            continue;
        }
        const auto received = qrs::parse_frame(qrs::serialize_frame(transmitted));
        require(received.session_id == session_id, "session changed during frame processing");
        decoder.add(received.symbol_id, received.payload);
    }

    require(dropped > 0, "loss simulation did not drop frames");
    require(decoder.complete(), "decoder did not recover after 30 percent frame loss");
    require(decoder.recover() == input, "recovered object differs from input");
}

void test_duplicate_symbol_rejection() {
    const std::vector<std::uint8_t> input(256, 0x5a);
    qrs::LtEncoder encoder(input, 64);
    qrs::LtDecoder decoder(encoder.parameters());
    const auto payload = encoder.encode(0);
    require(decoder.add(0, payload), "first symbol was rejected");
    require(!decoder.add(0, payload), "duplicate symbol was accepted");
}

void test_cross_language_fec_vector() {
    std::vector<std::uint8_t> input(32);
    for (std::size_t i = 0; i < input.size(); ++i) input[i] = static_cast<std::uint8_t>(i);
    const qrs::LtEncoder encoder(input, 4);
    require(encoder.encode(8) == std::vector<std::uint8_t>({4, 4, 4, 4}),
            "deterministic LT test vector changed");
    require(encoder.encode(11) == std::vector<std::uint8_t>({16, 16, 16, 16}),
            "deterministic LT repair vector changed");
    require(encoder.encode(0x80000000U) == std::vector<std::uint8_t>({28, 29, 30, 31}),
            "cross-language dense repair vector changed");
    require(encoder.encode(0x80000001U) == std::vector<std::uint8_t>({4, 5, 6, 7}),
            "second cross-language dense repair vector changed");
}

void test_dense_tail_recovery() {
    std::vector<std::uint8_t> input(16 * 32);
    for (std::size_t i = 0; i < input.size(); ++i) {
        input[i] = static_cast<std::uint8_t>((i * 67U + 31U) & 0xffU);
    }
    const qrs::LtEncoder encoder(input, 32);
    qrs::LtDecoder decoder(encoder.parameters());
    std::uint32_t symbol_id = 0x80000000U;
    while (!decoder.complete() && symbol_id < 0x80000040U) {
        decoder.add(symbol_id, encoder.encode(symbol_id));
        ++symbol_id;
    }
    require(decoder.complete(), "dense tail equations did not recover the object");
    require(decoder.recover() == input, "dense tail recovery changed the object");
}

void test_optical_phase_and_orientation_recovery() {
    std::vector<std::uint8_t> payload(256);
    for (std::size_t i = 0; i < payload.size(); ++i) {
        payload[i] = static_cast<std::uint8_t>((i * 29U + 7U) & 0xffU);
    }
    const qrs::Frame original{qrs::FrameType::data, 0, 0x8877665544332211ULL, 1234,
                              payload};
    require(qrs::optical_payload_capacity_bytes() >= qrs::serialize_frame(original).size(),
            "64x64 optical matrix is too small for a data frame");

    const auto phase_a = qrs::encode_optical_phase(original, false);
    const auto phase_b = qrs::encode_optical_phase(original, true);
    require(phase_a.at(1, 1) == phase_b.at(1, 1),
            "orientation anchors must remain static between phases");
    require(phase_a.at(12, 0) != phase_b.at(12, 0),
            "phase pilot must invert between phases");
    require(phase_a.at(9, 1) != phase_b.at(9, 1),
            "data cells must invert between phases");
    for (std::uint8_t rotation = 0; rotation < 4; ++rotation) {
        for (const bool mirrored : {false, true}) {
            const qrs::OpticalTransform transform{rotation, mirrored};
            const auto observed_a = qrs::transform_optical_matrix(phase_a, transform);
            const auto observed_b = qrs::transform_optical_matrix(phase_b, transform);
            require(qrs::decode_optical_pair(observed_a, observed_b) == original,
                    "optical orientation recovery failed");
            require(qrs::decode_optical_pair(observed_b, observed_a) == original,
                    "reversed optical phase order failed");
        }
    }
}

void test_optical_corruption_rejection() {
    const qrs::Frame original{qrs::FrameType::data, 0, 0x123456789abcdef0ULL, 9,
                              std::vector<std::uint8_t>(64, 0xa5)};
    auto phase_a = qrs::encode_optical_phase(original, false);
    auto phase_b = qrs::encode_optical_phase(original, true);
    // (9,1) is the first non-reserved data cell in row-major order.
    phase_a.at(9, 1) = static_cast<std::uint8_t>(255U - phase_a.at(9, 1));
    phase_b.at(9, 1) = static_cast<std::uint8_t>(255U - phase_b.at(9, 1));
    require_throws<qrs::FrameError>(
        [&] { static_cast<void>(qrs::decode_optical_pair(phase_a, phase_b)); },
        "optically corrupted frame passed CRC validation");
}

}  // namespace

int main() {
    try {
        test_crc32c_vector();
        test_frame_round_trip_and_corruption_rejection();
        test_manifest_round_trip_and_filename_safety();
        test_end_to_end_with_frame_loss();
        test_duplicate_symbol_rejection();
        test_cross_language_fec_vector();
        test_dense_tail_recovery();
        test_optical_phase_and_orientation_recovery();
        test_optical_corruption_rejection();
        std::cout << "All QRS tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "QRS test failure: " << error.what() << '\n';
        return 1;
    }
}
