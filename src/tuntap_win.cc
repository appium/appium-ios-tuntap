#ifdef _WIN32

#include <napi.h>
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <objbase.h>
#include <combaseapi.h>
#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <atomic>

// WinTun API definitions
// Download wintun.dll from https://www.wintun.net/
typedef void* WINTUN_ADAPTER_HANDLE;
typedef void* WINTUN_SESSION_HANDLE;

typedef struct _WINTUN_ADAPTER WINTUN_ADAPTER;
typedef struct _WINTUN_SESSION WINTUN_SESSION;

typedef WINTUN_ADAPTER_HANDLE (WINAPI* WINTUN_CREATE_ADAPTER_FUNC)(
    LPCWSTR Name,
    LPCWSTR TunnelType,
    const GUID* RequestedGUID
);

typedef BOOL (WINAPI* WINTUN_CLOSE_ADAPTER_FUNC)(WINTUN_ADAPTER_HANDLE Adapter);

typedef BOOL (WINAPI* WINTUN_DELETE_DRIVER_FUNC)(void);

typedef WINTUN_ADAPTER_HANDLE (WINAPI* WINTUN_OPEN_ADAPTER_FUNC)(
    LPCWSTR Name
);

typedef void (WINAPI* WINTUN_GET_ADAPTER_LUID_FUNC)(
    WINTUN_ADAPTER_HANDLE Adapter,
    NET_LUID* Luid
);

typedef WINTUN_SESSION_HANDLE (WINAPI* WINTUN_START_SESSION_FUNC)(
    WINTUN_ADAPTER_HANDLE Adapter,
    DWORD Capacity
);

typedef void (WINAPI* WINTUN_END_SESSION_FUNC)(WINTUN_SESSION_HANDLE Session);

typedef HANDLE (WINAPI* WINTUN_GET_READ_WAIT_EVENT_FUNC)(WINTUN_SESSION_HANDLE Session);

typedef BYTE* (WINAPI* WINTUN_RECEIVE_PACKET_FUNC)(
    WINTUN_SESSION_HANDLE Session,
    DWORD* PacketSize
);

typedef void (WINAPI* WINTUN_RELEASE_RECEIVE_PACKET_FUNC)(
    WINTUN_SESSION_HANDLE Session,
    const BYTE* Packet
);

typedef BYTE* (WINAPI* WINTUN_ALLOCATE_SEND_PACKET_FUNC)(
    WINTUN_SESSION_HANDLE Session,
    DWORD PacketSize
);

typedef void (WINAPI* WINTUN_SEND_PACKET_FUNC)(
    WINTUN_SESSION_HANDLE Session,
    const BYTE* Packet
);

// WinTun function pointers
struct WinTunAPI {
    HMODULE dll;
    WINTUN_CREATE_ADAPTER_FUNC CreateAdapter;
    WINTUN_CLOSE_ADAPTER_FUNC CloseAdapter;
    WINTUN_DELETE_DRIVER_FUNC DeleteDriver;
    WINTUN_OPEN_ADAPTER_FUNC OpenAdapter;
    WINTUN_GET_ADAPTER_LUID_FUNC GetAdapterLUID;
    WINTUN_START_SESSION_FUNC StartSession;
    WINTUN_END_SESSION_FUNC EndSession;
    WINTUN_GET_READ_WAIT_EVENT_FUNC GetReadWaitEvent;
    WINTUN_RECEIVE_PACKET_FUNC ReceivePacket;
    WINTUN_RELEASE_RECEIVE_PACKET_FUNC ReleaseReceivePacket;
    WINTUN_ALLOCATE_SEND_PACKET_FUNC AllocateSendPacket;
    WINTUN_SEND_PACKET_FUNC SendPacket;

    WinTunAPI() : dll(nullptr) {}

    ~WinTunAPI() {
        if (dll) {
            FreeLibrary(dll);
        }
    }

