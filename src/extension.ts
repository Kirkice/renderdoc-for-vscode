import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RenderDocBridge } from './renderdocBridge';
import { CaptureInfo, DrawCall, ResourceInfo } from './types';
import { CaptureInfoProvider } from './views/captureInfoProvider';
import { DrawCallProvider } from './views/drawCallProvider';
import { ApiInspectorProvider } from './views/apiInspectorProvider';
import { ResourceProvider } from './views/resourceProvider';
import { ThumbnailPanel } from './views/thumbnailPanel';
import { InspectorPanel } from './views/inspectorPanel';
import { DrawOverlayPanel } from './views/drawOverlayPanel';
import { initTools, registerAllTools } from './copilot/tools';
import { initChatParticipant, registerChatParticipant } from './copilot/chatParticipant';
import { ensureNativeBridge } from './bridgeInstaller';
import { CaptureCache, formatBytes } from './util/captureCache';
import {
    getShaderPanelHtml,
    getPipelineStateHtml,
    getTexturePreviewHtml,
} from './views/panelHtml';

let bridge: RenderDocBridge;
let captureCache: CaptureCache;
let captureInfoProvider: CaptureInfoProvider;
let drawCallProvider: DrawCallProvider;
let apiInspectorProvider: ApiInspectorProvider;
let resourceProvider: ResourceProvider;
let currentCapturePath: string | undefined;

// ── Selection tracking (for Copilot context) ──
let currentSelectedDrawCall: any | undefined;
let currentSelectedResource: any | undefined;
let currentDrawCalls: DrawCall[] = [];

