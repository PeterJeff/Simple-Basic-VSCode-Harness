const vscode = require('vscode');
const logger = require('./src/logger');
const ChatViewProvider = require('./src/chatProvider');

function activate(context) {
    logger.init(context);
    logger.log('Standalone Agent activated');

    const provider = new ChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'standalone-agent.chatView',
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('standalone-agent.newChat', () => {
            provider.newChat();
        }),

        vscode.commands.registerCommand('standalone-agent.clearHistory', async () => {
            const choice = await vscode.window.showWarningMessage(
                'Delete all chat history? This cannot be undone.',
                { modal: true }, 'Delete All'
            );
            if (choice === 'Delete All') provider.clearHistory();
        }),

        vscode.commands.registerCommand('standalone-agent.toggleVerbose', () => {
            const next = !logger.isVerbose();
            logger.setVerbose(next);
            vscode.workspace.getConfiguration('standaloneAgent')
                .update('verboseLogging', next, vscode.ConfigurationTarget.Global);
            provider.sendToWebview({ type: 'verboseState', verbose: next });
            vscode.window.showInformationMessage(
                `Standalone Agent: verbose logging ${next ? 'ON' : 'OFF'}`
            );
        }),

        vscode.commands.registerCommand('standalone-agent.showLogs', () => {
            logger.show();
        }),

        vscode.commands.registerCommand('standalone-agent.addSelectionToContext', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) return;
            const sel = editor.selection;
            const code = editor.document.getText(sel);
            const file = vscode.workspace.asRelativePath(editor.document.uri);
            provider.sendToWebview({
                type: 'addCodeContext',
                code,
                file,
                startLine: sel.start.line + 1,
                endLine:   sel.end.line + 1
            });
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('standaloneAgent')) {
                provider.onConfigChange();
            }
        })
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
