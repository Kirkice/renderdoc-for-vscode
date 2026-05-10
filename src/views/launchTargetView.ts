import * as vscode from 'vscode';
import { LaunchTargetState } from '../launchTargetState';

type LaunchTargetViewMessage =
    | { type: 'ready' }
    | { type: 'selectLocal' }
    | { type: 'selectDevice'; url: string }
    | { type: 'openCapture'; captureId: string }
    | { type: 'saveCapture'; captureId: string }
    | { type: 'deleteCapture'; captureId: string };

export class LaunchTargetViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private refreshInFlight: Promise<void> | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly state: LaunchTargetState,
        private readonly onRefresh: () => Promise<void>,
        private readonly onOpenCapture: (captureId: string) => Promise<void>,
        private readonly onSaveCapture: (captureId: string) => Promise<void>,
        private readonly onDeleteCapture: (captureId: string) => Promise<void>,
    ) {
        this.state.onDidChange(() => {
            void this.pushState();
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message: LaunchTargetViewMessage) => this.handleMessage(message));
        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
            }
        });
        void this.pushState();
    }

    private async handleMessage(message: LaunchTargetViewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.refreshState();
                await this.pushState();
                break;
            case 'selectLocal':
                await this.state.selectLocal();
                break;
            case 'selectDevice':
                await this.state.selectDevice(message.url);
                break;
            case 'openCapture':
                await this.onOpenCapture(message.captureId);
                break;
            case 'saveCapture':
                await this.onSaveCapture(message.captureId);
                break;
            case 'deleteCapture':
                await this.onDeleteCapture(message.captureId);
                break;
        }
    }

    private async pushState(): Promise<void> {
        const view = this.view;
        if (!view) {
            return;
        }
        const selected = this.state.getSelected();
        try {
            await view.webview.postMessage({
                type: 'state',
                selected,
                devices: this.state.getDevices(),
                liveTarget: this.state.getLiveTarget(),
                replayHost: this.state.getReplayHost(),
                recentCaptures: this.state.getRecentCaptures(),
                statusNote: this.state.getLastStatusNote(),
                bridgeVersion: this.state.getBridgeVersion(),
                sessionHint: this.state.getSessionHint(),
                refreshing: this.state.isRefreshing(),
                refreshError: this.state.getLastRefreshError(),
            });
        } catch (error: any) {
            if (this.view === view) {
                this.view = undefined;
            }
            console.warn('[RenderDoc] LaunchTargetViewProvider pushState failed:', error?.message ?? String(error));
        }
    }

    private async refreshState(): Promise<void> {
        if (!this.refreshInFlight) {
            this.refreshInFlight = (async () => {
                try {
                    await this.onRefresh();
                } catch (error: any) {
                    console.warn('[RenderDoc] LaunchTargetViewProvider refresh failed:', error?.message ?? String(error));
                } finally {
                    this.refreshInFlight = undefined;
                }
            })();
        }
        await this.refreshInFlight;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = String(Date.now());
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            color-scheme: dark;
            --bg-0: #0f1318;
            --bg-1: #161b22;
            --bg-2: #1d252f;
            --card: rgba(20, 26, 34, 0.9);
            --card-strong: rgba(25, 33, 43, 0.96);
            --line: rgba(132, 153, 176, 0.2);
            --line-strong: rgba(100, 187, 196, 0.44);
            --text-dim: rgba(232, 239, 245, 0.66);
            --accent: #75d0c7;
            --accent-strong: #c78a52;
            --shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
        }
        body {
            margin: 0;
            padding: 12px;
            font-family: "Segoe UI Variable Text", "Bahnschrift", "Segoe UI", sans-serif;
            color: #eef4f8;
            background:
                radial-gradient(circle at top left, rgba(117, 208, 199, 0.12), transparent 34%),
                radial-gradient(circle at top right, rgba(199, 138, 82, 0.16), transparent 30%),
                linear-gradient(180deg, var(--bg-1), var(--bg-0) 52%, #0d1117 100%);
        }
        .stack {
            display: grid;
            gap: 12px;
        }
        .sectionLabel {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.16em;
            color: var(--text-dim);
            margin: 4px 0 0;
        }
        .hero,
        .panel,
        .target {
            position: relative;
            overflow: hidden;
            border: 1px solid var(--line);
            border-radius: 16px;
            background: linear-gradient(180deg, rgba(28, 35, 44, 0.98), rgba(17, 22, 29, 0.98));
            box-shadow: var(--shadow);
        }
        .hero {
            padding: 14px;
        }
        .hero::after,
        .panel::after,
        .target::after {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(135deg, rgba(117, 208, 199, 0.08), transparent 36%, rgba(199, 138, 82, 0.08));
            pointer-events: none;
        }
        .heroHeader {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .eyebrow {
            font-size: 10px;
            letter-spacing: 0.16em;
            text-transform: uppercase;
            color: var(--text-dim);
        }
        .heroTitle {
            margin-top: 6px;
            font-size: 18px;
            font-weight: 700;
            line-height: 1.15;
        }
        .heroText {
            margin-top: 8px;
            font-size: 12px;
            line-height: 1.5;
            color: var(--text-dim);
            max-width: 28ch;
        }
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 5px 9px;
            border-radius: 999px;
            font-size: 10px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            border: 1px solid rgba(117, 208, 199, 0.32);
            color: #dff8f4;
            background: rgba(117, 208, 199, 0.12);
        }
        .badge.idle {
            border-color: rgba(132, 153, 176, 0.22);
            color: #d2dae4;
            background: rgba(132, 153, 176, 0.1);
        }
        .panel {
            padding: 12px;
            display: grid;
            gap: 8px;
        }
        .panelTitle {
            font-size: 13px;
            font-weight: 700;
        }
        .panelMeta {
            font-size: 11px;
            line-height: 1.45;
            color: var(--text-dim);
        }
        .targetGrid {
            display: grid;
            gap: 10px;
        }
        .target {
            padding: 12px;
            cursor: pointer;
            transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
            animation: riseIn 280ms ease both;
        }
        .target:hover {
            transform: translateY(-1px);
            border-color: rgba(117, 208, 199, 0.28);
        }
        .target.active {
            border-color: var(--line-strong);
            background: linear-gradient(180deg, rgba(21, 42, 46, 0.96), rgba(18, 25, 31, 0.98));
            box-shadow: 0 0 0 1px rgba(117, 208, 199, 0.16), var(--shadow);
        }
        .targetTop {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 10px;
        }
        .title {
            font-size: 13px;
            font-weight: 700;
            line-height: 1.25;
        }
        .meta {
            margin-top: 6px;
            font-size: 11px;
            line-height: 1.45;
            color: var(--text-dim);
        }
        .chip {
            padding: 4px 8px;
            border-radius: 999px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            border: 1px solid rgba(132, 153, 176, 0.22);
            color: #d2dae4;
            background: rgba(132, 153, 176, 0.08);
            white-space: nowrap;
        }
        .chip.good {
            color: #dff8f4;
            border-color: rgba(117, 208, 199, 0.28);
            background: rgba(117, 208, 199, 0.12);
        }
        .empty {
            font-size: 11px;
            line-height: 1.5;
            color: var(--text-dim);
            border: 1px dashed rgba(132, 153, 176, 0.26);
            border-radius: 14px;
            padding: 12px;
            background: rgba(18, 24, 31, 0.66);
        }
        .live {
            display: grid;
            gap: 6px;
        }
        .liveMetaRow {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .captureList {
            display: grid;
            gap: 10px;
        }
        .captureItem {
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 12px;
            background: rgba(18, 24, 31, 0.72);
            display: grid;
            gap: 8px;
        }
        .captureRow {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 10px;
        }
        .captureMetaRow {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .captureActions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .statusStack {
            display: grid;
            gap: 10px;
        }
        .statusNote {
            font-size: 12px;
            line-height: 1.5;
            color: #eef4f8;
            padding: 10px 12px;
            border-radius: 12px;
            background: rgba(117, 208, 199, 0.08);
            border: 1px solid rgba(117, 208, 199, 0.18);
        }
        .actionBtn {
            border: 1px solid rgba(132, 153, 176, 0.22);
            border-radius: 999px;
            background: rgba(132, 153, 176, 0.08);
            color: #eef4f8;
            font: inherit;
            font-size: 11px;
            padding: 5px 10px;
            cursor: pointer;
        }
        .actionBtn:hover {
            border-color: rgba(117, 208, 199, 0.3);
            background: rgba(117, 208, 199, 0.12);
        }
        @keyframes riseIn {
            from {
                opacity: 0;
                transform: translateY(6px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    </style>
</head>
<body>
    <div class="stack">
        <div class="hero">
            <div class="heroHeader">
                <div>
                    <div class="eyebrow">RenderDoc Capture Flow</div>
                    <div class="heroTitle">Launch, attach, and capture with a live target workflow.</div>
                </div>
                <div id="sessionBadge" class="badge idle">Idle</div>
            </div>
            <div class="heroText">Choose where the program should run, then use the title-bar commands to launch or attach. Capture stays separate so frame grabs happen only when you decide.</div>
        </div>

        <div class="sectionLabel">Target Selection</div>
        <div id="liveTarget"></div>
        <div id="sessionStatus"></div>
        <div id="recentCaptures"></div>
        <div id="replayHost"></div>
        <div id="targets" class="targetGrid"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const targetsEl = document.getElementById('targets');
        const liveTargetEl = document.getElementById('liveTarget');
        const sessionStatusEl = document.getElementById('sessionStatus');
        const recentCapturesEl = document.getElementById('recentCaptures');
        const replayHostEl = document.getElementById('replayHost');
        const sessionBadgeEl = document.getElementById('sessionBadge');

        function render(state) {
            const devices = Array.isArray(state.devices) ? state.devices : [];
            const selected = state.selected || { kind: 'local' };
            const liveTarget = state.liveTarget;
            const recentCaptures = Array.isArray(state.recentCaptures) ? state.recentCaptures : [];
            const replayHost = state.replayHost;
            const statusNote = typeof state.statusNote === 'string' ? state.statusNote : '';
            const bridgeVersion = typeof state.bridgeVersion === 'string' ? state.bridgeVersion : '';
            const sessionHint = typeof state.sessionHint === 'string' ? state.sessionHint : '';
            const refreshing = !!state.refreshing;
            const refreshError = typeof state.refreshError === 'string' ? state.refreshError : '';
            targetsEl.innerHTML = '';
            if (liveTarget) {
                const location = liveTarget.local ? 'Local target' : (liveTarget.url || 'Remote target');
                const apiChip = liveTarget.api ? '<span class="chip good">' + liveTarget.api + '</span>' : '';
                const pidChip = liveTarget.pid ? '<span class="chip">PID ' + liveTarget.pid + '</span>' : '';
                liveTargetEl.innerHTML = '<div class="panel"><div class="panelTitle">Current Live Session</div><div class="live"><div class="title">' + (liveTarget.target || 'Connected Target') + '</div><div class="panelMeta">' + location + '</div><div class="liveMetaRow">' + apiChip + pidChip + '</div></div></div>';
                sessionBadgeEl.textContent = 'Connected';
                sessionBadgeEl.className = 'badge';
            } else {
                liveTargetEl.innerHTML = '<div class="panel"><div class="panelTitle">Current Live Session</div><div class="empty">No live target is connected yet. Use the title-bar Launch, Attach, or Refresh actions above to start a capture workflow.</div></div>';
                sessionBadgeEl.textContent = 'Idle';
                sessionBadgeEl.className = 'badge idle';
            }

            const versionChip = bridgeVersion ? '<span class="chip">RenderDoc ' + bridgeVersion + '</span>' : '';
            const liveChip = liveTarget && !liveTarget.local ? '<span class="chip good">Remote Session</span>' : (liveTarget ? '<span class="chip good">Local Session</span>' : '<span class="chip">No Session</span>');
            const noteBlock = statusNote ? '<div class="statusNote">' + statusNote + '</div>' : '<div class="empty">No live capture or replay status messages yet.</div>';
            const hintBlock = sessionHint ? '<div class="panelMeta">' + sessionHint + '</div>' : '<div class="panelMeta">Session status, version, and replay compatibility guidance will appear here as you connect devices and capture frames.</div>';
            sessionStatusEl.innerHTML = '<div class="panel"><div class="panelTitle">Session Status</div><div class="statusStack"><div class="liveMetaRow">' + liveChip + versionChip + '</div>' + noteBlock + hintBlock + '</div></div>';

            if (replayHost && replayHost.connected) {
                const protocolChip = replayHost.protocol ? '<span class="chip good">' + replayHost.protocol + '</span>' : '';
                replayHostEl.innerHTML = '<div class="panel"><div class="panelTitle">Current Replay Host</div><div class="live"><div class="title">' + (replayHost.url || 'Remote Replay Host') + '</div><div class="panelMeta">Replay queries will open captures on this host when remote replay is selected.</div><div class="liveMetaRow">' + protocolChip + '</div></div></div>';
            } else {
                replayHostEl.innerHTML = '<div class="panel"><div class="panelTitle">Current Replay Host</div><div class="empty">No remote replay host is selected. Cross-platform captures will default to local replay unless you pick a device host.</div></div>';
            }

            if (recentCaptures.length) {
                recentCapturesEl.innerHTML = '<div class="panel"><div class="panelTitle">Current Session Captures</div><div class="panelMeta">Recent live captures from this session. Open them again, keep a permanent copy, or delete the temporary file.</div><div class="captureList">' + recentCaptures.map((capture) => {
                    const savedChip = capture.saved ? '<span class="chip good">Saved</span>' : '<span class="chip">Temporary</span>';
                    const apiChip = capture.api ? '<span class="chip">' + capture.api + '</span>' : '';
                    const frameChip = capture.frameNumber ? '<span class="chip">Frame ' + capture.frameNumber + '</span>' : '';
                    const sourceChip = capture.sourceUrl ? '<span class="chip">' + capture.sourceUrl + '</span>' : '<span class="chip">Local</span>';
                    const saveButton = capture.saved ? '' : '<button class="actionBtn" data-action="saveCapture" data-id="' + capture.id + '">Save As</button>';
                    return '<div class="captureItem"><div class="captureRow"><div><div class="title">' + capture.displayName + '</div><div class="meta">' + capture.filePath + '</div></div>' + savedChip + '</div><div class="captureMetaRow">' + apiChip + frameChip + sourceChip + '</div><div class="captureActions"><button class="actionBtn" data-action="openCapture" data-id="' + capture.id + '">Open</button>' + saveButton + '<button class="actionBtn" data-action="deleteCapture" data-id="' + capture.id + '">Delete</button></div></div>';
                }).join('') + '</div></div>';
            } else {
                recentCapturesEl.innerHTML = '<div class="panel"><div class="panelTitle">Current Session Captures</div><div class="empty">No live captures have been produced yet. Once you capture a frame from a local or remote target, it will appear here for reopen, save, or deletion.</div></div>';
            }

            recentCapturesEl.querySelectorAll('[data-action]').forEach((button) => {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const action = button.getAttribute('data-action');
                    const captureId = button.getAttribute('data-id');
                    if (action && captureId) {
                        vscode.postMessage({ type: action, captureId });
                    }
                });
            });

            const local = document.createElement('div');
            local.className = 'target' + (selected.kind === 'local' ? ' active' : '');
            local.innerHTML = '<div class="targetTop"><div class="title">Local Workspace</div><div class="chip good">Desktop</div></div><div class="meta">Launch on this machine with direct process control and immediate local replay access.</div>';
            local.addEventListener('click', () => vscode.postMessage({ type: 'selectLocal' }));
            targetsEl.appendChild(local);

            if (refreshing) {
                const loading = document.createElement('div');
                loading.className = 'empty';
                loading.textContent = 'Refreshing capture targets…';
                targetsEl.appendChild(loading);
            }

            if (refreshError) {
                const error = document.createElement('div');
                error.className = 'empty';
                error.textContent = 'Unable to refresh capture targets: ' + refreshError;
                targetsEl.appendChild(error);
            }

            if (!devices.length && !refreshing) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No mobile or remote devices detected.';
                targetsEl.appendChild(empty);
                return;
            }

            for (const target of devices) {
                const el = document.createElement('div');
                const active = selected.kind === 'device' && selected.url === target.url;
                el.className = 'target' + (active ? ' active' : '');
                const status = target.supported ? '<div class="chip good">Ready</div>' : '<div class="chip">Unsupported</div>';
                const detail = target.supported ? target.url : target.url + ' · unsupported';
                el.innerHTML = '<div class="targetTop"><div class="title">' + (target.name || target.id) + '</div>' + status + '</div><div class="meta">' + detail + '</div>';
                el.addEventListener('click', () => vscode.postMessage({ type: 'selectDevice', url: target.url }));
                targetsEl.appendChild(el);
            }
        }

        window.addEventListener('message', (event) => {
            if (event.data?.type === 'state') {
                render(event.data);
            }
        });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}