// Path of the capture currently known to the native bridge process.
// Used to force-restart the bridge before loading a different capture,
// because some backends (GL/ANGLE) crash when a second capture is opened
// in the same process after a prior replay was torn down.
let bridgeLoadedCapturePath: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
    bridge = new RenderDocBridge();
    captureCache = new CaptureCache(context);

    // Check RenderDoc availability on startup
    const available = await bridge.checkAvailability();
    console.log('[RenderDoc] checkAvailability:', available);
    if (!available) {
        const action = await vscode.window.showWarningMessage(
            'RenderDoc installation not found. Please install RenderDoc or configure the path.',
            'Configure Path',
            'Dismiss'
        );
        if (action === 'Configure Path') {
            vscode.commands.executeCommand('renderdoc.configureRenderdocPath');
        }
    }

    // Try to start the native bridge for advanced features
    bridge.tryStartNativeBridge();
    console.log('[RenderDoc] hasNativeBridge after start:', bridge.hasNativeBridge());

    // First-run: if the bridge binary is missing, offer to download it from
    // the latest GitHub Release (or guide the user to build from source).
    // Runs asynchronously so it doesn't block the rest of activation.
    ensureNativeBridge(context, bridge).catch((e) => {
        console.warn('[RenderDoc] ensureNativeBridge failed:', e);
    });

    // Register TreeView providers
    captureInfoProvider = new CaptureInfoProvider();
    drawCallProvider = new DrawCallProvider();
    apiInspectorProvider = new ApiInspectorProvider(bridge);
    resourceProvider = new ResourceProvider();

    // Use createTreeView to get selection change events for Copilot context
    const drawCallTreeView = vscode.window.createTreeView('renderdoc-drawCalls', {
        treeDataProvider: drawCallProvider,
        showCollapseAll: true,
    });
    const resourceTreeView = vscode.window.createTreeView('renderdoc-resources', {
        treeDataProvider: resourceProvider,
        showCollapseAll: true,
    });

    drawCallTreeView.onDidChangeSelection(e => {
        if (e.selection.length > 0) {
            const item = e.selection[0] as any;
            currentSelectedDrawCall = item.drawCall ?? {
                label: item.label,
                eventId: item.eventId,
            };
            // If the Inspector panel is open, update it to this event
            if (InspectorPanel.currentPanel && typeof currentSelectedDrawCall?.eventId === 'number') {
                InspectorPanel.currentPanel.setEvent(currentSelectedDrawCall.eventId, item.drawCall);
            }
            // Populate the sidebar API Inspector with this event's chunks.
            if (typeof currentSelectedDrawCall?.eventId === 'number') {
                const label = typeof item.label === 'string' ? item.label : item.label?.label;
                apiInspectorProvider.setEvent(currentSelectedDrawCall.eventId, label).catch(() => {});
            }
            // Drive the drawcall-overlay panel too, so clicking a draw call
            // reveals its geometry highlight just like RenderDoc desktop.
            if (DrawOverlayPanel.currentPanel && typeof currentSelectedDrawCall?.eventId === 'number') {
                const label = typeof item.label === 'string' ? item.label : item.label?.label;
                DrawOverlayPanel.currentPanel.showEvent(currentSelectedDrawCall.eventId, label).catch(() => {});
            }
        }
    });
    resourceTreeView.onDidChangeSelection(e => {
        if (e.selection.length > 0) {
            const item = e.selection[0] as any;
            currentSelectedResource = {
                label: typeof item.label === 'string' ? item.label : item.label?.label,
                resourceId: item.resourceId,
                resourceType: item.resourceType,
                description: item.description,
            };
        }
    });

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('renderdoc-captureInfo', captureInfoProvider),
        vscode.window.registerTreeDataProvider('renderdoc-apiInspector', apiInspectorProvider),
        drawCallTreeView,
        resourceTreeView
    );

    // Allow the Inspector to pull capture state on demand (e.g. when opened
    // via a draw-call click before any explicit setCapture happened, or after
    // a window reload where the webview's queued state was dropped).
    InspectorPanel.captureProvider = async () => {
        const info = captureInfoProvider.getCaptureInfo();
        if (!info) { return undefined; }
        let drawCalls: any[] = [];
        let resources: any[] = [];
        try { drawCalls = await bridge.getDrawCalls(info.filePath); } catch (e: any) {
            console.warn('[RenderDoc] captureProvider getDrawCalls failed:', e?.message);
        }
        try { resources = await bridge.getResources(info.filePath); } catch (e: any) {
            console.warn('[RenderDoc] captureProvider getResources failed:', e?.message);
        }
        return { captureInfo: info, drawCalls, resources };
    };

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('renderdoc.openCapture', () => openCapture(context)),
        vscode.commands.registerCommand('renderdoc.showThumbnail', () => showThumbnail(context)),
        vscode.commands.registerCommand('renderdoc.refreshCapture', () => refreshCapture()),
        vscode.commands.registerCommand('renderdoc.configureRenderdocPath', () => configureRenderdocPath()),
        vscode.commands.registerCommand('renderdoc.showDrawCallDetails', (item) => showDrawCallDetails(context, item)),
        vscode.commands.registerCommand('renderdoc.showResourceDetails', (item) => showResourceDetails(context, item)),
        vscode.commands.registerCommand('renderdoc.viewShaderSource', (item) => viewShaderSource(context, item)),
        vscode.commands.registerCommand('renderdoc.viewPipelineState', (item) => viewPipelineState(context, item)),
        vscode.commands.registerCommand('renderdoc.exportTexture', (item) => exportTexture(item)),
        vscode.commands.registerCommand('renderdoc.previewTexture', (item) => previewTexture(context, item)),
        vscode.commands.registerCommand('renderdoc.viewAllShaders', () => viewAllShaders(context)),
        vscode.commands.registerCommand('renderdoc.tryLocalReplay', () => tryLocalReplay()),
        vscode.commands.registerCommand('renderdoc.downloadNativeBridge', async () => {
            // Clear the "don't ask again" flag so the picker shows again.
            await context.globalState.update('renderdoc.skipBridgePrompt', false);
            await ensureNativeBridge(context, bridge);
        }),
        vscode.commands.registerCommand('renderdoc.clearCache', () => clearCaptureCache()),
        vscode.commands.registerCommand('renderdoc.openInspector', () => openInspector(context)),
        vscode.commands.registerCommand('renderdoc.showDrawcallOverlay', async () => {
            await DrawOverlayPanel.createOrShow(context, bridge);
            const sel = currentSelectedDrawCall;
            if (DrawOverlayPanel.currentPanel && sel && typeof sel.eventId === 'number') {
                DrawOverlayPanel.currentPanel.showEvent(sel.eventId, sel.label).catch(() => {});
            }
        }),
        vscode.commands.registerCommand('renderdoc.fetchTimings', () => fetchTimings()),
    );    // ── Copilot integration (non-critical, don't break extension if unavailable) ──
    try {
        const getCapturePath = () => currentCapturePath;
        const getSelectionContext = () => ({
            selectedDrawCall: currentSelectedDrawCall,
            selectedResource: currentSelectedResource,
        });
        initTools(bridge, getCapturePath, getSelectionContext, () => currentDrawCalls);
        initChatParticipant(bridge, getCapturePath, getSelectionContext);
        registerAllTools(context);
        registerChatParticipant(context);
    } catch (err: any) {
        console.warn('[RenderDoc] Copilot integration failed (non-critical):', err.message);
    }

    // Update status bar
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.text = available ? '$(device-camera) RenderDoc: Ready' : '$(warning) RenderDoc: Not Found';
    statusBarItem.tooltip = 'RenderDoc for VS Code';
    statusBarItem.command = 'renderdoc.openCapture';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Auto-restore the previously loaded capture, so the Inspector tab that
    // VS Code serialized across window reloads has real data to render.
    const lastPath = context.workspaceState.get<string>('renderdoc.lastCapturePath');
    if (lastPath && fs.existsSync(lastPath)) {
        loadCapture(context, lastPath, /* silent */ true).catch(err => {
            console.warn('[RenderDoc] auto-restore failed:', err?.message);
        });
    }

    // Revive Inspector webview panels that VS Code serialized across reloads.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('renderdoc-inspector', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: any) {
                InspectorPanel.revive(panel, context, bridge);
            }
        })
    );
}

