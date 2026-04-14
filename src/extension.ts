import * as vscode from 'vscode';
import { RenderDocBridge } from './renderdocBridge';
import { CaptureInfoProvider } from './views/captureInfoProvider';
import { DrawCallProvider } from './views/drawCallProvider';
import { ResourceProvider } from './views/resourceProvider';
import { ThumbnailPanel } from './views/thumbnailPanel';
import { initTools, registerAllTools } from './copilot/tools';
import { initChatParticipant, registerChatParticipant } from './copilot/chatParticipant';

let bridge: RenderDocBridge;
let captureInfoProvider: CaptureInfoProvider;
let drawCallProvider: DrawCallProvider;
let resourceProvider: ResourceProvider;
let currentCapturePath: string | undefined;

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

    // Register TreeView providers
    captureInfoProvider = new CaptureInfoProvider();
    drawCallProvider = new DrawCallProvider();
    resourceProvider = new ResourceProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('renderdoc-captureInfo', captureInfoProvider),
        vscode.window.registerTreeDataProvider('renderdoc-drawCalls', drawCallProvider),
        vscode.window.registerTreeDataProvider('renderdoc-resources', resourceProvider)
    );

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
        vscode.commands.registerCommand('renderdoc.tryLocalReplay', () => tryLocalReplay())
    );

    // ── Copilot integration ──────────────────────────────────────────
    const getCapturePath = () => currentCapturePath;
    initTools(bridge, getCapturePath);
    initChatParticipant(bridge, getCapturePath);
    registerAllTools(context);
    registerChatParticipant(context);

    // Update status bar
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.text = available ? '$(device-camera) RenderDoc: Ready' : '$(warning) RenderDoc: Not Found';
    statusBarItem.tooltip = 'RenderDoc for VS Code';
    statusBarItem.command = 'renderdoc.openCapture';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
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

async function loadCapture(context: vscode.ExtensionContext, filePath: string) {
    currentCapturePath = filePath;
    console.log('[RenderDoc] loadCapture called:', filePath);
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

    // If the capture is from a different OS (SuggestRemote), show a modal dialog
    if (nativeResult && nativeResult.canTryReplay && !nativeResult.replay) {
        const action = await vscode.window.showWarningMessage(
            nativeResult.replayMessage || 'This capture was made on a different OS. Local replay may be unstable.',
            { modal: true },
            'Try Local Replay',
            'Skip Replay'
        );
        if (action === 'Try Local Replay') {
            try {
                const tryResult = await bridge.nativeTryReplay();
                if (tryResult && tryResult.replay) {
                    vscode.window.showInformationMessage('Local replay started successfully! Shader/pipeline/texture features are now available.');
                } else {
                    vscode.window.showWarningMessage(`Replay failed: ${tryResult?.replayError || 'Unknown error'}`);
                }
            } catch (err: any) {
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

                // Step 4: Show thumbnail
                progress.report({ message: 'Loading thumbnail...', increment: 34 });
                const thumbnail = await bridge.getThumbnail(filePath);
                if (thumbnail) {
                    ThumbnailPanel.createOrShow(context, thumbnail, captureInfo);
                }

                vscode.window.showInformationMessage(`RenderDoc: Loaded ${filePath}`);
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
    const panel = vscode.window.createWebviewPanel(
        'renderdoc-drawcall',
        `Draw Call: ${item.label}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel.webview.html = getDrawCallDetailHtml(item);
}

async function showResourceDetails(context: vscode.ExtensionContext, item: any) {
    if (!item) { return; }
    const info = captureInfoProvider.getCaptureInfo();
    if (!info) { return; }

    const detail = await bridge.getResourceDetail(info.filePath, item.resourceId);
    const panel = vscode.window.createWebviewPanel(
        'renderdoc-resource',
        `Resource: ${item.label}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel.webview.html = getResourceDetailHtml(detail);
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
                    if (result && (result.vertex || result.fragment || result.compute || result.source)) {
                        showShaderPanel(context, result, eventId);
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

async function tryLocalReplay() {
    if (!currentCapturePath) {
        vscode.window.showWarningMessage('No capture file loaded.');
        return;
    }
    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage('Native bridge not available.');
        return;
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
            vscode.window.showInformationMessage('Local replay active! Shader/pipeline/texture features are now available.');
        } else {
            vscode.window.showWarningMessage(`Replay failed: ${result?.replayError || 'Unknown error'}`);
        }
    } catch (err: any) {
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
                const result = await bridge.nativeGetTextureData(resourceId);
                if (result && result.base64) {
                    const panel = vscode.window.createWebviewPanel(
                        'renderdoc-texture',
                        `Texture ${resourceId}`,
                        vscode.ViewColumn.One,
                        { enableScripts: true }
                    );
                    const fmt = result.format || 'png';
                    panel.webview.html = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; padding: 16px; background: var(--vscode-editor-background); display: flex; flex-direction: column; align-items: center; }
  img { max-width: 100%; border: 1px solid var(--vscode-panel-border); image-rendering: pixelated; }
  .info { color: var(--vscode-descriptionForeground); margin-top: 8px; font-family: var(--vscode-font-family); }
</style></head><body>
  <img src="data:image/${fmt};base64,${result.base64}" />
  <div class="info">${result.width ?? '?'}x${result.height ?? '?'} — Resource ID: ${resourceId}</div>
</body></html>`;
                } else {
                    vscode.window.showWarningMessage('No texture data returned. The capture may not support local replay.');
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to preview texture: ${err.message}`);
            }
        }
    );
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
