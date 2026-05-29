const vscode = require('vscode');

let _channel = null;
let _verbose = false;

function init(context) {
    _channel = vscode.window.createOutputChannel('Standalone Agent');
    context.subscriptions.push(_channel);
    const cfg = vscode.workspace.getConfiguration('standaloneAgent');
    _verbose = cfg.get('verboseLogging', false);
}

function log(msg) {
    _channel?.appendLine(`[${ts()}] ${msg}`);
}

function verbose(label, payload) {
    if (!_verbose || !_channel) return;
    _channel.appendLine(`[${ts()}][VERBOSE] ${label}`);
    if (payload !== undefined) {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        _channel.appendLine(text);
    }
}

function error(msg, err) {
    _channel?.appendLine(`[${ts()}][ERROR] ${msg}${err ? ': ' + err.message : ''}`);
}

function setVerbose(v)  { _verbose = v; }
function isVerbose()    { return _verbose; }
function show()         { _channel?.show(true); }

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

module.exports = { init, log, verbose, error, setVerbose, isVerbose, show };