async function openCapture(context: vscode.ExtensionContext) {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'RenderDoc Capture': ['rdc'] },
        title: 'Open RDC Capture File'
    });

    if (!uris || uris.length === 0) {
        return;
    }

    const filePath = uris[0].fsPath;
    await loadCapture(context, filePath);
}

async function loadCapture(context: vscode.ExtensionContext, filePath: string, silent = false) {
    currentCapturePath = filePath;
    context.workspaceState.update('renderdoc.lastCapturePath', filePath);
    console.log('[RenderDoc] loadCapture called:', filePath, 'silent:', silent);
    console.log('[RenderDoc] hasNativeBridge:', bridge.hasNativeBridge());

    // ── Fast path: serve from cache ──────────────────────────────────────
    // If we've previously loaded this exact rdc (same path, mtime, size),
    // the draw-call tree and resource list are on disk. Populate the UI
    // instantly and skip the 50+ s replay init. The user can still click
    // "Try Local Replay" to upgrade to a live replay when they want to
    // inspect shaders / pipeline state / textures.
    const cached = captureCache.get(filePath);
    if (cached) {
        console.log('[RenderDoc] loadCapture: cache hit, skipping replay init.');
        captureInfoProvider.update(cached.captureInfo);
        currentDrawCalls = cached.drawCalls;
        drawCallProvider.update(cached.drawCalls);
        resourceProvider.update(cached.resources);
        apiInspectorProvider.clear();
        captureInfoProvider.setReplayStatus('unavailable');
        if (InspectorPanel.currentPanel) {
            InspectorPanel.currentPanel.setCapture(cached.captureInfo, cached.drawCalls, cached.resources);
        }
        // Thumbnail is cheap (renderdoccmd, no replay), load it in the
        // background so the panel still shows the preview.
        bridge.getThumbnail(filePath).then(thumbnail => {
            if (thumbnail && !silent) {
                ThumbnailPanel.createOrShow(context, thumbnail, cached.captureInfo);
            }
        }).catch(() => { /* best-effort */ });
        if (!silent) {
            vscode.window.showInformationMessage(
                `RenderDoc: Loaded ${path.basename(filePath)} from cache. Click "Try Local Replay" for live shader/pipeline inspection.`
            );
        }
        return;
    }

    // Only one capture can be replayed at a time. If the bridge already has a
    // different capture loaded (potentially with an active replay), restart it
    // so the previous replay is cleanly shut down before opening the new one.
    // Re-opening a GL/ANGLE capture in the same bridge process after a prior
    // replay was torn down reliably crashes with an access violation, so a
    // fresh process is the safe choice.
    if (bridge.hasNativeBridge()
        && bridgeLoadedCapturePath
        && bridgeLoadedCapturePath !== filePath) {
        console.log('[RenderDoc] Different capture already loaded in bridge; restarting process to close previous replay.');
        bridge.restartNativeBridge();
        bridgeLoadedCapturePath = undefined;
        captureInfoProvider.setReplayStatus('unavailable');
    }

    // If the bridge isn't running (first open, previous crash, or just killed
    // above), try to (re)spawn it so advanced features are available.
    if (!bridge.hasNativeBridge()) {
        console.log('[RenderDoc] Native bridge not running; attempting to start it.');
        bridge.tryStartNativeBridge();
        console.log('[RenderDoc] hasNativeBridge after tryStart:', bridge.hasNativeBridge());
    }

    // Open in native bridge if available
    let nativeResult: any;
    if (bridge.hasNativeBridge()) {
        try {
            nativeResult = await bridge.nativeOpenCapture(filePath);
            console.log('[RenderDoc] nativeOpenCapture result:', JSON.stringify(nativeResult));
            bridgeLoadedCapturePath = filePath;
        } catch (err: any) {
            console.error('[RenderDoc] nativeOpenCapture error:', err.message);
        }
    } else {
        console.log('[RenderDoc] No native bridge available');
    }

    // Set replay status based on nativeOpenCapture result
    if (nativeResult && nativeResult.replay) {
        captureInfoProvider.setReplayStatus('active');
    } else if (nativeResult && nativeResult.canTryReplay) {
        captureInfoProvider.setReplayStatus('unavailable');
    } else if (nativeResult && !nativeResult.replay) {
        captureInfoProvider.setReplayStatus('failed');
    }

    // Auto-start local replay for any capture the native bridge says we can
    // try — including cross-OS (SuggestRemote) captures. RenderDoc's own GUI
    // does not block on SuggestRemote; it just attempts the local replay and
    // reports whatever error comes back. We mirror that behaviour here so the
    // user isn't forced through an ANGLE-install modal that is often wrong
    // (many GLES captures replay fine on desktop GL without ANGLE at all).
    //
    // A single large progress notification spans BOTH the replay-init phase
    // (0–70%, driven by RenderDoc's OpenCapture progress callback) and the
    // subsequent capture-analysis phase (70–100%, our own steps). This gives
    // the user one visible popup for the whole loading sequence — more
    // prominent than a tiny status-bar entry.
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `RenderDoc — Loading ${path.basename(filePath)}`,
            cancellable: true,
        },
        async (progress, token) => {
            // ───── Phase 1: replay driver init (0–70%) ─────
            if (nativeResult && nativeResult.canTryReplay && !nativeResult.replay) {
                progress.report({ message: 'Initialising local replay...', increment: 0 });
                let lastPct = 0;
                let cancelled = false;
                const unsubscribe = bridge.onNativeNotification('tryReplayProgress', (params) => {
                    const p = Math.max(0, Math.min(1, Number(params?.progress ?? 0)));
                    const pct = Math.round(p * 70); // reserve 30% for analysis
                    const delta = pct - lastPct;
                    if (delta > 0) {
                        lastPct = pct;
                        progress.report({ message: `Initialising local replay... ${Math.round(p * 100)}%`, increment: delta });
                    }
                });
                // Cancel handler: renderdoc.dll's OpenCapture can't be aborted
                // cleanly from the outside, so the only reliable way to stop
                // it is to kill the bridge process. We then restart it so
                // basic capture info (header/thumbnail) still works.
                const cancelSub = token.onCancellationRequested(() => {
                    cancelled = true;
                    console.log('[RenderDoc] User cancelled replay init — killing bridge.');
                    bridge.restartNativeBridge();
                });
                try {
                    const tryResult = await bridge.nativeTryReplay();
                    if (cancelled) {
                        captureInfoProvider.setReplayStatus('unavailable');
                    } else if (tryResult && tryResult.replay) {
                        captureInfoProvider.setReplayStatus('active');
                        if (!silent && nativeResult.suggestRemote) {
                            vscode.window.showInformationMessage('RenderDoc: local replay started (cross-OS capture).');
                        }
                    } else {
                        captureInfoProvider.setReplayStatus('failed');
                        if (!silent) {
                            const msg = tryResult?.replayError || nativeResult.replayMessage || 'Unknown error';
                            vscode.window.showWarningMessage(`RenderDoc: local replay failed — ${msg}`);
                        }
                    }
                } catch (err: any) {
                    if (cancelled) {
                        captureInfoProvider.setReplayStatus('unavailable');
                        console.log('[RenderDoc] tryReplay aborted by user cancel.');
                    } else {
                        console.warn('[RenderDoc] tryReplay crashed:', err?.message);
                        captureInfoProvider.setReplayStatus('failed');
                        bridge.restartNativeBridge();
                        if (!silent) {
                            vscode.window.showWarningMessage(
                                `RenderDoc: local replay crashed — ${err?.message || err}. ` +
                                `Basic capture info (draw calls, resources, thumbnail) is still available.`
                            );
                        }
                    }
                } finally {
                    unsubscribe();
                    cancelSub.dispose();
                }

                // If the user cancelled, try to re-open the capture in the
                // fresh bridge so subsequent UI actions (thumbnail, header)
                // still work, then stop here — no point running the analysis
                // phase which would all fail with "No replay active".
                if (cancelled) {
                    if (bridge.hasNativeBridge()) {
                        try { await bridge.nativeOpenCapture(filePath); } catch { /* ignore */ }
                    }
                    if (!silent) {
                        vscode.window.showInformationMessage('RenderDoc: replay loading cancelled.');
                    }
                    return;
                }

                // Make sure we end phase 1 at exactly 70%
                if (lastPct < 70) {
                    progress.report({ increment: 70 - lastPct });
                }
            } else {
                progress.report({ increment: 70 });
            }

            // ───── Phase 2: capture analysis (70–100%) ─────
            if (token.isCancellationRequested) { return; }
            // Step 1: Capture info — reads RDC binary directly, always works.
            let captureInfo: CaptureInfo | undefined;
            try {
                progress.report({ message: 'Reading capture info...', increment: 0 });
                captureInfo = await bridge.getCaptureInfo(filePath);
                captureInfoProvider.update(captureInfo);
            } catch (err: any) {
                vscode.window.showErrorMessage(`RenderDoc: Failed to read capture header - ${err.message}`);
                return;
            }

            // Step 2 & 3: Draw calls and resources — require an active replay.
            let drawCalls: DrawCall[] = [];
            let resources: ResourceInfo[] = [];
            let replayErr: Error | undefined;
            try {
                if (token.isCancellationRequested) { return; }
                progress.report({ message: 'Loading draw calls...', increment: 10 });
                drawCalls = await bridge.getDrawCalls(filePath);
                currentDrawCalls = drawCalls;
                drawCallProvider.update(drawCalls);

                if (token.isCancellationRequested) { return; }
                progress.report({ message: 'Loading resources...', increment: 10 });
                resources = await bridge.getResources(filePath);
                resourceProvider.update(resources);
            } catch (err: any) {
                replayErr = err;
                drawCallProvider.update([]);
                resourceProvider.update([]);
            }
            apiInspectorProvider.clear();

            // Persist successful results so the next open of this capture
            // is instant (skips the expensive replay init).
            if (!replayErr && captureInfo && drawCalls.length > 0) {
                try {
                    captureCache.put(filePath, captureInfo, drawCalls, resources);
                } catch (e: any) {
                    console.warn('[RenderDoc] captureCache.put failed:', e?.message);
                }
            }

            // Push whatever we have into an open Inspector
            if (InspectorPanel.currentPanel && captureInfo) {
                InspectorPanel.currentPanel.setCapture(captureInfo, drawCalls, resources);
            }

            // Step 4: Thumbnail — uses renderdoccmd binary, no replay needed.
            try {
                if (token.isCancellationRequested) { return; }
                progress.report({ message: 'Loading thumbnail...', increment: 10 });
                const thumbnail = await bridge.getThumbnail(filePath);
                if (thumbnail && !silent) {
                    ThumbnailPanel.createOrShow(context, thumbnail, captureInfo);
                }
            } catch (err: any) {
                console.warn('[RenderDoc] thumbnail load failed:', err?.message);
            }

            if (replayErr && !silent) {
                vscode.window.showWarningMessage(
                    `RenderDoc: this capture cannot be inspected without an active local replay. ` +
                    `Draw calls, resources, shader source and pipeline state are unavailable. ` +
                    `(${replayErr.message})`,
                    { modal: true }
                );
            } else if (!silent) {
                vscode.window.showInformationMessage(`RenderDoc: Loaded ${filePath}`);
            }
        }
    );
}

