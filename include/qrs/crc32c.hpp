#pragma once

#include <cstdint>
#include <span>

namespace qrs {

[[nodiscard]] std::uint32_t crc32c(std::span<const std::uint8_t> bytes) noexcept;

}  // namespace qrs
