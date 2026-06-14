{
  "targets": [
    {
      "target_name": "tuntap",
      "sources": [
        "src/tuntap.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags": [
        "-O3",
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-fPIC"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-Wno-vla-extension",
        "-O3",
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-fPIC"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "10.15",
        "GCC_OPTIMIZATION_LEVEL": "3",
        "WARNING_CFLAGS": [
          "-Wall",
          "-Wextra",
          "-Wno-unused-parameter",
          "-Wno-vla-extension",
          "-Wno-error"
        ],
        "OTHER_CPLUSPLUSFLAGS": [
          "-O3",
          "-fPIC"
        ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [
            "/std:c++20",
            "/O2"
          ]
        }
      },
      "defines": [
        "NAPI_CPP_EXCEPTIONS",
        "NAPI_VERSION=8"
      ],
      "conditions": [
        ["OS=='linux'", {
          "sources": [
            "src/native/file_descriptor.cc",
            "src/native/posix_uv_poll_loop.cc",
            "src/native/debug_log.cc",
            "src/native/tun_backend_linux.cc",
            "src/native/tunnel_bridge.cc",
            "src/native/tunnel_ssl.cc",
            "src/native/tunnel_forwarder.cc"
          ],
          "cflags": [
            "-pthread"
          ],
          "cflags_cc": [
            "-pthread"
          ],
          "include_dirs": [
            "<!(pkg-config --cflags-only-I openssl 2>/dev/null | sed 's/-I//g')"
          ],
          "ldflags": [
            "-pthread",
            "<!(pkg-config --variable=libdir openssl)/libssl.a",
            "<!(pkg-config --variable=libdir openssl)/libcrypto.a",
            "-ldl",
            "-lz"
          ]
        }],
        ["OS=='mac'", {
          "sources": [
            "src/native/file_descriptor.cc",
            "src/native/posix_uv_poll_loop.cc",
            "src/native/debug_log.cc",
            "src/native/tun_backend_darwin.cc",
            "src/native/tunnel_bridge.cc",
            "src/native/tunnel_ssl.cc",
            "src/native/tunnel_forwarder.cc"
          ],
          "include_dirs": [
            "<!(pkg-config --cflags-only-I openssl 2>/dev/null | sed 's/-I//g' || echo /opt/homebrew/opt/openssl@3/include)"
          ],
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-framework", "SystemConfiguration",
              "-framework", "CoreFoundation",
              "/opt/homebrew/opt/openssl@3/lib/libssl.a",
              "/opt/homebrew/opt/openssl@3/lib/libcrypto.a",
              "-lz"
            ]
          }
        }],
        ["OS=='win'", {
          "sources": [
            "src/native/handle.cc",
            "src/native/wintun_loader.cc",
            "src/native/tun_backend_windows.cc"
          ],
          "libraries": [
            "iphlpapi.lib",
            "ws2_32.lib"
          ],
          "defines": [
            "_WIN32_WINNT=0x0A00",
            "WIN32_LEAN_AND_MEAN",
            "NOMINMAX"
          ]
        }]
      ]
    }
  ]
}
