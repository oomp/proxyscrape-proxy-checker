import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import readline from 'readline';
import { spawn, execSync } from 'child_process';
import { BrowserWindow, app, ipcMain, dialog, session, clipboard } from 'electron';
import { autoUpdater } from 'electron-updater';
import { isDev } from '../shared/AppConstants';

// Keep the local portable build separate from official installations.
app.setName('Proxy Checker Local');
const localDataDir = process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
    : path.join(app.getPath('appData'), 'ProxyCheckerLocal');
fs.mkdirSync(localDataDir, { recursive: true });
app.setPath('userData', localDataDir);

const iconPath = path.join(__dirname, '../../public/icons/icon.png');

let window;
let goProcess = null;
let checkerPort = null;
let checkerToken = null;
let isQuitting = false;

// Buffered deep-link URL that arrived before the renderer window was ready.
let pendingDeepLink = null;

// Buffered update events that fired before the renderer registered its listeners.
// Replayed when the renderer sends 'update-listener-ready'.
let pendingUpdateAvailable = false;
let pendingUpdateReady = false;
let pendingUpdateError = null; // string | null

// Buffered native-check payload written by the host binary before this process
// existed (cold-start: host launched us, then wrote the file). Flushed to the
// renderer via did-finish-load, the same way pendingDeepLink is handled.
let pendingCheckPayload = null;

// True while a geo-enrich SSE connection is open. Prevents duplicate streams
// if listenGeoEnrichSSE() is ever called more than once.
let geoEnrichListening = false;

const isMac = process.platform === 'darwin';

/**
 * Returns the directory used for all persistent app data (settings.json, checker.db).
 * In portable mode this is beside the executable so the install stays self-contained.
 * In normal installs it is the standard Electron userData path.
 */
function getDataDir() {
    return app.getPath('userData');
}

/**
 * Kills the Go backend process and its entire process group so that neither
 * `go run` nor the compiled checker binary it spawns survive as orphans.
 * On Windows falls back to a plain kill since process groups work differently.
 */
function killGoProcess(proc) {
    if (!proc || proc.killed) return;
    try {
        if (process.platform !== 'win32') {
            // Negative PID sends the signal to the whole process group.
            process.kill(-proc.pid, 'SIGTERM');
        } else {
            proc.kill();
        }
    } catch {
        try { proc.kill(); } catch { /* already dead */ }
    }
}

/**
 * Route an incoming proxychecker:// deep-link URL to the renderer.
 * If the window is not yet ready the URL is buffered and flushed after load.
 */
function handleDeepLink(url) {
    if (!url || !url.startsWith('proxychecker://')) return;
    if (window && !window.isDestroyed()) {
        window.webContents.send('deep-link-proxy', url);
    } else {
        pendingDeepLink = url;
    }
}

