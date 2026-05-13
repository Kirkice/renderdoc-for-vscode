import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';
import { DrawCall, ResourceInfo, CaptureInfo, TextureOverlayMode } from '../types';
import { withTimeout } from '../util/async';
import { LruCache } from '../util/lruCache';
import type {
    ExtensionToWebviewMessage,
    MsgReplayStatus,
    WebviewShaderDiagnostic,
    WebviewToExtensionMessage,
} from '../ipc/messages';
import {
    findLinkedShaderDocumentInfos,
    getLinkedShaderDocumentInfo,
    getShaderSourceDocumentUri,
    loadShaderSourceFilesFromDocuments,
    openShaderSourceDocument,
} from '../shaderEditor';
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

    public static replayRecoveryProvider:
        | ((reason: string) => Promise<boolean>)
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
    private currentDrawPreviewCache = new LruCache<string, {
        base64: string;
        width: number;
        height: number;
        texFormat: string;
        resourceId?: string;
        label?: string;
        overlayMode?: TextureOverlayMode;
    }>(64);

    // Mesh decode cache keyed by "eventId:stage:maxVerts:instance".
    private meshCache = new LruCache<string, any>(64);
    private captureTimings: Record<string, number> = {};
    private captureTimingsAvailable = false;
    private captureTimingsError: string | undefined;
    private timingCapturePath: string | undefined;
    private timingsLoadingForPath: string | undefined;

    private latestMaliAnalysis?: { source: string, stage: string, result: string };
    private replayStatus: MsgReplayStatus = {
        type: 'replayStatus',
        status: 'none',
        mode: 'none',
    };

    private readonly shaderDiagnosticCollection = vscode.languages.createDiagnosticCollection('renderdoc-shaders');

    private disposables: vscode.Disposable[] = [];

    private static readonly replayableDrawFlags = new Set([
        'Drawcall',
        'Dispatch',
        'Clear',
        'Copy',
        'Resolve',
        'GenMips',
        'Present',
    ]);

    public static createOrShow(context: vscode.ExtensionContext, bridge: RenderDocBridge) {
        const column = vscode.ViewColumn.Active;

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

        this.disposables.push(this.shaderDiagnosticCollection);
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
            void this.handleActiveTextEditorChanged(editor);
        }));
        this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
            if (getLinkedShaderDocumentInfo(event.document.uri)) {
                this.shaderDiagnosticCollection.delete(event.document.uri);
            }
        }));
    }

    /** Called from extension.ts when a new capture has been loaded/refreshed. */
    public setCapture(
        captureInfo: CaptureInfo | undefined,
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
            this.currentDrawPreviewCache.clear();
            this.shaderDiagnosticCollection.clear();
            this.captureTimings = {};
            this.captureTimingsAvailable = false;
            this.captureTimingsError = undefined;
            this.timingCapturePath = undefined;
            this.timingsLoadingForPath = undefined;
            this.currentEventId = undefined;
            this.currentDrawCall = undefined;
            this.panel.title = 'Inspector';
        }

        this.panel.webview.postMessage({
            type: 'captureLoaded',
            captureInfo,
            drawCalls,
            resources: resources.map(r => ({
                resourceId: r.resourceId,
                name: r.name,
                type: r.type,
                shaderStages: r.shaderStages,
                format: r.format,
                width: r.width,
                height: r.height,
                byteSize: r.byteSize,
            })),
        });

        if (captureInfo?.filePath) {
            this.loadCaptureTimings(captureInfo.filePath).catch(() => { /* best effort */ });
        }

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

    public setReplayStatus(status: Omit<MsgReplayStatus, 'type'>) {
        this.replayStatus = { type: 'replayStatus', ...status };
        this.postReplayStatus();
    }

    private postReplayStatus() {
        this.panel.webview.postMessage(this.replayStatus satisfies ExtensionToWebviewMessage);
    }

    private postShaderEditResult(result: {
        eventId: number;
        stage: string;
        action: 'apply' | 'compile' | 'revert';
        ok: boolean;
        message?: string;
        refresh?: boolean;
        diagnostics?: WebviewShaderDiagnostic[];
    }) {
        this.panel.webview.postMessage({
            type: 'shaderEditResult',
            ...result,
        } satisfies ExtensionToWebviewMessage);
    }

    private postShaderSelectionSync(eventId: number, stage: string, fileIndex: number) {
        this.panel.webview.postMessage({
            type: 'syncShaderSelection',
            eventId,
            stage,
            fileIndex,
        } satisfies ExtensionToWebviewMessage);
    }

    private postCaptureTimings() {
        this.panel.webview.postMessage({
            type: 'timingsLoaded',
            timings: this.captureTimings,
            available: this.captureTimingsAvailable,
            error: this.captureTimingsError,
        });
    }

    private async loadCaptureTimings(filePath: string) {
        if (!this.bridge.hasNativeBridge()) {
            this.captureTimings = {};
            this.captureTimingsAvailable = false;
            this.captureTimingsError = 'Native bridge unavailable (local replay required).';
            this.timingCapturePath = filePath;
            this.postCaptureTimings();
            return;
        }
        if (this.timingCapturePath === filePath && (this.captureTimingsAvailable || this.captureTimingsError)) {
            this.postCaptureTimings();
            return;
        }
        if (this.timingsLoadingForPath === filePath) {
            return;
        }

        this.timingsLoadingForPath = filePath;
        try {
            const timings = await withTimeout(
                this.bridge.getDrawTimings(),
                45000,
                'GPU timing request timed out after 45s.',
            );
            if (this.captureInfo?.filePath !== filePath) {
                return;
            }
            this.captureTimings = Object.fromEntries(Array.from(timings.entries()).map(([eventId, durationUs]) => [String(eventId), durationUs]));
            this.captureTimingsAvailable = true;
            this.captureTimingsError = undefined;
            this.timingCapturePath = filePath;
            this.postCaptureTimings();
        } catch (e: any) {
            if (this.captureInfo?.filePath !== filePath) {
                return;
            }
            this.captureTimings = {};
            this.captureTimingsAvailable = false;
            this.captureTimingsError = e?.message ?? String(e);
            this.timingCapturePath = filePath;
            this.postCaptureTimings();
        } finally {
            if (this.timingsLoadingForPath === filePath) {
                this.timingsLoadingForPath = undefined;
            }
        }
    }

    /** Set / change the focused event — the whole panel updates around this. */
    public async setEvent(eventId: number, drawCall?: DrawCall) {
        const previousEventId = this.currentEventId;
        const normalized = this.normalizeEventSelection(eventId, drawCall);
        this.currentEventId = normalized.eventId;
        this.currentDrawCall = normalized.drawCall;

        // Force a fresh pipeline query when moving between events. Empirically
        // some captures can show stale input-texture bindings when revisiting a
        // previously viewed draw, while the native bridge returns the correct
        // pipeline state when queried again for that event.
        if (previousEventId !== undefined && previousEventId !== this.currentEventId) {
            this.pipelineCache.clear();
        }

        this.panel.title = `Inspector — EID ${this.currentEventId}${this.currentDrawCall ? ': ' + this.currentDrawCall.name : ''}`;

        // Post eventChanged immediately so the header updates even while the
        // capture state is still being pulled (first draw click after reload
        // can take seconds to convert XML).
        this.panel.webview.postMessage({
            type: 'eventChanged',
            eventId: this.currentEventId,
            drawCall: this.currentDrawCall,
        });

        // If capture wasn't pushed yet, pull it now in the background.
        if (!this.captureInfo && InspectorPanel.captureProvider) {
            InspectorPanel.captureProvider().then(pulled => {
                if (pulled && !this.captureInfo) {
                    this.setCapture(pulled.captureInfo, pulled.drawCalls, pulled.resources);
                    // Re-post event so drawCall lookup picks up the now-loaded tree.
                    if (!this.currentDrawCall) {
                        const refreshed = this.normalizeEventSelection(this.currentEventId ?? eventId);
                        this.currentEventId = refreshed.eventId;
                        this.currentDrawCall = refreshed.drawCall;
                        this.panel.webview.postMessage({
                            type: 'eventChanged',
                            eventId: this.currentEventId,
                            drawCall: this.currentDrawCall,
                        });
                    }
                }
            }).catch(() => { /* best effort */ });
        }

        // Kick off async loads; webview gets incremental updates as data arrives.
        // Guard with .catch so even an uncaught async error still unblocks the
        // webview with an error message instead of leaving "Loading鈥? forever.
        this.loadShadersForEvent(this.currentEventId).catch(e => {
            console.warn('[Inspector] shader load failed:', e?.message);
            this.panel.webview.postMessage({
                type: 'shadersLoaded',
                eventId: this.currentEventId,
                data: { error: e?.message || 'Shader load failed.' },
            });
        });
        this.loadPipelineForEvent(this.currentEventId).catch(e => {
            console.warn('[Inspector] pipeline load failed:', e?.message);
            this.panel.webview.postMessage({
                type: 'pipelineLoaded',
                eventId: this.currentEventId,
                data: { error: e?.message || 'Pipeline load failed.' },
            });
        });
    }

    public reveal() {
        this.panel.reveal(vscode.ViewColumn.Active, true);
    }

    /**
     * Clear replay-derived caches when the native replay session is recreated
     * for the same capture path. Without this, same-file replays can keep
     * showing stale pipeline/input-texture results from a previous bridge run.
     */
    public invalidateReplayCaches() {
        this.shaderCache.clear();
        this.pipelineCache.clear();
        this.texturePreviewCache.clear();
        this.currentDrawPreviewCache.clear();
        this.meshCache.clear();

        if (this.currentEventId !== undefined) {
            void this.setEvent(this.currentEventId, this.currentDrawCall);
        }
    }

    /** Current focused event ID, or undefined if none selected. */
    public getCurrentEventId(): number | undefined {
        return this.currentEventId;
    }

    /** Current focused draw call (if any). */
    public getCurrentDrawCall(): DrawCall | undefined {
        return this.currentDrawCall;
    }

    public getLatestMaliAnalysisResult(): { source: string, stage: string, result: string } | undefined {
        return this.latestMaliAnalysis;
    }

    /** File path of the currently loaded capture, or undefined if none. */
    public getCaptureFilePath(): string | undefined {
        return this.captureInfo?.filePath;
    }

    private async handleActiveTextEditorChanged(editor: vscode.TextEditor | undefined) {
        if (!editor) {
            return;
        }

        const linkedInfo = getLinkedShaderDocumentInfo(editor.document.uri);
        if (!linkedInfo) {
            return;
        }

        if (this.captureInfo?.filePath && linkedInfo.capturePath && this.captureInfo.filePath !== linkedInfo.capturePath) {
            return;
        }

        if (typeof linkedInfo.eventId !== 'number' || !linkedInfo.stage) {
            return;
        }

        if (this.currentEventId !== linkedInfo.eventId) {
            await this.setEvent(linkedInfo.eventId);
        }

        this.postShaderSelectionSync(linkedInfo.eventId, linkedInfo.stage, linkedInfo.fileIndex);
    }

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    private findDrawCall(eventId: number, list = this.drawCalls): DrawCall | undefined {
        for (const dc of list) {
            if (dc.children?.length) {
                const found = this.findDrawCall(eventId, dc.children);
                if (found) { return found; }
            }
            if (dc.eventId === eventId) { return dc; }
        }
        return undefined;
    }

    private isReplayableDrawCall(drawCall: DrawCall | undefined): boolean {
        if (!drawCall) {
            return false;
        }
        return InspectorPanel.replayableDrawFlags.has(drawCall.flags || '');
    }

    private findFirstReplayableDraw(list: DrawCall[]): DrawCall | undefined {
        for (const drawCall of list) {
            if (this.isReplayableDrawCall(drawCall)) {
                return drawCall;
            }
            if (drawCall.children?.length) {
                const found = this.findFirstReplayableDraw(drawCall.children);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    }

    private normalizeEventSelection(eventId: number, drawCall?: DrawCall): { eventId: number; drawCall?: DrawCall } {
        const resolvedDrawCall = drawCall ?? this.findDrawCall(eventId);
        if (!resolvedDrawCall) {
            return { eventId, drawCall };
        }
        if (this.isReplayableDrawCall(resolvedDrawCall)) {
            return { eventId: resolvedDrawCall.eventId, drawCall: resolvedDrawCall };
        }
        if (resolvedDrawCall.children?.length) {
            const leaf = this.findFirstReplayableDraw(resolvedDrawCall.children);
            if (leaf) {
                return { eventId: leaf.eventId, drawCall: leaf };
            }
        }
        return { eventId: resolvedDrawCall.eventId, drawCall: resolvedDrawCall };
    }

    private shouldRecoverReplayError(
        error: unknown,
        request: 'generic' | 'texturePreview' | 'currentDrawPreview' = 'generic',
    ): boolean {
        const message = String((error as any)?.message ?? error ?? '');
        if (!message) {
            return false;
        }
        if (message.includes('No replay active')) {
            return true;
        }
        if (message.includes("Data was requested through RenderDoc's API which is not available")) {
            return true;
        }
        if (this.replayStatus.mode !== 'remote') {
            return false;
        }
        if (request === 'texturePreview' && message.includes("Couldn't readback bytes")) {
            return true;
        }
        if (request === 'currentDrawPreview' && message.includes('Current draw preview readback empty')) {
            return true;
        }
        return false;
    }

    private async tryRecoverReplay(reason: string): Promise<boolean> {
        const recover = InspectorPanel.replayRecoveryProvider;
        if (!recover) {
            return false;
        }
        try {
            return await recover(reason);
        } catch (error: any) {
            console.warn('[Inspector ext] replay recovery failed:', error?.message ?? String(error));
            return false;
        }
    }

    private async loadShadersForEvent(eventId: number) {
        console.log('[Inspector ext] loadShadersForEvent', eventId, 'hasNative=', this.bridge.hasNativeBridge());
        if (!this.bridge.hasNativeBridge()) {
            const recovered = await this.tryRecoverReplay('shader request');
            if (!recovered || !this.bridge.hasNativeBridge()) {
                this.panel.webview.postMessage({
                    type: 'shadersLoaded',
                    eventId,
                    data: { error: 'Native bridge unavailable (local replay required).' },
                });
                return;
            }
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
                if (this.shouldRecoverReplayError(e) && await this.tryRecoverReplay('shader request')) {
                    try {
                        const retried = await withTimeout(
                            this.bridge.nativeGetShaderSource(eventId),
                            30000,
                            'Shader source request timed out after 30s.',
                        );
                        this.shaderCache.set(eventId, retried);
                    } catch (retryError: any) {
                        this.shaderCache.set(eventId, { error: retryError.message });
                    }
                } else {
                    this.shaderCache.set(eventId, { error: e.message });
                }
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
            const recovered = await this.tryRecoverReplay('pipeline request');
            if (!recovered || !this.bridge.hasNativeBridge()) {
                this.panel.webview.postMessage({
                    type: 'pipelineLoaded',
                    eventId,
                    data: { error: 'Native bridge unavailable (local replay required).' },
                });
                return;
            }
        }
        if (!this.pipelineCache.has(eventId)) {
            try {
                const result = await withTimeout(
                    this.bridge.nativeGetPipelineState(eventId),
                    30000,
                    'Pipeline state request timed out after 30s.',
                );
                this.pipelineCache.set(eventId, result);
                // Proactively pre-fetch all render-target thumbnails for this event
                // so the Textures tab is instant when the user navigates to it.
                if (eventId === this.currentEventId && result && !result.error) {
                    this.prefetchRTTextures(eventId, result).catch(() => { /* best-effort */ });
                }
            } catch (e: any) {
                if (this.shouldRecoverReplayError(e) && await this.tryRecoverReplay('pipeline request')) {
                    try {
                        const retried = await withTimeout(
                            this.bridge.nativeGetPipelineState(eventId),
                            30000,
                            'Pipeline state request timed out after 30s.',
                        );
                        this.pipelineCache.set(eventId, retried);
                        if (eventId === this.currentEventId && retried && !retried.error) {
                            this.prefetchRTTextures(eventId, retried).catch(() => { /* best-effort */ });
                        }
                    } catch (retryError: any) {
                        this.pipelineCache.set(eventId, { error: retryError.message });
                    }
                } else {
                    this.pipelineCache.set(eventId, { error: e.message });
                }
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

    /**
     * Pre-fetch GPU thumbnails for all render targets at `eventId`.
     * Uses the fast `getTextureThumbBatch` path (single SetFrameEvent + GPU render at 256×256).
     * Results are stored in the texturePreviewCache and pushed to the webview immediately,
     * so the Textures tab renders without waiting when the user switches to it.
     */
    private async prefetchRTTextures(eventId: number, pipeline: any) {
        const fb = pipeline?.framebuffer || {};
        const actionOutputs = Array.isArray(pipeline?.actionOutputs) ? pipeline.actionOutputs : [];
        const hasFramebufferOutputs = (fb.colorTargets || []).length || fb.depthTarget || fb.depthResolveTarget || fb.stencilTarget;
        const hasActionFallback = !!(actionOutputs.length || pipeline?.actionDepth || pipeline?.actionCopyDestination);
        const usesPresentationFallback = !hasFramebufferOutputs && !hasActionFallback && !!(pipeline?.presentationColorTarget || pipeline?.presentationDepthTarget);
        const rtIds: string[] = Array.from(new Set([
            ...((hasFramebufferOutputs
                ? (fb.colorTargets || [])
                : (hasActionFallback ? actionOutputs : (pipeline?.presentationColorTarget ? [pipeline.presentationColorTarget] : []))).map(String)),
            ...((fb.depthTarget || (!hasFramebufferOutputs && (pipeline?.actionDepth || (usesPresentationFallback ? pipeline?.presentationDepthTarget : undefined))))
                ? [String(fb.depthTarget || pipeline.actionDepth || pipeline.presentationDepthTarget)]
                : []),
            ...(fb.depthResolveTarget ? [String(fb.depthResolveTarget)] : []),
            ...(fb.stencilTarget ? [String(fb.stencilTarget)] : []),
            ...((!hasFramebufferOutputs && hasActionFallback && pipeline?.actionCopyDestination) ? [String(pipeline.actionCopyDestination)] : []),
        ]));
        if (rtIds.length === 0) { return; }

        // Only fetch RTs that are not yet in cache for this event
        const uncached = rtIds.filter(id => !this.texturePreviewCache.has(`${id}:0:${eventId}:-1:thumb`));
        if (uncached.length === 0) { return; }

        try {
            const batchResult = await withTimeout(
                this.bridge.nativeGetTextureThumbBatch(eventId, uncached),
                30000,
                'Render-target thumbnail request timed out after 30s.',
            );
            if (!batchResult?.results) { return; }
            for (const r of batchResult.results as any[]) {
                const key = `${r.resourceId}:0:${eventId}:-1:thumb`;
                if (this.currentEventId !== eventId) { continue; }
                if (r?.base64) {
                    const data = { base64: r.base64, width: r.width, height: r.height, texFormat: r.texFormat };
                    this.texturePreviewCache.set(key, data);
                    this.panel.webview.postMessage({ type: 'texturePreview', key, ...data });
                } else {
                    this.panel.webview.postMessage({
                        type: 'texturePreview',
                        key,
                        error: r?.error || 'Thumbnail preview unavailable',
                    });
                }
            }
        } catch (_e) {
            // Pre-fetch failure is non-fatal; textures will load on demand instead
        }
    }

    private async loadMesh(eventId: number, stage: 'vsin' | 'vsout' | 'gsout', maxVertices: number, instance: number) {
        const key = `${eventId}:${stage}:${maxVertices}:${instance}`;
        if (this.meshCache.has(key)) {
            this.panel.webview.postMessage({ type: 'meshLoaded', key, data: this.meshCache.get(key) });
            return;
        }
        if (!this.bridge.hasNativeBridge()) {
            this.panel.webview.postMessage({ type: 'meshLoaded', key, error: 'Native bridge not available (replay required).' });
            return;
        }
        try {
            const data = await withTimeout(
                this.bridge.nativeGetMeshData(eventId, stage, { maxVertices, instance }),
                120000,
                'Mesh fetch timed out after 120s.',
            );
            this.meshCache.set(key, data);
            this.panel.webview.postMessage({ type: 'meshLoaded', key, data });
        } catch (e: any) {
            this.panel.webview.postMessage({ type: 'meshLoaded', key, error: e?.message ?? String(e) });
        }
    }

    private async loadTexturePreview(resourceId: string, mip: number, eventId: number, channelExtract: number,
        purpose: 'thumb' | 'preview' | 'modal' = 'preview') {
        const key = `${resourceId}:${mip}:${eventId}:${channelExtract}:${purpose}`;
        if (this.texturePreviewCache.has(key)) {
            const cached = this.texturePreviewCache.get(key)!;
            this.panel.webview.postMessage({ type: 'texturePreview', key, ...cached });
            return;
        }
        if (!this.bridge.hasNativeBridge()) {
            const recovered = await this.tryRecoverReplay('texture preview request');
            if (!recovered || !this.bridge.hasNativeBridge()) {
                this.panel.webview.postMessage({ type: 'texturePreview', key, error: 'Native bridge not available (replay required).' });
                return;
            }
        }
        try {
            const result = await withTimeout(
                this.bridge.nativeGetTextureData(resourceId, mip, eventId, channelExtract),
                30000,
                'Texture preview request timed out after 30s.',
            );
            if (result?.base64) {
                const data = { base64: result.base64, width: result.width, height: result.height, texFormat: result.texFormat };
                this.texturePreviewCache.set(key, data);
                this.panel.webview.postMessage({ type: 'texturePreview', key, ...data });
            } else {
                this.panel.webview.postMessage({ type: 'texturePreview', key, error: 'No preview returned' });
            }
        } catch (e: any) {
            if (this.shouldRecoverReplayError(e, 'texturePreview') && await this.tryRecoverReplay('texture preview request')) {
                try {
                    const retried = await withTimeout(
                        this.bridge.nativeGetTextureData(resourceId, mip, eventId, channelExtract),
                        30000,
                        'Texture preview request timed out after 30s.',
                    );
                    if (retried?.base64) {
                        const data = { base64: retried.base64, width: retried.width, height: retried.height, texFormat: retried.texFormat };
                        this.texturePreviewCache.set(key, data);
                        this.panel.webview.postMessage({ type: 'texturePreview', key, ...data });
                    } else {
                        this.panel.webview.postMessage({ type: 'texturePreview', key, error: 'No preview returned' });
                    }
                } catch (retryError: any) {
                    this.panel.webview.postMessage({ type: 'texturePreview', key, error: retryError.message });
                }
            } else {
                this.panel.webview.postMessage({ type: 'texturePreview', key, error: e.message });
            }
        }
    }

    private async loadCurrentDrawPreview(
        eventId: number,
        channelExtract: number = -1,
        overlayMode: TextureOverlayMode = 'none',
        baseGammaEnabled: boolean = true,
        resourceId?: string,
        overlayResourceId?: string,
        label?: string,
    ) {
        const key = `current-draw:${eventId}:${channelExtract}:${overlayMode}:${baseGammaEnabled ? 1 : 0}:${resourceId ?? ''}:${overlayResourceId ?? ''}`;
        if (this.currentDrawPreviewCache.has(key)) {
            const cached = this.currentDrawPreviewCache.get(key)!;
            this.panel.webview.postMessage({ type: 'currentDrawPreview', key, ...cached });
            return;
        }
        if (!this.bridge.hasNativeBridge()) {
            const recovered = await this.tryRecoverReplay('current draw preview request');
            if (!recovered || !this.bridge.hasNativeBridge()) {
                this.panel.webview.postMessage({ type: 'currentDrawPreview', key, error: 'Native bridge not available (replay required).' });
                return;
            }
        }
        try {
            const result = await withTimeout(
                this.bridge.nativeGetCurrentDrawPreview(
                    eventId,
                    channelExtract,
                    overlayMode,
                    baseGammaEnabled,
                    resourceId,
                    overlayResourceId,
                    label,
                ),
                30000,
                'Current draw preview request timed out after 30s.',
            );
            if (result?.base64) {
                const data = {
                    base64: result.base64,
                    width: result.width,
                    height: result.height,
                    texFormat: result.texFormat,
                    resourceId: result.resourceId,
                    label: result.label,
                    overlayMode: result.overlayMode,
                    baseGammaEnabled: result.baseGammaEnabled,
                    baseGammaAvailable: result.baseGammaAvailable,
                };
                this.currentDrawPreviewCache.set(key, data);
                this.panel.webview.postMessage({ type: 'currentDrawPreview', key, ...data });
            } else {
                this.panel.webview.postMessage({ type: 'currentDrawPreview', key, error: 'No preview returned' });
            }
        } catch (e: any) {
            if (this.shouldRecoverReplayError(e, 'currentDrawPreview') && await this.tryRecoverReplay('current draw preview request')) {
                try {
                    const retried = await withTimeout(
                        this.bridge.nativeGetCurrentDrawPreview(
                            eventId,
                            channelExtract,
                            overlayMode,
                            baseGammaEnabled,
                            resourceId,
                            overlayResourceId,
                            label,
                        ),
                        30000,
                        'Current draw preview request timed out after 30s.',
                    );
                    if (retried?.base64) {
                        const data = {
                            base64: retried.base64,
                            width: retried.width,
                            height: retried.height,
                            texFormat: retried.texFormat,
                            resourceId: retried.resourceId,
                            label: retried.label,
                            overlayMode: retried.overlayMode,
                            baseGammaEnabled: retried.baseGammaEnabled,
                            baseGammaAvailable: retried.baseGammaAvailable,
                        };
                        this.currentDrawPreviewCache.set(key, data);
                        this.panel.webview.postMessage({ type: 'currentDrawPreview', key, ...data });
                    } else {
                        this.panel.webview.postMessage({ type: 'currentDrawPreview', key, error: 'No preview returned' });
                    }
                } catch (retryError: any) {
                    this.panel.webview.postMessage({ type: 'currentDrawPreview', key, error: retryError.message });
                }
            } else {
                this.panel.webview.postMessage({ type: 'currentDrawPreview', key, error: e.message });
            }
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
                    if (this.timingCapturePath && (this.captureTimingsAvailable || this.captureTimingsError)) {
                        this.postCaptureTimings();
                    }
                    this.postReplayStatus();
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
                this.loadTexturePreview(
                    msg.resourceId,
                    msg.mip ?? 0,
                    msg.eventId ?? this.currentEventId ?? 0,
                    msg.channelExtract ?? -1,
                    msg.purpose ?? 'preview',
                );
                break;
            case 'requestCurrentDrawPreview':
                this.loadCurrentDrawPreview(
                    msg.eventId ?? this.currentEventId ?? 0,
                    msg.channelExtract ?? -1,
                    msg.overlayMode ?? 'none',
                    msg.baseGammaEnabled ?? true,
                    msg.resourceId,
                    msg.overlayResourceId,
                    msg.label,
                );
                break;
            case 'requestMesh':
                this.loadMesh(
                    msg.eventId,
                    msg.stage,
                    msg.maxVertices ?? 0,
                    msg.instance ?? 0,
                );
                break;
            case 'openShaderInEditor': {
                void this.openShaderInEditor(msg);
                break;
            }
            case 'analyzeMaliOffline': {
                this.analyzeMaliOffline(msg.source, msg.stage);
                break;
            }
            case 'compileShaderEdit':
                void this.compileShaderEdit(msg);
                break;
            case 'applyShaderEdit':
                void this.applyShaderEdit(msg);
                break;
            case 'revertShaderEdit':
                void this.revertShaderEdit(msg);
                break;
            case 'copyToClipboard':
                vscode.env.clipboard.writeText(msg.text ?? '');
                vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
                break;
            case 'exportTexture':
                vscode.commands.executeCommand('renderdoc.exportTexture', { resourceId: msg.resourceId, label: msg.label });
                break;
            case 'showShaderSource':
                vscode.commands.executeCommand('renderdoc.viewShaderSource', { resourceId: msg.resourceId, label: msg.label });
                break;
            case 'showResourceDetails':
                vscode.commands.executeCommand('renderdoc.showResourceDetails', { resourceId: msg.resourceId, label: msg.label });
                break;
            case 'useRecommendedReplayHost':
                vscode.commands.executeCommand('renderdoc.useRecommendedReplayHost');
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

    private async withShaderEditReplay<T>(reason: string, fn: () => Promise<T>): Promise<T> {
        if (!this.bridge.hasNativeBridge()) {
            const recovered = await this.tryRecoverReplay(reason);
            if (!recovered || !this.bridge.hasNativeBridge()) {
                throw new Error('Native bridge unavailable (local replay required).');
            }
        }

        try {
            return await fn();
        } catch (error: any) {
            if (this.shouldRecoverReplayError(error) && await this.tryRecoverReplay(reason)) {
                return fn();
            }
            throw error;
        }
    }

    private shaderLanguageForEncoding(sourceEncoding: number): string {
        switch (sourceEncoding) {
            case 2:
                return 'glsl';
            case 5:
                return 'hlsl';
            default:
                return 'plaintext';
        }
    }

    private shaderDiagnosticSeverity(severity: WebviewShaderDiagnostic['severity']): vscode.DiagnosticSeverity {
        switch (severity) {
            case 'warning':
                return vscode.DiagnosticSeverity.Warning;
            case 'note':
                return vscode.DiagnosticSeverity.Information;
            default:
                return vscode.DiagnosticSeverity.Error;
        }
    }

    private setShaderProblems(
        msg: Extract<WebviewToExtensionMessage, { type: 'applyShaderEdit' | 'compileShaderEdit' }>,
        files: Array<{ filename: string; contents: string }>,
        diagnostics?: WebviewShaderDiagnostic[],
        fallbackMessage?: string,
        fallbackSeverity: WebviewShaderDiagnostic['severity'] = 'error',
    ) {
        const fallbackFileIndex = files.length > 0
            ? Math.max(0, Math.min(files.length - 1, msg.entryFileIndex ?? 0))
            : 0;

        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
            const uri = getShaderSourceDocumentUri({
                context: this.context,
                capturePath: this.captureInfo?.filePath,
                eventId: msg.eventId,
                resourceId: msg.resourceId,
                stage: msg.stage,
                filename: files[fileIndex].filename,
                language: this.shaderLanguageForEncoding(msg.sourceEncoding),
            });
            byFile.set(uri.toString(), []);
        }

        const pushDiagnostic = (diagnostic: WebviewShaderDiagnostic) => {
            const fileIndex = typeof diagnostic.fileIndex === 'number' && diagnostic.fileIndex >= 0 && diagnostic.fileIndex < files.length
                ? diagnostic.fileIndex
                : fallbackFileIndex;
            const uri = getShaderSourceDocumentUri({
                context: this.context,
                capturePath: this.captureInfo?.filePath,
                eventId: msg.eventId,
                resourceId: msg.resourceId,
                stage: msg.stage,
                filename: files[fileIndex]?.filename,
                language: this.shaderLanguageForEncoding(msg.sourceEncoding),
            });
            const startLine = Math.max(0, (diagnostic.line ?? 1) - 1);
            const startColumn = Math.max(0, (diagnostic.column ?? 1) - 1);
            const range = new vscode.Range(startLine, startColumn, startLine, startColumn + 1);
            const item = new vscode.Diagnostic(
                range,
                diagnostic.message || diagnostic.raw || 'Shader compiler diagnostic.',
                this.shaderDiagnosticSeverity(diagnostic.severity),
            );
            item.source = 'RenderDoc';
            const key = uri.toString();
            const list = byFile.get(key);
            if (list) {
                list.push(item);
            } else {
                byFile.set(key, [item]);
            }
        };

        for (const diagnostic of diagnostics ?? []) {
            pushDiagnostic(diagnostic);
        }

        if ((!diagnostics || diagnostics.length === 0) && fallbackMessage && files.length > 0) {
            pushDiagnostic({
                severity: fallbackSeverity,
                message: fallbackMessage,
                raw: fallbackMessage,
                fileIndex: fallbackFileIndex,
                line: 1,
                column: 1,
            });
        }

        for (const file of files) {
            const uri = getShaderSourceDocumentUri({
                context: this.context,
                capturePath: this.captureInfo?.filePath,
                eventId: msg.eventId,
                resourceId: msg.resourceId,
                stage: msg.stage,
                filename: file.filename,
                language: this.shaderLanguageForEncoding(msg.sourceEncoding),
            });
            this.shaderDiagnosticCollection.set(uri, byFile.get(uri.toString()) ?? []);
        }
    }

    private clearShaderProblemsForStage(eventId: number, resourceId: string, stage: string) {
        const capturePath = this.captureInfo?.filePath;
        for (const info of findLinkedShaderDocumentInfos((entry) => {
            return entry.capturePath === capturePath &&
                entry.eventId === eventId &&
                entry.resourceId === resourceId &&
                entry.stage === stage;
        })) {
            this.shaderDiagnosticCollection.delete(info.uri);
        }
    }

    private async openShaderInEditor(msg: Extract<WebviewToExtensionMessage, { type: 'openShaderInEditor' }>) {
        try {
            let source = msg.source ?? '';
            let filename = msg.filename;

            if (Array.isArray(msg.files) && msg.files.length > 0) {
                const resolvedFiles = await loadShaderSourceFilesFromDocuments({
                    context: this.context,
                    capturePath: this.captureInfo?.filePath,
                    eventId: msg.eventId,
                    resourceId: msg.resourceId,
                    stage: msg.stage,
                    language: msg.language,
                    files: msg.files,
                });

                if (typeof msg.selectedFileIndex === 'number' &&
                    msg.selectedFileIndex >= 0 &&
                    msg.selectedFileIndex < resolvedFiles.length) {
                    source = resolvedFiles[msg.selectedFileIndex].contents;
                    filename = resolvedFiles[msg.selectedFileIndex].filename;
                }
            }

            await openShaderSourceDocument({
                context: this.context,
                source,
                capturePath: this.captureInfo?.filePath,
                eventId: msg.eventId,
                resourceId: msg.resourceId,
                stage: msg.stage,
                filename,
                language: msg.language,
                viewColumn: msg.openToSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
                preserveFocus: msg.preserveFocus,
                preview: msg.preview,
                line: msg.line,
                column: msg.column,
                fileIndex: msg.selectedFileIndex,
            });
        } catch (error: any) {
            console.warn('[RenderDoc] Failed to open linked shader editor:', error?.message ?? String(error));
        }
    }

    private async resolveShaderEditFiles(msg: Extract<WebviewToExtensionMessage, { type: 'applyShaderEdit' | 'compileShaderEdit' }>) {
        return loadShaderSourceFilesFromDocuments({
            context: this.context,
            capturePath: this.captureInfo?.filePath,
            eventId: msg.eventId,
            resourceId: msg.resourceId,
            stage: msg.stage,
            language: this.shaderLanguageForEncoding(msg.sourceEncoding),
            files: msg.files,
        });
    }

    private async applyShaderEdit(msg: Extract<WebviewToExtensionMessage, { type: 'applyShaderEdit' }>) {
        try {
            const files = await this.resolveShaderEditFiles(msg);
            const result = await this.withShaderEditReplay('shader edit apply', () => this.bridge.nativeApplyShaderEdit({
                resourceId: msg.resourceId,
                shaderStage: msg.shaderStage,
                sourceEncoding: msg.sourceEncoding,
                entryPoint: msg.entryPoint,
                entryFileIndex: msg.entryFileIndex,
                compileFlags: msg.compileFlags,
                files,
            }));

            const compileLog = result.errors?.trim();
            const ok = !!result.applied;
            this.setShaderProblems(msg, files, result.diagnostics, compileLog, ok ? 'warning' : 'error');
            this.postShaderEditResult({
                eventId: msg.eventId,
                stage: msg.stage,
                action: 'apply',
                ok,
                message: ok
                    ? (compileLog ? `Shader applied.\n\n${compileLog}` : 'Shader applied.')
                    : (compileLog || 'Shader compilation failed.'),
                refresh: ok,
                diagnostics: result.diagnostics,
            });

            if (ok) {
                this.invalidateReplayCaches();
            }
        } catch (error: any) {
            this.postShaderEditResult({
                eventId: msg.eventId,
                stage: msg.stage,
                action: 'apply',
                ok: false,
                message: error?.message ?? String(error),
            });
        }
    }

    private async compileShaderEdit(msg: Extract<WebviewToExtensionMessage, { type: 'compileShaderEdit' }>) {
        try {
            const files = await this.resolveShaderEditFiles(msg);
            const result = await this.withShaderEditReplay('shader edit compile', () => this.bridge.nativeCompileShaderEdit({
                resourceId: msg.resourceId,
                shaderStage: msg.shaderStage,
                sourceEncoding: msg.sourceEncoding,
                entryPoint: msg.entryPoint,
                entryFileIndex: msg.entryFileIndex,
                compileFlags: msg.compileFlags,
                files,
            }));

            const compileLog = result.errors?.trim();
            const ok = !!result.compiled;
            this.setShaderProblems(msg, files, result.diagnostics, compileLog, ok ? 'warning' : 'error');
            this.postShaderEditResult({
                eventId: msg.eventId,
                stage: msg.stage,
                action: 'compile',
                ok,
                message: ok
                    ? (compileLog ? `Shader compiled.\n\n${compileLog}` : 'Shader compiled successfully.')
                    : (compileLog || 'Shader compilation failed.'),
                refresh: false,
                diagnostics: result.diagnostics,
            });
        } catch (error: any) {
            this.postShaderEditResult({
                eventId: msg.eventId,
                stage: msg.stage,
                action: 'compile',
                ok: false,
                message: error?.message ?? String(error),
            });
        }
    }

    private async revertShaderEdit(msg: Extract<WebviewToExtensionMessage, { type: 'revertShaderEdit' }>) {
        try {
            const result = await this.withShaderEditReplay('shader edit revert', () => this.bridge.nativeRevertShaderEdit(msg.resourceId));
            const detail = result.errors?.trim();
            const ok = !!result.reverted;
            if (ok) {
                this.clearShaderProblemsForStage(msg.eventId, msg.resourceId, msg.stage);
            }
            this.postShaderEditResult({
                eventId: msg.eventId,
                stage: msg.stage,
                action: 'revert',
                ok,
                message: ok
                    ? (detail ? `Shader replacement reverted.\n\n${detail}` : 'Shader replacement reverted.')
                    : (detail || 'Shader replacement was not active.'),
                refresh: ok,
            });

            if (ok) {
                this.invalidateReplayCaches();
            }
        } catch (error: any) {
            this.postShaderEditResult({
                eventId: msg.eventId,
                stage: msg.stage,
                action: 'revert',
                ok: false,
                message: error?.message ?? String(error),
            });
        }
    }

    private async analyzeMaliOffline(source: string, stage: string) {
        try {
            const config = vscode.workspace.getConfiguration('renderdoc');
            const maliocPath = config.get<string>('maliOfflineCompilerPath');

            if (!maliocPath) {
                this.panel.webview.postMessage({
                    type: 'maliAnalysisResult',
                    error: 'Error: mali offline compiler path (malioc.exe) is not configured in settings.'
                });
                return;
            }

            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const { exec } = require('child_process');
            
            let finalMaliPath = maliocPath;
            // 如果用户填写的只是一个目录，自动加上 malioc.exe
            if (fs.existsSync(finalMaliPath) && fs.statSync(finalMaliPath).isDirectory()) {
                finalMaliPath = path.join(finalMaliPath, process.platform === 'win32' ? 'malioc.exe' : 'malioc');
            }

            // Map stage to appropriate extension
            let ext = '.vert';
            if (stage === 'fragment' || stage === 'pixel' || stage === 'FS') ext = '.frag';
            else if (stage === 'compute' || stage === 'CS') ext = '.comp';
            else if (stage === 'geometry' || stage === 'GS') ext = '.geom';
            else if (stage === 'tess_control' || stage === 'hull' || stage === 'TCS' || stage === 'HS') ext = '.tesc';
            else if (stage === 'tess_eval' || stage === 'domain' || stage === 'TES' || stage === 'DS') ext = '.tese';
            else if (stage === 'vertex' || stage === 'VS') ext = '.vert';

            const tempFile = path.join(os.tmpdir(), `mali_analyze_${Date.now()}${ext}`);
            fs.writeFileSync(tempFile, source);

            // 在 Windows 下加 chcp 65001 强制控制台输出 UTF-8，防止中文系统的报错变成乱码
            const cmd = process.platform === 'win32' 
                ? `chcp 65001 >nul & "${finalMaliPath}" "${tempFile}"` 
                : `"${finalMaliPath}" "${tempFile}"`;

            exec(cmd, { timeout: 30000 }, (error: any, stdout: string, stderr: string) => {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); // cleanup
                
                let result = stdout;
                if (error && stderr && !stdout) {
                    result = stderr;
                } else if (stderr) {
                    result += '\n\n' + stderr;
                }

                const errStr = error ? (error.message || stderr) : undefined;
                const finalResult = result || 'No output from Mali Offline Compiler.';
                
                this.latestMaliAnalysis = {
                    source: source,
                    stage: stage,
                    result: errStr ? `Error: ${errStr}\nOutput: ${finalResult}` : finalResult
                };

                this.panel.webview.postMessage({
                    type: 'maliAnalysisResult',
                    result: finalResult,
                    error: (!result && errStr) ? errStr : undefined
                });
            });

        } catch (e: any) {
            this.latestMaliAnalysis = {
                source: source,
                stage: stage,
                result: `Failed to run Mali Offline Compiler: ${e.message}`
            };
            this.panel.webview.postMessage({
                type: 'maliAnalysisResult',
                error: `Failed to run Mali Offline Compiler: ${e.message}`
            });
        }
    }

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    private getInitialHtml(): string {
        return buildInspectorHtml(this.panel.webview, this.context.extensionUri);
    }
}

