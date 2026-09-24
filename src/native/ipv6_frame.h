#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace ipv6_frame {

constexpr size_t kHeaderSize = 40;
constexpr uint8_t kVersion = 6;
constexpr unsigned kVersionShift = 4;
constexpr uint8_t kVersionMask = 0x0f;
constexpr size_t kPayloadLengthOffset = 4;
/** FrameLength result: the buffer does not yet hold a full frame. */
constexpr size_t kNeedMoreData = 0;
/** FrameLength result: skip one byte and look for the next header. */
constexpr size_t kResyncOneByte = 1;

/** True when the first byte of `data` carries the IPv6 version nibble. */
inline bool HasIpv6Version(const uint8_t* data) { return ((data[0] >> kVersionShift) & kVersionMask) == kVersion; }

/**
 * Returns the complete frame length, kNeedMoreData if incomplete, or kResyncOneByte when the
 * header is not IPv6 or claims more than `max_frame` bytes.
 */
inline size_t FrameLength(const uint8_t* data, size_t len, size_t max_frame) {
  if (len < kHeaderSize) {
    return kNeedMoreData;
  }
  if (!HasIpv6Version(data)) {
    return kResyncOneByte;
  }
  const size_t payload = (static_cast<size_t>(data[kPayloadLengthOffset]) << 8) | data[kPayloadLengthOffset + 1];
  const size_t total = kHeaderSize + payload;
  if (total > max_frame) {
    return kResyncOneByte;
  }
  if (len < total) {
    return kNeedMoreData;
  }
  return total;
}

/**
 * Extract every complete IPv6 frame of at most `max_frame` bytes into `out`; returns how many
 * oversize claims were skipped.
 */
inline size_t DrainFrames(std::vector<uint8_t>& buffer, std::vector<std::vector<uint8_t>>& out, size_t max_frame) {
  size_t offset = 0;
  size_t oversize = 0;
  while (offset < buffer.size()) {
    const uint8_t* cursor = buffer.data() + offset;
    const size_t frame_len = FrameLength(cursor, buffer.size() - offset, max_frame);
    if (frame_len == kNeedMoreData) {
      break;
    }
    if (frame_len == kResyncOneByte) {
      if (HasIpv6Version(cursor)) {
        ++oversize;
      }
      offset += kResyncOneByte;
      continue;
    }
    out.emplace_back(buffer.begin() + static_cast<ptrdiff_t>(offset),
                     buffer.begin() + static_cast<ptrdiff_t>(offset + frame_len));
    offset += frame_len;
  }
  if (offset > 0) {
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<ptrdiff_t>(offset));
  }
  return oversize;
}

}  // namespace ipv6_frame
