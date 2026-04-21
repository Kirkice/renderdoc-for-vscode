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

    private dispose() {
        DrawOverlayPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    }
}

function baseCss(): string {
    return `
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
               background: var(--vscode-editor-background); margin: 0; padding: 12px;
               display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
        .header { margin-bottom: 8px; }
        .title { font-size: 1.1em; font-weight: 600; }
        .sub { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; }
        .stage { flex: 1; display: flex; align-items: center; justify-content: center;
                 border: 1px solid var(--vscode-panel-border); border-radius: 6px;
                 overflow: auto; background: #1a1a1a; }
        .stage img { max-width: 100%; max-height: 100%; display: block;
                     image-rendering: -webkit-optimize-contrast; }
        .placeholder { color: var(--vscode-descriptionForeground); padding: 24px; text-align: center; }
        .legend { margin-top: 8px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    `;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