    bool Load() {
        // Try to load wintun.dll from multiple locations
        const wchar_t* paths[] = {
            L"wintun.dll",
            L".\\wintun.dll",
            L"..\\wintun.dll",
            L"bin\\wintun.dll"
        };

        for (const auto& path : paths) {
            dll = LoadLibraryW(path);
            if (dll) break;
        }

        if (!dll) {
            return false;
        }

        CreateAdapter = (WINTUN_CREATE_ADAPTER_FUNC)GetProcAddress(dll, "WintunCreateAdapter");
        CloseAdapter = (WINTUN_CLOSE_ADAPTER_FUNC)GetProcAddress(dll, "WintunCloseAdapter");
        DeleteDriver = (WINTUN_DELETE_DRIVER_FUNC)GetProcAddress(dll, "WintunDeleteDriver");
        OpenAdapter = (WINTUN_OPEN_ADAPTER_FUNC)GetProcAddress(dll, "WintunOpenAdapter");
        GetAdapterLUID = (WINTUN_GET_ADAPTER_LUID_FUNC)GetProcAddress(dll, "WintunGetAdapterLUID");
        StartSession = (WINTUN_START_SESSION_FUNC)GetProcAddress(dll, "WintunStartSession");
        EndSession = (WINTUN_END_SESSION_FUNC)GetProcAddress(dll, "WintunEndSession");
        GetReadWaitEvent = (WINTUN_GET_READ_WAIT_EVENT_FUNC)GetProcAddress(dll, "WintunGetReadWaitEvent");
        ReceivePacket = (WINTUN_RECEIVE_PACKET_FUNC)GetProcAddress(dll, "WintunReceivePacket");
        ReleaseReceivePacket = (WINTUN_RELEASE_RECEIVE_PACKET_FUNC)GetProcAddress(dll, "WintunReleaseReceivePacket");
        AllocateSendPacket = (WINTUN_ALLOCATE_SEND_PACKET_FUNC)GetProcAddress(dll, "WintunAllocateSendPacket");
        SendPacket = (WINTUN_SEND_PACKET_FUNC)GetProcAddress(dll, "WintunSendPacket");

        return CreateAdapter && CloseAdapter && OpenAdapter && GetAdapterLUID &&
               StartSession && EndSession && GetReadWaitEvent &&
               ReceivePacket && ReleaseReceivePacket &&
               AllocateSendPacket && SendPacket;
    }
};

static std::unique_ptr<WinTunAPI> g_wintun_api;
static std::once_flag g_wintun_init_flag;

class TunDeviceWin : public Napi::ObjectWrap<TunDeviceWin> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    TunDeviceWin(const Napi::CallbackInfo& info);
    ~TunDeviceWin();

private:
    static Napi::FunctionReference constructor;

    Napi::Value Open(const Napi::CallbackInfo& info);
    Napi::Value Close(const Napi::CallbackInfo& info);
    Napi::Value Read(const Napi::CallbackInfo& info);
    Napi::Value Write(const Napi::CallbackInfo& info);
    Napi::Value GetName(const Napi::CallbackInfo& info);
    Napi::Value GetFd(const Napi::CallbackInfo& info);
    Napi::Value StartPolling(const Napi::CallbackInfo& info);

    void CloseInternal();
    void StopPolling();
    static DWORD WINAPI ReadThreadProc(LPVOID lpParameter);

    std::wstring name_w_;
    std::string name_;
    WINTUN_ADAPTER_HANDLE adapter_;
    WINTUN_SESSION_HANDLE session_;
    HANDLE read_event_;
    HANDLE read_thread_;
    std::atomic<bool> is_open_;
    std::atomic<bool> stop_polling_;
    std::mutex device_mutex_;
    Napi::ThreadSafeFunction tsfn_;
};

Napi::FunctionReference TunDeviceWin::constructor;

std::wstring Utf8ToWide(const std::string& utf8) {
    if (utf8.empty()) return std::wstring();
    int size = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    if (size <= 1) return std::wstring();
    std::wstring result(size - 1, 0); // size - 1 to exclude null terminator
    MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, &result[0], size);
    return result;
}

std::string WideToUtf8(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (size <= 1) return std::string();
    std::string result(size - 1, 0); // size - 1 to exclude null terminator
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, &result[0], size, nullptr, nullptr);
    return result;
}

