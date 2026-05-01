#pragma once

#ifdef _WIN32

#include <windows.h>

#include <string>

// Function-pointer typedefs reproduced from the WireGuard-supplied wintun.h
// (https://git.zx2c4.com/wintun/plain/api/wintun.h, GPL-2.0 OR MIT). Only the
// pieces we use are declared here so we do not have to vendor the full
// upstream header.

typedef struct _WINTUN_ADAPTER* WINTUN_ADAPTER_HANDLE;
typedef struct _TUN_SESSION* WINTUN_SESSION_HANDLE;

#ifndef WINTUN_MIN_RING_CAPACITY
#define WINTUN_MIN_RING_CAPACITY 0x20000
#endif
#ifndef WINTUN_MAX_RING_CAPACITY
#define WINTUN_MAX_RING_CAPACITY 0x4000000
#endif
#ifndef WINTUN_MAX_IP_PACKET_SIZE
#define WINTUN_MAX_IP_PACKET_SIZE 0xFFFF
#endif

typedef WINTUN_ADAPTER_HANDLE(WINAPI* WINTUN_CREATE_ADAPTER_FUNC)(LPCWSTR Name,
                                                                 LPCWSTR TunnelType,
                                                                 const GUID* RequestedGUID);
typedef WINTUN_ADAPTER_HANDLE(WINAPI* WINTUN_OPEN_ADAPTER_FUNC)(LPCWSTR Name);
typedef VOID(WINAPI* WINTUN_CLOSE_ADAPTER_FUNC)(WINTUN_ADAPTER_HANDLE Adapter);
typedef BOOL(WINAPI* WINTUN_DELETE_DRIVER_FUNC)(VOID);
typedef VOID(WINAPI* WINTUN_GET_ADAPTER_LUID_FUNC)(WINTUN_ADAPTER_HANDLE Adapter, NET_LUID* Luid);
typedef DWORD(WINAPI* WINTUN_GET_RUNNING_DRIVER_VERSION_FUNC)(VOID);

typedef WINTUN_SESSION_HANDLE(WINAPI* WINTUN_START_SESSION_FUNC)(WINTUN_ADAPTER_HANDLE Adapter,
                                                                DWORD Capacity);
typedef VOID(WINAPI* WINTUN_END_SESSION_FUNC)(WINTUN_SESSION_HANDLE Session);
typedef HANDLE(WINAPI* WINTUN_GET_READ_WAIT_EVENT_FUNC)(WINTUN_SESSION_HANDLE Session);
typedef BYTE*(WINAPI* WINTUN_RECEIVE_PACKET_FUNC)(WINTUN_SESSION_HANDLE Session, DWORD* PacketSize);
typedef VOID(WINAPI* WINTUN_RELEASE_RECEIVE_PACKET_FUNC)(WINTUN_SESSION_HANDLE Session,
                                                        const BYTE* Packet);
typedef BYTE*(WINAPI* WINTUN_ALLOCATE_SEND_PACKET_FUNC)(WINTUN_SESSION_HANDLE Session,
                                                       DWORD PacketSize);
typedef VOID(WINAPI* WINTUN_SEND_PACKET_FUNC)(WINTUN_SESSION_HANDLE Session, const BYTE* Packet);

// Singleton container for the resolved entry points. Callers must invoke
// `Load` (returning false on failure) before reading any function pointer.
class WintunApi {
public:
  static WintunApi& Instance();

  // Loads `wintun.dll` and resolves all required entry points. On the first
  // failure `error` describes which step went wrong; subsequent calls succeed
  // immediately as long as a previous call already loaded the library.
  bool Load(std::string& error);

  WINTUN_CREATE_ADAPTER_FUNC CreateAdapter = nullptr;
  WINTUN_OPEN_ADAPTER_FUNC OpenAdapter = nullptr;
  WINTUN_CLOSE_ADAPTER_FUNC CloseAdapter = nullptr;
  WINTUN_GET_RUNNING_DRIVER_VERSION_FUNC GetRunningDriverVersion = nullptr;
  WINTUN_START_SESSION_FUNC StartSession = nullptr;
  WINTUN_END_SESSION_FUNC EndSession = nullptr;
  WINTUN_GET_READ_WAIT_EVENT_FUNC GetReadWaitEvent = nullptr;
  WINTUN_RECEIVE_PACKET_FUNC ReceivePacket = nullptr;
  WINTUN_RELEASE_RECEIVE_PACKET_FUNC ReleaseReceivePacket = nullptr;
  WINTUN_ALLOCATE_SEND_PACKET_FUNC AllocateSendPacket = nullptr;
  WINTUN_SEND_PACKET_FUNC SendPacket = nullptr;

private:
  WintunApi() = default;
  WintunApi(const WintunApi&) = delete;
  WintunApi& operator=(const WintunApi&) = delete;

  bool TryLoadFrom(LPCWSTR path);
  bool ResolveEntryPoints(std::string& error);

  HMODULE module_ = nullptr;
  bool loaded_ = false;
};

// Builds a UTF-8 description of the latest Win32 error suitable for embedding
// in `std::string` error messages.
std::string FormatLastError(DWORD error_code);

// Converts a UTF-8 string to UTF-16 for Win32 wide-char APIs.
std::wstring Utf8ToUtf16(const std::string& utf8);

#endif
