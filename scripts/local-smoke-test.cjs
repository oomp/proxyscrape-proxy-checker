// Packaged Windows app verification. All check traffic stays on loopback.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
        await delay(200);
    }
    throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}
async function freePort() {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
class CDP {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ws.addEventListener('message', event => {
            const msg = JSON.parse(event.data);
            if (msg.id) {
                const item = this.pending.get(msg.id);
                if (!item) return;
                this.pending.delete(msg.id);
                clearTimeout(item.timer);
                msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
            } else this.events.push(msg);
        });
    }
    async ready() { await once(this.ws, 'open'); return this; }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    close() {
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP closed')); }
        this.pending.clear();
        this.ws.close();
    }
}

async function main() {
    const input = path.resolve(process.argv[2] || 'release/ProxyCheckerLocal-2.4.0-local.1-portable.exe');
    const root = path.resolve(process.argv[3] || '.superpowers/sdd/2026-11-08-local-build/smoke');
    fs.mkdirSync(root, { recursive: true });
    const executable = path.join(root, path.basename(input));
    if (fs.existsSync(path.join(path.dirname(input), 'resources/app.asar'))) {
        fs.cpSync(path.dirname(input), root, { recursive: true });
    } else fs.copyFileSync(input, executable);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const report = { assertions: [], errors: [], requests: [] };
    const pass = value => { report.assertions.push(value); console.log('PASS: ' + value); };
    const sockets = new Set();
    let app, renderer, inspector, clipboardSaved = false;
    const judge = http.createServer((req, res) => {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const ips = JSON.parse(body || '{}').ips || [];
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ results: ips.map(query => ({ query, status: 'success', countryCode: 'DE', country: 'Germany', city: 'Fixture' })) }));
            });
        } else if (req.url === '/ip') res.end('198.51.100.100');
        else res.end('AZ Environment variables\nREMOTE_ADDR = 198.51.100.20\n');
    });
    const judgePort = await listen(judge);
    let connections = 0;
    const socks = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let buffer = Buffer.alloc(0), phase = 0;
        const onData = chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (phase === 0) {
                if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
                assert.equal(buffer[0], 5);
                buffer = buffer.subarray(2 + buffer[1]);
                socket.write(Buffer.from([5, 0]));
                phase = 1;
            }
            if (phase !== 1 || buffer.length < 5) return;
            const type = buffer[3];
            const addressLength = type === 1 ? 4 : type === 3 ? 1 + buffer[4] : 16;
            const length = 4 + addressLength + 2;
            if (buffer.length < length) return;
            const host = type === 1 ? [...buffer.subarray(4, 8)].join('.') : type === 3 ? buffer.subarray(5, 4 + addressLength).toString() : '';
            const port = buffer.readUInt16BE(4 + addressLength);
            // Hard stop: this fixture is never allowed to forward external traffic.
            assert.equal(host, '127.0.0.1');
            assert.equal(port, judgePort);
            connections++;
            phase = 2;
            socket.removeListener('data', onData);
            const upstream = net.connect({ host, port }, () => {
                socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                if (buffer.length > length) upstream.write(buffer.subarray(length));
                socket.pipe(upstream).pipe(socket);
            });
            sockets.add(upstream);
            upstream.on('close', () => sockets.delete(upstream));
            upstream.on('error', () => socket.destroy());
            socket.on('close', () => upstream.destroy());
        };
        socket.on('data', onData);
    });
    const socksPort = await listen(socks);
    const closed = net.createServer();
    const deadPort = await listen(closed);
    await new Promise(resolve => closed.close(resolve));
    const judgeURL = `http://127.0.0.1:${judgePort}`;
    fs.writeFileSync(path.join(root, 'data/settings.json'), JSON.stringify({
        core: { timeout: 2000, threads: 2, retries: 0, protocols: { http: false, https: false, socks4: false, socks5: true }, rotatingCount: 5000 },
        judges: { swap: true, items: [{ url: judgeURL, validate: 'AZ Environment variables', active: true }] },
        ip: { current: '198.51.100.100', lookupUrl: judgeURL + '/ip' },
        blacklist: { filter: false, items: [] }, exporting: { type: 1, authType: 1 }, version: '2.0.0',
    }));
    try {
        const debugPort = await freePort(), inspectPort = await freePort();
        app = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${inspectPort}`], {
            cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, PORTABLE_EXECUTABLE_DIR: root, GEO_WORKER_URL: judgeURL },
        });
        const target = async (port, filter) => {
            const items = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
            return items.find(filter);
        };
        inspector = await new CDP((await until(() => target(inspectPort, x => x.webSocketDebuggerUrl), 'main inspector')).webSocketDebuggerUrl).ready();
        renderer = await new CDP((await until(() => target(debugPort, x => x.type === 'page'), 'renderer')).webSocketDebuggerUrl).ready();
        await renderer.send('Runtime.enable');
        await renderer.send('Network.enable');
        await renderer.send('Page.enable');
        await until(() => renderer.eval("!!document.querySelector('.cm-content')"), 'editor ready');
        pass('Packaged portable app and Go/SQLite backend start');
        const actualData = await inspector.eval("process.mainModule.require('electron').app.getPath('userData')");
        assert.equal(path.resolve(actualData), path.join(root, 'data'));
        pass('Portable data isolated beside the test executable');
        await inspector.eval(`globalThis.__smokeElectron = process.mainModule.require('electron'); globalThis.__smokeClipboard = __smokeElectron.clipboard.availableFormats().map(format => [format, __smokeElectron.clipboard.readBuffer(format)]); true`);
        clipboardSaved = true;
        const writeClipboard = text => inspector.eval(`__smokeElectron.clipboard.writeText(${JSON.stringify(text)}); true`);
        const lines = Array.from({ length: 30 }, (_, i) => `socks5://192.0.2.1:${10001 + i}`).join('\r\n');
        const clickText = text => renderer.eval(`(() => { const el = [...document.querySelectorAll('span,button')].find(x => x.textContent === ${JSON.stringify(text)}); if (!el) throw new Error('Missing control: '+${JSON.stringify(text)}); el.click(); return true; })()`);
        const text = () => renderer.eval("document.querySelector('.cm-content').innerText");
        await writeClipboard(lines);
        await clickText('Paste');
        await until(async () => (await text()) === lines.replaceAll('\r\n', '\n'), 'Paste 30 lines');
        await until(() => renderer.eval("/30 lines/.test(document.body.innerText) && !document.body.innerText.includes('parsing…')"), 'parsed 30 lines');
        pass('Paste button accepts and parses all 30 Windows CRLF lines');
        await writeClipboard('socks5://192.0.2.1:25001');
        await clickText('Paste');
        await until(async () => (await text()) === 'socks5://192.0.2.1:25001', 'seed different editor text');
        await writeClipboard(lines);
        // Select the actual CodeMirror document, then send Ctrl+V through Chromium.
        await renderer.eval("document.querySelector('.cm-content').focus()");
        const key = async (key, code, vk, modifiers = 2) => {
            await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
            await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
        };
        await key('a', 'KeyA', 65);
        await key('v', 'KeyV', 86);
        await until(async () => (await text()) === lines.replaceAll('\r\n', '\n'), 'Ctrl+V 30 lines');
        pass('Ctrl+V imports 30 Windows CRLF lines in the packaged editor');
        await writeClipboard('socks5://192.0.2.1:25001\r\nsocks5://192.0.2.1:25002');
        await clickText('Paste');
        await until(async () => (await text()).includes('25002') && !(await text()).includes('10001'), 'Paste replacement');
        pass('Paste button replaces previous text without leftovers');
        const fixtureList = `socks5://127.0.0.1:${socksPort}\r\nsocks5://127.0.0.1:${deadPort}`;
        await writeClipboard(fixtureList);
        await clickText('Paste');
        await until(() => renderer.eval("/2 lines/.test(document.body.innerText) && !document.body.innerText.includes('parsing…')"), 'local fixture parsed');
        fs.writeFileSync(path.join(root, 'ui-before-check.txt'), await renderer.eval('document.body.innerText'));
        await clickText('Check');
        await until(() => connections > 0, 'SOCKS5 forwarding used');
        const api = await until(async () => {
            const list = await renderer.eval(`(async () => { const e=window.__ELECTRON__; const r=await fetch(e.apiBase+'/api/checks',{headers:{Authorization:'Bearer '+e.token}}); return r.json(); })()`);
            return list.length ? list : null;
        }, 'persisted check');
        const id = api[0]?.id;
        assert.ok(id, 'completed check persisted');
        const results = await renderer.eval(`(async () => { const e=window.__ELECTRON__; const r=await fetch(e.apiBase+'/api/checks/${id}/results',{headers:{Authorization:'Bearer '+e.token}}); return r.json(); })()`);
        report.checkResults = results;
        fs.writeFileSync(path.join(root, 'results-debug.json'), JSON.stringify(results, null, 2));
        const items = results.items || results.results || results;
        assert.ok(Array.isArray(items), 'result array');
        assert.equal(items.length, 2);
        assert.equal(items.filter(x => x.status === 'working' && x.protocols.includes('socks5')).length, 1);
        assert.equal(items.filter(x => x.status === 'failed').length, 1);
        await until(() => renderer.eval(`(() => {
            const stop = [...document.querySelectorAll('button')].find(x => x.textContent === 'Stop');
            return stop && getComputedStyle(stop.parentElement.parentElement).opacity === '0';
        })()`), 'checking overlay finished');
        await renderer.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        pass('End-to-end check distinguishes working and closed loopback SOCKS5 endpoints');
        const screenshot = await renderer.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(root, 'verified-app.png'), Buffer.from(screenshot.data, 'base64'));
        report.errors = renderer.events.filter(x => x.method === 'Runtime.exceptionThrown').map(x => x.params.exceptionDetails.exception?.description || x.params.exceptionDetails.text);
        assert.deepEqual(report.errors, []);
        report.requests = renderer.events.filter(x => x.method === 'Network.requestWillBeSent').map(x => { const u = new URL(x.params.request.url); return u.origin + u.pathname; });
        assert.ok(report.requests.every(url => !/posthog|intercom|updates\.proxyscrape/i.test(url)));
        pass('No renderer exceptions or analytics/chat/update requests during the workflow');
        console.log(JSON.stringify({ assertions: report.assertions.length, screenshot: path.join(root, 'verified-app.png') }));
    } finally {
        if (renderer) {
            fs.writeFileSync(path.join(root, 'ui-final.txt'), await renderer.eval('document.body.innerText').catch(() => 'unavailable'));
        }
        if (clipboardSaved && inspector) {
            await inspector.eval(`__smokeElectron.clipboard.clear(); for (const [format, data] of __smokeClipboard) __smokeElectron.clipboard.writeBuffer(format, data); true`).catch(() => {});
        }
        if (renderer) renderer.close();
        if (inspector) {
            inspector.eval("__smokeElectron.app.quit(); true").catch(() => {});
            await delay(500);
            inspector.close();
        }
        if (app && app.exitCode === null) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        for (const socket of sockets) socket.destroy();
        socks.close(); judge.close();
        fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