Napi::Object TunDeviceWin::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);

    // Initialize WinTun API
    std::call_once(g_wintun_init_flag, []() {
        g_wintun_api = std::make_unique<WinTunAPI>();
        if (!g_wintun_api->Load()) {
            g_wintun_api.reset();
        }
    });

    if (!g_wintun_api) {
        Napi::Error::New(env, "Failed to load wintun.dll. Please download wintun.dll from https://www.wintun.net/ "
                             "and place it in the same directory as the executable or in the PATH.")
            .ThrowAsJavaScriptException();
        return exports;
    }

    Napi::Function func = DefineClass(env, "TunDevice", {
        InstanceMethod("open", &TunDeviceWin::Open),
        InstanceMethod("close", &TunDeviceWin::Close),
        InstanceMethod("read", &TunDeviceWin::Read),
        InstanceMethod("write", &TunDeviceWin::Write),
        InstanceMethod("getName", &TunDeviceWin::GetName),
        InstanceMethod("getFd", &TunDeviceWin::GetFd),
        InstanceMethod("startPolling", &TunDeviceWin::StartPolling),
    });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();

    exports.Set("TunDevice", func);
    return exports;
}

TunDeviceWin::TunDeviceWin(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<TunDeviceWin>(info),
      adapter_(nullptr),
      session_(nullptr),
      read_event_(nullptr),
      read_thread_(nullptr),
      is_open_(false),
      stop_polling_(false) {

    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);

    if (info.Length() > 0 && info[0].IsString()) {
        name_ = info[0].As<Napi::String>().Utf8Value();
        // If empty string provided, use default name
        if (name_.empty()) {
            name_ = "AppiumTun";
            name_w_ = L"AppiumTun";
        } else {
            name_w_ = Utf8ToWide(name_);
        }
    } else {
        name_ = "AppiumTun";
        name_w_ = L"AppiumTun";
    }
}

TunDeviceWin::~TunDeviceWin() {
    std::lock_guard<std::mutex> lock(device_mutex_);
    CloseInternal();
}

void TunDeviceWin::CloseInternal() {
    if (is_open_.exchange(false)) {
        StopPolling();

        if (session_ && g_wintun_api) {
            g_wintun_api->EndSession(session_);
            session_ = nullptr;
        }

        if (adapter_ && g_wintun_api) {
            g_wintun_api->CloseAdapter(adapter_);
            adapter_ = nullptr;
        }

        read_event_ = nullptr;
    }
}

