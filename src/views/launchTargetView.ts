import * as vscode from 'vscode';
import { LaunchTargetState } from '../launchTargetState';

type LaunchTargetViewMessage =
    | { type: 'ready' }
    | { type: 'selectLocal' }
    | { type: 'selectDevice'; url: string };

export class LaunchTargetViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly state: LaunchTargetState,
        private readonly onRefresh: () => Promise<void>,
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
        void this.pushState();
    }

    private async handleMessage(message: LaunchTargetViewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.pushState();
                break;
            case 'selectLocal':
                await this.state.selectLocal();
                break;
            case 'selectDevice':
                await this.state.selectDevice(message.url);
                break;
        }
    }

    private async pushState(): Promise<void> {
        if (!this.view) {
            return;
        }
        const selected = this.state.getSelected();
        await this.view.webview.postMessage({
            type: 'state',
            selected,
            devices: this.state.getDevices(),
            liveTarget: this.state.getLiveTarget(),
        });
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
        <div id="targets" class="targetGrid"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const targetsEl = document.getElementById('targets');
        const liveTargetEl = document.getElementById('liveTarget');
        const sessionBadgeEl = document.getElementById('sessionBadge');

        function render(state) {
            const devices = Array.isArray(state.devices) ? state.devices : [];
            const selected = state.selected || { kind: 'local' };
            const liveTarget = state.liveTarget;
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

            const local = document.createElement('div');
            local.className = 'target' + (selected.kind === 'local' ? ' active' : '');
            local.innerHTML = '<div class="targetTop"><div class="title">Local Workspace</div><div class="chip good">Desktop</div></div><div class="meta">Launch on this machine with direct process control and immediate local replay access.</div>';
            local.addEventListener('click', () => vscode.postMessage({ type: 'selectLocal' }));
            targetsEl.appendChild(local);

            if (!devices.length) {
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