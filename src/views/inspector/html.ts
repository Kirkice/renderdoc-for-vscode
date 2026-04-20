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
        `style-src ${cspSource}`,
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
            <button class="tab active" data-tab="overview" role="tab">Overview</button>
            <button class="tab" data-tab="pipeline" role="tab">Pipeline</button>
            <button class="tab" data-tab="shaders" role="tab">Shaders</button>
            <button class="tab" data-tab="textures" role="tab">Textures</button>
            <button class="tab" data-tab="mesh" role="tab">Mesh</button>
            <button class="tab" data-tab="events" role="tab">Events</button>
        </nav>

        <main class="content">
            <section id="tab-overview" class="tab-panel active">
                <div id="overview-body" class="empty-state">Load a capture to begin.</div>
            </section>

            <section id="tab-pipeline" class="tab-panel">
                <div id="pipeline-body" class="empty-state">Select an event to inspect its pipeline.</div>
            </section>

            <section id="tab-shaders" class="tab-panel">
                <div id="shaders-toolbar" class="sub-toolbar" hidden>
                    <div id="shader-stage-tabs" class="stage-tabs"></div>
                </div>
                <pre id="shaders-body" class="code-view empty-state">Select an event to view its shaders.</pre>
            </section>

            <section id="tab-textures" class="tab-panel">
                <div id="textures-toolbar" class="sub-toolbar">
                    <div class="scope-toggle" data-scope="tex">
                        <button class="scope" data-val="draw">This Draw (RTs)</button>
                        <button class="scope active" data-val="all">All Textures</button>
                    </div>
                    <input id="tex-filter" type="search" placeholder="Filter textures..." class="filter-input">
                    <span id="tex-count" class="muted"></span>
                </div>
                <div id="textures-body" class="tex-grid empty-state">Load a capture to see textures.</div>
            </section>

            <section id="tab-mesh" class="tab-panel">
                <div id="mesh-body" class="empty-state">Mesh input inspection requires bound buffer data (coming soon).</div>
            </section>

            <section id="tab-events" class="tab-panel">
                <div id="events-toolbar" class="sub-toolbar">
                    <div class="scope-toggle" data-scope="evt">
                        <button class="scope" data-val="group">Current Group</button>
                        <button class="scope active" data-val="all">All Events</button>
                    </div>
                    <input id="evt-filter" type="search" placeholder="Filter events..." class="filter-input">
                    <span id="evt-count" class="muted"></span>
                </div>
                <div id="events-body" class="event-tree empty-state">Load a capture.</div>
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