function getCheckerBinaryName() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'win32') {
        return arch === 'arm64' ? 'checker-win-arm64.exe' : 'checker-win-x64.exe';
    }
    return `checker-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

function getCheckerBinaryPath() {
    const binaryName = getCheckerBinaryName();
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'bin', binaryName);
    }
    return path.join(__dirname, '../../bin', binaryName);
}

function startGoBackend() {
    return new Promise((resolve, reject) => {
        const dataDir = getDataDir();

        let cmd, args, opts;
        if (!app.isPackaged) {
            // In dev (unpackaged), compile and run from source — no pre-build step required.
            const backendDir = path.join(__dirname, '../../backend');

            // Resolve the `go` binary via the user's login shell PATH (one-time,
            // synchronous). We do NOT pass shell:true to the main spawn because that
            // causes the shell wrapper to absorb SIGTERM on quit, leaving the actual
            // go run process and the compiled checker binary as orphans.
            let goBin = 'go';
            try {
                const whichCmd = process.platform === 'win32' ? 'where go' : 'which go';
                goBin = execSync(whichCmd, { encoding: 'utf8', shell: true }).trim().split('\n')[0].trim();
            } catch {
                // falls back to bare 'go'; will produce ENOENT if not on PATH
            }

            cmd = goBin;
            args = ['run', './cmd/checker', 'serve', '--mode=desktop', '--data-dir', dataDir];
            // detached:true gives the child its own process group (PGID = goProcess.pid).
            // On quit we send SIGTERM to -pid which kills the entire group (go run +
            // the compiled binary it spawns), preventing orphaned processes.
            opts = {
                cwd: backendDir,
                // Pass the real app version via env so the backend knows what version
                // it is running as (used for the /api/version update check).
                env: { ...process.env, APP_VERSION: app.getVersion() },
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
            };
        } else {
            const binaryPath = getCheckerBinaryPath();
            if (!fs.existsSync(binaryPath)) {
                dialog.showErrorBox(
                    'Proxy Checker',
                    `Backend binary not found at:\n${binaryPath}\n\nRun: npm run build:backend`
                );
                reject(new Error('checker binary missing'));
                return;
            }
            cmd = binaryPath;
            args = ['serve', '--mode=desktop', '--data-dir', dataDir];
            opts = {
                // Pass APP_VERSION so the backend's init() picks it up even if
                // the -X linker flag injection somehow failed (belt-and-suspenders).
                env: { ...process.env, APP_VERSION: app.getVersion() },
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
            };
        }

        goProcess = spawn(cmd, args, opts);

        const rl = readline.createInterface({ input: goProcess.stdout });
        let port = null;
        let token = null;
        let settled = false;
        let killedAfterTimeout = false;

        // go run compiles before starting, so allow extra time in dev (unpackaged)
        const startupTimeoutMs = app.isPackaged ? 30000 : 90000;
        const timeout = setTimeout(() => {
            if (!settled) {
                dialog.showErrorBox(
                    'Proxy Checker',
                    'Timed out waiting for the backend to start (no CHECKER_PORT/CHECKER_TOKEN on stdout).'
                );
                killedAfterTimeout = true;
                killGoProcess(goProcess);
                reject(new Error('checker startup timeout'));
            }
        }, startupTimeoutMs);

        rl.on('line', (line) => {
            const portMatch = line.match(/^CHECKER_PORT=(\d+)/);
            if (portMatch) {
                port = parseInt(portMatch[1], 10);
            }
            const tokenMatch = line.match(/^CHECKER_TOKEN=(.+)$/);
            if (tokenMatch) {
                token = tokenMatch[1].trim();
            }
            if (port != null && token && !settled) {
                settled = true;
                clearTimeout(timeout);
                checkerPort = port;
                checkerToken = token;
                resolve();
            }
        });

        goProcess.stderr.on('data', (chunk) => {
            console.error('[checker]', chunk.toString());
        });

        goProcess.on('error', (err) => {
            clearTimeout(timeout);
            const hint = isDev
                ? 'Make sure Go is installed and on your PATH (`go version`).'
                : 'Run: npm run build:backend';
            dialog.showErrorBox('Proxy Checker', `Failed to start backend:\n${err.message}\n\n${hint}`);
            reject(err);
        });

        goProcess.on('exit', (code, signal) => {
            clearTimeout(timeout);
            if (isQuitting || killedAfterTimeout) {
                return;
            }
            if (!settled) {
                dialog.showErrorBox(
                    'Proxy Checker',
                    'The checker backend exited before it became ready. Check logs for details.'
                );
                reject(new Error('checker exited during startup'));
                return;
            }
            const detail =
                code != null && code !== 0
                    ? `Process exited with code ${code}.`
                    : signal
                      ? `Process terminated (${signal}).`
                      : 'Process ended unexpectedly.';
            dialog.showErrorBox('Proxy Checker', `The checker backend stopped.\n${detail}`);
            app.quit();
        });
    });
}

// =============================================================================
// Browser registration is disabled to preserve official installation settings.

// Preload reads sync before first paint — must be registered early
ipcMain.on('get-api-config', (event) => {
    event.returnValue = {
        apiBase: checkerPort != null ? `http://127.0.0.1:${checkerPort}` : '',
        token: checkerToken || '',
    };
});

// Triggered by the renderer's "Restart now" button after update-ready fires.
ipcMain.on('install-update', () => {
    // Official update installation is disabled for the local fork.
});

