import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';
import { DrawCall, ResourceInfo, CaptureInfo } from '../types';
import { withTimeout } from '../util/async';
import { LruCache } from '../util/lruCache';
import type {
    ExtensionToWebviewMessage,
    WebviewToExtensionMessage,
} from '../ipc/messages';
import { buildInspectorHtml } from './inspector/html';

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

    // Cache per-event shader results to avoid repeated calls.
    // Size-bounded to prevent unbounded growth on very large captures where
    // the user may page through thousands of events in a single session.
    private shaderCache = new LruCache<number, any>(200);
    private pipelineCache = new LruCache<number, any>(200);
    // Cache rendered textures (base64 PNG) keyed by "resId:mip:eventId".
    // Each entry can be hundreds of KB so we keep a tighter cap.
    private texturePreviewCache = new LruCache<string, { base64: string; width: number; height: number; texFormat: string }>(128);

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
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
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
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        };
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
        // and tabs stay on "Loading鈥? forever.
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

    /** Set / change the focused event 鈥?the whole panel updates around this. */
    public async setEvent(eventId: number, drawCall?: DrawCall) {
        this.currentEventId = eventId;
        this.currentDrawCall = drawCall ?? this.findDrawCall(eventId);
        this.panel.title = `Inspector 鈥?EID ${eventId}${this.currentDrawCall ? ': ' + this.currentDrawCall.name : ''}`;

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
        // webview with an error message instead of leaving "Loading鈥? forever.
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

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

    private handleWebviewMessage(msg: WebviewToExtensionMessage) {
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

                    // Wait up to ~30s for a capture to become available 鈥?
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

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    private getInitialHtml(): string {
        return buildInspectorHtml(this.panel.webview, this.context.extensionUri);
    }
}

