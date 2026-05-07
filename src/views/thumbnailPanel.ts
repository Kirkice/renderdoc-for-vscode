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
        const column = vscode.ViewColumn.Active;

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
            column,
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
        :root {
            color-scheme: dark;
            --bg-0: #10151c;
            --bg-1: #171e27;
            --line: rgba(133, 152, 173, 0.18);
            --text-dim: rgba(234, 240, 245, 0.66);
            --shadow: 0 24px 56px rgba(0, 0, 0, 0.28);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Segoe UI Variable Text", "Bahnschrift", "Segoe UI", sans-serif;
            color: #eef4f8;
            background:
                radial-gradient(circle at top left, rgba(112, 208, 198, 0.12), transparent 28%),
                radial-gradient(circle at top right, rgba(201, 139, 82, 0.14), transparent 24%),
                linear-gradient(180deg, var(--bg-1), var(--bg-0) 60%, #0d1217 100%);
        }
        .shell {
            max-width: 1080px;
            margin: 0 auto;
            padding: 22px;
            display: grid;
            gap: 16px;
        }
        .hero,
        .preview,
        .info-grid {
            position: relative;
            overflow: hidden;
            border: 1px solid var(--line);
            border-radius: 18px;
            background: linear-gradient(180deg, rgba(30, 38, 49, 0.98), rgba(18, 24, 31, 0.98));
            box-shadow: var(--shadow);
        }
        .hero::after,
        .preview::after,
        .info-grid::after {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(135deg, rgba(112, 208, 198, 0.07), transparent 36%, rgba(201, 139, 82, 0.08));
        }
        .hero {
            padding: 18px 20px;
            display: grid;
            gap: 8px;
        }
        .eyebrow {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.16em;
            color: var(--text-dim);
        }
        .heroTitle {
            font-size: 26px;
            line-height: 1.08;
            font-weight: 760;
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
        }
        .subtitle {
            color: var(--text-dim);
            font-size: 12px;
            line-height: 1.55;
            word-break: break-all;
        }
        .badge {
            display: inline-flex;
            align-items: center;
            padding: 5px 10px;
            border-radius: 999px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            border: 1px solid rgba(112, 208, 198, 0.28);
            background: rgba(112, 208, 198, 0.12);
            color: #def8f4;
        }
        .preview {
            padding: 18px;
        }
        .thumbnail-container {
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 18px;
            min-height: 280px;
            border: 1px solid rgba(133, 152, 173, 0.14);
            border-radius: 16px;
            background:
                linear-gradient(45deg, #1d232b 25%, transparent 25%) 0 0 / 18px 18px,
                linear-gradient(-45deg, #1d232b 25%, transparent 25%) 0 9px / 18px 18px,
                linear-gradient(45deg, transparent 75%, #1d232b 75%) 9px -9px / 18px 18px,
                linear-gradient(-45deg, transparent 75%, #1d232b 75%) 9px 0 / 18px 18px,
                #28313d;
        }
        .thumbnail-container img {
            display: block;
            max-width: 100%;
            height: auto;
            border-radius: 10px;
            box-shadow: 0 18px 36px rgba(0, 0, 0, 0.26);
        }
        .info-grid {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 10px 18px;
            padding: 18px;
        }
        .info-grid .label {
            color: var(--text-dim);
            font-weight: 600;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.12em;
        }
        .info-grid .value {
            color: #eef4f8;
            font-family: Consolas, "Cascadia Code", monospace;
            word-break: break-word;
        }
        @media (max-width: 760px) {
            .shell { padding: 14px; }
            .heroTitle { font-size: 22px; }
            .info-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="shell">
        <div class="hero">
            <div class="eyebrow">Capture Preview</div>
            <div class="heroTitle"><span class="badge">${escapeHtml(info.api)}</span> RenderDoc Capture</div>
            <div class="subtitle">${escapeHtml(info.filePath)}</div>
        </div>

        <div class="preview">
            <div class="thumbnail-container">
                <img src="${imgSrc}" alt="Capture Thumbnail" width="${thumbnail.width}" height="${thumbnail.height}" />
            </div>
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