// Renderer signals that its update listeners are registered; replay any events
// that fired before componentDidMount ran (fast startup / cached updates).
ipcMain.on('update-listener-ready', () => {
    if (!window || window.isDestroyed()) return;
    if (pendingUpdateAvailable) window.webContents.send('update-available');
    if (pendingUpdateReady)     window.webContents.send('update-ready');
    if (pendingUpdateError)     window.webContents.send('update-error', pendingUpdateError);
    pendingUpdateAvailable = false;
    pendingUpdateReady     = false;
    pendingUpdateError     = null;
});

ipcMain.handle('choose-directory', async () => {
    try {
        const { filePaths, canceled } = await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
        });
        if (canceled || !filePaths?.length) return null;
        return filePaths[0];
    } catch (error) {
        console.error(error);
        return null;
    }
});

ipcMain.handle('choose-path', async (event, action = 'save') => {
    try {
        const txtFilter = [{ name: 'Text Files', extensions: ['txt'] }];
        if (action === 'save') {
            const { filePath, canceled } = await dialog.showSaveDialog({ filters: txtFilter });
            if (!canceled && filePath) return filePath;
        } else {
            const { filePaths, canceled } = await dialog.showOpenDialog({
                filters: txtFilter,
                properties: ['openFile'],
            });
            if (!canceled && filePaths && filePaths.length) return filePaths[0];
        }
    } catch (error) {
        console.error(error);
    }
});

ipcMain.handle('choose-multi', async () => {
    try {
        const { filePaths, canceled } = await dialog.showOpenDialog({
            filters: [{ name: 'Text Files', extensions: ['txt'] }],
            properties: ['openFile', 'multiSelections'],
        });
        if (canceled || !filePaths || !filePaths.length) return null;
        // Read contents in the main process so the renderer never needs `fs`.
        const results = await Promise.all(
            filePaths.map(async (p) => ({
                name: path.basename(p),
                text: await fs.promises.readFile(p, 'utf8'),
            }))
        );
        return results;
    } catch (error) {
        console.error(error);
        return null;
    }
});

ipcMain.handle('read-file', async (_event, filePath) => {
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
        console.error('read-file failed:', error);
        return null;
    }
});

ipcMain.handle('write-file', async (_event, filePath, content) => {
    try {
        await fs.promises.writeFile(filePath, content, 'utf8');
        return true;
    } catch (error) {
        console.error('write-file failed:', error);
        return false;
    }
});

ipcMain.handle('getDownloadsPath', () => app.getPath('downloads'));

// Clipboard — accessed from the main process to avoid the renderer-side
// deprecation warning ("Accessing clipboard.readText from the renderer process
// is deprecated"). The renderer calls window.__ELECTRON__.readClipboard() which
// invokes this handler via IPC.
ipcMain.handle('clipboard:read', () => clipboard.readText());


const preloadPath = path.join(__dirname, '../preload/index.js');

const windowOptions = {
    width: 1220,
    height: 955,
    minWidth: 700,
    minHeight: 500,
    show: false,
    icon: iconPath,
    ...(isMac
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 10 } }
        : { frame: false }),
    webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
    }
};

const devWindow = () => {
    window = new BrowserWindow(windowOptions);

    window.webContents.once('dom-ready', () => {
        window.webContents.openDevTools();
    });
};

const prodWindow = () => {
    window = new BrowserWindow({ ...windowOptions, resizable: true });
    window.removeMenu();
};

const createWindow = () => {
    isDev ? devWindow() : prodWindow();

    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
        window.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        window.loadFile(path.join(__dirname, '../renderer/index.html'));
    }

    window.on('ready-to-show', () => {
        window.show();
    });

    window.on('closed', () => {
        window = null;
    });

    window.on('maximize', () => {
        window.webContents.send('on-window-maximize');
    });

    window.on('unmaximize', () => {
        window.webContents.send('on-window-unmaximize');
    });
};

// Register as the default OS handler for proxychecker:// deep links (browser extension).
// On Windows in dev mode Electron is not the executable itself, so the main
// script path must be passed as an extra argument — see Electron deep-link docs.
// Do not replace the official application's OS protocol registration.

