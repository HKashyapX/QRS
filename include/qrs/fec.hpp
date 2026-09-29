#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <unordered_set>
#include <vector>

namespace qrs {

struct FecParameters {
    std::uint64_t object_size{0};
    std::uint16_t symbol_size{0};
    std::uint32_t source_symbol_count{0};
};

[[nodiscard]] FecParameters make_fec_parameters(std::uint64_t object_size,
                                                std::uint16_t symbol_size);

class LtEncoder {
public:
    LtEncoder(std::span<const std::uint8_t> object, std::uint16_t symbol_size);

    [[nodiscard]] const FecParameters& parameters() const noexcept;
    [[nodiscard]] std::vector<std::uint8_t> encode(std::uint32_t symbol_id) const;

private:
    FecParameters parameters_;
    std::vector<std::vector<std::uint8_t>> source_symbols_;
};

class LtDecoder {
public:
    explicit LtDecoder(FecParameters parameters);

    // Returns false for a duplicate symbol or after completion.
    bool add(std::uint32_t symbol_id, std::span<const std::uint8_t> payload);
    [[nodiscard]] bool complete() const noexcept;
    [[nodiscard]] std::size_t resolved_count() const noexcept;
    [[nodiscard]] std::vector<std::uint8_t> recover() const;

private:
    struct Equation {
        std::vector<std::uint32_t> dependencies;
        std::vector<std::uint8_t> payload;
    };

    void propagate();
    void solve_tail();

    FecParameters parameters_;
    std::vector<std::optional<std::vector<std::uint8_t>>> resolved_;
    std::vector<Equation> equations_;
    std::unordered_set<std::uint32_t> seen_symbol_ids_;
    std::size_t resolved_count_{0};
};

}  // namespace qrs
