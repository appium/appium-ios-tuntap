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
          "variables": {
            "openssl_prefix%": "<!(brew --prefix openssl@3 2>/dev/null || brew --prefix openssl 2>/dev/null || echo /opt/homebrew/opt/openssl@3)"
          },
          "sources": [
            "src/native/file_descriptor.cc",
            "src/native/posix_uv_poll_loop.cc",
            "src/native/debug_log.cc",
            "src/native/tun_backend_darwin.cc",
            "src/native/tunnel_ssl.cc",
            "src/native/tunnel_forwarder.cc"
          ],
          "include_dirs": [
            "<!(pkg-config --cflags-only-I openssl 2>/dev/null | sed 's/-I//g' || echo '<(openssl_prefix)/include')"
          ],
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-framework", "SystemConfiguration",
              "-framework", "CoreFoundation",
              '<(openssl_prefix)/lib/libssl.a',
              '<(openssl_prefix)/lib/libcrypto.a',
              "-lz"
            ]
          }
        }],
        ["OS=='win'", {
          "variables": {
            "openssl_root%": "<!(node -p \"process.env.OPENSSL_ROOT_DIR || process.env.OPENSSL_ROOT || ''\")"
          },
          "sources": [
            "src/native/debug_log.cc",
            "src/native/handle.cc",
            "src/native/wintun_loader.cc",
            "src/native/tun_backend_windows.cc",
            "src/native/tunnel_ssl.cc",
            "src/native/tunnel_forwarder.cc"
          ],
          "include_dirs": [
            "<(openssl_root)/include"
          ],
          "libraries": [
            "<(openssl_root)/lib/libssl.lib",
            "<(openssl_root)/lib/libcrypto.lib",
            "crypt32.lib",
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
