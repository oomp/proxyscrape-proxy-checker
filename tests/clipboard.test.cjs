const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse } = require('@babel/parser');
const { EditorState } = require('@codemirror/state');

// Execute the actual application handlers. Only the OS clipboard and the view
// boundary are controlled; document changes use the real CodeMirror state.
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/containers/InputV2.jsx'), 'utf8');
const syntax = parse(source, { sourceType: 'module', plugins: ['jsx'] });
function findNode(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const value of Object.values(node)) {
        if (!value || typeof value !== 'object') continue;
        for (const child of Array.isArray(value) ? value : [value]) {
            const found = findNode(child, predicate);
            if (found) return found;
        }
    }
    return null;
}
const buttonNode = findNode(syntax, node => node.type === 'VariableDeclarator' && node.id?.name === 'handleClipboardPaste')?.init?.arguments[0];
const keyboardNode = findNode(syntax, node => node.type === 'ObjectMethod' && node.key?.name === 'paste');
assert.ok(buttonNode && keyboardNode, 'application paste handlers must be available');

function fixture(text, doc = '', selection = { anchor: 0 }) {
    const errors = [];
    const parsed = [];
    const view = {
        state: EditorState.create({ doc, selection }),
        dispatch(spec) { this.state = this.state.update(spec).state; },
    };
    const context = {
        window: { __ELECTRON__: { readClipboard: async () => text } },
        editorViewRef: { current: view },
        sourceMetaRef: { current: null },
        triggerParseNowRef: { current: value => parsed.push(value) },
        showError: value => errors.push(value),
    };
    const button = vm.runInNewContext(`(${source.slice(buttonNode.start, buttonNode.end)})`, context);
    const keyboard = vm.runInNewContext(`({${source.slice(keyboardNode.start, keyboardNode.end)}}).paste`, context);
    return {
        view, errors, parsed,
        button,
        keyboard: () => keyboard({ preventDefault() {}, clipboardData: { getData: () => text } }, view),
    };
}

for (const [name, text] of [['Windows CRLF', 'a\r\nb'], ['Unix LF', 'a\nb'], ['legacy CR', 'a\rb']]) {
    test(`Ctrl+V accepts ${name} without a cursor range error`, () => {
        const f = fixture(text);
        assert.doesNotThrow(f.keyboard);
        assert.equal(f.view.state.doc.toString(), 'a\nb');
        assert.equal(f.view.state.selection.main.anchor, 3);
        assert.deepEqual(f.parsed, ['a\nb']);
    });
    test(`Paste button replaces the document using ${name}`, async () => {
        const f = fixture(text, 'old text');
        await f.button();
        assert.deepEqual(f.errors, []);
        assert.equal(f.view.state.doc.toString(), 'a\nb');
        assert.equal(f.view.state.selection.main.anchor, 3);
    });
}

test('Ctrl+V preserves text outside the replaced selection', () => {
    const f = fixture('a\r\nb', 'left OLD right', { anchor: 5, head: 8 });
    assert.doesNotThrow(f.keyboard);
    assert.equal(f.view.state.doc.toString(), 'left a\nb right');
    assert.equal(f.view.state.selection.main.anchor, 8);
});

for (const mode of ['keyboard', 'button']) {
    test(`${mode} imports a complete 30-line SOCKS5 list with Windows line endings`, async () => {
        const lines = Array.from({ length: 30 }, (_, i) => `socks5://192.0.2.1:${20000 + i}`);
        const f = fixture(lines.join('\r\n'));
        await f[mode]();
        assert.deepEqual(f.errors, []);
        assert.equal(f.view.state.doc.lines, 30);
        assert.equal(f.view.state.doc.toString(), lines.join('\n'));
        assert.equal(f.view.state.selection.main.anchor, lines.join('\n').length);
    });
    test(`${mode} accepts Unicode beside CRLF line endings`, async () => {
        const f = fixture('🌍\r\nТест');
        await f[mode]();
        assert.deepEqual(f.errors, []);
        assert.equal(f.view.state.doc.toString(), '🌍\nТест');
        assert.equal(f.view.state.selection.main.anchor, 7);
    });
    test(`${mode} leaves existing text intact when the clipboard is empty`, async () => {
        const f = fixture('', 'keep');
        await f[mode]();
        assert.deepEqual(f.errors, []);
        assert.equal(f.view.state.doc.toString(), 'keep');
        assert.deepEqual(f.parsed, []);
    });
}