// macOS fires open-url when a proxychecker:// link is clicked in the browser.
// Register early so links that arrive before whenReady() are not lost.
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

// Enforce a single running instance. A second launch focuses the existing window
// instead of opening a duplicate. This also prevents the Chromium service-worker
// storage error caused by two processes sharing the same user-data directory.
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

// Windows / Linux: a second instance is spawned when a proxychecker:// link is
// clicked. The URL arrives in commandLine; we focus the existing window and route it.
app.on('second-instance', (event, commandLine) => {
    if (window) {
        if (window.isMinimized()) window.restore();
        window.focus();
    }
    const url = commandLine.find(arg => arg.startsWith('proxychecker://'));
    if (url) handleDeepLink(url);
});

app.whenReady().then(async () => {
    // Some external endpoints (judge servers, IP-lookup services) don't send CORS
    // headers, so Chromium would block those responses. We inject the header only
    // when the server hasn't already sent one — adding it to a response that already
    // has it produces a duplicate-value rejection and breaks Intercom, PostHog, etc.
    //
    // In production we also set a Content-Security-Policy. Dev mode intentionally
    // omits it because Vite HMR requires 'unsafe-eval', which would re-trigger the
    // same Electron security warning we're trying to silence.
    const productionCSP = [
        "default-src 'self'",
        // n.proxyscrape.com  — PostHog reverse-proxy (avoids ad-blockers)
        // widget.intercom.io — Intercom widget bootstrap script
        // js.intercomcdn.com — Intercom CDN where the actual runtime scripts live
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        // Local Go backend (any port) + analytics/chat services
        "connect-src 'self' http://127.0.0.1:* https://github.com https://api.proxyscrape.com",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
    ].join('; ');

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        const hasCors = Object.keys(headers).some(
            k => k.toLowerCase() === 'access-control-allow-origin'
        );
        if (!hasCors) {
            headers['Access-Control-Allow-Origin'] = ['*'];
        }
        if (!isDev) {
            headers['Content-Security-Policy'] = [productionCSP];
        }
        callback({ responseHeaders: headers });
    });

    // Local builds start with independent settings; do not import official data.

    // Write our PID so the native messaging host binary can detect whether the
    // app is running (it reads this file and checks process liveness).
    try {
        fs.writeFileSync(path.join(os.tmpdir(), 'proxychecker-local.pid'), String(process.pid), 'utf8');
    } catch { /* non-fatal */ }

    // Watch for native-messaging "check" payloads written by the Go host binary.
    // Chrome launches the host as a short-lived subprocess; it writes the proxy
    // list to this file and exits. We poll rather than fs.watch because the file
    // may not exist at startup and fs.watchFile works on non-existent paths.
    const checkFile = path.join(os.tmpdir(), 'proxychecker-local-check.json');
    const consumeCheckFile = () => {
        try {
            const raw = fs.readFileSync(checkFile, 'utf8');
            fs.unlinkSync(checkFile); // consume immediately to avoid re-processing
            const { proxies, source } = JSON.parse(raw);
            if (!Array.isArray(proxies) || proxies.length === 0) return;

            if (window && !window.isDestroyed()) {
                // Window is live — deliver immediately.
                if (window.isMinimized()) window.restore();
                if (process.platform === 'win32') {
                    // Windows blocks focus-stealing from background processes via SetForegroundWindow
                    // policy. Briefly marking the window always-on-top bypasses the restriction.
                    window.setAlwaysOnTop(true);
                    window.show();
                    window.focus();
                    window.setAlwaysOnTop(false);
                } else {
                    window.show();
                    window.focus();
                    app.focus({ steal: true });
                }
                window.webContents.send('native-check-proxies', { proxies, source: source || null });
            } else {
                // Window not yet created (cold-start: host launched us before this
                // process existed). Buffer and flush after did-finish-load.
                pendingCheckPayload = { proxies, source: source || null };
            }
        } catch { /* file gone or malformed — ignore */ }
    };
    fs.watchFile(checkFile, { interval: 300, persistent: false }, consumeCheckFile);
    // Handle the case where the host wrote the file before this process started
    // (i.e. the host launched us — watchFile only fires on changes after registration).
    // Ignore files older than 30 s — they are stale leftovers from a previous
    // session where the app crashed before consuming the payload.
    if (fs.existsSync(checkFile)) {
        const ageMs = Date.now() - fs.statSync(checkFile).mtimeMs;
        if (ageMs < 30_000) {
            consumeCheckFile();
        } else {
            try { fs.unlinkSync(checkFile); } catch { /* already gone */ }
        }
    }

    // Auto-register all detected browsers that haven't been explicitly opted out.
    // Always re-registers unconditionally so the manifest path is always current —
    // this fixes stale manifests after reinstall to a different location or after
    // an app bundle path change (e.g. canary → stable). The write is cheap (one
    // JSON file + registry keys on Windows) and non-fatal on failure.
    // Scanned browsers (unconventional Chromium forks) are included.
    // Browser registration is explicit in the local portable build.

    try {
        await startGoBackend();
    } catch {
        app.quit();
        return;
    }

    createWindow();

    // Windows / Linux cold launch: if the app was started directly by the OS
    // protocol handler (first instance), the URL lands in process.argv.
    if (process.platform !== 'darwin') {
        const coldUrl = process.argv.find(arg => arg.startsWith('proxychecker://'));
        if (coldUrl) pendingDeepLink = coldUrl;
    }

    // Flush any deep-link that arrived before the renderer was ready.
    if (pendingDeepLink) {
        const urlToSend = pendingDeepLink;
        pendingDeepLink = null;
        window.webContents.once('did-finish-load', () => {
            window.webContents.send('deep-link-proxy', urlToSend);
        });
    }

    // Flush any native-check payload buffered during cold-start (host launched us
    // before the window existed — consumeCheckFile stored it in pendingCheckPayload).
    if (pendingCheckPayload) {
        const payloadToSend = pendingCheckPayload;
        pendingCheckPayload = null;
        window.webContents.once('did-finish-load', () => {
            if (window && !window.isDestroyed()) {
                if (window.isMinimized()) window.restore();
                window.show();
                window.focus();
                app.focus({ steal: true });
                window.webContents.send('native-check-proxies', payloadToSend);
            }
        });
    }

    // Local builds are updated manually.

    // On startup, trigger geo enrichment for any pending rows.
    signalAndListenGeoEnrich();
});

