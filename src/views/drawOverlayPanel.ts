import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';

/**
 * Draw-call highlight overlay panel — mirrors RenderDoc desktop's
 * "Highlight Drawcall" feature. Displays the current render target with
 * the drawcall bounds painted in pink/purple on top.
 *
 * The panel auto-updates whenever a new draw call is selected in the tree.
 */
export class DrawOverlayPanel {
    public static currentPanel: DrawOverlayPanel | undefined;
    private static readonly viewType = 'renderdoc-drawOverlay';

    private readonly panel: vscode.WebviewPanel;
    private readonly bridge: RenderDocBridge;
    private disposables: vscode.Disposable[] = [];
    private lastEventId: number | undefined;
    private lastLabel: string | undefined;
    private inFlight = false;

    public static async createOrShow(
        _context: vscode.ExtensionContext,
        bridge: RenderDocBridge,
    ): Promise<DrawOverlayPanel> {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (DrawOverlayPanel.currentPanel) {
            DrawOverlayPanel.currentPanel.panel.reveal(column, /* preserveFocus */ true);
            return DrawOverlayPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            DrawOverlayPanel.viewType,
            'RenderDoc: Draw Highlight',
            { viewColumn: column ?? vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: false, retainContextWhenHidden: true, localResourceRoots: [] },
        );

        DrawOverlayPanel.currentPanel = new DrawOverlayPanel(panel, bridge);
        return DrawOverlayPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, bridge: RenderDocBridge) {
        this.panel = panel;
        this.bridge = bridge;
        this.panel.webview.html = this.renderPlaceholder('Select a draw call to highlight its geometry.');
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    /**
     * Request a fresh overlay for the given event and swap it into the panel.
     * Safe to call from the tree-view selection change handler on every click.
     */
    public async showEvent(eventId: number, label?: string): Promise<void> {
        if (typeof eventId !== 'number' || eventId <= 0) { return; }
        if (this.inFlight && this.lastEventId === eventId) { return; }
        this.lastEventId = eventId;
        this.lastLabel = label;

        if (!this.bridge.hasNativeBridge()) {
            this.panel.webview.html = this.renderPlaceholder(
                'Draw highlight requires an active local replay. ' +
                'Open a capture that supports local replay to enable this feature.',
                eventId, label,
            );
            return;
        }

        this.inFlight = true;
        this.panel.webview.html = this.renderLoading(eventId, label);
        try {
            const res = await this.bridge.nativeGetDrawcallOverlay(eventId);
            // If a newer event was requested while we were rendering, drop this result.
            if (this.lastEventId !== eventId) { return; }
            this.panel.webview.html = this.renderImage(res.base64, res.width, res.height, eventId, label, res.rtName);
        } catch (err: any) {
            if (this.lastEventId !== eventId) { return; }
            const msg = String(err?.message ?? err);
            this.panel.webview.html = this.renderPlaceholder(
                `Failed to render drawcall overlay: ${msg}`, eventId, label,
            );
        } finally {
            this.inFlight = false;
        }
    }

    private renderImage(
        base64: string, width: number, height: number,
        eventId: number, label: string | undefined, rtName: string | undefined,
    ): string {
        const imgSrc = `data:image/png;base64,${base64}`;
        const title = label ? escapeHtml(label) : `Event ${eventId}`;
        const rt = rtName ? escapeHtml(rtName) : '(unnamed)';
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">
<style>${baseCss()}</style>
</head><body>
<div class="header">
  <div class="title">${title}</div>
  <div class="sub">Event ${eventId} &middot; ${width}&times;${height} &middot; RT: ${rt}</div>
</div>
<div class="stage">
  <img src="${imgSrc}" alt="Drawcall overlay" />
</div>
<div class="legend">Pink area shows pixels affected by this draw call.</div>
</body></html>`;
    }

    private renderLoading(eventId: number, label: string | undefined): string {
        const title = label ? escapeHtml(label) : `Event ${eventId}`;
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${baseCss()}</style></head><body>
<div class="header"><div class="title">${title}</div><div class="sub">Rendering overlay&hellip;</div></div>
<div class="stage"><div class="placeholder">Rendering drawcall overlay for event ${eventId}&hellip;</div></div>
</body></html>`;
    }

    private renderPlaceholder(message: string, eventId?: number, label?: string): string {
        const title = label ? escapeHtml(label) : (eventId ? `Event ${eventId}` : 'Draw Highlight');
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${baseCss()}</style></head><body>
<div class="header"><div class="title">${title}</div></div>
<div class="stage"><div class="placeholder">${escapeHtml(message)}</div></div>
</body></html>`;
    }

    public dispose() {
        DrawOverlayPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    }
}

function baseCss(): string {
    return `
        :root {
            color-scheme: dark;
            --bg-0: #10151c;
            --bg-1: #171e27;
            --line: rgba(133, 152, 173, 0.18);
            --text-dim: rgba(234, 240, 245, 0.66);
            --shadow: 0 24px 56px rgba(0, 0, 0, 0.28);
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; min-height: 100%; }
        body {
            font-family: "Segoe UI Variable Text", "Bahnschrift", "Segoe UI", sans-serif;
            color: #eef4f8;
            background:
                radial-gradient(circle at top left, rgba(112, 208, 198, 0.12), transparent 30%),
                radial-gradient(circle at top right, rgba(201, 139, 82, 0.12), transparent 24%),
                linear-gradient(180deg, var(--bg-1), var(--bg-0) 60%, #0d1217 100%);
        }
        .shell {
            max-width: 1180px;
            margin: 0 auto;
            padding: 20px;
            display: grid;
            gap: 16px;
            min-height: 100vh;
        }
        .hero,
        .stage,
        .legend {
            position: relative;
            overflow: hidden;
            border: 1px solid var(--line);
            border-radius: 18px;
            background: linear-gradient(180deg, rgba(30, 38, 49, 0.98), rgba(18, 24, 31, 0.98));
            box-shadow: var(--shadow);
        }
        .hero::after,
        .stage::after,
        .legend::after {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(135deg, rgba(112, 208, 198, 0.07), transparent 36%, rgba(201, 139, 82, 0.08));
        }
        .hero {
            padding: 18px 20px;
        }
        .title { font-size: 24px; line-height: 1.08; font-weight: 760; }
        .sub { color: var(--text-dim); font-size: 12px; margin-top: 8px; line-height: 1.5; }
        .stage {
            flex: 1;
            min-height: 420px;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: auto;
            padding: 18px;
            background:
                linear-gradient(45deg, #1d232b 25%, transparent 25%) 0 0 / 18px 18px,
                linear-gradient(-45deg, #1d232b 25%, transparent 25%) 0 9px / 18px 18px,
                linear-gradient(45deg, transparent 75%, #1d232b 75%) 9px -9px / 18px 18px,
                linear-gradient(-45deg, transparent 75%, #1d232b 75%) 9px 0 / 18px 18px,
                #28313d;
        }
        .stage img {
            max-width: 100%;
            max-height: min(76vh, 900px);
            display: block;
            border-radius: 12px;
            box-shadow: 0 18px 36px rgba(0, 0, 0, 0.24);
            image-rendering: -webkit-optimize-contrast;
        }
        .placeholder {
            color: var(--text-dim);
            padding: 24px;
            text-align: center;
            line-height: 1.55;
            max-width: 48ch;
        }
        .legend {
            padding: 14px 16px;
            font-size: 12px;
            line-height: 1.5;
            color: var(--text-dim);
        }
        @media (max-width: 760px) {
            .shell { padding: 14px; }
            .title { font-size: 21px; }
            .stage { min-height: 280px; }
        }
    `;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
