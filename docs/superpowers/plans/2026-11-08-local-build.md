# Proxy Checker Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver an unsigned portable Windows x64 proxy checker with reliable list paste and the approved local-build changes.

**Architecture:** Keep the upstream Electron/React frontend and Go checking backend. Correct clipboard transactions using CodeMirror document coordinates. Package a separately identified app without analytics, support chat or upstream updates.

**Tech Stack:** Node.js, React, CodeMirror 6, Electron, Go, SQLite/CGO, Electron Builder.

**Spec:** docs/superpowers/specs/2026-11-08-local-build-design.md

## Global Constraints

- Do not check the user's real proxies or modify the installed application or its settings.
- Preserve the upstream license and attribution. Do not add features unrelated to the approved fixes.
- Deliver user-facing files in the task's outputs directory.

## Review Focus

- CRLF clipboard input must not place selection beyond the normalized document.
- Pasting over a selection must preserve text outside the selection.
- Paste-button replacement must discard the previous document and accept Unicode.
- The local build must not share the official app's persistent data or updater installation.
- Packaged backend startup and ordinary checking must work without analytics keys and without packet-capture drivers.

### Task 1: Clipboard regression and fix

**Files:** src/renderer/containers/InputV2.jsx; tests/clipboard.test.cjs; package.json.

- [ ] Install locked dependencies, add a regression harness that executes the actual clipboard handlers with real CodeMirror state and controlled clipboard input.
- [ ] Observe the Windows multiline cases fail with the reported range error.
- [ ] Correct both handlers using CodeMirror's normalized text/selection APIs.
- [ ] Run the complete frontend test command; cover CRLF/LF, 30 lines, selection replacement, Unicode and empty input.
- [ ] Commit the clipboard fix and tests.

### Task 2: Independent local packaging

**Files:** src/renderer/index.jsx; src/renderer/misc/analytics.js; src/renderer/misc/intercom.js; src/main/index.js; backend/internal/updater/updater.go; electron.vite.config.mjs; electron-builder.config.js; package.json; build scripts.

- [ ] Disable analytics, support chat and required third-party build keys.
- [ ] Disable official updates and isolate identity, persistent data and native integration from the official installation.
- [ ] Compile the existing Windows x64 Go backend and native host with a task-local compiler if needed.
- [ ] Run the available backend suite, build the renderer and package the portable app.
- [ ] Commit the local-build changes.

### Task 3: Verify and deliver

**Files:** scripts/local-smoke-test.cjs; outputs/ProxyCheckerLocal/README-RU.txt; outputs executable and source archive.

- [ ] Launch the packaged app with isolated data and verify Paste, Ctrl+V, 30-line counting, replacement and absence of analytics/updater calls.
- [ ] Verify the backend on controlled local endpoints; never use the user's proxy addresses.
- [ ] Obtain one independent review of the full diff and address material findings.
- [ ] Copy the portable executable, source archive/patch, license and concise Russian instructions to outputs; record SHA-256.
- [ ] Push the source branch to the authorized fork and report the build and actual verification limits.
