import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RenderDocBridge } from './renderdocBridge';
import { CaptureInfoProvider } from './views/captureInfoProvider';
import { DrawCallProvider } from './views/drawCallProvider';
import { ResourceProvider } from './views/resourceProvider';
import { ThumbnailPanel } from './views/thumbnailPanel';
import { InspectorPanel } from './views/inspectorPanel';
import { initTools, registerAllTools } from './copilot/tools';
import { initChatParticipant, registerChatParticipant } from './copilot/chatParticipant';
import { ensureNativeBridge } from './bridgeInstaller';

let bridge: RenderDocBridge;
let captureInfoProvider: CaptureInfoProvider;
let drawCallProvider: DrawCallProvider;
let resourceProvider: ResourceProvider;
let currentCapturePath: string | undefined;

// ── Selection tracking (for Copilot context) ──
let currentSelectedDrawCall: any | undefined;
let currentSelectedResource: any | undefined;

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

    // Open in native bridge if available
    let nativeResult: any;
    if (bridge.hasNativeBridge()) {
        try {
            nativeResult = await bridge.nativeOpenCapture(filePath);
            console.log('[RenderDoc] nativeOpenCapture result:', JSON.stringify(nativeResult));
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

    // Silent auto-restore: try local replay automatically (best-effort) so
    // shader/pipeline tabs actually have data. Users never clicked the modal.
    if (silent && nativeResult && nativeResult.canTryReplay && !nativeResult.replay) {
        try {
            const tryResult = await bridge.nativeTryReplay();
            if (tryResult && tryResult.replay) {
                captureInfoProvider.setReplayStatus('active');
            } else {
                captureInfoProvider.setReplayStatus('failed');
            }
        } catch (err: any) {
            console.warn('[RenderDoc] silent tryReplay crashed:', err?.message);
            captureInfoProvider.setReplayStatus('failed');
            bridge.restartNativeBridge();
            if (bridge.hasNativeBridge()) {
                try { await bridge.nativeOpenCapture(filePath); } catch { /* ignore */ }
            }
        }
    }

    // If the capture is from a different OS (SuggestRemote), show a modal dialog
    if (!silent && nativeResult && nativeResult.canTryReplay && !nativeResult.replay) {
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
            try {
                // Step 1: Get capture info
                progress.report({ message: 'Reading capture info...', increment: 0 });
                const captureInfo = await bridge.getCaptureInfo(filePath);
                captureInfoProvider.update(captureInfo);

                // Step 2: Get draw calls
                progress.report({ message: 'Loading draw calls...', increment: 33 });
                const drawCalls = await bridge.getDrawCalls(filePath);
                drawCallProvider.update(drawCalls);

                // Step 3: Get resources
                progress.report({ message: 'Loading resources...', increment: 33 });
                const resources = await bridge.getResources(filePath);
                resourceProvider.update(resources);

                // Push data into Inspector (if it's open) — user-controlled via command
                if (InspectorPanel.currentPanel) {
                    InspectorPanel.currentPanel.setCapture(captureInfo, drawCalls, resources);
                }

                // Step 4: Show thumbnail
                progress.report({ message: 'Loading thumbnail...', increment: 34 });
                const thumbnail = await bridge.getThumbnail(filePath);
                if (thumbnail && !silent) {
                    ThumbnailPanel.createOrShow(context, thumbnail, captureInfo);
                }

                if (!silent) {
                    vscode.window.showInformationMessage(`RenderDoc: Loaded ${filePath}`);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`RenderDoc: Failed to load capture - ${err.message}`);
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

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Loading shader source...' },
        async () => {
            try {
                if (bridge.hasNativeBridge() && eventId !== undefined) {
                    const result = await bridge.nativeGetShaderSource(eventId);
                    if (result && result.shaders && Object.keys(result.shaders).length > 0) {
                        // Convert new format {shaders: {vertex: {source:...}, fragment: {source:...}}}
                        // to the format showShaderPanel expects {vertex: "source", fragment: "source"}
                        const panelData: Record<string, string> = {};
                        for (const [stage, info] of Object.entries(result.shaders) as [string, any][]) {
                            panelData[stage] = info.source || info.disassembly || '// No source available';
                        }
                        showShaderPanel(context, panelData, eventId);
                        return;
                    }
                }
                // Fallback: extract shaders from XML
                const shaders = await bridge.getShaderSourcesFromXml(currentCapturePath!);
                if (shaders.length === 0) {
                    vscode.window.showInformationMessage('No shader sources found in this capture. Local replay may not be supported.');
                    return;
                }
                // Show as a quick-pick then open in editor
                if (shaders.length === 1) {
                    const doc = await vscode.workspace.openTextDocument({ content: shaders[0].source, language: 'glsl' });
                    await vscode.window.showTextDocument(doc);
                } else {
                    const pick = await vscode.window.showQuickPick(
                        shaders.map((s, i) => ({ label: s.name, index: i })),
                        { placeHolder: 'Select shader to view' }
                    );
                    if (pick) {
                        const doc = await vscode.workspace.openTextDocument({ content: shaders[pick.index].source, language: 'glsl' });
                        await vscode.window.showTextDocument(doc);
                    }
                }
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

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Extracting all shaders...' },
        async () => {
            try {
                const shaders = await bridge.getShaderSourcesFromXml(currentCapturePath!);
                if (shaders.length === 0) {
                    vscode.window.showInformationMessage('No shader sources found in this capture file.');
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

// ── ANGLE (libEGL) detection and installation helpers ──────────────────────

function getRenderDocDir(): string {
    const config = vscode.workspace.getConfiguration('renderdoc');
    const configuredPath = config.get<string>('installPath');
    if (configuredPath) { return configuredPath; }
    // Default Windows path
    return path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'RenderDoc');
}

function checkAngleAvailability(): { available: boolean; targetDir: string } {
    const rdcDir = getRenderDocDir();
    const pluginDir = path.join(rdcDir, 'plugins', 'gles');
    const eglPath = path.join(pluginDir, 'libEGL.dll');
    const glesPath = path.join(pluginDir, 'libGLESv2.dll');
    return {
        available: fs.existsSync(eglPath) && fs.existsSync(glesPath),
        targetDir: pluginDir,
    };
}

function findAngleSources(): { egl: string; gles: string; source: string } | null {
    // Search for ANGLE DLLs in common locations
    const candidates: Array<{ dir: string; source: string }> = [];

    // Chrome
    const chromeDirs = [
        path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application'),
    ];
    for (const chromeBase of chromeDirs) {
        try {
            if (!fs.existsSync(chromeBase)) { continue; }
            const entries = fs.readdirSync(chromeBase).filter(e => /^\d+\./.test(e)).sort().reverse();
            for (const ver of entries) {
                const dir = path.join(chromeBase, ver);
                candidates.push({ dir, source: `Chrome ${ver}` });
            }
        } catch { /* ignore */ }
    }

    // Edge
    const edgeDirs = [
        path.join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application'),
    ];
    for (const edgeBase of edgeDirs) {
        try {
            if (!fs.existsSync(edgeBase)) { continue; }
            const entries = fs.readdirSync(edgeBase).filter(e => /^\d+\./.test(e)).sort().reverse();
            for (const ver of entries) {
                const dir = path.join(edgeBase, ver);
                candidates.push({ dir, source: `Edge ${ver}` });
            }
        } catch { /* ignore */ }
    }

    for (const { dir, source } of candidates) {
        const egl = path.join(dir, 'libEGL.dll');
        const gles = path.join(dir, 'libGLESv2.dll');
        if (fs.existsSync(egl) && fs.existsSync(gles)) {
            return { egl, gles, source };
        }
    }
    return null;
}

async function installAngleDlls(sources: { egl: string; gles: string; source: string }): Promise<boolean> {
    const { targetDir } = checkAngleAvailability();
    try {
        // Try direct copy first (may fail without admin)
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.copyFileSync(sources.egl, path.join(targetDir, 'libEGL.dll'));
        fs.copyFileSync(sources.gles, path.join(targetDir, 'libGLESv2.dll'));
        return true;
    } catch {
        // Need admin elevation on Windows
        if (process.platform === 'win32') {
            try {
                const cp = await import('child_process');
                const psCmd = `New-Item '${targetDir}' -ItemType Directory -Force | Out-Null; ` +
                    `Copy-Item '${sources.egl}' '${path.join(targetDir, 'libEGL.dll')}' -Force; ` +
                    `Copy-Item '${sources.gles}' '${path.join(targetDir, 'libGLESv2.dll')}' -Force`;
                cp.execSync(`powershell -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command',\\"${psCmd.replace(/"/g, '`"')}\\""`, { timeout: 30000 });
                // Verify
                return fs.existsSync(path.join(targetDir, 'libEGL.dll')) && fs.existsSync(path.join(targetDir, 'libGLESv2.dll'));
            } catch (adminErr: any) {
                vscode.window.showErrorMessage(`Failed to install ANGLE (admin privileges required): ${adminErr.message}`);
                return false;
            }
        }
        return false;
    }
}

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
    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage('Native bridge not available.');
        return;
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
            'Shader sources can still be viewed via XML extraction (View All Shaders).'
        );
    }
}

function showShaderPanel(context: vscode.ExtensionContext, result: any, eventId: number) {
    const panel = vscode.window.createWebviewPanel(
        'renderdoc-shader',
        `Shader @ EID ${eventId}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const stages: Array<{ name: string; source: string }> = [];
    for (const [stage, src] of Object.entries(result)) {
        if (typeof src === 'string' && src.trim().length > 0) {
            stages.push({ name: stage, source: src });
        }
    }

    const tabs = stages.map((s, i) =>
        `<button class="tab${i === 0 ? ' active' : ''}" onclick="showTab(${i})">${escapeHtml(s.name)}</button>`
    ).join('');
    const contents = stages.map((s, i) =>
        `<pre class="tabcontent" id="tab${i}" style="${i === 0 ? '' : 'display:none'}">${escapeHtml(s.source)}</pre>`
    ).join('');

    panel.webview.html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); padding: 8px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 8px; }
  .tab { padding: 6px 16px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background);
         color: var(--vscode-foreground); cursor: pointer; border-radius: 4px 4px 0 0; }
  .tab.active { background: var(--vscode-editor-selectionBackground); font-weight: bold; }
  pre { background: var(--vscode-editor-background); padding: 12px; overflow: auto;
        border: 1px solid var(--vscode-panel-border); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; }
</style></head><body>
  <div class="tabs">${tabs}</div>
  ${contents}
  <script>
    function showTab(idx) {
      document.querySelectorAll('.tabcontent').forEach((el, i) => el.style.display = i === idx ? '' : 'none');
      document.querySelectorAll('.tab').forEach((el, i) => el.className = i === idx ? 'tab active' : 'tab');
    }
  </script>
</body></html>`;
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

function getPipelineStateHtml(state: any, eventId: number): string {
    const json = JSON.stringify(state, null, 2);
    // Build a structured view for known keys
    let sections = '';
    if (typeof state === 'object' && state !== null) {
        for (const [key, value] of Object.entries(state)) {
            const content = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
            sections += `<details open><summary>${escapeHtml(key)}</summary><pre>${escapeHtml(content)}</pre></details>`;
        }
    } else {
        sections = `<pre>${escapeHtml(json)}</pre>`;
    }
    return `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  details { margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  summary { cursor: pointer; padding: 8px; background: var(--vscode-editor-selectionBackground); font-weight: bold; }
  pre { padding: 8px 12px; margin: 0; overflow: auto; font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size); white-space: pre-wrap; }
  .header { font-size: 1.2em; margin-bottom: 12px; }
</style></head><body>
  <div class="header">Pipeline State @ Event ${eventId}</div>
  ${sections}
</body></html>`;
}

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

function getTexturePreviewHtml(result: any, resourceId: string): string {
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { margin: 0; padding: 16px; background: var(--vscode-editor-background); display: flex; flex-direction: column; align-items: center; font-family: var(--vscode-font-family); }
  .canvas-wrap {
    background-image: linear-gradient(45deg, #808080 25%, transparent 25%),
                      linear-gradient(-45deg, #808080 25%, transparent 25%),
                      linear-gradient(45deg, transparent 75%, #808080 75%),
                      linear-gradient(-45deg, transparent 75%, #808080 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
    background-color: #c0c0c0;
    display: inline-block;
    border: 1px solid var(--vscode-panel-border);
    line-height: 0;
  }
  canvas { display: block; max-width: 90vw; max-height: 80vh; image-rendering: pixelated; }
  .info { color: var(--vscode-descriptionForeground); margin-top: 8px; font-size: 0.85em; }
  .channel-bar { display: flex; gap: 6px; margin-top: 12px; }
  .channel-btn {
    padding: 4px 14px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    border-radius: 4px; cursor: pointer; font-family: var(--vscode-font-family); font-size: 0.85em;
    font-weight: 600; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  .channel-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .channel-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
</style></head><body>
  <div class="canvas-wrap"><canvas id="texCanvas"></canvas></div>
  <div class="info" id="infoLine">${result.width ?? '?'}x${result.height ?? '?'} &mdash; ${result.texFormat ?? ''} &mdash; Resource ID: ${resourceId}</div>
  <div class="channel-bar">
    <button class="channel-btn active" data-ch="rgb">RGB</button>
    <button class="channel-btn" data-ch="r">R</button>
    <button class="channel-btn" data-ch="g">G</button>
    <button class="channel-btn" data-ch="b">B</button>
    <button class="channel-btn" data-ch="a">A</button>
  </div>
  <script>
  (function(){
    var canvas = document.getElementById('texCanvas');
    var ctx = canvas.getContext('2d');
    var pixels = null;
    var w = 0, h = 0;

    // Decode PNG base64 → Blob → createImageBitmap with NO premultiply
    var b64 = '${result.base64}';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], { type: 'image/png' });

    createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(function(bmp) {
      w = bmp.width; h = bmp.height;
      canvas.width = w; canvas.height = h;
      // Draw the bitmap and read raw (non-premultiplied) pixel data
      ctx.drawImage(bmp, 0, 0);
      pixels = ctx.getImageData(0, 0, w, h).data;
      showChannel('rgb');
    }).catch(function(err) {
      document.getElementById('infoLine').textContent = 'Failed to decode texture: ' + err.message;
    });

    function showChannel(ch) {
      if (!pixels) return;
      var out = ctx.createImageData(w, h);
      var d = out.data;
      var s = pixels;
      var len = s.length;
      var i, v;
      if (ch === 'rgb') {
        for (i = 0; i < len; i += 4) {
          d[i] = s[i]; d[i+1] = s[i+1]; d[i+2] = s[i+2]; d[i+3] = 255;
        }
      } else if (ch === 'r') {
        for (i = 0; i < len; i += 4) {
          v = s[i]; d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
        }
      } else if (ch === 'g') {
        for (i = 0; i < len; i += 4) {
          v = s[i+1]; d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
        }
      } else if (ch === 'b') {
        for (i = 0; i < len; i += 4) {
          v = s[i+2]; d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
        }
      } else if (ch === 'a') {
        for (i = 0; i < len; i += 4) {
          v = s[i+3]; d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
        }
      }
      ctx.putImageData(out, 0, 0);
    }

    document.querySelectorAll('.channel-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.channel-btn').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        showChannel(btn.getAttribute('data-ch'));
      });
    });
  })();
  </script>
</body></html>`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDrawCallDetailHtml(item: any): string {
    return `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); }
  .header { font-size: 1.2em; margin-bottom: 16px; }
</style></head><body>
  <div class="header">Draw Call #${item.eventId ?? ''}</div>
  <table>
    <tr><th>Name</th><td>${item.label ?? ''}</td></tr>
    <tr><th>Event ID</th><td>${item.eventId ?? ''}</td></tr>
    <tr><th>Draw Index</th><td>${item.drawIndex ?? ''}</td></tr>
    <tr><th>Num Indices</th><td>${item.numIndices ?? ''}</td></tr>
    <tr><th>Num Instances</th><td>${item.numInstances ?? ''}</td></tr>
    <tr><th>Flags</th><td>${item.flags ?? ''}</td></tr>
  </table>
</body></html>`;
}

function getResourceDetailHtml(detail: any): string {
    if (!detail) {
        return '<html><body>No detail available.</body></html>';
    }
    const rows = Object.entries(detail)
        .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
        .join('');
    return `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); width: 200px; }
</style></head><body>
  <table>${rows}</table>
</body></html>`;
}

export function deactivate() {}
