#pragma once

#if !defined(__linux__) && !defined(__APPLE__)
#error "appium-ios-tuntap native addon supports only Linux and macOS"
#endif

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#include <BaseTsd.h>
using ssize_t = SSIZE_T;
#else
#include <sys/types.h>
#endif

#include <uv.h>

enum class ReadPacketStatus {
  Data,
  NoData,
  Closed,
  Error,
};

class TunPlatformBackend {
public:
  using PacketCallback = std::function<void(std::vector<uint8_t>)>;
  using ErrorCallback = std::function<void(const std::string&)>;

  virtual ~TunPlatformBackend() = default;

  virtual bool OpenDevice(const std::string& requested_name,
                          std::string& out_interface_name,
                          std::string& error) = 0;
  virtual void CloseDevice() = 0;
  virtual bool IsOpen() const = 0;

  virtual ReadPacketStatus ReadPacket(size_t max_payload_size,
                                      std::vector<uint8_t>& out,
                                      std::string& error) = 0;
  virtual ssize_t WritePacket(const uint8_t* data,
                              size_t length,
                              std::string& error) = 0;

  virtual bool StartReceiveLoop(uv_loop_t* loop,
                                size_t buffer_size,
                                PacketCallback on_packet,
                                ErrorCallback on_error,
                                std::string& error) = 0;
  virtual void StopReceiveLoop() = 0;

  virtual int GetNativeFd() const { return -1; }
};

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend();