app.on('activate', () => {
    if (window === null) {
        createWindow();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
    if (goProcess) {
        killGoProcess(goProcess);
        goProcess = null;
    }
    if (window && !window.isDestroyed()) {
        window.webContents.send('app-before-quit');
    }
    // Remove the PID file so the native messaging host knows the app is gone.
    try { fs.unlinkSync(path.join(os.tmpdir(), 'proxychecker-local.pid')); } catch { /* already gone */ }
});

app.on('window-all-closed', async () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Auto-updates run on all packaged non-portable builds (stable and canary).
// Canary publishes to the canary/ R2 channel so users only receive canary updates.
// Portables never auto-update — the user controls when to replace the executable.

// Explicitly set so the behaviour is documented — when an update is downloaded
// but the user dismisses the toast, it installs silently on the next app quit.
// Write updater events to a rolling log file so silent failures are
// diagnosable without attaching a debugger. Log path on Windows:
//   %APPDATA%\ProxyScrape Proxy Checker[ Canary]\logs\updater.log
autoUpdater.logger = (() => {
    try {
        const logDir  = path.join(app.getPath('logs'));
        fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, 'updater.log');
        const stamp   = () => new Date().toISOString();
        const write   = (level, msg) => {
            try { fs.appendFileSync(logFile, `${stamp()} [${level}] ${msg}\n`); } catch { /* ignore write errors */ }
        };
        return { info: m => write('INFO', m), warn: m => write('WARN', m), error: m => write('ERROR', m), debug: m => write('DEBUG', m) };
    } catch {
        return null;
    }
})();

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.on('update-available', () => {
    pendingUpdateError = null; // a successful check supersedes any prior error
    if (window && !window.isDestroyed()) {
        window.webContents.send('update-available');
    } else {
        pendingUpdateAvailable = true;
    }
});

autoUpdater.on('download-progress', (progressObj) => {
    if (window && !window.isDestroyed()) {
        window.webContents.send('download-progress', Math.floor(progressObj.percent));
    }
});

// Notify the renderer so it can prompt the user. quitAndInstall is
// triggered by the renderer via the 'install-update' IPC channel after
// the user confirms (or immediately for stable if the user hasn't dismissed).
autoUpdater.on('update-downloaded', () => {
    pendingUpdateAvailable = false; // ready supersedes available
    pendingUpdateError = null;
    if (window && !window.isDestroyed()) {
        window.webContents.send('update-ready');
    } else {
        pendingUpdateReady = true;
    }
});

autoUpdater.on('error', (err) => {
    const msg = err?.message || String(err);
    console.error('[updater] error:', msg);
    pendingUpdateAvailable = false; // error supersedes in-progress download
    pendingUpdateReady = false;
    if (window && !window.isDestroyed()) {
        window.webContents.send('update-error', msg);
    } else {
        pendingUpdateError = msg;
    }
});

ipcMain.on('window-minimize', () => {
    if (window && !window.isDestroyed()) {
        window.minimize();
    }
});

ipcMain.on('window-maximize', () => {
    if (window && !window.isDestroyed()) {
        window.maximize();
    }
});

ipcMain.on('window-unmaximize', () => {
    if (window && !window.isDestroyed()) {
        window.unmaximize();
    }
});

ipcMain.on('window-close', () => {
    if (window && !window.isDestroyed()) {
        window.close();
    }
});

// =============================================================================
// Geo enrichment SSE — drain stream so background DB worker runs to completion
// =============================================================================

/**
 * Connect to the Go geo enrichment SSE stream and drain it until the backend
 * reports running=false or the stream closes. This keeps the singleton guard
 * active so duplicate streams are never opened, and ensures the Go worker runs
 * to completion (updating the DB) even when no renderer client is listening.
 */
function listenGeoEnrichSSE() {
    if (!checkerPort || !checkerToken) return;
    // Singleton guard — only one SSE connection at a time.
    if (geoEnrichListening) return;

    geoEnrichListening = true;

    const req = http.request({
        hostname: '127.0.0.1',
        port: checkerPort,
        path: '/api/geo/enrich/events',
        method: 'GET',
        headers: { Authorization: `Bearer ${checkerToken}` },
    }, (res) => {
        let buf = '';
        res.on('data', chunk => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop(); // keep incomplete line for next chunk

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const payload = JSON.parse(line.slice(6));
                    // Stop listening when enrichment is done.
                    if (!payload.running) {
                        res.destroy();
                        geoEnrichListening = false;
                        return;
                    }
                } catch { /* ignore malformed frames */ }
            }
        });
        res.on('end', () => {
            geoEnrichListening = false;
        });
        res.on('error', () => {
            geoEnrichListening = false;
        });
    });
    req.on('error', () => {
        geoEnrichListening = false;
    });
    req.end();
}

/**
 * POST /api/geo/enrich and return the parsed JSON response, or null on error.
 * Awaiting this resolves only after the server has accepted (or rejected) the
 * job, so callers know the exact status before deciding to open an SSE stream.
 */
function signalGoGeoEnrich() {
    if (!checkerPort || !checkerToken) return Promise.resolve(null);
    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: checkerPort,
            path: '/api/geo/enrich',
            method: 'POST',
            headers: { Authorization: `Bearer ${checkerToken}` },
        }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

/**
 * Signal geo enrichment and — only if the server confirms work was started or
 * is already in progress — open the SSE listener. This prevents the race where
 * listenGeoEnrichSSE() connects before the POST is processed: the first SSE
 * tick would see running=false, close the stream, and leave enrichment with no
 * listener for the rest of the job.
 */
async function signalAndListenGeoEnrich() {
    const result = await signalGoGeoEnrich();
    if (result?.status === 'started' || result?.status === 'already_running') {
        listenGeoEnrichSSE();
    }
    return result;
}

