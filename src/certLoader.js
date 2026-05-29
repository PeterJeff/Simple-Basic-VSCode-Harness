const https = require('https');
const tls = require('tls');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const logger = require('./logger');

let _agent = null;
let _enabled = true;

function configure({ enabled }) {
    if (enabled !== _enabled) {
        _enabled = enabled;
        _agent = null; // force rebuild on next use
    }
}

function loadWindowsCerts() {
    // Write the script to a temp file to avoid PowerShell command-line quoting issues
    const tmp = path.join(os.tmpdir(), `agent_certs_${process.pid}.ps1`);
    const script = `
$pems = [System.Collections.Generic.List[string]]::new()
foreach ($storeName in @('Root', 'CA')) {
    try {
        $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($storeName, 'LocalMachine')
        $store.Open('ReadOnly')
        foreach ($cert in $store.Certificates) {
            $pems.Add('-----BEGIN CERTIFICATE-----')
            $pems.Add([System.Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks'))
            $pems.Add('-----END CERTIFICATE-----')
        }
        $store.Close()
    } catch {}
}
$pems -join [char]10
`.trimStart();

    fs.writeFileSync(tmp, script, 'utf8');
    try {
        const out = execSync(`powershell -NoProfile -NonInteractive -File "${tmp}"`, {
            encoding: 'utf8',
            timeout: 15000,
            windowsHide: true
        });
        const certs = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
        logger.log(`certLoader: loaded ${certs.length} certs from Windows store`);
        return certs;
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

function buildAgent() {
    // Node's built-in Mozilla CA bundle
    const builtinCerts = tls.rootCertificates ? [...tls.rootCertificates] : [];

    let allCerts = builtinCerts;
    if (_enabled && process.platform === 'win32') {
        try {
            const winCerts = loadWindowsCerts();
            allCerts = [...builtinCerts, ...winCerts];
        } catch (e) {
            logger.log(`certLoader: could not load Windows certs (${e.message}), using Node built-ins only`);
        }
    }

    return new https.Agent({ ca: allCerts, keepAlive: true });
}

/**
 * Returns a singleton https.Agent that trusts both Node's built-in CAs
 * and (on Windows) the system LocalMachine Root + CA certificate stores.
 */
function getHttpsAgent() {
    if (!_agent) _agent = buildAgent();
    return _agent;
}

/** Call on extension deactivate if you want to force a re-read on next activation. */
function resetAgent() { _agent = null; }

module.exports = { getHttpsAgent, resetAgent, configure };
