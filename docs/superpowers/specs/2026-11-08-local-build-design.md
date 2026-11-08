# Proxy Checker Local: approved scope

The user approved a ready Windows build of the ProxyScrape fork with the discussed fixes. The app must accept complete SOCKS5 lists through both Ctrl+V and Paste, including Windows CRLF line endings. Disable PostHog analytics, Intercom support chat, their required build keys, and official update installation. Produce a separate unsigned portable Windows x64 build. Preserve the license notices and existing proxy-checking implementation. Do not check the user's real proxies or modify the installed application or its settings.

Approach: patch the existing React/CodeMirror handlers, retain the Go backend, use a distinct app identity and portable data directory, and package with Electron Builder. Rewriting the app or changing its checking algorithm is outside this request. A local source patch alone would not satisfy the requested ready build.

Verification: reproduce the clipboard failure against the real production handlers and CodeMirror state; verify the fix for CRLF, LF, selections, empty clipboard and Unicode; build and launch the packaged app using isolated data. Verify the backend through local fixtures where possible, without external proxy checks.
