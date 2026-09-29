#include "qrs/fec.hpp"

#include <algorithm>
#include <iterator>
#include <limits>
#include <stdexcept>

namespace qrs {
namespace {

constexpr std::uint32_t dense_repair_flag = 0x80000000U;

std::uint64_t splitmix64(std::uint64_t& state) noexcept {
    state += 0x9e3779b97f4a7c15ULL;
    auto value = state;
    value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31U);
}

std::vector<std::uint32_t> dependencies_for(const std::uint32_t symbol_id,
                                            const std::uint32_t source_count) {
    if (source_count == 0) return {};
    if (symbol_id < source_count) return {symbol_id};

    std::uint64_t state = 0x5152532d4c542d30ULL ^ symbol_id;
    if (symbol_id >= dense_repair_flag) {
        auto degree = std::max<std::uint32_t>(1, (source_count + 1U) / 2U);
        if (degree % 2U == 0 && degree < source_count) ++degree;
        std::vector<std::uint32_t> dependencies;
        dependencies.reserve(degree);
        while (dependencies.size() < degree) {
            const auto candidate = static_cast<std::uint32_t>(splitmix64(state) % source_count);
            if (std::find(dependencies.begin(), dependencies.end(), candidate) ==
                dependencies.end()) {
                dependencies.push_back(candidate);
            }
        }
        std::sort(dependencies.begin(), dependencies.end());
        return dependencies;
    }
    const auto roll = splitmix64(state) % 100ULL;
    std::uint32_t degree = 1;
    if (roll >= 45 && roll < 80) {
        degree = 2;
    } else if (roll >= 80 && roll < 94) {
        degree = 3;
    } else if (roll >= 94) {
        const auto maximum = std::min<std::uint32_t>(8, source_count);
        degree = maximum <= 4
                     ? maximum
                     : 4 + static_cast<std::uint32_t>(splitmix64(state) % (maximum - 3));
    }
    degree = std::min(degree, source_count);

    std::vector<std::uint32_t> dependencies;
    dependencies.reserve(degree);
    while (dependencies.size() < degree) {
        const auto candidate = static_cast<std::uint32_t>(splitmix64(state) % source_count);
        if (std::find(dependencies.begin(), dependencies.end(), candidate) == dependencies.end()) {
            dependencies.push_back(candidate);
        }
    }
    std::sort(dependencies.begin(), dependencies.end());
    return dependencies;
}

void xor_into(std::vector<std::uint8_t>& destination,
              const std::span<const std::uint8_t> source) {
    for (std::size_t i = 0; i < destination.size(); ++i) destination[i] ^= source[i];
}

std::vector<std::uint32_t> xor_dependencies(const std::vector<std::uint32_t>& left,
                                            const std::vector<std::uint32_t>& right) {
    std::vector<std::uint32_t> result;
    result.reserve(left.size() + right.size());
    std::set_symmetric_difference(left.begin(), left.end(), right.begin(), right.end(),
                                  std::back_inserter(result));
    return result;
}

void validate_parameters(const FecParameters& parameters) {
    if (parameters.symbol_size == 0) throw std::invalid_argument("symbol size must be non-zero");
    const auto expected = parameters.object_size == 0
                              ? 0ULL
                              : (parameters.object_size + parameters.symbol_size - 1ULL) /
                                    parameters.symbol_size;
    if (expected != parameters.source_symbol_count) {
        throw std::invalid_argument("invalid source symbol count");
    }
}

}  // namespace

FecParameters make_fec_parameters(const std::uint64_t object_size,
                                  const std::uint16_t symbol_size) {
    if (symbol_size == 0) throw std::invalid_argument("symbol size must be non-zero");
    const auto count = object_size == 0 ? 0ULL : (object_size + symbol_size - 1ULL) / symbol_size;
    if (count > std::numeric_limits<std::uint32_t>::max()) {
        throw std::invalid_argument("object requires too many source symbols");
    }
    return {object_size, symbol_size, static_cast<std::uint32_t>(count)};
}

LtEncoder::LtEncoder(const std::span<const std::uint8_t> object,
                     const std::uint16_t symbol_size)
    : parameters_(make_fec_parameters(object.size(), symbol_size)),
      source_symbols_(parameters_.source_symbol_count,
                      std::vector<std::uint8_t>(symbol_size, 0)) {
    for (std::size_t i = 0; i < object.size(); ++i) {
        source_symbols_[i / symbol_size][i % symbol_size] = object[i];
    }
}

const FecParameters& LtEncoder::parameters() const noexcept { return parameters_; }

std::vector<std::uint8_t> LtEncoder::encode(const std::uint32_t symbol_id) const {
    if (parameters_.source_symbol_count == 0) {
        throw std::logic_error("an empty object has no encoding symbols");
    }
    std::vector<std::uint8_t> payload(parameters_.symbol_size, 0);
    for (const auto dependency : dependencies_for(symbol_id, parameters_.source_symbol_count)) {
        xor_into(payload, source_symbols_[dependency]);
    }
    return payload;
}

