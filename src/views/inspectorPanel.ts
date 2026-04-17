import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';
import { DrawCall, ResourceInfo, CaptureInfo } from '../types';

/** Wrap a promise so it rejects after `ms` if it hasn't settled. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) { done = true; reject(new Error(message)); }
        }, ms);
        p.then(v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
               e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
}

/**
 * RenderDoc-style unified Inspector WebView.
 *
 * One persistent WebView panel with a tabbed UI that mirrors the RenderDoc
 * desktop layout: Overview / Pipeline / Shaders / Textures / Mesh / Events.
 *
 * Selecting an event in the sidebar updates this panel in place; within the
 * panel the user can click resources to drill down further without leaving
 * the single view.
 */
export class InspectorPanel {
    public static currentPanel: InspectorPanel | undefined;
    private static readonly viewType = 'renderdoc-inspector';

    /**
     * Optional provider the panel uses to fetch capture state when the webview
     * becomes ready (and the extension hasn't explicitly pushed it yet). Callers
     * can inject this once during activate() to support reload scenarios.
     */
    public static captureProvider:
        | (() => Promise<{ captureInfo: CaptureInfo; drawCalls: DrawCall[]; resources: ResourceInfo[] } | undefined>)
        | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private readonly bridge: RenderDocBridge;

    private captureInfo: CaptureInfo | undefined;
    private drawCalls: DrawCall[] = [];
    private resources: ResourceInfo[] = [];
    private currentEventId: number | undefined;
    private currentDrawCall: DrawCall | undefined;

    // Cache per-event shader results to avoid repeated calls
    private shaderCache = new Map<number, any>();
    private pipelineCache = new Map<number, any>();
    // Cache rendered textures (base64 PNG) keyed by "resId:mip:eventId"
    private texturePreviewCache = new Map<string, { base64: string; width: number; height: number; texFormat: string }>();

