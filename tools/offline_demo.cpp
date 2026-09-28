#include "qrs/fec.hpp"
#include "qrs/frame.hpp"
#include "qrs/manifest.hpp"

#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

std::vector<std::uint8_t> read_file(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("cannot open input file: " + path);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void write_file(const std::string& path, const std::vector<std::uint8_t>& bytes) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("cannot open output file: " + path);
    output.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
    if (!output) throw std::runtime_error("failed to write output file: " + path);
}

}  // namespace

int main(int argc, char** argv) {
    try {
        const std::string input_path = argc > 1 ? argv[1] : "payload.txt";
        const std::string output_path = argc > 2 ? argv[2] : "recovered_payload.txt";
        const auto loss_percent = argc > 3 ? std::stoi(argv[3]) : 30;
        if (loss_percent < 0 || loss_percent > 90) {
            throw std::invalid_argument("loss percentage must be between 0 and 90");
        }

        const auto input = read_file(input_path);
        constexpr std::uint16_t symbol_size = 256;
        std::random_device random_device;
        const auto session_id = (static_cast<std::uint64_t>(random_device()) << 32U) |
                                random_device();
        if (session_id == 0) throw std::runtime_error("failed to generate a session ID");

        qrs::LtEncoder encoder(input, symbol_size);
        qrs::LtDecoder decoder(encoder.parameters());
        qrs::Manifest manifest{input.size(), symbol_size,
                               encoder.parameters().source_symbol_count,
                               qrs::FecCodec::deterministic_lt,
                               qrs::CryptoSuite::none,
                               {}, qrs::safe_filename(input_path)};
        const qrs::Frame manifest_frame{qrs::FrameType::manifest, 0, session_id, 0,
                                        qrs::serialize_manifest(manifest)};
        const auto received_manifest = qrs::parse_manifest(
            qrs::parse_frame(qrs::serialize_frame(manifest_frame)).payload);
        if (received_manifest.object_size != input.size()) {
            throw std::runtime_error("manifest validation failed");
        }

        std::mt19937 loss_generator(42);
        std::uint32_t symbol_id = 0;
        std::size_t received_count = 0;
        while (!decoder.complete() && symbol_id < 100000) {
            const qrs::Frame outgoing{qrs::FrameType::data, 0, session_id, symbol_id,
                                      encoder.encode(symbol_id)};
            ++symbol_id;
            if (static_cast<int>(loss_generator() % 100U) < loss_percent) continue;
            const auto incoming = qrs::parse_frame(qrs::serialize_frame(outgoing));
            if (incoming.session_id != session_id) continue;
            decoder.add(incoming.symbol_id, incoming.payload);
            ++received_count;
        }
        if (!decoder.complete()) throw std::runtime_error("decoder did not converge");

        const auto recovered = decoder.recover();
        if (recovered != input) throw std::runtime_error("integrity comparison failed");
        write_file(output_path, recovered);

        std::cout << "QRS offline transfer complete\n"
                  << "  bytes:       " << input.size() << '\n'
                  << "  source:      " << encoder.parameters().source_symbol_count << " symbols\n"
                  << "  transmitted: " << symbol_id << " symbols\n"
                  << "  received:    " << received_count << " symbols\n"
                  << "  simulated loss: " << loss_percent << "%\n"
                  << "  output:      " << output_path << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "QRS offline demo failed: " << error.what() << '\n';
        return 1;
    }
}