Napi::Value TunDeviceWin::Open(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(device_mutex_);

    if (is_open_) {
        return Napi::Boolean::New(env, true);
    }

    if (!g_wintun_api) {
        Napi::Error::New(env, "WinTun API not loaded").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Validate adapter name is not empty
    if (name_.empty() || name_w_.empty()) {
        Napi::Error::New(env, "Adapter name cannot be empty").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Generate a GUID for the adapter
    GUID guid;
    HRESULT hr = CoCreateGuid(&guid);
    if (hr != S_OK) {
        Napi::Error::New(env, "Failed to generate GUID").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Try to open existing adapter first
    adapter_ = g_wintun_api->OpenAdapter(name_w_.c_str());

    if (!adapter_) {
        // If not found, create a new one
        adapter_ = g_wintun_api->CreateAdapter(name_w_.c_str(), L"AppiumTunnel", &guid);
    }

    if (!adapter_) {
        DWORD lastError = GetLastError();

        std::string error = "Failed to create/open WinTun adapter. Error code: " + std::to_string(lastError);
        error += "\nAdapter name (UTF-8): '" + name_ + "'";
        error += "\nAdapter name length: " + std::to_string(name_.length());
        error += "\nWide name length: " + std::to_string(name_w_.length());
        error += "\nNote: This operation requires administrator privileges.";

        if (lastError == ERROR_INVALID_PARAMETER) {
            error += "\nERROR_INVALID_PARAMETER (87): One of the parameters is invalid.";
            error += "\nPossible causes:";
            error += "\n  - Adapter name contains invalid characters";
            error += "\n  - Adapter name is too long (max 128 characters)";
            error += "\n  - Adapter name is empty or contains null characters";
        }

        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Start a session with ring buffer capacity of 0x400000 (4MB)
    session_ = g_wintun_api->StartSession(adapter_, 0x400000);
    if (!session_) {
        g_wintun_api->CloseAdapter(adapter_);
        adapter_ = nullptr;
        std::string error = "Failed to start WinTun session. Error code: " + std::to_string(GetLastError());
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Get the read wait event handle
    read_event_ = g_wintun_api->GetReadWaitEvent(session_);
    if (!read_event_) {
        g_wintun_api->EndSession(session_);
        g_wintun_api->CloseAdapter(adapter_);
        session_ = nullptr;
        adapter_ = nullptr;
        Napi::Error::New(env, "Failed to get read wait event").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    is_open_ = true;
    return Napi::Boolean::New(env, true);
}

Napi::Value TunDeviceWin::Close(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(device_mutex_);
    CloseInternal();
    return Napi::Boolean::New(env, true);
}

Napi::Value TunDeviceWin::Read(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(device_mutex_);

    if (!is_open_ || !session_) {
        Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
        return env.Null();
    }

    DWORD packet_size;
    BYTE* packet = g_wintun_api->ReceivePacket(session_, &packet_size);

    if (!packet) {
        DWORD err = GetLastError();
        if (err == ERROR_NO_MORE_ITEMS) {
            // No data available
            return Napi::Buffer<uint8_t>::New(env, 0);
        }
        std::string error = "Read error. Error code: " + std::to_string(err);
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Null();
    }

    // Copy packet data
    Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(env, packet, packet_size);

    // Release the packet back to WinTun
    g_wintun_api->ReleaseReceivePacket(session_, packet);

    return buffer;
}

Napi::Value TunDeviceWin::Write(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(device_mutex_);

    if (!is_open_ || !session_) {
        Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected buffer as first argument").ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    uint8_t* data = buffer.Data();
    size_t length = buffer.Length();

    if (length > 0xFFFF) {
        Napi::Error::New(env, "Packet too large (max 65535 bytes)").ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    // Allocate send packet
    BYTE* packet = g_wintun_api->AllocateSendPacket(session_, (DWORD)length);
    if (!packet) {
        std::string error = "Failed to allocate send packet. Error code: " + std::to_string(GetLastError());
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    // Copy data to packet
    memcpy(packet, data, length);

    // Send packet
    g_wintun_api->SendPacket(session_, packet);

    return Napi::Number::New(env, length);
}

Napi::Value TunDeviceWin::GetName(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(device_mutex_);
    return Napi::String::New(info.Env(), name_);
}

Napi::Value TunDeviceWin::GetFd(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(device_mutex_);
    // Windows doesn't use file descriptors, return a handle value or -1
    return Napi::Number::New(info.Env(), read_event_ ? (int64_t)read_event_ : -1);
}

Napi::Value TunDeviceWin::StartPolling(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(device_mutex_);

    if (!is_open_ || !session_) {
        Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
        return env.Null();
    }

    if (!info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected function as first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    StopPolling();

    tsfn_ = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "TunDeviceDataCallback",
        0,
        1
    );

    stop_polling_ = false;
    read_thread_ = CreateThread(nullptr, 0, ReadThreadProc, this, 0, nullptr);

    if (!read_thread_) {
        tsfn_.Release();
        Napi::Error::New(env, "Failed to create read thread").ThrowAsJavaScriptException();
        return env.Null();
    }

    return env.Undefined();
}

void TunDeviceWin::StopPolling() {
    if (read_thread_) {
        stop_polling_ = true;
        // Signal the event to wake up the thread
        if (read_event_) {
            SetEvent(read_event_);
        }
        WaitForSingleObject(read_thread_, 5000);
        CloseHandle(read_thread_);
        read_thread_ = nullptr;
    }

    if (tsfn_) {
        tsfn_.Release();
    }
}

DWORD WINAPI TunDeviceWin::ReadThreadProc(LPVOID lpParameter) {
    TunDeviceWin* self = static_cast<TunDeviceWin*>(lpParameter);

    while (!self->stop_polling_.load() && self->is_open_.load()) {
        // Wait for data to be available
        DWORD wait_result = WaitForSingleObject(self->read_event_, 100);

        if (wait_result != WAIT_OBJECT_0 || self->stop_polling_.load()) {
            continue;
        }

        // Try to read a packet
        DWORD packet_size;
        BYTE* packet = g_wintun_api->ReceivePacket(self->session_, &packet_size);

        if (packet && packet_size > 0) {
            // Copy packet data
            std::vector<uint8_t> buffer(packet, packet + packet_size);

            // Release the packet
            g_wintun_api->ReleaseReceivePacket(self->session_, packet);

            // Call JavaScript callback
            self->tsfn_.BlockingCall([buffer = std::move(buffer)](Napi::Env env, Napi::Function jsCallback) {
                jsCallback.Call({ Napi::Buffer<uint8_t>::Copy(env, buffer.data(), buffer.size()) });
            });
        }
    }

    return 0;
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return TunDeviceWin::Init(env, exports);
}

NODE_API_MODULE(tuntap, Init)

#endif // _WIN32