async function showThumbnail(context: vscode.ExtensionContext) {
    const info = captureInfoProvider.getCaptureInfo();
    if (!info) {
        vscode.window.showWarningMessage('No capture file loaded. Open a .rdc file first.');
        return;
    }
    const thumbnail = await bridge.getThumbnail(info.filePath);
    if (thumbnail) {
        ThumbnailPanel.createOrShow(context, thumbnail, info);
    }
}

async function refreshCapture() {
    const info = captureInfoProvider.getCaptureInfo();
    if (!info) {
        vscode.window.showWarningMessage('No capture file loaded.');
        return;
    }
    const captureInfo = await bridge.getCaptureInfo(info.filePath);
    captureInfoProvider.update(captureInfo);
    const drawCalls = await bridge.getDrawCalls(info.filePath);
    currentDrawCalls = drawCalls;
    drawCallProvider.update(drawCalls);
    const resources = await bridge.getResources(info.filePath);
    resourceProvider.update(resources);
    if (InspectorPanel.currentPanel) {
        InspectorPanel.currentPanel.setCapture(captureInfo, drawCalls, resources);
    }
}

/** Walk draw call tree and attach GPU timings by eventId. */
function applyTimingsToTree(calls: DrawCall[], timings: Map<number, number>): void {
    for (const dc of calls) {
        const t = timings.get(dc.eventId);
        if (t !== undefined) { dc.durationUs = t; }
        if (dc.children && dc.children.length > 0) {
            applyTimingsToTree(dc.children, timings);
        }
    }
}

