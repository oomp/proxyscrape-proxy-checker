import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, { recursive: true });
if (process.platform !== 'win32') throw new Error('This local build script targets native Windows x64.');

const env = { ...process.env, GOOS: 'windows', GOARCH: 'amd64' };
if (env.ZIG) env.CC = `"${env.ZIG.replaceAll('\\', '/')}" cc -target x86_64-windows-gnu`;

for (const [command, output, cgo, symbol] of [
    ['checker', 'checker-win-x64.exe', '1', 'github.com/proxyscrape/checker-backend/internal/api.appVersion'],
    ['host', 'proxychecker-host-win-x64.exe', '0', 'main.appVersion'],
]) {
    console.log(`Building ${output} (${version})`);
    const result = spawnSync('go', [
        'build', '-C', path.join(root, 'backend'), '-trimpath',
        '-ldflags', `-s -w -X ${symbol}=${version}`,
        '-o', path.join(bin, output), `./cmd/${command}`,
    ], { stdio: 'inherit', env: { ...env, CGO_ENABLED: cgo } });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