    private disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext, bridge: RenderDocBridge) {
        const column = vscode.ViewColumn.Beside;

        if (InspectorPanel.currentPanel) {
            InspectorPanel.currentPanel.panel.reveal(column, true);
            return InspectorPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            InspectorPanel.viewType,
            'RenderDoc Inspector',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
            }
        );

        InspectorPanel.currentPanel = new InspectorPanel(panel, context, bridge);
        return InspectorPanel.currentPanel;
    }

    /**
     * Hook used by the webview-panel serializer so a panel restored across a
     * window reload becomes a live InspectorPanel again (otherwise VS Code
     * would show a dead tab with no extension-side backing).
     */
    public static revive(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        bridge: RenderDocBridge,
    ) {
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        InspectorPanel.currentPanel = new InspectorPanel(panel, context, bridge);
        return InspectorPanel.currentPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        bridge: RenderDocBridge
    ) {
        this.panel = panel;
        this.context = context;
        this.bridge = bridge;

        this.panel.webview.html = this.getInitialHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleWebviewMessage(msg),
            null,
            this.disposables
        );
    }

    /** Called from extension.ts when a new capture has been loaded/refreshed. */
    public setCapture(
        captureInfo: CaptureInfo,
        drawCalls: DrawCall[],
        resources: ResourceInfo[]
    ) {
        const sameFile = this.captureInfo?.filePath === captureInfo?.filePath;
        console.log('[Inspector ext] setCapture:', captureInfo?.filePath,
            'draws=', drawCalls?.length, 'resources=', resources?.length, 'sameFile=', sameFile);
        this.captureInfo = captureInfo;
        this.drawCalls = drawCalls;
        this.resources = resources;
        // Only invalidate caches when the capture file actually changed.
        // Re-posting the same capture (e.g. webview ready handler re-sync)
        // must not wipe cached shader/pipeline data; otherwise the webview
        // resets state.shaders/pipeline to null but no reload is triggered
        // and tabs stay on "Loading…" forever.
        if (!sameFile) {
            this.shaderCache.clear();
            this.pipelineCache.clear();
            this.texturePreviewCache.clear();
        }

        this.panel.webview.postMessage({
            type: 'captureLoaded',
            captureInfo,
            drawCalls,
            resources: resources.map(r => ({
                resourceId: r.resourceId,
                name: r.name,
                type: r.type,
                format: r.format,
                width: r.width,
                height: r.height,
                byteSize: r.byteSize,
            })),
        });

        // After (re-)pushing capture, if we already have a focused event,
        // re-post its shader/pipeline state from cache so the webview doesn't
        // get stuck on Loading after the captureLoaded reset.
        if (this.currentEventId !== undefined) {
            const eid = this.currentEventId;
            if (this.shaderCache.has(eid)) {
                this.panel.webview.postMessage({ type: 'shadersLoaded', eventId: eid, data: this.shaderCache.get(eid) });
            }
            if (this.pipelineCache.has(eid)) {
                this.panel.webview.postMessage({ type: 'pipelineLoaded', eventId: eid, data: this.pipelineCache.get(eid) });
            }
        }
    }

    /** Set / change the focused event — the whole panel updates around this. */
    public async setEvent(eventId: number, drawCall?: DrawCall) {
        this.currentEventId = eventId;
        this.currentDrawCall = drawCall ?? this.findDrawCall(eventId);
        this.panel.title = `Inspector — EID ${eventId}${this.currentDrawCall ? ': ' + this.currentDrawCall.name : ''}`;

        // Post eventChanged immediately so the header updates even while the
        // capture state is still being pulled (first draw click after reload
        // can take seconds to convert XML).
        this.panel.webview.postMessage({
            type: 'eventChanged',
            eventId,
            drawCall: this.currentDrawCall,
        });

        // If capture wasn't pushed yet, pull it now in the background.
        if (!this.captureInfo && InspectorPanel.captureProvider) {
            InspectorPanel.captureProvider().then(pulled => {
                if (pulled && !this.captureInfo) {
                    this.setCapture(pulled.captureInfo, pulled.drawCalls, pulled.resources);
                    // Re-post event so drawCall lookup picks up the now-loaded tree.
                    if (!this.currentDrawCall) {
                        this.currentDrawCall = this.findDrawCall(eventId);
                        this.panel.webview.postMessage({
                            type: 'eventChanged',
                            eventId,
                            drawCall: this.currentDrawCall,
                        });
                    }
                }
            }).catch(() => { /* best effort */ });
        }

        // Kick off async loads; webview gets incremental updates as data arrives.
        // Guard with .catch so even an uncaught async error still unblocks the
        // webview with an error message instead of leaving "Loading…" forever.
        this.loadShadersForEvent(eventId).catch(e => {
            console.warn('[Inspector] shader load failed:', e?.message);
            this.panel.webview.postMessage({
                type: 'shadersLoaded',
                eventId,
                data: { error: e?.message || 'Shader load failed.' },
            });
        });
        this.loadPipelineForEvent(eventId).catch(e => {
            console.warn('[Inspector] pipeline load failed:', e?.message);
            this.panel.webview.postMessage({
                type: 'pipelineLoaded',
                eventId,
                data: { error: e?.message || 'Pipeline load failed.' },
            });
        });
    }

    public reveal() {
        this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    /** Current focused event ID, or undefined if none selected. */
    public getCurrentEventId(): number | undefined {
        return this.currentEventId;
    }

    /** Current focused draw call (if any). */
    public getCurrentDrawCall(): DrawCall | undefined {
        return this.currentDrawCall;
    }

    /** File path of the currently loaded capture, or undefined if none. */
    public getCaptureFilePath(): string | undefined {
        return this.captureInfo?.filePath;
    }

    // ─────────────────────────────────────────────────────────────────────

    private findDrawCall(eventId: number, list = this.drawCalls): DrawCall | undefined {
        for (const dc of list) {
            if (dc.eventId === eventId) { return dc; }
            if (dc.children?.length) {
                const found = this.findDrawCall(eventId, dc.children);
                if (found) { return found; }
            }
        }
        return undefined;
    }

    private async loadShadersForEvent(eventId: number) {
        console.log('[Inspector ext] loadShadersForEvent', eventId, 'hasNative=', this.bridge.hasNativeBridge());
        if (!this.bridge.hasNativeBridge()) {
            this.panel.webview.postMessage({
                type: 'shadersLoaded',
                eventId,
                data: { error: 'Native bridge unavailable (local replay required).' },
            });
            return;
        }
        if (!this.shaderCache.has(eventId)) {
            try {
                const result = await withTimeout(
                    this.bridge.nativeGetShaderSource(eventId),
                    30000,
                    'Shader source request timed out after 30s.',
                );
                this.shaderCache.set(eventId, result);
            } catch (e: any) {
                this.shaderCache.set(eventId, { error: e.message });
            }
        }
        if (this.currentEventId === eventId) {
            this.panel.webview.postMessage({
                type: 'shadersLoaded',
                eventId,
                data: this.shaderCache.get(eventId),
            });
        }
    }

    private async loadPipelineForEvent(eventId: number) {
        console.log('[Inspector ext] loadPipelineForEvent', eventId, 'hasNative=', this.bridge.hasNativeBridge());
        if (!this.bridge.hasNativeBridge()) {
            this.panel.webview.postMessage({
                type: 'pipelineLoaded',
                eventId,
                data: { error: 'Native bridge unavailable (local replay required).' },
            });
            return;
        }
        if (!this.pipelineCache.has(eventId)) {
            try {
                const result = await withTimeout(
                    this.bridge.nativeGetPipelineState(eventId),
                    30000,
                    'Pipeline state request timed out after 30s.',
                );
                this.pipelineCache.set(eventId, result);
            } catch (e: any) {
                this.pipelineCache.set(eventId, { error: e.message });
            }
        }
        if (this.currentEventId === eventId) {
            this.panel.webview.postMessage({
                type: 'pipelineLoaded',
                eventId,
                data: this.pipelineCache.get(eventId),
            });
        }
    }

    private async loadTexturePreview(resourceId: string, mip: number, eventId: number, channelExtract: number) {
        const key = `${resourceId}:${mip}:${eventId}:${channelExtract}`;
        if (this.texturePreviewCache.has(key)) {
            const cached = this.texturePreviewCache.get(key)!;
            this.panel.webview.postMessage({ type: 'texturePreview', key, ...cached });
            return;
        }
        if (!this.bridge.hasNativeBridge()) {
            this.panel.webview.postMessage({ type: 'texturePreview', key, error: 'Native bridge not available (replay required).' });
            return;
        }
        try {
            const result = await this.bridge.nativeGetTextureData(resourceId, mip, eventId, channelExtract);
            if (result?.base64) {
                const data = { base64: result.base64, width: result.width, height: result.height, texFormat: result.texFormat };
                this.texturePreviewCache.set(key, data);
                this.panel.webview.postMessage({ type: 'texturePreview', key, ...data });
            } else {
                this.panel.webview.postMessage({ type: 'texturePreview', key, error: 'No preview returned' });
            }
        } catch (e: any) {
            this.panel.webview.postMessage({ type: 'texturePreview', key, error: e.message });
        }
    }

    private handleWebviewMessage(msg: any) {
        if (msg?.type !== 'requestTexture') {
            console.log('[Inspector ext] webview->ext msg:', msg?.type);
        }
        switch (msg.type) {
            case 'ready':
                // Webview is ready. Always try to re-sync BOTH capture and
                // event so the webview never gets stuck on the empty state
                // regardless of ordering (e.g. user clicked a draw before
                // capture finished loading, or VS Code reloaded the panel).
                (async () => {
                    console.log('[Inspector] webview ready; captureInfo?', !!this.captureInfo,
                        'currentEventId=', this.currentEventId);

                    // Wait up to ~30s for a capture to become available —
                    // covers the case where auto-restore on activate() is
                    // still running (native replay init + draw-call parse can
                    // take a while on large captures).
                    let captureToPush = this.captureInfo
                        ? { captureInfo: this.captureInfo, drawCalls: this.drawCalls, resources: this.resources }
                        : undefined;
                    if (!captureToPush && InspectorPanel.captureProvider) {
                        for (let i = 0; i < 150 && !captureToPush && !this.captureInfo; i++) {
                            try {
                                captureToPush = await InspectorPanel.captureProvider();
                            } catch { /* retry */ }
                            if (!captureToPush) {
                                await new Promise(r => setTimeout(r, 200));
                            }
                        }
                    }
                    if (captureToPush) {
                        this.setCapture(captureToPush.captureInfo, captureToPush.drawCalls, captureToPush.resources);
                    }
                    if (this.currentEventId !== undefined) {
                        // Re-post eventChanged directly (don't re-trigger loads
                        // unnecessarily if setEvent already ran).
                        this.panel.webview.postMessage({
                            type: 'eventChanged',
                            eventId: this.currentEventId,
                            drawCall: this.currentDrawCall ?? this.findDrawCall(this.currentEventId),
                        });
                    }
                })();
                break;
            case 'selectEvent':
                this.setEvent(msg.eventId);
                break;
            case 'requestTexture':
                this.loadTexturePreview(msg.resourceId, msg.mip ?? 0, msg.eventId ?? this.currentEventId ?? 0, msg.channelExtract ?? -1);
                break;
            case 'openShaderInEditor': {
                const source = msg.source ?? '';
                vscode.workspace.openTextDocument({ content: source, language: msg.language ?? 'glsl' })
                    .then(doc => vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active }));
                break;
            }
            case 'copyToClipboard':
                vscode.env.clipboard.writeText(msg.text ?? '');
                vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
                break;
            case 'exportTexture':
                vscode.commands.executeCommand('renderdoc.exportTexture', { resourceId: msg.resourceId, label: msg.label });
                break;
            case 'showResourceDetails':
                vscode.commands.executeCommand('renderdoc.showResourceDetails', { resourceId: msg.resourceId, label: msg.label });
                break;
        }
    }

    private dispose() {
        InspectorPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    /** Public wrapper around dispose so callers can force-close the panel. */
    public disposePanel() {
        this.dispose();
    }

    // ─────────────────────────────────────────────────────────────────────

    private getInitialHtml(): string {
        const nonce = getNonce();
        const csp = `default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>RenderDoc Inspector</title>
    <style>${getCss()}</style>
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
    <script nonce="${nonce}">${getClientScript()}</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function getCss(): string {
    return /* css */ `
        :root { --pad: 12px; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-size: var(--vscode-font-size);
        }
        #app { display: flex; flex-direction: column; height: 100vh; }

        /* Toolbar */
        .toolbar {
            display: flex; justify-content: space-between; align-items: center;
            padding: 6px 12px;
            background: var(--vscode-titleBar-activeBackground, var(--vscode-sideBar-background));
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .title-group { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .app-title { font-weight: 600; color: var(--vscode-descriptionForeground); }
        .separator { color: var(--vscode-descriptionForeground); }
        .event-label {
            font-family: var(--vscode-editor-font-family);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            color: var(--vscode-symbolIcon-functionForeground, var(--vscode-foreground));
        }
        .badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 0.75em; padding: 2px 8px; border-radius: 8px;
        }
        .toolbar-actions { display: flex; gap: 4px; align-items: center; }
        .icon-btn {
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid transparent;
            padding: 4px 10px; border-radius: 3px; cursor: pointer;
            font-family: inherit; font-size: 0.9em;
        }
        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            border-color: var(--vscode-panel-border);
        }
        .event-input {
            width: 80px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            padding: 4px 6px; border-radius: 2px;
            font-family: inherit; font-size: 0.9em;
        }

        /* Tabs */
        .tabs {
            display: flex; gap: 2px;
            background: var(--vscode-tab-inactiveBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
            overflow-x: auto;
        }
        .tab {
            background: transparent;
            color: var(--vscode-tab-inactiveForeground);
            border: none; padding: 8px 16px; cursor: pointer;
            font-family: inherit; font-size: 0.9em;
            border-bottom: 2px solid transparent;
            white-space: nowrap;
        }
        .tab:hover { background: var(--vscode-tab-hoverBackground); color: var(--vscode-tab-activeForeground); }
        .tab.active {
            color: var(--vscode-tab-activeForeground);
            background: var(--vscode-tab-activeBackground);
            border-bottom-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
        }

        /* Content */
        .content { flex: 1; overflow: hidden; position: relative; }
        .tab-panel { display: none; height: 100%; overflow: auto; padding: var(--pad); }
        .tab-panel.active { display: block; }

        .sub-toolbar {
            display: flex; gap: 8px; align-items: center;
            padding: 6px var(--pad); margin: -12px -12px 12px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky; top: -12px; z-index: 2;
        }
        .filter-input {
            flex: 1; max-width: 300px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            padding: 4px 8px; border-radius: 2px;
            font-family: inherit;
        }
        .muted { color: var(--vscode-descriptionForeground); font-size: 0.85em; }

        .empty-state {
            display: flex; align-items: center; justify-content: center;
            min-height: 200px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        /* Overview */
        .info-grid {
            display: grid; grid-template-columns: auto 1fr;
            gap: 6px 16px;
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px 16px; margin-bottom: 16px;
        }
        .info-grid .k { color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 0.8em; letter-spacing: 0.5px; }
        .info-grid .v { font-family: var(--vscode-editor-font-family); }
        .stat-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
        .stat-card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px 16px; min-width: 120px;
        }
        .stat-card .n { font-size: 1.6em; font-weight: 600; color: var(--vscode-symbolIcon-numberForeground, var(--vscode-foreground)); }
        .stat-card .l { color: var(--vscode-descriptionForeground); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.5px; }

        /* Pipeline */
        .pipe-flow {
            display: flex; align-items: stretch; gap: 0;
            overflow-x: auto; padding: 8px 4px;
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .pipe-stage {
            flex: 0 0 auto;
            min-width: 160px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px 12px;
            display: flex; flex-direction: column; gap: 4px;
            position: relative;
            cursor: default;
        }
        .pipe-stage.clickable { cursor: pointer; }
        .pipe-stage.clickable:hover {
            border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
        }
        .pipe-stage.inactive { opacity: 0.4; }
        .pipe-stage.fixed { background: var(--vscode-sideBar-background); }
        .pipe-stage .ps-kind {
            font-size: 0.7em;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-descriptionForeground);
        }
        .pipe-stage .ps-name {
            font-weight: 600;
            font-size: 0.95em;
            color: var(--vscode-symbolIcon-methodForeground, var(--vscode-textLink-foreground));
        }
        .pipe-stage .ps-shader {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.85em;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pipe-stage .ps-meta {
            font-size: 0.75em;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
        }
        .pipe-arrow {
            flex: 0 0 auto;
            align-self: center;
            color: var(--vscode-descriptionForeground);
            padding: 0 4px;
            font-size: 1.2em;
        }
        .pipe-subtitle {
            margin: 16px 0 6px;
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .resource-chip {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 3px 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.8em;
            cursor: pointer;
            margin: 2px 4px 2px 0;
        }
        .resource-chip:hover { background: var(--vscode-button-hoverBackground, var(--vscode-badge-background)); }
        .resource-chip.depth { background: rgba(220, 120, 120, 0.3); color: rgb(250, 180, 180); }

        /* Scope toggle (used in tab toolbars) */
        .scope-toggle { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; }
        .scope-toggle .scope {
            background: transparent; color: var(--vscode-foreground);
            border: none; padding: 4px 10px; cursor: pointer;
            font-family: inherit; font-size: 0.85em;
            border-right: 1px solid var(--vscode-panel-border);
        }
        .scope-toggle .scope:last-child { border-right: none; }
        .scope-toggle .scope.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

        /* Pipeline (legacy stage-list, still used as fallback) */
        .stage-row {
            display: grid; grid-template-columns: 80px 1fr auto;
            align-items: center;
            padding: 8px 12px;
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
        }
        .stage-row.inactive { opacity: 0.45; }
        .stage-name {
            font-weight: 600; text-transform: uppercase; font-size: 0.85em;
            color: var(--vscode-symbolIcon-methodForeground, var(--vscode-textLink-foreground));
        }
        .stage-shader { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
        .stage-action { font-size: 0.85em; }
        .link {
            color: var(--vscode-textLink-foreground);
            cursor: pointer; text-decoration: none;
        }
        .link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }

        /* Shaders */
        .stage-tabs { display: flex; gap: 2px; }
        .stage-tab {
            background: transparent;
            color: var(--vscode-tab-inactiveForeground);
            border: 1px solid transparent;
            padding: 4px 12px; cursor: pointer; border-radius: 3px;
            font-family: inherit; font-size: 0.85em;
        }
        .stage-tab:hover { background: var(--vscode-toolbar-hoverBackground); }
        .stage-tab.active {
            background: var(--vscode-tab-activeBackground);
            color: var(--vscode-tab-activeForeground);
            border-color: var(--vscode-panel-border);
        }
        .code-view {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size, 13px);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 12px; margin: 0;
            white-space: pre; overflow: auto;
            height: calc(100vh - 180px);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
        }
        .code-view.empty-state { min-height: auto; display: block; padding: 16px; }

        /* Textures grid */
        .tex-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 12px;
        }
        .tex-grid.empty-state { display: flex; }
        .tex-card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px; cursor: pointer;
            transition: border-color 0.1s, transform 0.1s;
        }
        .tex-card:hover {
            border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
            transform: translateY(-1px);
        }
        .tex-card .thumb {
            width: 100%; aspect-ratio: 1;
            background:
                linear-gradient(45deg, #2a2a2a 25%, transparent 25%) 0 0 / 16px 16px,
                linear-gradient(-45deg, #2a2a2a 25%, transparent 25%) 0 8px / 16px 16px,
                linear-gradient(45deg, transparent 75%, #2a2a2a 75%) 8px -8px / 16px 16px,
                linear-gradient(-45deg, transparent 75%, #2a2a2a 75%) 8px 0 / 16px 16px,
                #1a1a1a;
            border-radius: 3px;
            display: flex; align-items: center; justify-content: center;
            overflow: hidden; margin-bottom: 8px;
            position: relative;
        }
        .tex-card .thumb img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }
        .tex-card .thumb .placeholder { color: var(--vscode-descriptionForeground); font-size: 0.8em; }
        .tex-card .tex-name { font-weight: 600; font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tex-card .tex-meta { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-top: 2px; font-family: var(--vscode-editor-font-family); }

        /* Events */
        .event-tree { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
        .event-tree.empty-state { display: flex; font-family: var(--vscode-font-family); }
        .evt-node {
            padding: 2px 0; cursor: pointer;
            display: flex; gap: 6px; align-items: baseline;
            white-space: nowrap; border-radius: 2px;
        }
        .evt-node:hover { background: var(--vscode-list-hoverBackground); }
        .evt-node.current {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .evt-eid { color: var(--vscode-descriptionForeground); min-width: 50px; font-size: 0.85em; }
        .evt-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
        .evt-flag { font-size: 0.75em; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .evt-flag.draw { background: rgba(80, 180, 80, 0.3); color: rgb(130, 230, 130); }
        .evt-flag.clear { background: rgba(220, 200, 80, 0.3); color: rgb(250, 230, 130); }
        .evt-flag.dispatch { background: rgba(80, 140, 220, 0.3); color: rgb(130, 180, 250); }
        .evt-children { margin-left: 18px; border-left: 1px dashed var(--vscode-panel-border); padding-left: 8px; }

        /* Modal */
        .modal { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 100; }
        .modal[hidden] { display: none; }
        .modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
        .modal-panel {
            position: relative; z-index: 1;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            width: min(90vw, 1200px); height: min(90vh, 900px);
            display: flex; flex-direction: column;
        }
        .modal-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
        }
        .modal-actions { display: flex; gap: 6px; align-items: center; }
        .modal-body { flex: 1; display: flex; overflow: hidden; }
        .tex-preview-area {
            flex: 1; padding: 16px; overflow: auto;
            display: flex; align-items: center; justify-content: center;
            background:
                linear-gradient(45deg, #2a2a2a 25%, transparent 25%) 0 0 / 24px 24px,
                linear-gradient(-45deg, #2a2a2a 25%, transparent 25%) 0 12px / 24px 24px,
                linear-gradient(45deg, transparent 75%, #2a2a2a 75%) 12px -12px / 24px 24px,
                linear-gradient(-45deg, transparent 75%, #2a2a2a 75%) 12px 0 / 24px 24px,
                #1a1a1a;
        }
        .tex-preview-area img { max-width: 100%; max-height: 100%; image-rendering: pixelated; }
        .tex-meta {
            width: 260px; padding: 12px;
            border-left: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
            overflow: auto; font-size: 0.85em;
        }
        .channel-toggle { display: inline-flex; gap: 0; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; }
        .channel-toggle .ch {
            background: transparent; color: var(--vscode-foreground);
            border: none; padding: 3px 10px; cursor: pointer; font-family: inherit; font-size: 0.85em;
            border-right: 1px solid var(--vscode-panel-border);
        }
        .channel-toggle .ch:last-child { border-right: none; }
        .channel-toggle .ch.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    `;
}

function getClientScript(): string {
    return /* js */ `
(() => {
    const vscode = acquireVsCodeApi();
    const state = {
        captureInfo: null,
        drawCalls: [],
        resources: [],
        eventId: null,
        drawCall: null,
        shaders: null,
        pipeline: null,
        activeTab: 'overview',
        activeShaderStage: null,
        eventFilter: '',
        texFilter: '',
        modalResource: null,
        modalChannel: -1,
        eventScope: 'all',   // 'all' | 'group'
        texScope: 'all',     // 'all' | 'draw'
    };

    // Build resourceId -> resource info lookup (strings for consistent key match)
    const resById = () => {
        const m = new Map();
        for (const r of state.resources) m.set(String(r.resourceId), r);
        return m;
    };
    const resName = (rid) => {
        const r = resById().get(String(rid));
        return r ? (r.name || ('Resource ' + rid)) : ('Resource ' + rid);
    };

    // ── Tab switching ──────────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
    function switchTab(tab) {
        state.activeTab = tab;
        document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
        document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
        render();
    }

    // ── Toolbar ────────────────────────────────────────────────────
    document.getElementById('btn-prev-event').addEventListener('click', () => navigateEvent(-1));
    document.getElementById('btn-next-event').addEventListener('click', () => navigateEvent(+1));
    document.getElementById('btn-jump').addEventListener('click', () => {
        const v = parseInt(document.getElementById('event-jump').value, 10);
        if (!isNaN(v)) vscode.postMessage({ type: 'selectEvent', eventId: v });
    });
    document.getElementById('event-jump').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('btn-jump').click();
    });

    function flattenEvents(list, out = []) {
        for (const dc of list) {
            out.push(dc);
            if (dc.children?.length) flattenEvents(dc.children, out);
        }
        return out;
    }
    // Find the smallest marker / parent node whose subtree contains the given EID.
    // If the event is a top-level leaf, returns null (caller falls back to root list).
    function findParentGroup(list, eventId, parent = null) {
        for (const dc of list) {
            if (dc.eventId === eventId) return parent;
            if (dc.children?.length) {
                const found = findParentGroup(dc.children, eventId, dc);
                if (found !== null) return found;
                // Also consider this node as a candidate if a descendant matches
                const contains = flattenEvents(dc.children).some(c => c.eventId === eventId);
                if (contains) return dc;
            }
        }
        return null;
    }
    function navigateEvent(delta) {
        const flat = flattenEvents(state.drawCalls);
        if (!flat.length) return;
        let idx = flat.findIndex(dc => dc.eventId === state.eventId);
        if (idx < 0) idx = 0;
        else idx = Math.max(0, Math.min(flat.length - 1, idx + delta));
        vscode.postMessage({ type: 'selectEvent', eventId: flat[idx].eventId });
    }

    // ── Filters ────────────────────────────────────────────────────
    document.getElementById('evt-filter').addEventListener('input', e => {
        state.eventFilter = e.target.value.toLowerCase();
        if (state.activeTab === 'events') renderEvents();
    });
    document.getElementById('tex-filter').addEventListener('input', e => {
        state.texFilter = e.target.value.toLowerCase();
        if (state.activeTab === 'textures') renderTextures();
    });

    // ── Scope toggles ─────────────────────────────────────────────
    document.querySelectorAll('.scope-toggle').forEach(group => {
        group.querySelectorAll('.scope').forEach(btn => {
            btn.addEventListener('click', () => {
                group.querySelectorAll('.scope').forEach(b => b.classList.toggle('active', b === btn));
                const kind = group.dataset.scope;
                if (kind === 'tex') { state.texScope = btn.dataset.val; renderTextures(); }
                else if (kind === 'evt') { state.eventScope = btn.dataset.val; renderEvents(); }
            });
        });
    });

    // ── Message router ─────────────────────────────────────────────
    window.addEventListener('message', ev => {
        const m = ev.data;
        console.log('[Inspector webview] msg:', m.type);
        switch (m.type) {
            case 'captureLoaded':
                state.captureInfo = m.captureInfo;
                state.drawCalls = m.drawCalls || [];
                state.resources = m.resources || [];
                render();
                break;
            case 'eventChanged':
                {
                    const sameEvent = state.eventId === m.eventId;
                    state.eventId = m.eventId;
                    state.drawCall = m.drawCall;
                    if (!sameEvent) {
                        state.shaders = null;
                        state.pipeline = null;
                    }
                    updateHeader();
                    render();
                }
                break;
            case 'shadersLoaded':
                if (m.eventId === state.eventId) {
                    state.shaders = m.data;
                    if (state.activeTab === 'shaders') renderShaders();
                }
                break;
            case 'pipelineLoaded':
                if (m.eventId === state.eventId) {
                    state.pipeline = m.data;
                    if (state.activeTab === 'pipeline' || state.activeTab === 'overview') render();
                }
                break;
            case 'texturePreview':
                handleTexturePreview(m);
                break;
        }
    });

    // ── Header ─────────────────────────────────────────────────────
    function updateHeader() {
        const lbl = document.getElementById('event-label');
        const apiBadge = document.getElementById('api-badge');
        if (state.eventId != null) {
            const name = state.drawCall?.name || '(unknown)';
            lbl.textContent = 'EID ' + state.eventId + ' — ' + name;
        } else {
            lbl.textContent = 'No event selected';
        }
        if (state.captureInfo?.api) {
            apiBadge.textContent = state.captureInfo.api;
            apiBadge.hidden = false;
        } else if (state.pipeline?.api) {
            apiBadge.textContent = state.pipeline.api;
            apiBadge.hidden = false;
        } else {
            apiBadge.hidden = true;
        }
    }

    // ── Overview ───────────────────────────────────────────────────
    function renderOverview() {
        const body = document.getElementById('overview-body');
        if (!state.captureInfo) { body.textContent = 'Load a capture to begin.'; body.className = 'empty-state'; return; }
        body.className = '';
        const info = state.captureInfo;
        const drawCount = flattenEvents(state.drawCalls).length;
        const texCount = state.resources.filter(r => r.type === 'Texture').length;
        const bufCount = state.resources.filter(r => r.type === 'Buffer').length;
        const shdCount = state.resources.filter(r => r.type === 'Shader').length;

        let html = '<div class="stat-row">';
        html += stat(drawCount, 'Events');
        html += stat(texCount, 'Textures');
        html += stat(bufCount, 'Buffers');
        html += stat(shdCount, 'Shaders');
        html += '</div>';

        html += '<div class="info-grid">';
        for (const [k, v] of [
            ['API', info.api],
            ['Driver', info.driver],
            ['RenderDoc Version', info.rdocVersion],
            ['Machine ID', info.machineIdent],
            ['Timestamp', info.timestamp],
            ['Frame Count', info.frameCount],
            ['Sections', info.sectionCount],
            ['File', info.filePath],
        ]) {
            if (v == null || v === '') continue;
            html += '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>';
        }
        html += '</div>';

        if (state.drawCall) {
            html += '<h3>Current Event</h3>';
            html += '<div class="info-grid">';
            for (const [k, v] of [
                ['EID', state.drawCall.eventId],
                ['Name', state.drawCall.name],
                ['Indices', state.drawCall.numIndices],
                ['Instances', state.drawCall.numInstances],
                ['Flags', state.drawCall.flags],
            ]) {
                if (v == null || v === '' || v === 0) continue;
                html += '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>';
            }
            html += '</div>';
        }
        body.innerHTML = html;
    }
    const stat = (n, l) => '<div class="stat-card"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';

    // ── Pipeline ───────────────────────────────────────────────────
    // Full graphics pipeline flow. Mirrors the RenderDoc desktop layout.
    // Inactive stages are greyed out. Compute pipeline is shown as a
    // separate card below.
    const GFX_PIPELINE = [
        { id: 'ia',       kind: 'Fixed',  label: 'Input Assembler', fixed: true },
        { id: 'vertex',   kind: 'Shader', label: 'Vertex Shader' },
        { id: 'tessCtrl', kind: 'Shader', label: 'Tess Control (HS)', aliases: ['hull'] },
        { id: 'tessEval', kind: 'Shader', label: 'Tess Eval (DS)',    aliases: ['domain'] },
        { id: 'geometry', kind: 'Shader', label: 'Geometry Shader' },
        { id: 'raster',   kind: 'Fixed',  label: 'Rasterizer', fixed: true },
        { id: 'fragment', kind: 'Shader', label: 'Fragment Shader', aliases: ['pixel'] },
        { id: 'om',       kind: 'Fixed',  label: 'Output Merger', fixed: true },
    ];
    function resolveShader(shaders, id, aliases) {
        if (shaders[id]) return { key: id, info: shaders[id] };
        for (const a of (aliases || [])) {
            if (shaders[a]) return { key: a, info: shaders[a] };
        }
        return null;
    }
    function renderPipeline() {
        const body = document.getElementById('pipeline-body');
        if (state.eventId == null) { body.textContent = 'Select an event.'; body.className = 'empty-state'; return; }
        body.className = '';
        const p = state.pipeline;
        if (!p) { body.innerHTML = '<div class="empty-state">Loading pipeline…</div>'; return; }
        if (p.error) { body.innerHTML = '<div class="empty-state">Pipeline unavailable: ' + esc(p.error) + '<br><br>(Replay required for pipeline state)</div>'; return; }

        const shaders = p.shaders || {};
        const fb = p.framebuffer || {};
        const vi = p.vertexInput || {};

        let html = '<div class="info-grid">';
        html += '<div class="k">API</div><div class="v">' + esc(p.api || '?') + '</div>';
        html += '<div class="k">Event</div><div class="v">' + state.eventId + '</div>';
        if (state.drawCall) html += '<div class="k">Draw</div><div class="v">' + esc(state.drawCall.name) + '</div>';
        html += '</div>';

        html += '<div class="pipe-subtitle">Graphics Pipeline</div>';
        html += '<div class="pipe-flow">';
        GFX_PIPELINE.forEach((stage, idx) => {
            if (idx > 0) html += '<span class="pipe-arrow">▶</span>';
            html += renderPipelineStage(stage, shaders, fb, vi);
        });
        html += '</div>';

        const cs = resolveShader(shaders, 'compute', []);
        if (cs) {
            html += '<div class="pipe-subtitle">Compute Pipeline</div>';
            html += '<div class="pipe-flow">';
            html += renderPipelineStage({ id: 'compute', kind: 'Shader', label: 'Compute Shader' }, shaders, fb, vi);
            html += '</div>';
        }

        const colorRTs = fb.colorTargets || [];
        if (colorRTs.length || fb.depthTarget) {
            html += '<div class="pipe-subtitle">Render Targets</div><div>';
            for (const rt of colorRTs) {
                html += '<span class="resource-chip" data-resid="' + esc(rt) + '">' + esc(resName(rt)) + '</span>';
            }
            if (fb.depthTarget) {
                html += '<span class="resource-chip depth" data-resid="' + esc(fb.depthTarget) + '">DS: ' + esc(resName(fb.depthTarget)) + '</span>';
            }
            html += '</div>';
        }

        const vbs = vi.vertexBuffers || [];
        if (vbs.length || vi.indexBuffer) {
            html += '<div class="pipe-subtitle">Vertex Input</div><div>';
            vbs.forEach((vb, i) => {
                html += '<span class="resource-chip" data-resid="' + esc(vb.resourceId) + '">VB' + i + ': ' + esc(resName(vb.resourceId)) + '</span>';
            });
            if (vi.indexBuffer) {
                html += '<span class="resource-chip" data-resid="' + esc(vi.indexBuffer) + '">IB: ' + esc(resName(vi.indexBuffer)) + '</span>';
            }
            html += '</div>';
        }

        body.innerHTML = html;
        body.querySelectorAll('.pipe-stage.clickable').forEach(el => {
            el.addEventListener('click', () => {
                const stageKey = el.dataset.stage;
                if (stageKey) { switchTab('shaders'); state.activeShaderStage = stageKey; renderShaders(); }
            });
        });
        body.querySelectorAll('.resource-chip[data-resid]').forEach(el => {
            el.addEventListener('click', () => openTextureModal(el.dataset.resid));
        });
    }
    function renderPipelineStage(stage, shaders, fb, vi) {
        let shaderInfo = null;
        let stageKey = stage.id;
        if (stage.kind === 'Shader') {
            const res = resolveShader(shaders, stage.id, stage.aliases);
            if (res) { shaderInfo = res.info; stageKey = res.key; }
        }
        const active = stage.fixed ? true : !!shaderInfo;
        const clickable = stage.kind === 'Shader' && shaderInfo;
        let cls = 'pipe-stage' + (stage.fixed ? ' fixed' : '') + (!active ? ' inactive' : '') + (clickable ? ' clickable' : '');
        let html = '<div class="' + cls + '"' + (clickable ? ' data-stage="' + esc(stageKey) + '"' : '') + '>';
        html += '<span class="ps-kind">' + esc(stage.kind) + '</span>';
        html += '<span class="ps-name">' + esc(stage.label) + '</span>';
        if (stage.kind === 'Shader') {
            if (shaderInfo) {
                const shName = shaderInfo.name || resName(shaderInfo.resourceId);
                html += '<span class="ps-shader" title="' + esc(shName) + '">' + esc(shName) + '</span>';
                html += '<span class="ps-meta">id ' + esc(String(shaderInfo.resourceId)) + '</span>';
            } else {
                html += '<span class="ps-meta">(not bound)</span>';
            }
        } else if (stage.id === 'ia') {
            const vbCount = (vi.vertexBuffers || []).length;
            html += '<span class="ps-meta">' + vbCount + ' VB' + (vbCount === 1 ? '' : 's') + (vi.indexBuffer ? ' + IB' : '') + '</span>';
        } else if (stage.id === 'raster') {
            html += '<span class="ps-meta">fixed-function</span>';
        } else if (stage.id === 'om') {
            const nRT = (fb.colorTargets || []).length;
            html += '<span class="ps-meta">' + nRT + ' RT' + (nRT === 1 ? '' : 's') + (fb.depthTarget ? ' + DS' : '') + '</span>';
        }
        html += '</div>';
        return html;
    }

    // ── Shaders ────────────────────────────────────────────────────
    function renderShaders() {
        const body = document.getElementById('shaders-body');
        const toolbar = document.getElementById('shaders-toolbar');
        if (state.eventId == null) {
            body.textContent = 'Select an event.';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }
        if (!state.shaders) {
            body.textContent = 'Loading shaders…';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }
        if (state.shaders.error) {
            body.textContent = 'Shader sources unavailable: ' + state.shaders.error + '\\n\\n(Local replay required.)';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }
        const shaders = state.shaders.shaders || {};
        const stages = Object.keys(shaders);
        if (stages.length === 0) {
            body.textContent = 'No bound shaders at this event.';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }

        toolbar.hidden = false;
        const tabs = document.getElementById('shader-stage-tabs');
        tabs.innerHTML = '';
        if (!state.activeShaderStage || !stages.includes(state.activeShaderStage)) {
            state.activeShaderStage = stages[0];
        }
        for (const s of stages) {
            const btn = document.createElement('button');
            btn.className = 'stage-tab' + (s === state.activeShaderStage ? ' active' : '');
            btn.textContent = s;
            btn.addEventListener('click', () => { state.activeShaderStage = s; renderShaders(); });
            tabs.appendChild(btn);
        }

        const openBtn = document.createElement('button');
        openBtn.className = 'icon-btn';
        openBtn.style.marginLeft = 'auto';
        openBtn.textContent = 'Open in Editor';
        openBtn.addEventListener('click', () => {
            const info = shaders[state.activeShaderStage];
            vscode.postMessage({ type: 'openShaderInEditor', source: info.source || info.disassembly || '', language: 'glsl' });
        });
        tabs.appendChild(openBtn);

        const info = shaders[state.activeShaderStage];
        body.className = 'code-view';
        // Header shows shader resource name + id. Prefer the explicit name the
        // native bridge attaches to the shader source response; fall back to
        // the pipeline-state shaders entry; finally fall back to resource-list
        // lookup (which is a no-op for shaders that never appear in the
        // texture/buffer XML resource list).
        const pipeStage = state.pipeline && state.pipeline.shaders && state.pipeline.shaders[state.activeShaderStage];
        const rid = (info && info.resourceId) || (pipeStage && pipeStage.resourceId);
        const shaderName = (info && info.name) || (pipeStage && pipeStage.name) || (rid ? resName(rid) : '');
        let header;
        if (rid) {
            const nameStr = shaderName && shaderName !== ('Resource ' + rid) ? shaderName : ('Shader ' + rid);
            header = '// ' + state.activeShaderStage + ' shader — ' + nameStr + ' (id ' + rid + ')\\n';
        } else {
            header = '// ' + state.activeShaderStage + ' shader\\n';
        }
        const code = info.source || info.disassembly || '// No source available for ' + state.activeShaderStage;
        body.textContent = header + '\\n' + code;
    }

    // ── Textures ───────────────────────────────────────────────────
    function renderTextures() {
        const body = document.getElementById('textures-body');
        let textures = state.resources.filter(r => r.type === 'Texture');

        // Scope to resources used by the current draw: render targets + any
        // textures the shader sampled from (native bridge collects these via
        // DescriptorAccess → GetDescriptors when pipelineState is queried).
        let scopeLabel = '';
        if (state.texScope === 'draw') {
            const pipe = state.pipeline || {};
            const fb = pipe.framebuffer || {};
            const ids = new Set();
            (fb.colorTargets || []).forEach(id => ids.add(String(id)));
            if (fb.depthTarget)   ids.add(String(fb.depthTarget));
            if (fb.stencilTarget) ids.add(String(fb.stencilTarget));
            (pipe.boundTextures || []).forEach(id => ids.add(String(id)));
            textures = textures.filter(t => ids.has(String(t.resourceId)));
            scopeLabel = '(current draw)';
        }

        const f = state.texFilter;
        const filtered = f ? textures.filter(t => (t.name || '').toLowerCase().includes(f) || (t.format || '').toLowerCase().includes(f)) : textures;
        document.getElementById('tex-count').textContent = filtered.length + ' / ' + textures.length + ' ' + scopeLabel;
        if (filtered.length === 0) {
            body.innerHTML = '';
            body.className = 'tex-grid empty-state';
            if (state.texScope === 'draw' && state.eventId == null) {
                body.textContent = 'Select an event to see its bound textures.';
            } else if (state.texScope === 'draw') {
                const pipeReady = state.pipeline && !state.pipeline.error;
                body.textContent = pipeReady
                    ? 'This draw did not sample any textures or bind render targets.'
                    : 'Loading pipeline state for this draw…';
            } else {
                body.textContent = textures.length === 0 ? 'No textures in this capture.' : 'No textures match filter.';
            }
            return;
        }
        body.className = 'tex-grid';
        body.innerHTML = filtered.map(t => texCardHtml(t)).join('');
        body.querySelectorAll('.tex-card').forEach(card => {
            card.addEventListener('click', () => openTextureModal(card.dataset.resid));
        });

        // Auto-request thumbnails for every visible card (RenderDoc-style —
        // the user asked for immediate loading on tab open instead of a
        // per-card click). Dedupe by key to avoid a storm on re-renders.
        for (const t of filtered) {
            requestThumbnail(String(t.resourceId));
        }
    }

    // Thumbnail management ──────────────────────────────────────
    // We keep a client-side cache of already-loaded thumbnails, keyed by
    // "resId:eventId", so tab switches or filter changes don't refetch.
    const thumbCache = new Map();       // key → base64 PNG
    const thumbPending = new Set();     // key currently in flight
    function thumbKey(resId) {
        return String(resId) + ':0:' + (state.eventId || 0) + ':-1';
    }
    function requestThumbnail(resId) {
        const key = thumbKey(resId);
        if (thumbCache.has(key)) {
            applyThumbnail(resId, thumbCache.get(key));
            return;
        }
        if (thumbPending.has(key)) return;
        thumbPending.add(key);
        vscode.postMessage({
            type: 'requestTexture',
            resourceId: resId,
            mip: 0,
            eventId: state.eventId || 0,
            channelExtract: -1,
        });
    }
    function applyThumbnail(resId, base64) {
        const card = document.querySelector('.tex-card[data-resid="' + CSS.escape(String(resId)) + '"] .thumb');
        if (!card) return;
        card.innerHTML = '<img src="data:image/png;base64,' + base64 + '" alt="thumbnail">';
    }
    function applyThumbnailError(resId, errMsg) {
        const card = document.querySelector('.tex-card[data-resid="' + CSS.escape(String(resId)) + '"] .thumb');
        if (!card) return;
        card.innerHTML = '<span class="placeholder">' + esc(errMsg || 'preview failed') + '</span>';
    }

    function texCardHtml(t) {
        const dim = (t.width && t.height) ? (t.width + '×' + t.height) : '';
        return '<div class="tex-card" data-resid="' + esc(t.resourceId) + '">' +
            '<div class="thumb"><span class="placeholder">Loading…</span></div>' +
            '<div class="tex-name" title="' + esc(t.name || '') + '">' + esc(t.name || ('Texture ' + t.resourceId)) + '</div>' +
            '<div class="tex-meta">' + esc(dim) + ' ' + esc(t.format || '') + '</div>' +
            '</div>';
    }

    // ── Texture modal ──────────────────────────────────────────────
    function openTextureModal(resId) {
        const tex = state.resources.find(r => r.resourceId === resId);
        if (!tex) return;
        state.modalResource = tex;
        state.modalChannel = -1;
        document.getElementById('tex-modal-title').textContent = tex.name || 'Texture ' + resId;
        document.getElementById('tex-modal-preview').innerHTML = '<div class="muted">Loading…</div>';
        const meta = document.getElementById('tex-modal-meta');
        meta.innerHTML = '<div class="info-grid">' +
            kv('ID', resId) +
            kv('Name', tex.name) +
            kv('Format', tex.format) +
            kv('Size', (tex.width||0) + ' × ' + (tex.height||0)) +
            kv('Mips', tex.mipLevels) +
            kv('Bytes', tex.byteSize) +
            '</div>';
        document.querySelectorAll('#channel-toggle .ch').forEach(b => b.classList.toggle('active', parseInt(b.dataset.ch) === -1));
        document.getElementById('texture-modal').hidden = false;
        requestTexture();
    }
    function requestTexture() {
        if (!state.modalResource) return;
        vscode.postMessage({
            type: 'requestTexture',
            resourceId: state.modalResource.resourceId,
            mip: 0,
            eventId: state.eventId || 0,
            channelExtract: state.modalChannel,
        });
    }
    function handleTexturePreview(m) {
        // Is this response destined for a thumbnail card (auto-loaded on tab
        // open) rather than the modal? Match by key — thumbnails always use
        // mip=0, channel=-1, so they share the same key shape we computed in
        // thumbKey().
        if (thumbPending.has(m.key)) {
            thumbPending.delete(m.key);
            const resId = m.key.split(':')[0];
            if (m.error) {
                applyThumbnailError(resId, m.error);
            } else if (m.base64) {
                thumbCache.set(m.key, m.base64);
                applyThumbnail(resId, m.base64);
            }
            // A thumbnail load does NOT block the modal; if the user also
            // happens to have the modal open for the same key, fall through.
            if (!state.modalResource || state.modalResource.resourceId !== resId || state.modalChannel !== -1) {
                return;
            }
        }
        if (!state.modalResource) return;
        const expectedKey = state.modalResource.resourceId + ':0:' + (state.eventId||0) + ':' + state.modalChannel;
        if (m.key !== expectedKey) return;
        const area = document.getElementById('tex-modal-preview');
        if (m.error) { area.innerHTML = '<div class="muted">Error: ' + esc(m.error) + '</div>'; return; }
        area.innerHTML = '<img src="data:image/png;base64,' + m.base64 + '" alt="texture preview">';
    }
    document.getElementById('tex-modal-close').addEventListener('click', () => { document.getElementById('texture-modal').hidden = true; state.modalResource = null; });
    document.querySelector('#texture-modal .modal-backdrop').addEventListener('click', () => { document.getElementById('texture-modal').hidden = true; state.modalResource = null; });
    document.querySelectorAll('#channel-toggle .ch').forEach(b => b.addEventListener('click', () => {
        state.modalChannel = parseInt(b.dataset.ch, 10);
        document.querySelectorAll('#channel-toggle .ch').forEach(x => x.classList.toggle('active', x === b));
        requestTexture();
    }));
    document.getElementById('tex-modal-export').addEventListener('click', () => {
        if (state.modalResource) vscode.postMessage({ type: 'exportTexture', resourceId: state.modalResource.resourceId, label: state.modalResource.name });
    });

    // ── Events tree ────────────────────────────────────────────────
    function renderEvents() {
        const body = document.getElementById('events-body');
        if (!state.drawCalls.length) { body.className = 'event-tree empty-state'; body.textContent = 'No events.'; return; }
        body.className = 'event-tree';
        const allFlat = flattenEvents(state.drawCalls);

        // Determine the root list to render based on scope
        let rootList = state.drawCalls;
        if (state.eventScope === 'group' && state.eventId != null) {
            // Find the smallest marker/parent subtree that contains the current event
            const parent = findParentGroup(state.drawCalls, state.eventId);
            if (parent) rootList = parent.children && parent.children.length ? parent.children : [parent];
        }
        const f = state.eventFilter;
        let shown = 0;
        const render = (list, depth = 0) => {
            let html = '';
            for (const dc of list) {
                const match = !f || dc.name.toLowerCase().includes(f) || String(dc.eventId).includes(f);
                const childrenHtml = dc.children?.length ? render(dc.children, depth + 1) : '';
                if (!match && !childrenHtml) continue;
                if (match) shown++;
                html += evtNodeHtml(dc);
                if (childrenHtml) html += '<div class="evt-children">' + childrenHtml + '</div>';
            }
            return html;
        };
        body.innerHTML = render(rootList);
        document.getElementById('evt-count').textContent = shown + ' / ' + allFlat.length + (state.eventScope === 'group' ? ' (group)' : '');
        body.querySelectorAll('.evt-node').forEach(el => {
            el.addEventListener('click', () => vscode.postMessage({ type: 'selectEvent', eventId: parseInt(el.dataset.eid, 10) }));
        });
    }
    function evtNodeHtml(dc) {
        const flagClass = /drawcall|draw/i.test(dc.flags || '') ? 'draw'
            : /clear/i.test(dc.flags || '') ? 'clear'
            : /dispatch/i.test(dc.flags || '') ? 'dispatch' : '';
        const current = dc.eventId === state.eventId ? ' current' : '';
        return '<div class="evt-node' + current + '" data-eid="' + dc.eventId + '">' +
            '<span class="evt-eid">' + dc.eventId + '</span>' +
            '<span class="evt-name">' + esc(dc.name) + '</span>' +
            (flagClass ? '<span class="evt-flag ' + flagClass + '">' + esc((dc.flags || '').split('|')[0]) + '</span>' : '') +
            '</div>';
    }

    // ── Render dispatch ────────────────────────────────────────────
    function render() {
        if (state.activeTab === 'overview') renderOverview();
        else if (state.activeTab === 'pipeline') renderPipeline();
        else if (state.activeTab === 'shaders') renderShaders();
        else if (state.activeTab === 'textures') renderTextures();
        else if (state.activeTab === 'events') renderEvents();
        updateHeader();
    }

    // ── Utils ──────────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function kv(k, v) {
        if (v == null || v === '') return '';
        return '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>';
    }

    console.log('[Inspector webview] sending ready');
    vscode.postMessage({ type: 'ready' });
})();
    `;
}