async function fetchTimings() {
    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage('RenderDoc: GPU timings require an active local replay.');
        return;
    }
    if (currentDrawCalls.length === 0) {
        vscode.window.showWarningMessage('RenderDoc: No draw calls loaded. Open a capture first.');
        return;
    }
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc — Fetching GPU timings…' },
        async (progress) => {
            progress.report({ message: 'Replaying frame with timer queries…' });
            try {
                const timings = await bridge.getDrawTimings();
                applyTimingsToTree(currentDrawCalls, timings);
                drawCallProvider.update(currentDrawCalls);
                vscode.window.showInformationMessage(
                    `RenderDoc: GPU timings loaded for ${timings.size} events.`
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`RenderDoc: Failed to fetch timings — ${err.message}`);
            }
        }
    );
}

async function configureRenderdocPath() {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select RenderDoc Installation Directory'
    });

    if (uris && uris.length > 0) {
        const config = vscode.workspace.getConfiguration('renderdoc');
        await config.update('installPath', uris[0].fsPath, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`RenderDoc path set to: ${uris[0].fsPath}`);

        const available = await bridge.checkAvailability();
        if (!available) {
            vscode.window.showErrorMessage('RenderDoc not detected at the configured path.');
        }
    }
}

async function showDrawCallDetails(context: vscode.ExtensionContext, item: any) {
    if (!item) { return; }
    if (item.eventId === undefined) { return; }

    // User asked for simplest possible behaviour: always dispose the previous
    // Inspector panel and create a fresh one on every draw-call click, so we
    // never hit any stale-state / re-render corner cases.
    if (InspectorPanel.currentPanel) {
        InspectorPanel.currentPanel.disposePanel();
    }

    const info = captureInfoProvider.getCaptureInfo();
    const inspector = InspectorPanel.createOrShow(context, bridge);
    if (info) {
        try {
            const drawCalls = await bridge.getDrawCalls(info.filePath);
            const resources = await bridge.getResources(info.filePath);
            inspector.setCapture(info, drawCalls, resources);
        } catch { /* best-effort */ }
    }
    await inspector.setEvent(item.eventId, item.drawCall);
}

