import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RenderDocBridge } from './renderdocBridge';
import { CaptureInfo, DrawCall, ResourceInfo } from './types';
import { CaptureInfoProvider } from './views/captureInfoProvider';
import { DrawCallProvider } from './views/drawCallProvider';
import { ResourceProvider } from './views/resourceProvider';
import { ThumbnailPanel } from './views/thumbnailPanel';
import { InspectorPanel } from './views/inspectorPanel';
import { initTools, registerAllTools } from './copilot/tools';
import { initChatParticipant, registerChatParticipant } from './copilot/chatParticipant';
import { ensureNativeBridge } from './bridgeInstaller';
import {
    checkAngleAvailability,
    findAngleSources,
    installAngleDlls,
} from './commands/angle';
import {
    getShaderPanelHtml,
    getPipelineStateHtml,
    getTexturePreviewHtml,
} from './views/panelHtml';

let bridge: RenderDocBridge;
let captureInfoProvider: CaptureInfoProvider;
let drawCallProvider: DrawCallProvider;
let resourceProvider: ResourceProvider;
let currentCapturePath: string | undefined;

// ── Selection tracking (for Copilot context) ──
let currentSelectedDrawCall: any | undefined;
let currentSelectedResource: any | undefined;

// Path of the capture currently known to the native bridge process.
// Used to force-restart the bridge before loading a different capture,
// because some backends (GL/ANGLE) crash when a second capture is opened
// in the same process after a prior replay was torn down.
let bridgeLoadedCapturePath: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
    bridge = new RenderDocBridge();

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
        vscode.commands.registerCommand('renderdoc.openInspector', () => openInspector(context))
    );

    // ── Copilot integration (non-critical, don't break extension if unavailable) ──
    try {
        const getCapturePath = () => currentCapturePath;
        const getSelectionContext = () => ({
            selectedDrawCall: currentSelectedDrawCall,
            selectedResource: currentSelectedResource,
        });
        initTools(bridge, getCapturePath, getSelectionContext);
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

    // Auto-start local replay for natively supported captures (both silent
    // auto-restore and explicit user opens). The native bridge no longer
    // auto-opens the replay in `openCapture` because re-opening GL/ANGLE
    // captures after tear-down can crash — so we must always call tryReplay
    // here. Cross-OS (SuggestRemote) captures still go through the modal
    // below so the user can decide whether to attempt the risky local replay.
    if (nativeResult && nativeResult.canTryReplay && !nativeResult.replay && !nativeResult.suggestRemote) {
        try {
            const tryResult = await bridge.nativeTryReplay();
            if (tryResult && tryResult.replay) {
                captureInfoProvider.setReplayStatus('active');
            } else {
                captureInfoProvider.setReplayStatus('failed');
            }
        } catch (err: any) {
            console.warn('[RenderDoc] tryReplay crashed:', err?.message);
            captureInfoProvider.setReplayStatus('failed');
            bridge.restartNativeBridge();
            if (bridge.hasNativeBridge()) {
                try { await bridge.nativeOpenCapture(filePath); } catch { /* ignore */ }
            }
        }
    }

    // If the capture is from a different OS (SuggestRemote), show a modal dialog
    if (!silent && nativeResult && nativeResult.canTryReplay && !nativeResult.replay && nativeResult.suggestRemote) {
        // Check ANGLE availability for GLES captures
        const angleStatus = checkAngleAvailability();
        const angleSources = !angleStatus.available ? findAngleSources() : null;
        const hasAngle = angleStatus.available;

        let message = nativeResult.replayMessage || 'This capture was made on a different OS. Local replay may be unstable.';
        if (!hasAngle) {
            message += '\n\nNote: ANGLE (libEGL.dll) is not installed. GLES captures require ANGLE for desktop replay.';
            if (angleSources) {
                message += ` Found ANGLE in ${angleSources.source} — can be installed automatically.`;
            }
        }

        const buttons = hasAngle
            ? ['Try Local Replay', 'Skip Replay'] as const
            : angleSources
                ? ['Install ANGLE & Replay', 'Skip Replay'] as const
                : ['Try Local Replay', 'Skip Replay'] as const;

        const action = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            ...buttons
        );
        if (action === 'Install ANGLE & Replay' && angleSources) {
            const installed = await installAngleDlls(angleSources);
            if (installed) {
                vscode.window.showInformationMessage('ANGLE installed! Restarting bridge and attempting replay...');
                bridge.restartNativeBridge();
                if (bridge.hasNativeBridge()) {
                    try {
                        await bridge.nativeOpenCapture(filePath);
                        const tryResult = await bridge.nativeTryReplay();
                        if (tryResult && tryResult.replay) {
                            captureInfoProvider.setReplayStatus('active');
                            vscode.window.showInformationMessage('Local replay started successfully! All advanced features are now available.');
                        } else {
                            captureInfoProvider.setReplayStatus('failed');
                            vscode.window.showWarningMessage(`Replay failed: ${tryResult?.replayError || 'Unknown error'}`);
                        }
                    } catch (err: any) {
                        captureInfoProvider.setReplayStatus('failed');
                        console.log('[RenderDoc] tryReplay crashed after ANGLE install, restarting bridge...');
                        bridge.restartNativeBridge();
                        if (bridge.hasNativeBridge()) {
                            try { await bridge.nativeOpenCapture(filePath); } catch { /* ignore */ }
                        }
                        vscode.window.showWarningMessage(
                            'Replay still crashed even with ANGLE. The capture may use unsupported GLES features.'
                        );
                    }
                }
            }
        } else if (action === 'Try Local Replay') {
            try {
                const tryResult = await bridge.nativeTryReplay();
                if (tryResult && tryResult.replay) {
                    captureInfoProvider.setReplayStatus('active');
                    vscode.window.showInformationMessage('Local replay started successfully! Shader/pipeline/texture features are now available.');
                } else {
                    captureInfoProvider.setReplayStatus('failed');
                    vscode.window.showWarningMessage(`Replay failed: ${tryResult?.replayError || 'Unknown error'}`);
                }
            } catch (err: any) {
                captureInfoProvider.setReplayStatus('failed');
                // Bridge likely crashed — restart it so file info still works
                console.log('[RenderDoc] tryReplay crashed, restarting bridge...');
                bridge.tryStartNativeBridge();
                if (bridge.hasNativeBridge()) {
                    try { await bridge.nativeOpenCapture(filePath); } catch { /* ignore */ }
                }
                vscode.window.showWarningMessage(
                    'Local replay crashed — this capture cannot be replayed on this GPU. ' +
                    'Basic file info (draw calls, resources, thumbnail) is still available.'
                );
            }
        }
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'RenderDoc: Analyzing capture...',
            cancellable: false
        },
        async (progress) => {
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
                progress.report({ message: 'Loading draw calls...', increment: 33 });
                drawCalls = await bridge.getDrawCalls(filePath);
                drawCallProvider.update(drawCalls);

                progress.report({ message: 'Loading resources...', increment: 33 });
                resources = await bridge.getResources(filePath);
                resourceProvider.update(resources);
            } catch (err: any) {
                replayErr = err;
                drawCallProvider.update([]);
                resourceProvider.update([]);
            }

            // Push whatever we have into an open Inspector
            if (InspectorPanel.currentPanel && captureInfo) {
                InspectorPanel.currentPanel.setCapture(captureInfo, drawCalls, resources);
            }

            // Step 4: Thumbnail — uses renderdoccmd binary, no replay needed.
            try {
                progress.report({ message: 'Loading thumbnail...', increment: 34 });
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
    drawCallProvider.update(drawCalls);
    const resources = await bridge.getResources(info.filePath);
    resourceProvider.update(resources);
    if (InspectorPanel.currentPanel) {
        InspectorPanel.currentPanel.setCapture(captureInfo, drawCalls, resources);
    }
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
                    panelData[stage] = info.source || info.disassembly || '// No source available';
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

    // Check if ANGLE is needed but missing (GLES capture without libEGL.dll)
    const angleStatus = checkAngleAvailability();
    if (!angleStatus.available) {
        const angleSources = findAngleSources();
        if (angleSources) {
            const action = await vscode.window.showWarningMessage(
                'This GLES capture needs ANGLE (libEGL.dll) for local replay, but it is not installed in RenderDoc plugins. ' +
                `Found ANGLE DLLs in: ${angleSources.source}. Install them now?`,
                { modal: true },
                'Install ANGLE',
                'Try Anyway'
            );
            if (action === 'Install ANGLE') {
                const installed = await installAngleDlls(angleSources);
                if (installed) {
                    vscode.window.showInformationMessage('ANGLE installed! The native bridge must be restarted. Restarting...');
                    bridge.restartNativeBridge();
                    if (bridge.hasNativeBridge() && currentCapturePath) {
                        try { await bridge.nativeOpenCapture(currentCapturePath); } catch { /* ignore */ }
                    }
                }
            } else if (action !== 'Try Anyway') {
                return;
            }
        } else {
            const action = await vscode.window.showWarningMessage(
                'This GLES capture needs ANGLE (libEGL.dll + libGLESv2.dll) for desktop replay. ' +
                'ANGLE was not found on this system. Install Google Chrome or copy ANGLE DLLs to:\n' +
                `${angleStatus.targetDir}`,
                { modal: true },
                'Try Anyway'
            );
            if (action !== 'Try Anyway') { return; }
        }
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
