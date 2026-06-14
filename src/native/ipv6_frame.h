#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace ipv6_frame {

constexpr size_t kHeaderSize = 40;
constexpr uint8_t kVersion = 6;

/** Returns complete frame length, or 0 if buffer does not yet hold a full frame. */
inline size_t FrameLength(const uint8_t* data, size_t len) {
  if (len < kHeaderSize) {
    return 0;
  }
  if (((data[0] >> 4) & 0x0f) != kVersion) {
    return 1;  // resync: consume one byte
  }
  const size_t payload = (static_cast<size_t>(data[4]) << 8) | data[5];
  const size_t total = kHeaderSize + payload;
  if (len < total) {
    return 0;
  }
  return total;
}

/** Append bytes and extract every complete IPv6 frame into `out`. */
inline void DrainFrames(std::vector<uint8_t>& buffer, std::vector<std::vector<uint8_t>>& out) {
  size_t offset = 0;
  while (offset < buffer.size()) {
    const size_t frame_len = FrameLength(buffer.data() + offset, buffer.size() - offset);
    if (frame_len == 0) {
      break;
    }
    if (frame_len == 1) {
      offset += 1;
      continue;
    }
    out.emplace_back(buffer.begin() + static_cast<ptrdiff_t>(offset),
                     buffer.begin() + static_cast<ptrdiff_t>(offset + frame_len));
    offset += frame_len;
  }
  if (offset > 0) {
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<ptrdiff_t>(offset));
  }
}

}  // namespace ipv6_frame