async function showResourceDetails(context: vscode.ExtensionContext, item: any) {
    if (!item) { return; }

    // Open the Inspector on the Textures tab (if a texture) or show in a quick
    // pick. Resource details are available to Copilot via the
    // renderdoc_getResourceDetail tool.
    const info = captureInfoProvider.getCaptureInfo();
    const inspector = InspectorPanel.createOrShow(context, bridge);
    if (info) {
        try {
            const drawCalls = await bridge.getDrawCalls(info.filePath);
            const resources = await bridge.getResources(info.filePath);
            inspector.setCapture(info, drawCalls, resources);
        } catch { /* best-effort */ }
    }
    inspector.reveal();
}

// ── Advanced Feature Commands ────────────────────────────────────────

async function viewShaderSource(context: vscode.ExtensionContext, item: any) {
    if (!item) { return; }
    if (!currentCapturePath) {
        vscode.window.showWarningMessage('No capture file loaded.');
        return;
    }

    // item can come from DrawCallItem (has drawCall.eventId) or ResourceItem (has resourceId)
    const eventId = item.drawCall?.eventId ?? item.eventId;

    if (!bridge.hasNativeBridge() || eventId === undefined) {
        vscode.window.showWarningMessage(
            'Shader source requires an active local replay. Open a capture that can replay on this machine, or select a draw call first.'
        );
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Loading shader source...' },
        async () => {
            try {
                const result = await bridge.nativeGetShaderSource(eventId);
                if (!result || !result.shaders || Object.keys(result.shaders).length === 0) {
                    vscode.window.showInformationMessage('No shader sources returned by the native bridge for this event.');
                    return;
                }
                const panelData: Record<string, string> = {};
                for (const [stage, info] of Object.entries(result.shaders) as [string, any][]) {
                    // Build a human-readable tab label: "VertexShader  myVS.hlsl (main)"
                    const shaderName: string = info.name || '';
                    const entry: string = info.entryPoint && info.entryPoint !== 'main' ? ` (${info.entryPoint})` : '';
                    const tabLabel = shaderName ? `${stage}  ${shaderName}${entry}` : `${stage}${entry}`;
                    panelData[tabLabel] = info.source || info.disassembly || '// No source available';
                }
                showShaderPanel(context, panelData, eventId);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get shader source: ${err.message}`);
            }
        }
    );
}

async function viewAllShaders(context: vscode.ExtensionContext) {
    if (!currentCapturePath) {
        vscode.window.showWarningMessage('No capture file loaded.');
        return;
    }
    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage(
            'Listing all shaders requires an active local replay. The RenderDoc native bridge is not running.'
        );
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Extracting all shaders...' },
        async () => {
            try {
                const shaders = await bridge.getAllShaders();
                if (shaders.length === 0) {
                    vscode.window.showInformationMessage('No shader sources found in this capture.');
                    return;
                }
                const pick = await vscode.window.showQuickPick(
                    shaders.map((s, i) => ({ label: `${i + 1}. ${s.name}`, description: `${s.source.length} chars`, index: i })),
                    { placeHolder: `Found ${shaders.length} shader(s) — select one to view` }
                );
                if (pick) {
                    const doc = await vscode.workspace.openTextDocument({ content: shaders[pick.index].source, language: 'glsl' });
                    await vscode.window.showTextDocument(doc);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to extract shaders: ${err.message}`);
            }
        }
    );
}

