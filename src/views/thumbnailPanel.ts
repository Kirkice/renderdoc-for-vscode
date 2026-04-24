import * as vscode from 'vscode';
import { ThumbnailData, CaptureInfo } from '../types';

export class ThumbnailPanel {
    public static currentPanel: ThumbnailPanel | undefined;
    private static readonly viewType = 'renderdoc-thumbnail';

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(
        context: vscode.ExtensionContext,
        thumbnail: ThumbnailData,
        captureInfo: CaptureInfo
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, update it
        if (ThumbnailPanel.currentPanel) {
            ThumbnailPanel.currentPanel.update(thumbnail, captureInfo);
            ThumbnailPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            ThumbnailPanel.viewType,
            `RenderDoc: ${captureInfo.api} Capture`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: false,
                localResourceRoots: []
            }
        );

        ThumbnailPanel.currentPanel = new ThumbnailPanel(panel, thumbnail, captureInfo);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        thumbnail: ThumbnailData,
        captureInfo: CaptureInfo
    ) {
        this.panel = panel;
        this.update(thumbnail, captureInfo);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    public update(thumbnail: ThumbnailData, captureInfo: CaptureInfo) {
        this.panel.title = `RenderDoc: ${captureInfo.api} Capture`;
        this.panel.webview.html = this.getHtml(thumbnail, captureInfo);
    }

    private getHtml(thumbnail: ThumbnailData, info: CaptureInfo): string {
        const mimeType = thumbnail.format === 'jpg' ? 'jpeg' : thumbnail.format;
        const imgSrc = `data:image/${mimeType};base64,${thumbnail.base64}`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Capture Preview</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .capture-header {
            text-align: center;
            margin-bottom: 20px;
        }
        .capture-header h1 {
            font-size: 1.4em;
            margin: 0 0 8px 0;
            color: var(--vscode-foreground);
        }
        .capture-header .subtitle {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        .thumbnail-container {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            overflow: hidden;
            max-width: 100%;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        }
        .thumbnail-container img {
            display: block;
            max-width: 100%;
            height: auto;
        }
        .info-grid {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 6px 16px;
            margin-top: 20px;
            padding: 16px;
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            width: 100%;
            max-width: 600px;
        }
        .info-grid .label {
            color: var(--vscode-descriptionForeground);
            font-weight: 600;
            font-size: 0.85em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .info-grid .value {
            color: var(--vscode-foreground);
        }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.8em;
            font-weight: 600;
        }
        .badge-api {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
    </style>
</head>
<body>
    <div class="capture-header">
        <h1><span class="badge badge-api">${escapeHtml(info.api)}</span> Capture</h1>
        <div class="subtitle">${escapeHtml(info.filePath)}</div>
    </div>

    <div class="thumbnail-container">
        <img src="${imgSrc}" alt="Capture Thumbnail" width="${thumbnail.width}" height="${thumbnail.height}" />
    </div>

    <div class="info-grid">
        <span class="label">Graphics API</span>
        <span class="value">${escapeHtml(info.api)}</span>

        <span class="label">Driver</span>
        <span class="value">${escapeHtml(info.driver)}</span>

        <span class="label">RenderDoc</span>
        <span class="value">${escapeHtml(info.rdocVersion)}</span>

        <span class="label">Machine</span>
        <span class="value">${escapeHtml(info.machineIdent)}</span>

        <span class="label">Timestamp</span>
        <span class="value">${escapeHtml(info.timestamp)}</span>

        <span class="label">Thumbnail</span>
        <span class="value">${thumbnail.width} x ${thumbnail.height}</span>

        <span class="label">Sections</span>
        <span class="value">${info.sectionCount}</span>
    </div>
</body>
</html>`;
    }

    public dispose() {
        ThumbnailPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