LtDecoder::LtDecoder(const FecParameters parameters)
    : parameters_(parameters), resolved_(parameters.source_symbol_count) {
    validate_parameters(parameters_);
}

bool LtDecoder::add(const std::uint32_t symbol_id,
                    const std::span<const std::uint8_t> payload) {
    if (complete() || !seen_symbol_ids_.insert(symbol_id).second) return false;
    if (payload.size() != parameters_.symbol_size) {
        throw std::invalid_argument("encoding symbol has an incorrect payload size");
    }

    Equation equation{dependencies_for(symbol_id, parameters_.source_symbol_count),
                      std::vector<std::uint8_t>(payload.begin(), payload.end())};
    for (auto iterator = equation.dependencies.begin(); iterator != equation.dependencies.end();) {
        if (resolved_[*iterator]) {
            xor_into(equation.payload, *resolved_[*iterator]);
            iterator = equation.dependencies.erase(iterator);
        } else {
            ++iterator;
        }
    }

    if (!equation.dependencies.empty()) equations_.push_back(std::move(equation));
    const auto maximum_equations = std::max<std::size_t>(1024, 8ULL * parameters_.source_symbol_count);
    if (equations_.size() > maximum_equations) {
        equations_.erase(equations_.begin(),
                         equations_.begin() + static_cast<std::ptrdiff_t>(equations_.size() -
                                                                          maximum_equations));
    }
    propagate();
    solve_tail();
    return true;
}

void LtDecoder::propagate() {
    while (true) {
        const auto singleton = std::find_if(
            equations_.begin(), equations_.end(),
            [](const Equation& equation) { return equation.dependencies.size() == 1; });
        if (singleton == equations_.end()) break;

        const auto resolved_index = singleton->dependencies.front();
        const auto resolved_payload = singleton->payload;
        equations_.erase(singleton);

        if (!resolved_[resolved_index]) {
            resolved_[resolved_index] = resolved_payload;
            ++resolved_count_;
        }

        for (auto& equation : equations_) {
            const auto dependency = std::find(equation.dependencies.begin(),
                                              equation.dependencies.end(), resolved_index);
            if (dependency != equation.dependencies.end()) {
                xor_into(equation.payload, *resolved_[resolved_index]);
                equation.dependencies.erase(dependency);
            }
        }
        std::erase_if(equations_, [](const Equation& equation) {
            return equation.dependencies.empty();
        });
    }
}

void LtDecoder::solve_tail() {
    const auto unresolved_count = parameters_.source_symbol_count - resolved_count_;
    if (unresolved_count == 0 || unresolved_count > 64 || equations_.size() < unresolved_count) {
        return;
    }

    std::vector<std::optional<Equation>> pivots(parameters_.source_symbol_count);
    for (const auto& equation : equations_) {
        auto row = equation;
        while (!row.dependencies.empty()) {
            const auto pivot = row.dependencies.front();
            if (!pivots[pivot]) {
                pivots[pivot] = std::move(row);
                break;
            }
            row.dependencies = xor_dependencies(row.dependencies, pivots[pivot]->dependencies);
            xor_into(row.payload, pivots[pivot]->payload);
        }
    }

    for (std::size_t pivot = pivots.size(); pivot-- > 0;) {
        if (!pivots[pivot]) continue;
        for (std::size_t other = 0; other < pivot; ++other) {
            if (!pivots[other] ||
                !std::binary_search(pivots[other]->dependencies.begin(),
                                    pivots[other]->dependencies.end(),
                                    static_cast<std::uint32_t>(pivot))) {
                continue;
            }
            pivots[other]->dependencies =
                xor_dependencies(pivots[other]->dependencies, pivots[pivot]->dependencies);
            xor_into(pivots[other]->payload, pivots[pivot]->payload);
        }
    }

    equations_.clear();
    for (auto& pivot : pivots) {
        if (pivot) equations_.push_back(std::move(*pivot));
    }
    propagate();
}

bool LtDecoder::complete() const noexcept {
    return resolved_count_ == parameters_.source_symbol_count;
}

std::size_t LtDecoder::resolved_count() const noexcept { return resolved_count_; }

std::vector<std::uint8_t> LtDecoder::recover() const {
    if (!complete()) throw std::logic_error("object is not fully decoded");
    std::vector<std::uint8_t> object;
    object.reserve(static_cast<std::size_t>(parameters_.object_size));
    for (const auto& symbol : resolved_) {
        object.insert(object.end(), symbol->begin(), symbol->end());
    }
    object.resize(static_cast<std::size_t>(parameters_.object_size));
    return object;
}

}  // namespace qrs
