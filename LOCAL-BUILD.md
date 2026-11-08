# Proxy Checker Local (Windows x64)

Independent unsigned portable build of [ProxyScrape Proxy Checker](https://github.com/ProxyScrape/proxyscrape-proxy-checker).

## Changes

- Both Paste and Ctrl+V use CodeMirror's normalized text coordinates, including Windows CRLF input.
- PostHog, Intercom and their required build keys are removed.
- Official update checks and installation are disabled.
- Portable settings, history and Chromium data live in `data/` beside the executable.
- Browser extension registration and automatic import of official settings are disabled.
- The existing Go checking implementation, judges and IP/geolocation services are retained.

## Build

Prerequisites: Windows x64, Node.js 24, Go with toolchain downloads enabled, and Zig 0.14.0 (or a compatible CGO C compiler).

```powershell
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/electron/install.js
$env:ZIG = 'C:/Tools/zig-windows-x86_64-0.14.0/zig.exe'
$env:GOMAXPROCS = '4'
npm test
npm run dist:local
```

Artifact: `release/ProxyCheckerLocal-2.4.0-local.1-portable.exe`.
No signing certificate or analytics/chat key is needed.
The Go build script injects the package version into both sidecars.
Electron Builder can use `ELECTRON_BUILDER_NSIS_DIR` and `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` for previously downloaded official NSIS tooling.

## Verification

```powershell
$env:CGO_ENABLED = '1'
$env:CC = '"C:/Tools/zig-windows-x86_64-0.14.0/zig.exe" cc -target x86_64-windows-gnu'
go -C backend test ./...
node scripts/local-smoke-test.cjs
```

The clipboard regression suite executes the production handlers with real CodeMirror state. The packaged-app smoke test uses real Electron clipboard/keyboard input, a loopback SOCKS5 fixture, a loopback judge and a closed loopback port. It saves a report and screenshot in its scratch directory. It never checks the user's proxies. Its renderer network observation starts after debugger attachment; it is not a system-wide startup traffic capture.

## License

The original `LICENSE` is preserved: MIT with Commons Clause. This build is an independent modification, not an official ProxyScrape release. See the complete license for the terms.
