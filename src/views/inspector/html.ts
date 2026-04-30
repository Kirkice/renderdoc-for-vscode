import * as vscode from 'vscode';

/** Produce a CSP nonce for the inlined client script. */
export function generateNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Build the full Inspector webview HTML document.
 *
 * CSS and JS are loaded as external resources from `media/inspector/*` via
 * `webview.asWebviewUri`. The CSP forbids every source except the webview's
 * own origin, nonced scripts, and data/https images (needed for texture
 * base64 previews).
 */
export function buildInspectorHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
): string {
    const nonce = generateNonce();
    const cspSource = webview.cspSource;

    const styleUri  = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'inspector', 'style.css'),
    );
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'inspector', 'main.js'),
    );

    const csp = [
        `default-src 'none'`,
        `img-src ${cspSource} data: https:`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>RenderDoc Inspector</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="app">
        <header class="toolbar">
            <div class="title-group">
                <span class="app-title">RenderDoc</span>
                <span class="separator">›</span>
                <span id="event-label" class="event-label">No event selected</span>
                <span id="api-badge" class="badge" hidden></span>
            </div>
            <div class="toolbar-actions">
                <button id="btn-prev-event" title="Previous event" class="icon-btn">‹</button>
                <button id="btn-next-event" title="Next event" class="icon-btn">›</button>
                <input id="event-jump" type="number" placeholder="EID" class="event-input" min="0">
                <button id="btn-jump" class="icon-btn">Go</button>
            </div>
        </header>

        <nav class="tabs" role="tablist">
            <button class="tab active" data-tab="textures" role="tab">Texture Viewer</button>
            <button class="tab" data-tab="pipeline" role="tab">Pipeline State</button>
            <button class="tab" data-tab="shaders" role="tab">Shaders</button>
            <button class="tab" data-tab="mesh" role="tab">Mesh View</button>
            <button class="tab" data-tab="overview" role="tab">Overview</button>
            <button class="tab" data-tab="resources" role="tab">Resource Inspector</button>
            <button class="tab" data-tab="pipelinegraph" role="tab">PipelineGraph</button>
        </nav>

        <main class="content">
            <section id="tab-textures" class="tab-panel active">
                <div id="tex-current" class="tex-current empty-state">Select an event to preview its render target.</div>
                <div id="textures-toolbar" class="sub-toolbar">
                    <div class="scope-toggle" data-scope="tex">
                        <button class="scope active" data-val="output">Outputs (RTs)</button>
                        <button class="scope" data-val="input">Inputs (Sampled)</button>
                    </div>
                    <input id="tex-filter" type="search" placeholder="Filter..." class="filter-input">
                    <span id="tex-count" class="muted"></span>
                </div>
                <div id="textures-body" class="tex-grid empty-state">Select an event.</div>
            </section>

            <section id="tab-pipeline" class="tab-panel">
                <div id="pipeline-body" class="empty-state">Select an event to inspect its pipeline.</div>
            </section>

            <section id="tab-shaders" class="tab-panel">
                <div id="shaders-toolbar" class="sub-toolbar" hidden>
                    <div id="shader-stage-tabs" class="stage-tabs"></div>
                </div>
                <div id="shader-file-tabs" class="stage-tabs shader-file-tabs" hidden></div>
                <div style="display:flex; flex-direction:row; height:calc(100vh - 180px); gap: 0;">
                    <div id="shaders-container" style="flex: 2; display: flex; flex-direction: column; min-width: 0; min-height: 0;">
                        <pre id="shaders-body" class="code-view empty-state" style="flex: 1; height: 100%; margin: 0; min-width: 0;">Select an event to view its shaders.</pre>
                    </div>
                    <div id="mali-offline-splitter" class="vertical-splitter" style="display:none;"></div>
                    <div id="mali-offline-result-container" style="display:none; flex: 1; flex-direction: column; min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-editor-background);">
                        <div style="padding: 6px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; font-size: 0.9em; flex-shrink: 0;">Mali Offline Compiler Analysis</div>
                        <div id="mali-offline-result" style="padding: 12px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 13px); overflow: auto; white-space: pre; flex: 1;"></div>
                    </div>
                </div>
            </section>

            <section id="tab-mesh" class="tab-panel">
                <div id="mesh-toolbar" class="sub-toolbar">
                    <div class="scope-toggle" data-scope="mesh">
                        <button class="scope active" data-val="vsin">VS Input</button>
                        <button class="scope" data-val="vsout">VS Output</button>
                    </div>
                    <button id="mesh-refresh" class="icon-btn">Reload</button>
                    <button id="mesh-reset-view" class="icon-btn" title="Reset preview camera">Reset View</button>
                    <label class="muted" style="display:flex;align-items:center;gap:4px;">
                        <input id="mesh-show-preview" type="checkbox" checked>
                        Preview
                    </label>
                    <span id="mesh-info" class="muted"></span>
                </div>
                <div id="mesh-split" class="mesh-split">
                    <div id="mesh-body" class="mesh-table-wrap empty-state">Select an event to view mesh data.</div>
                    <div id="mesh-splitter" class="horizontal-splitter"></div>
                    <div id="mesh-preview-pane" class="mesh-preview-pane">
                        <canvas id="mesh-canvas"></canvas>
                        <div id="mesh-preview-hint" class="mesh-preview-hint">Drag: rotate · Shift+Drag: pan · Wheel: zoom</div>
                    </div>
                </div>
            </section>

            <section id="tab-overview" class="tab-panel">
                <div id="overview-body" class="empty-state">Load a capture to begin.</div>
            </section>

            <section id="tab-resources" class="tab-panel">
                <div id="resources-toolbar" class="sub-toolbar">
                    <div class="scope-toggle" data-scope="res">
                        <button class="scope active" data-val="all">All</button>
                        <button class="scope" data-val="Texture">Textures</button>
                        <button class="scope" data-val="Buffer">Buffers</button>
                        <button class="scope" data-val="Shader">Shaders</button>
                    </div>
                    <input id="res-filter" type="search" placeholder="Filter resources..." class="filter-input">
                    <span id="res-count" class="muted"></span>
                </div>
                <div id="resources-body" class="resource-list empty-state">Load a capture to see resources.</div>
            </section>

            <section id="tab-pipelinegraph" class="tab-panel">
                <div id="pipeline-graph-toolbar" class="sub-toolbar">
                    <div class="scope-toggle" data-scope="pipelinegraph-zoom">
                        <button id="pg-zoom-out" class="scope" title="Zoom out">-</button>
                        <button id="pg-zoom-reset" class="scope active" title="Reset zoom">100%</button>
                        <button id="pg-zoom-in" class="scope" title="Zoom in">+</button>
                        <button id="pg-zoom-fit" class="scope" title="Fit graph to width">Fit</button>
                    </div>
                    <span id="pg-zoom-label" class="muted">100%</span>
                    <span class="muted">Wheel: zoom · Drag: pan</span>
                </div>
                <div id="pipeline-graph-viewport" class="pg-viewport">
                    <div id="pipeline-graph-stage" class="pg-stage">
                        <div id="pipeline-graph-body" class="empty-state">Load a capture to view its render flow graph.</div>
                    </div>
                </div>
            </section>
        </main>

        <div id="texture-modal" class="modal" hidden>
            <div class="modal-backdrop"></div>
            <div class="modal-panel">
                <div class="modal-header">
                    <span id="tex-modal-title">Texture</span>
                    <div class="modal-actions">
                        <div class="channel-toggle" id="channel-toggle">
                            <button data-ch="-1" class="ch active">RGBA</button>
                            <button data-ch="0" class="ch">R</button>
                            <button data-ch="1" class="ch">G</button>
                            <button data-ch="2" class="ch">B</button>
                            <button data-ch="3" class="ch">A</button>
                        </div>
                        <button id="tex-modal-export" class="icon-btn">Export</button>
                        <button id="tex-modal-close" class="icon-btn">✕</button>
                    </div>
                </div>
                <div class="modal-body">
                    <div id="tex-modal-preview" class="tex-preview-area">
                        <div class="muted">Loading…</div>
                    </div>
                    <div id="tex-modal-meta" class="tex-meta"></div>
                </div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
