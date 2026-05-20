import * as vscode from 'vscode';
import { LaunchTargetState } from '../launchTargetState';

type LaunchTargetViewMessage =
    | { type: 'ready' }
    | { type: 'selectLocal' }
    | { type: 'selectDevice'; url: string }
    | { type: 'refreshCaptureTargets' }
    | { type: 'openLaunchApplication' };

export class LaunchTargetViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private refreshInFlight: Promise<void> | undefined;

    constructor(
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
                await vscode.commands.executeCommand('renderdoc.selectLocalCaptureTarget');
                break;
            case 'selectDevice':
                await vscode.commands.executeCommand('renderdoc.selectCaptureTargetByUrl', message.url);
                break;
            case 'refreshCaptureTargets':
                await vscode.commands.executeCommand('renderdoc.refreshCaptureTargets');
                break;
            case 'openLaunchApplication':
                await vscode.commands.executeCommand('renderdoc.launchCapture');
                break;
        }
    }

    private async pushState(): Promise<void> {
        const view = this.view;
        if (!view) {
            return;
        }

        try {
            await view.webview.postMessage({
                type: 'state',
                selected: this.state.getSelected(),
                devices: this.state.getDevices(),
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
        void webview;
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
            --panel: rgba(18, 24, 31, 0.92);
            --panel-soft: rgba(18, 24, 31, 0.68);
            --line: rgba(132, 153, 176, 0.2);
            --line-strong: rgba(100, 187, 196, 0.44);
            --text-dim: rgba(232, 239, 245, 0.66);
            --shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
        }
        * {
            box-sizing: border-box;
        }
        body {
            margin: 0;
            padding: 10px;
            font-family: "Segoe UI Variable Text", "Bahnschrift", "Segoe UI", sans-serif;
            color: #eef4f8;
            background:
                radial-gradient(circle at top left, rgba(117, 208, 199, 0.12), transparent 34%),
                radial-gradient(circle at top right, rgba(199, 138, 82, 0.14), transparent 30%),
                linear-gradient(180deg, var(--bg-1), var(--bg-0) 52%, #0d1117 100%);
        }
        .panel {
            display: grid;
            gap: 8px;
            padding: 10px;
            border: 1px solid var(--line);
            border-radius: 14px;
            background: linear-gradient(180deg, rgba(28, 35, 44, 0.98), rgba(17, 22, 29, 0.98));
            box-shadow: var(--shadow);
        }
        .panelHeader,
        .targetTop,
        .panelTools {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 10px;
        }
        .panelTitleWrap,
        .targetGroup,
        .targetGrid {
            display: grid;
            gap: 6px;
        }
        .targetSplit {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 8px;
            align-items: stretch;
        }
        .targetGroup {
            min-width: 0;
            align-content: start;
            grid-template-rows: auto 1fr;
        }
        .targetGrid {
            min-width: 0;
        }
        .targetGrid.fill {
            height: 100%;
        }
        .targetGrid.fill > .target,
        .targetGrid.fill > .empty {
            height: 100%;
        }
        .panelTag,
        .groupLabel,
        .currentLabel,
        .chip {
            font-size: 10px;
            letter-spacing: 0.14em;
            text-transform: uppercase;
        }
        .panelTag,
        .groupLabel,
        .currentLabel,
        .panelMeta,
        .currentMeta,
        .meta,
        .metaTight,
        .empty,
        .notice {
            color: var(--text-dim);
        }
        .panelTag,
        .groupLabel,
        .currentLabel {
            font-size: 10px;
        }
        .panelTitle,
        .currentName,
        .title {
            font-size: 13px;
            font-weight: 700;
            line-height: 1.3;
            color: #eef4f8;
        }
        .panelTitle {
            font-size: 14px;
        }
        .panelMeta,
        .currentMeta,
        .meta,
        .metaTight,
        .empty,
        .notice {
            font-size: 11px;
            line-height: 1.4;
        }
        .currentBar,
        .target {
            padding: 9px 10px;
            border: 1px solid rgba(132, 153, 176, 0.18);
            border-radius: 12px;
            background: var(--panel-soft);
        }
        .currentBar {
            display: grid;
            gap: 6px;
        }
        .target {
            position: relative;
            display: grid;
            align-content: start;
            width: 100%;
            cursor: pointer;
            appearance: none;
            text-align: left;
            color: inherit;
            font: inherit;
            transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
        }
        .target:hover {
            transform: translateY(-1px);
            border-color: rgba(117, 208, 199, 0.28);
        }
        .target.active {
            border-color: rgba(117, 208, 199, 0.56);
            background: linear-gradient(180deg, rgba(28, 58, 63, 0.98), rgba(19, 29, 35, 0.98));
            box-shadow: inset 0 0 0 1px rgba(117, 208, 199, 0.22), 0 0 0 1px rgba(117, 208, 199, 0.12);
        }
        .target.active::before {
            content: '';
            position: absolute;
            inset: 0 auto 0 0;
            width: 3px;
            border-radius: 12px 0 0 12px;
            background: linear-gradient(180deg, rgba(117, 208, 199, 0.96), rgba(74, 161, 170, 0.84));
        }
        .target.active .title {
            color: #f5fffd;
        }
        .target.active .meta,
        .target.active .metaTight {
            color: rgba(232, 244, 247, 0.84);
        }
        .meta {
            margin-top: 4px;
        }
        .metaTight {
            margin-top: 2px;
        }
        .chip {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            border-radius: 999px;
            border: 1px solid rgba(132, 153, 176, 0.22);
            background: rgba(132, 153, 176, 0.08);
            white-space: nowrap;
        }
        .chip.good {
            color: #dff8f4;
            border-color: rgba(117, 208, 199, 0.3);
            background: rgba(117, 208, 199, 0.12);
        }
        .chip.warn {
            color: #ffe7ce;
            border-color: rgba(199, 138, 82, 0.34);
            background: rgba(199, 138, 82, 0.14);
        }
        .empty,
        .notice {
            padding: 8px 10px;
            border-radius: 10px;
            border: 1px dashed rgba(132, 153, 176, 0.26);
            background: var(--panel-soft);
        }
        .notice {
            border-style: solid;
            border-color: rgba(117, 208, 199, 0.18);
            color: #eef4f8;
            background: rgba(117, 208, 199, 0.08);
        }
        .notice.warn {
            border-color: rgba(199, 138, 82, 0.26);
            background: rgba(199, 138, 82, 0.12);
        }
        .actionBtn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid rgba(132, 153, 176, 0.22);
            border-radius: 10px;
            background: rgba(132, 153, 176, 0.08);
            color: #eef4f8;
            font: inherit;
            font-size: 11px;
            padding: 7px 10px;
            cursor: pointer;
        }
        .actionBtn:hover {
            border-color: rgba(117, 208, 199, 0.3);
            background: rgba(117, 208, 199, 0.12);
        }
        .actionBtn.primary {
            border-color: rgba(117, 208, 199, 0.3);
            background: rgba(117, 208, 199, 0.16);
            color: #dff8f4;
        }
        .actionBtn.ghost {
            background: transparent;
        }
        .launchRow {
            display: flex;
        }
        .launchRow .actionBtn {
            width: 100%;
        }
        @media (max-width: 420px) {
            .targetSplit {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const appEl = document.getElementById('app');

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function chip(label, tone) {
            return '<span class="chip' + (tone ? ' ' + tone : '') + '">' + escapeHtml(label) + '</span>';
        }

        function messageButton(label, message, variant) {
            return '<button type="button" class="actionBtn' + (variant ? ' ' + variant : '') + '" data-message="' + message + '">' + escapeHtml(label) + '</button>';
        }

        function renderTargetCard(title, primaryMeta, secondaryMeta, statusHtml, active, attrs) {
            return '<button type="button" class="target' + (active ? ' active' : '') + '" ' + attrs + '>'
                + '<div class="targetTop"><div class="title">' + escapeHtml(title) + '</div>' + statusHtml + '</div>'
                + '<div class="meta">' + escapeHtml(primaryMeta) + '</div>'
                + (secondaryMeta ? '<div class="metaTight">' + escapeHtml(secondaryMeta) + '</div>' : '')
                + '</button>';
        }

        function bindButtons(root) {
            if (!root) {
                return;
            }

            root.querySelectorAll('[data-message]').forEach((button) => {
                button.addEventListener('click', () => {
                    const type = button.getAttribute('data-message');
                    if (type) {
                        vscode.postMessage({ type });
                    }
                });
            });

            root.querySelectorAll('[data-select-mode]').forEach((button) => {
                button.addEventListener('click', () => {
                    const mode = button.getAttribute('data-select-mode');
                    if (mode === 'local') {
                        vscode.postMessage({ type: 'selectLocal' });
                        return;
                    }

                    const url = button.getAttribute('data-url');
                    if (mode === 'device' && url) {
                        vscode.postMessage({ type: 'selectDevice', url });
                    }
                });
            });
        }

        function render(state) {
            if (!appEl) {
                return;
            }

            const devices = Array.isArray(state.devices) ? state.devices : [];
            const selected = state.selected && typeof state.selected.kind === 'string' ? state.selected : { kind: 'local' };
            const selectedDevice = selected.kind === 'device'
                ? devices.find((target) => target.url === selected.url)
                : undefined;
            const refreshing = !!state.refreshing;
            const refreshError = typeof state.refreshError === 'string' ? state.refreshError : '';

            const selectionName = selected.kind === 'local'
                ? 'Local Workspace'
                : (selectedDevice?.name || selectedDevice?.id || selected.url || 'Remote Device');
            const selectionKindChip = selected.kind === 'local'
                ? chip('Desktop', 'good')
                : chip('Device', selectedDevice?.supported ? 'good' : 'warn');
            const selectionSummary = selected.kind === 'local'
                ? 'Desktop capture and local replay.'
                : (selectedDevice
                    ? (selectedDevice.url + ' - Launch and Attach use this device.')
                    : ((selected.url || 'Selected device') + ' - Device is not currently detected.'));

            const notices = [];
            if (refreshing) {
                notices.push('<div class="notice">Refreshing target list...</div>');
            }
            if (refreshError) {
                notices.push('<div class="notice warn">Unable to refresh targets: ' + escapeHtml(refreshError) + '</div>');
            }
            if (selected.kind === 'device' && selectedDevice && !selectedDevice.supported) {
                notices.push('<div class="notice warn">The selected device reports limited RenderDoc support.</div>');
            }

            const localCard = renderTargetCard(
                'Local Workspace',
                'Desktop executable or existing local process.',
                'Best for local capture and replay.',
                chip('Desktop', 'good'),
                selected.kind === 'local',
                'data-select-mode="local"'
            );

            const deviceCards = devices.length
                ? devices.map((target) => {
                    const status = target.supported ? chip('Ready', 'good') : chip('Limited', 'warn');
                    const secondaryMeta = target.supported
                        ? ('Protocol: ' + target.protocol)
                        : 'RenderDoc support is uncertain on this target.';
                    const active = selected.kind === 'device' && selected.url === target.url;
                    return renderTargetCard(
                        target.name || target.id,
                        target.url,
                        secondaryMeta,
                        status,
                        active,
                        'data-select-mode="device" data-url="' + escapeHtml(target.url) + '"'
                    );
                }).join('')
                : '<div class="empty">No connected devices.</div>';

            appEl.innerHTML = '<div class="panel">'
                + '<div class="panelHeader">'
                + '<div class="panelTitleWrap">'
                + '<div class="panelTag">Capture Target</div>'
                + '<div class="panelTitle">Target Environment</div>'
                + '<div class="panelMeta">Choose the Command Target for launch and attach. Use Launch Panel for capture and session actions.</div>'
                + '</div>'
                + '<div class="panelTools">' + messageButton('Refresh', 'refreshCaptureTargets', 'ghost') + '</div>'
                + '</div>'
                + notices.join('')
                + '<div class="currentBar">'
                + '<div class="currentLabel">Active Target</div>'
                + '<div class="currentName">' + escapeHtml(selectionName) + '</div>'
                + '<div class="panelTools">' + selectionKindChip + '</div>'
                + '<div class="currentMeta">' + escapeHtml(selectionSummary) + '</div>'
                + '</div>'
                + '<div class="targetSplit">'
                + '<div class="targetGroup"><div class="groupLabel">Desktop</div><div class="targetGrid fill">' + localCard + '</div></div>'
                + '<div class="targetGroup"><div class="groupLabel">Devices</div><div class="targetGrid' + (devices.length <= 1 ? ' fill' : '') + '">' + deviceCards + '</div></div>'
                + '</div>'
                + '<div class="launchRow">'
                + messageButton('Open Launch Panel', 'openLaunchApplication', 'primary')
                + '</div>'
                + '</div>';

            bindButtons(appEl);
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