// ANGLE helpers live in ./commands/angle.ts

async function openInspector(context: vscode.ExtensionContext) {
    const info = captureInfoProvider.getCaptureInfo();
    const panel = InspectorPanel.createOrShow(context, bridge);
    if (info) {
        try {
            const drawCalls = await bridge.getDrawCalls(info.filePath);
            const resources = await bridge.getResources(info.filePath);
            panel.setCapture(info, drawCalls, resources);
            // If there's a currently selected draw call, focus it
            if (currentSelectedDrawCall?.eventId !== undefined) {
                await panel.setEvent(currentSelectedDrawCall.eventId, currentSelectedDrawCall);
            }
        } catch (err: any) {
            vscode.window.showWarningMessage(`Inspector: failed to load capture data - ${err.message}`);
        }
    } else {
        vscode.window.showInformationMessage('Open a .rdc capture to populate the Inspector.');
    }
    panel.reveal();
}

async function tryLocalReplay() {
    if (!currentCapturePath) {
        vscode.window.showWarningMessage('No capture file loaded.');
        return;
    }
    // Auto-recover: the bridge process may have died (e.g. from a previous
    // replay crash). If the binary is installed, transparently restart it
    // and re-open the capture before proceeding.
    if (!bridge.hasNativeBridge()) {
        if (!bridge.isNativeBridgeInstalled()) {
            const action = await vscode.window.showWarningMessage(
                'Native bridge binary is not installed. Local replay requires it.',
                'Download Prebuilt',
                'Build from Source',
            );
            if (action === 'Download Prebuilt' || action === 'Build from Source') {
                vscode.commands.executeCommand('renderdoc.downloadNativeBridge')
                    .then(undefined, () => { /* command may not exist */ });
            }
            return;
        }
        console.log('[RenderDoc] Native bridge not running; attempting restart before replay...');
        bridge.restartNativeBridge();
        bridgeLoadedCapturePath = undefined;
        // Give the process a moment to spawn; hasNativeBridge() flips synchronously on spawn.
        if (!bridge.hasNativeBridge()) {
            vscode.window.showWarningMessage(
                'Failed to start the native bridge process. Check the Extension Host log for [RenderDoc] errors.'
            );
            return;
        }
        try { await bridge.nativeOpenCapture(currentCapturePath); }
        catch (err: any) {
            vscode.window.showWarningMessage(`Native bridge restarted but failed to open capture: ${err.message}`);
            return;
        }
        bridgeLoadedCapturePath = currentCapturePath;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Attempting local replay may crash if the capture is from a different platform. Continue?',
        { modal: true },
        'Try Replay'
    );
    if (confirm !== 'Try Replay') { return; }

    try {
        const result = await bridge.nativeTryReplay();
        if (result && result.replay) {
            captureInfoProvider.setReplayStatus('active');
            vscode.window.showInformationMessage('Local replay active! Shader/pipeline/texture features are now available.');
        } else {
            captureInfoProvider.setReplayStatus('failed');
            vscode.window.showWarningMessage(`Replay failed: ${result?.replayError || 'Unknown error'}`);
        }
    } catch (err: any) {
        captureInfoProvider.setReplayStatus('failed');
        console.log('[RenderDoc] tryLocalReplay crashed, restarting bridge...');
        bridge.tryStartNativeBridge();
        if (bridge.hasNativeBridge()) {
            try { await bridge.nativeOpenCapture(currentCapturePath); } catch { /* ignore */ }
        }
        vscode.window.showWarningMessage(
            'Local replay crashed — this capture cannot be replayed on this GPU. ' +
            'Inspection features are disabled for this capture.'
        );
    }
}

