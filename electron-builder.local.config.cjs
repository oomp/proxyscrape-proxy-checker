const upstream = require('./electron-builder.config.js');

module.exports = {
    ...upstream,
    appId: 'local.proxychecker.portable',
    productName: 'Proxy Checker Local',
    executableName: 'ProxyCheckerLocal',
    electronDist: require('path').join(__dirname, 'node_modules/electron/dist'),
    files: [...upstream.files, 'LICENSE'],
    protocols: [],
    publish: null,
    afterSign: null,
    win: {
        icon: './public/icons/icon.ico',
        signAndEditExecutable: false,
        extraResources: [
            { from: 'bin/checker-win-x64.exe', to: 'bin/checker-win-x64.exe' },
            { from: 'bin/proxychecker-host-win-x64.exe', to: 'bin/proxychecker-host-win-x64.exe' },
        ],
        target: [{ target: 'portable', arch: ['x64'] }],
    },
    portable: { artifactName: 'ProxyCheckerLocal-${version}-portable.exe' },
};