async function clearCaptureCache() {
    const stats = captureCache.stats();
    if (stats.files === 0) {
        vscode.window.showInformationMessage('RenderDoc: cache is already empty.');
        return;
    }
    const pick = await vscode.window.showWarningMessage(
        `Clear ${stats.files} cached capture${stats.files === 1 ? '' : 's'} (${formatBytes(stats.bytes)})? The next open of each capture will re-run the full replay init.`,
        { modal: true },
        'Clear'
    );
    if (pick !== 'Clear') { return; }
    const removed = captureCache.clear();
    vscode.window.showInformationMessage(
        `RenderDoc: cleared ${removed.files} cached capture${removed.files === 1 ? '' : 's'} (${formatBytes(removed.bytes)}).`
    );
}

function showShaderPanel(_context: vscode.ExtensionContext, result: any, eventId: number) {
    const panel = vscode.window.createWebviewPanel(
        'renderdoc-shader',
        `Shader @ EID ${eventId}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel.webview.html = getShaderPanelHtml(result);
}

async function viewPipelineState(context: vscode.ExtensionContext, item: any) {
    if (!item) { return; }
    const eventId = item.drawCall?.eventId ?? item.eventId;
    if (eventId === undefined) { return; }

    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage('Pipeline state requires the native bridge. Ensure RenderDoc is installed and the capture supports local replay.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Loading pipeline state...' },
        async () => {
            try {
                const state = await bridge.nativeGetPipelineState(eventId);
                const panel = vscode.window.createWebviewPanel(
                    'renderdoc-pipeline',
                    `Pipeline State @ EID ${eventId}`,
                    vscode.ViewColumn.One,
                    { enableScripts: true }
                );
                panel.webview.html = getPipelineStateHtml(state, eventId);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get pipeline state: ${err.message}`);
            }
        }
    );
}

// getPipelineStateHtml lives in ./views/panelHtml.ts

async function exportTexture(item: any) {
    if (!item) { return; }
    const resourceId = item.resourceId;
    if (!resourceId) { return; }

    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage('Texture export requires the native bridge. Ensure RenderDoc is installed and the capture supports local replay.');
        return;
    }

    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`texture_${resourceId}.png`),
        filters: { 'PNG Image': ['png'], 'All Files': ['*'] },
        title: 'Export Texture'
    });
    if (!uri) { return; }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Exporting texture...' },
        async () => {
            try {
                const result = await bridge.nativeGetTextureData(resourceId);
                if (result && result.base64) {
                    const buffer = Buffer.from(result.base64, 'base64');
                    await vscode.workspace.fs.writeFile(uri, buffer);
                    vscode.window.showInformationMessage(`Texture exported to ${uri.fsPath}`);
                } else {
                    vscode.window.showWarningMessage('No texture data returned. The capture may not support local replay.');
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to export texture: ${err.message}`);
            }
        }
    );
}

async function previewTexture(context: vscode.ExtensionContext, item: any) {
    if (!item) { return; }
    const resourceId = item.resourceId;
    if (!resourceId) { return; }

    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage('Texture preview requires the native bridge. Ensure RenderDoc is installed and the capture supports local replay.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Loading texture preview...' },
        async () => {
            try {
                // Fetch texture as PNG with alpha preserved
                const result = await bridge.nativeGetTextureData(resourceId);
                if (!result || !result.base64) {
                    vscode.window.showWarningMessage('No texture data returned. The capture may not support local replay.');
                    return;
                }

                const panel = vscode.window.createWebviewPanel(
                    'renderdoc-texture',
                    `Texture ${resourceId}`,
                    vscode.ViewColumn.One,
                    { enableScripts: true }
                );
                panel.webview.html = getTexturePreviewHtml(result, resourceId);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to preview texture: ${err.message}`);
            }
        }
    );
}

// getTexturePreviewHtml lives in ./views/panelHtml.ts
