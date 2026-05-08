import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RenderDocBridge } from './renderdocBridge';
import {
    AttachCaptureOptions,
    CaptureAttachTarget,
    CaptureInfo,
    CaptureLaunchTarget,
    DrawCall,
    LiveTargetInfo,
    LaunchCaptureOptions,
    LaunchCaptureResult,
    ResourceInfo,
    TriggerCaptureOptions,
} from './types';
import { LaunchTargetState } from './launchTargetState';
import { CaptureInfoProvider } from './views/captureInfoProvider';
import { DrawCallProvider } from './views/drawCallProvider';
import { ApiInspectorProvider } from './views/apiInspectorProvider';
import { LaunchTargetViewProvider } from './views/launchTargetView';
import { LaunchApplicationPanel, type LaunchFormState } from './views/launchApplicationPanel';
import { CaptureResultPanel } from './views/captureResultPanel';
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
    getResourceDetailHtml,
} from './views/panelHtml';

let bridge: RenderDocBridge;
let captureCache: CaptureCache;
let captureInfoProvider: CaptureInfoProvider;
let drawCallProvider: DrawCallProvider;
let apiInspectorProvider: ApiInspectorProvider;
let resourceProvider: ResourceProvider;
let launchTargetState: LaunchTargetState;
let currentCapturePath: string | undefined;

// ── Selection tracking (for Copilot context) ──
let currentSelectedDrawCall: any | undefined;
let currentSelectedResource: any | undefined;
let currentDrawCalls: DrawCall[] = [];
let currentResources: ResourceInfo[] = [];
let shaderAliasScanGeneration = 0;

const REPLAYABLE_DRAW_FLAGS = new Set([
    'Drawcall',
    'Dispatch',
    'Clear',
    'Copy',
    'Resolve',
    'GenMips',
    'Present',
]);

function findDrawCallByEventId(eventId: number, list: DrawCall[] = currentDrawCalls): DrawCall | undefined {
    for (const drawCall of list) {
        if (drawCall.eventId === eventId) {
            return drawCall;
        }
        if (drawCall.children?.length) {
            const found = findDrawCallByEventId(eventId, drawCall.children);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

async function recoverReplayForCurrentCapture(reason: string): Promise<boolean> {
    if (!currentCapturePath || !captureInfoProvider) {
        return false;
    }
    if (captureInfoProvider.getReplayStatus() !== 'active') {
        return false;
    }
    if (!bridge.isNativeBridgeInstalled()) {
        return false;
    }

    console.log('[RenderDoc] Recovering replay for current capture due to', reason);

    if (!bridge.hasNativeBridge()) {
        bridge.tryStartNativeBridge();
    }
    if (!bridge.hasNativeBridge()) {
        return false;
    }

    await syncReplayHostSelection();

    try {
        await bridge.nativeOpenCapture(currentCapturePath);
        bridgeLoadedCapturePath = currentCapturePath;
    } catch (error: any) {
        console.warn('[RenderDoc] Replay recovery openCapture failed:', error?.message ?? String(error));
        return false;
    }

    try {
        const result = await bridge.nativeTryReplay();
        if (result?.replay) {
            captureInfoProvider.setReplayStatus('active');
            InspectorPanel.currentPanel?.invalidateReplayCaches();
            return true;
        }
        captureInfoProvider.setReplayStatus('failed');
        console.warn('[RenderDoc] Replay recovery tryReplay failed:', result?.replayError || 'Unknown error');
        return false;
    } catch (error: any) {
        captureInfoProvider.setReplayStatus('failed');
        console.warn('[RenderDoc] Replay recovery crashed:', error?.message ?? String(error));
        return false;
    }
}

function isReplayableDrawCall(drawCall: DrawCall | undefined): boolean {
    if (!drawCall) {
        return false;
    }
    return REPLAYABLE_DRAW_FLAGS.has(drawCall.flags || '');
}

function findFirstReplayableDraw(list: DrawCall[]): DrawCall | undefined {
    for (const drawCall of list) {
        if (isReplayableDrawCall(drawCall)) {
            return drawCall;
        }
        if (drawCall.children?.length) {
            const found = findFirstReplayableDraw(drawCall.children);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

function normalizeSelectedDrawCall(drawCall: DrawCall | undefined): DrawCall | undefined {
    if (!drawCall) {
        return undefined;
    }
    if (isReplayableDrawCall(drawCall)) {
        return drawCall;
    }
    if (drawCall.children?.length) {
        return findFirstReplayableDraw(drawCall.children) ?? drawCall;
    }
    return drawCall;
}

type ExclusiveRenderDocPanel = 'thumbnail' | 'inspector' | 'captureResult';

function closeExclusiveRenderDocPanels(active: ExclusiveRenderDocPanel) {
    if (active !== 'thumbnail' && ThumbnailPanel.currentPanel) {
        ThumbnailPanel.currentPanel.dispose();
    }
    if (active !== 'inspector' && InspectorPanel.currentPanel) {
        InspectorPanel.currentPanel.disposePanel();
    }
    if (active !== 'captureResult') {
        CaptureResultPanel.closeCurrent();
    }
}

// Path of the capture currently known to the native bridge process.
// Used to force-restart the bridge before loading a different capture,
// because some backends (GL/ANGLE) crash when a second capture is opened
// in the same process after a prior replay was torn down.
let bridgeLoadedCapturePath: string | undefined;

function getPreferredReplayHostUrl(): string | undefined {
    const selected = launchTargetState.getSelected();
    return selected.kind === 'device' ? selected.url : undefined;
}

async function syncReplayHostSelection(silent = true): Promise<string | undefined> {
    if (!bridge.isNativeBridgeInstalled()) {
        return undefined;
    }

    const desiredUrl = getPreferredReplayHostUrl();

    try {
        const currentHost = await bridge.nativeGetReplayHost();
        if (!desiredUrl) {
            if (currentHost.connected) {
                await bridge.nativeDisconnectReplayHost();
                console.log('[RenderDoc] Cleared remote replay host selection.');
            }
            return undefined;
        }

        if (!currentHost.connected || currentHost.url !== desiredUrl) {
            const connected = await bridge.nativeSetReplayHost(desiredUrl);
            console.log('[RenderDoc] Remote replay host ready:', JSON.stringify(connected));
            if (!connected.connected) {
                if (!silent) {
                    vscode.window.showWarningMessage(
                        `RenderDoc: the selected device did not accept a remote replay connection. Falling back to local replay.`
                    );
                }
                return undefined;
            }
        }

        return desiredUrl;
    } catch (error: any) {
        console.warn('[RenderDoc] Failed to sync remote replay host:', error?.message ?? String(error));
        if (!silent) {
            vscode.window.showWarningMessage(
                `RenderDoc: failed to connect the selected remote replay host. Falling back to local replay. ` +
                `(${error?.message ?? String(error)})`
            );
        }
        return undefined;
    }
}

const LAST_LAUNCH_CAPTURE_STATE_KEY = 'renderdoc.lastLaunchCaptureState';
const LAST_ATTACH_CAPTURE_STATE_KEY = 'renderdoc.lastAttachCaptureState';
const SAVED_CAPTURE_PATHS_KEY = 'renderdoc.savedCapturePaths';

type StoredLaunchCaptureState = {
    targetKind?: 'local' | 'device';
    targetUrl?: string;
    executable?: string;
    workingDir?: string;
    cmdLine?: string;
};

type StoredAttachCaptureState = {
    mode?: 'local' | 'remote';
    targetUrl?: string;
    processName?: string;
    pid?: number;
};

const LAST_TRIGGER_CAPTURE_STATE_KEY = 'renderdoc.lastTriggerCaptureState';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadReplayDataWithRetry(
    filePath: string,
    token?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<{ drawCalls: DrawCall[]; resources: ResourceInfo[] }> {
    const maxAttempts = 4;
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (token?.isCancellationRequested) {
            throw new Error('Capture loading cancelled.');
        }

        try {
            const drawCalls = await bridge.getDrawCalls(filePath);
            const resources = await bridge.getResources(filePath);

            // A newly opened replay can transiently report an empty action tree.
            // Give it a couple of short retries before surfacing an empty EventBrowser.
            if (drawCalls.length > 0 || attempt === maxAttempts) {
                return { drawCalls, resources };
            }

            lastError = new Error('Replay returned no draw calls yet.');
        } catch (err: any) {
            lastError = err;
        }

        if (attempt < maxAttempts) {
            progress?.report({ message: `Waiting for replay data... (${attempt + 1}/${maxAttempts})` });
            await delay(250 * attempt);
        }
    }

    throw lastError || new Error('Failed to load replay data.');
}

type CaptureTriggerOptions = {
    trigger: 'immediate' | 'frame' | 'delay';
    frameNumber?: number;
    delaySeconds?: number;
};

type LocalProcessInfo = {
    pid: number;
    processName: string;
    path?: string;
};

function execFileText(file: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr?.trim() || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

function isAndroidLikeTarget(target: CaptureLaunchTarget): boolean {
    const probe = `${target.protocol} ${target.url} ${target.id} ${target.name}`.toLowerCase();
    return probe.includes('adb') || probe.includes('android');
}

async function findAdbExecutable(): Promise<string | undefined> {
    try {
        await execFileText('adb', ['version']);
        return 'adb';
    } catch {
        // fall through
    }

    try {
        if (process.platform === 'win32') {
            const out = await execFileText('where.exe', ['adb']);
            const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
            return first || undefined;
        }
        const out = await execFileText('which', ['adb']);
        const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        return first || undefined;
    } catch {
        return undefined;
    }
}

async function listAndroidPackages(adbPath: string, serial: string): Promise<string[]> {
    const args = serial ? ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'] : ['shell', 'pm', 'list', 'packages', '-3'];
    const out = await execFileText(adbPath, args);
    return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^package:/, '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

async function resolveAndroidLaunchActivity(adbPath: string, serial: string, packageName: string): Promise<string | undefined> {
    const args = serial
        ? ['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName]
        : ['shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName];
    const out = await execFileText(adbPath, args);
    const lines = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const activityLine = [...lines].reverse().find((line) => line.includes('/'));
    return activityLine || undefined;
}

async function chooseAndroidPackageActivity(target: CaptureLaunchTarget, initialValue = ''): Promise<string | undefined> {
    const mode = await vscode.window.showQuickPick([
        {
            label: 'Browse Installed Packages',
            description: 'Use adb to choose an installed package and resolve its launcher activity',
            value: 'browse' as const,
        },
        {
            label: 'Manual Entry',
            description: 'Type package/activity yourself',
            value: 'manual' as const,
        },
    ], {
        title: 'Android Target',
        placeHolder: 'Choose how to specify the Android launch target',
    });

    if (!mode) {
        return undefined;
    }

    if (mode.value === 'manual') {
        return await vscode.window.showInputBox({
            title: 'Android Package / Activity',
            prompt: 'Package and activity to launch on the device',
            placeHolder: 'com.example.game/.MainActivity',
            value: initialValue,
            validateInput: (input) => input.trim() ? undefined : 'Enter a package/activity.',
        });
    }

    const adbPath = await findAdbExecutable();
    if (!adbPath) {
        vscode.window.showWarningMessage('adb was not found on PATH. Falling back to manual Android target entry.');
        return await vscode.window.showInputBox({
            title: 'Android Package / Activity',
            prompt: 'Package and activity to launch on the device',
            placeHolder: 'com.example.game/.MainActivity',
            value: initialValue,
            validateInput: (input) => input.trim() ? undefined : 'Enter a package/activity.',
        });
    }

    try {
        const packages = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'RenderDoc — Enumerating Android Packages',
                cancellable: false,
            },
            async () => listAndroidPackages(adbPath, target.id),
        );

        if (packages.length === 0) {
            vscode.window.showWarningMessage('No launchable third-party Android packages were found.');
            return await vscode.window.showInputBox({
                title: 'Android Package / Activity',
                prompt: 'Package and activity to launch on the device',
                placeHolder: 'com.example.game/.MainActivity',
                value: initialValue,
                validateInput: (input) => input.trim() ? undefined : 'Enter a package/activity.',
            });
        }

        const pickedPackage = await vscode.window.showQuickPick(
            packages.map((pkg) => ({ label: pkg, description: target.name || target.id })),
            {
                title: 'Android Package',
                placeHolder: 'Choose the package to launch',
            },
        );
        if (!pickedPackage) {
            return undefined;
        }

        let resolved = '';
        try {
            resolved = (await resolveAndroidLaunchActivity(adbPath, target.id, pickedPackage.label)) || '';
        } catch (err: any) {
            console.warn('[RenderDoc] resolveAndroidLaunchActivity failed:', err?.message);
        }

        if (resolved) {
            return resolved;
        }

        const manualActivity = await vscode.window.showInputBox({
            title: 'Android Activity',
            prompt: 'Launcher activity could not be resolved automatically. Enter the activity name to launch.',
            placeHolder: '.MainActivity',
            value: `${pickedPackage.label}/`,
            validateInput: (input) => input.trim().includes('/') ? undefined : 'Enter package/activity.',
        });
        return manualActivity;
    } catch (err: any) {
        vscode.window.showWarningMessage(`adb package enumeration failed: ${err?.message || err}`);
        return await vscode.window.showInputBox({
            title: 'Android Package / Activity',
            prompt: 'Package and activity to launch on the device',
            placeHolder: 'com.example.game/.MainActivity',
            value: initialValue,
            validateInput: (input) => input.trim() ? undefined : 'Enter a package/activity.',
        });
    }
}

async function listLocalProcesses(): Promise<LocalProcessInfo[]> {
    if (process.platform !== 'win32') {
        return [];
    }

    const script = [
        'Get-Process',
        '| Sort-Object ProcessName, Id',
        '| Select-Object Id, ProcessName, Path',
        '| ConvertTo-Json -Depth 2',
    ].join(' ');
    const out = await execFileText('powershell.exe', ['-NoProfile', '-Command', script]);
    const parsed = JSON.parse(out || '[]');
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
        .map((item: any) => ({
            pid: Number(item?.Id || 0),
            processName: String(item?.ProcessName || '').trim(),
            path: typeof item?.Path === 'string' ? item.Path.trim() : undefined,
        }))
        .filter((item) => item.pid > 0 && item.processName);
}

async function promptForCaptureTrigger(initial?: {
    trigger?: 'immediate' | 'frame' | 'delay';
    frameNumber?: number;
    delaySeconds?: number;
}): Promise<CaptureTriggerOptions | undefined> {
    const triggerPick = await vscode.window.showQuickPick([
        {
            label: 'Capture Immediately',
            description: 'Trigger a capture right after the target control connection is established',
            value: 'immediate' as const,
        },
        {
            label: 'Capture On Frame Number',
            description: 'Queue a capture for a specific frame',
            value: 'frame' as const,
        },
        {
            label: 'Capture After Delay',
            description: 'Wait a few seconds after launch or attach, then trigger a capture',
            value: 'delay' as const,
        },
    ], {
        title: 'Capture Trigger',
        placeHolder: 'Choose when the frame capture should happen',
    });
    if (!triggerPick) {
        return undefined;
    }

    let frameNumber = initial?.frameNumber || 1;
    let delaySeconds = initial?.delaySeconds || 3;
    if (triggerPick.value === 'frame') {
        const value = await promptForPositiveNumber('Capture on which frame number?', '1', frameNumber, true);
        if (value === undefined) {
            return undefined;
        }
        frameNumber = value;
    } else if (triggerPick.value === 'delay') {
        const value = await promptForPositiveNumber('How many seconds after launch should capture trigger?', '3', delaySeconds, false);
        if (value === undefined) {
            return undefined;
        }
        delaySeconds = value;
    }

    return {
        trigger: triggerPick.value,
        frameNumber,
        delaySeconds,
    };
}

async function promptForCaptureOutputDir(executable: string, storedDir?: string): Promise<string | undefined> {
    const outputDir = await vscode.window.showInputBox({
        title: 'Capture Output Directory',
        prompt: 'Directory where the captured .rdc file should be stored locally',
        value: getDefaultCaptureOutputDir(executable, storedDir),
        validateInput: (input) => input.trim() ? undefined : 'Enter a directory path.',
    });
    if (outputDir === undefined) {
        return undefined;
    }
    await fs.promises.mkdir(outputDir, { recursive: true });
    return outputDir;
}

function getLiveCaptureTempDir(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'live-captures');
}

function buildLiveCaptureTemplate(baseDir: string, stemSource: string): string {
    return path.join(baseDir, `${buildCaptureStem(stemSource)}_${Date.now()}`);
}

async function getSavedCapturePaths(context: vscode.ExtensionContext): Promise<string[]> {
    const saved = context.globalState.get<string[]>(SAVED_CAPTURE_PATHS_KEY) || [];
    const existing: string[] = [];
    for (const filePath of saved) {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            existing.push(filePath);
        } catch {
            // Skip missing files.
        }
    }
    if (existing.length !== saved.length) {
        await context.globalState.update(SAVED_CAPTURE_PATHS_KEY, existing);
    }
    return existing;
}

async function rememberSavedCapturePath(context: vscode.ExtensionContext, filePath: string): Promise<void> {
    const saved = await getSavedCapturePaths(context);
    if (!saved.includes(filePath)) {
        saved.push(filePath);
        await context.globalState.update(SAVED_CAPTURE_PATHS_KEY, saved);
    }
}

async function forgetSavedCapturePaths(context: vscode.ExtensionContext, filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
        return;
    }
    const removeSet = new Set(filePaths.map((filePath) => path.normalize(filePath)));
    const saved = context.globalState.get<string[]>(SAVED_CAPTURE_PATHS_KEY) || [];
    const next = saved.filter((filePath) => !removeSet.has(path.normalize(filePath)));
    await context.globalState.update(SAVED_CAPTURE_PATHS_KEY, next);
}

async function refreshLiveTargetState(): Promise<void> {
    await launchTargetState.refreshLiveTarget(bridge);
    await vscode.commands.executeCommand('setContext', 'renderdoc.liveTargetActive', !!launchTargetState.getLiveTarget());
}

async function promptForCaptureDisposition(context: vscode.ExtensionContext, capturePath: string): Promise<string | undefined> {
    closeExclusiveRenderDocPanels('captureResult');
    const choice = await CaptureResultPanel.show(capturePath);

    if (choice === 'delete') {
        await fs.promises.rm(capturePath, { force: true });
        return undefined;
    }

    if (choice === 'save') {
        const uri = await vscode.window.showSaveDialog({
            title: 'Save Captured Frame',
            defaultUri: vscode.Uri.file(capturePath),
            filters: { 'RenderDoc Capture': ['rdc'] },
        });
        if (!uri) {
            return capturePath;
        }
        await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
        try {
            await fs.promises.rename(capturePath, uri.fsPath);
        } catch {
            await fs.promises.copyFile(capturePath, uri.fsPath);
            await fs.promises.rm(capturePath, { force: true });
        }
        await rememberSavedCapturePath(context, uri.fsPath);
        return uri.fsPath;
    }

    if (choice === 'dismiss') {
        return undefined;
    }

    return capturePath;
}

async function captureFromLiveTarget(context: vscode.ExtensionContext) {
    try {
        const liveTarget = launchTargetState.getLiveTarget();
        if (!liveTarget) {
            vscode.window.showWarningMessage('No live target is connected. Launch or attach first.');
            return;
        }

        const stored = context.workspaceState.get<CaptureTriggerOptions>(LAST_TRIGGER_CAPTURE_STATE_KEY);
        const triggerOptions = await promptForCaptureTrigger(stored);
        if (!triggerOptions) {
            return;
        }

        await context.workspaceState.update(LAST_TRIGGER_CAPTURE_STATE_KEY, triggerOptions);

        const tempDir = getLiveCaptureTempDir(context);
        await fs.promises.mkdir(tempDir, { recursive: true });
        const options: TriggerCaptureOptions = {
            localCopyPath: `${buildLiveCaptureTemplate(tempDir, liveTarget.target || 'capture')}.rdc`,
            ...triggerOptions,
        };

        const result = await runCaptureWithProgress('RenderDoc — Capture Frame', () => bridge.nativeTriggerCapture(options));
        const finalPath = await promptForCaptureDisposition(context, result.capturePath);
        if (finalPath) {
            await loadCapture(context, finalPath);
        }
        await refreshLiveTargetState();
    } catch (err: any) {
        vscode.window.showErrorMessage(`RenderDoc: capture failed - ${err?.message || err}`);
    }
}

async function disconnectLiveTarget() {
    try {
        await bridge.nativeDisconnectLiveTarget();
    } catch (err: any) {
        console.warn('[RenderDoc] disconnectLiveTarget failed:', err?.message);
    }
    await refreshLiveTargetState();
}

async function clearSavedCaptures(context: vscode.ExtensionContext) {
    const savedPaths = await getSavedCapturePaths(context);
    if (savedPaths.length === 0) {
        vscode.window.showInformationMessage('RenderDoc: no saved RDC files are tracked for cleanup.');
        return;
    }

    const picks = await vscode.window.showQuickPick(
        savedPaths.map((filePath) => ({
            label: path.basename(filePath),
            description: path.dirname(filePath),
            detail: filePath,
            filePath,
            picked: true,
        })),
        {
            title: 'Clear Saved RDC Files',
            placeHolder: 'Select the saved RDC files to delete',
            canPickMany: true,
        },
    );

    if (!picks || picks.length === 0) {
        return;
    }

    const filePaths = picks.map((pick) => pick.filePath);
    const confirm = await vscode.window.showWarningMessage(
        `Delete ${filePaths.length} saved RDC file(s)?`,
        { modal: true },
        'Delete',
    );
    if (confirm !== 'Delete') {
        return;
    }

    for (const filePath of filePaths) {
        await fs.promises.rm(filePath, { force: true });
    }
    await forgetSavedCapturePaths(context, filePaths);

    if (currentCapturePath && filePaths.some((filePath) => path.normalize(filePath) === path.normalize(currentCapturePath))) {
        closeCapture();
    }

    vscode.window.showInformationMessage(`RenderDoc: deleted ${filePaths.length} saved RDC file(s).`);
}

async function runCaptureWithProgress<T extends LaunchCaptureResult>(
    title: string,
    action: () => Promise<T>,
): Promise<T> {
    let lastStatusMessage = 'Preparing capture...';
    const unsubscribe = bridge.onNativeNotification('launchCaptureStatus', (params) => {
        if (typeof params?.message === 'string' && params.message.trim()) {
            lastStatusMessage = params.message;
        }
    });

    try {
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: false,
            },
            async (progress) => {
                const updateStatus = bridge.onNativeNotification('launchCaptureStatus', (params) => {
                    if (typeof params?.message === 'string' && params.message.trim()) {
                        progress.report({ message: params.message });
                    }
                });
                try {
                    progress.report({ message: lastStatusMessage });
                    return await action();
                } finally {
                    updateStatus();
                }
            },
        );
    } finally {
        unsubscribe();
    }
}

export async function activate(context: vscode.ExtensionContext) {
    bridge = new RenderDocBridge();
    captureCache = new CaptureCache(context);
    launchTargetState = new LaunchTargetState(context);

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
    const launchTargetViewProvider = new LaunchTargetViewProvider(
        context,
        launchTargetState,
        async () => { await launchTargetState.refresh(bridge); },
    );

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
            const selectedDrawCall = normalizeSelectedDrawCall(item.drawCall)
                ?? normalizeSelectedDrawCall(findDrawCallByEventId(item.eventId));
            currentSelectedDrawCall = selectedDrawCall ?? item.drawCall ?? {
                label: item.label,
                eventId: item.eventId,
            };
            // If the Inspector panel is open, update it to this event
            if (InspectorPanel.currentPanel && typeof currentSelectedDrawCall?.eventId === 'number') {
                InspectorPanel.currentPanel.setEvent(currentSelectedDrawCall.eventId, currentSelectedDrawCall);
            }
            // Populate the sidebar API Inspector with this event's chunks.
            if (typeof currentSelectedDrawCall?.eventId === 'number') {
                const label = currentSelectedDrawCall.name || (typeof item.label === 'string' ? item.label : item.label?.label);
                apiInspectorProvider.setEvent(currentSelectedDrawCall.eventId, label).catch(() => {});
            }
            // Drive the drawcall-overlay panel too, so clicking a draw call
            // reveals its geometry highlight just like RenderDoc desktop.
            if (DrawOverlayPanel.currentPanel && typeof currentSelectedDrawCall?.eventId === 'number') {
                const label = currentSelectedDrawCall.name || (typeof item.label === 'string' ? item.label : item.label?.label);
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
        vscode.window.registerWebviewViewProvider('renderdoc-launchTarget', launchTargetViewProvider),
        launchTargetState.onDidChange(() => {
            void vscode.commands.executeCommand('setContext', 'renderdoc.liveTargetActive', !!launchTargetState.getLiveTarget());
            if (!LaunchApplicationPanel.currentPanel) {
                return;
            }
            const current = launchTargetState.getSelected();
            LaunchApplicationPanel.currentPanel.setTarget(current.kind === 'local'
                ? { kind: 'local' }
                : { kind: 'device', target: launchTargetState.getSelectedTarget() });
            LaunchApplicationPanel.currentPanel.setLiveTarget(launchTargetState.getLiveTarget());
        }),
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

    InspectorPanel.replayRecoveryProvider = async (reason: string) => {
        return recoverReplayForCurrentCapture(reason);
    };

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('renderdoc.openCapture', () => openCapture(context)),
        vscode.commands.registerCommand('renderdoc.launchCapture', () => openLaunchApplication(context)),
        vscode.commands.registerCommand('renderdoc.attachCapture', () => attachProcessAndCapture(context)),
        vscode.commands.registerCommand('renderdoc.triggerCapture', () => captureFromLiveTarget(context)),
        vscode.commands.registerCommand('renderdoc.disconnectLiveTarget', () => disconnectLiveTarget()),
        vscode.commands.registerCommand('renderdoc.clearSavedCaptures', () => clearSavedCaptures(context)),
        vscode.commands.registerCommand('renderdoc.refreshCaptureTargets', async () => {
            await launchTargetState.refresh(bridge);
            await refreshLiveTargetState();
        }),
        vscode.commands.registerCommand('renderdoc.closeCapture', () => closeCapture()),
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

    // Revive Inspector webview panels that VS Code serialized across reloads.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('renderdoc-inspector', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: any) {
                InspectorPanel.revive(panel, context, bridge);
            }
        })
    );

    void launchTargetState.refresh(bridge);
    void refreshLiveTargetState();
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

function getDefaultCaptureOutputDir(executable: string, storedDir?: string): string {
    if (storedDir?.trim()) {
        return storedDir.trim();
    }

    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceDir) {
        return path.join(workspaceDir, '.renderdoc-captures');
    }

    const exeDir = executable ? path.dirname(executable) : '';
    if (exeDir && exeDir !== '.') {
        return path.join(exeDir, 'captures');
    }

    return path.join(process.env.TEMP || process.cwd(), 'renderdoc-captures');
}

function buildCaptureStem(value: string): string {
    const base = (value || 'capture')
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return base || 'capture';
}

async function promptForPositiveNumber(
    prompt: string,
    placeHolder: string,
    initialValue: number,
    integerOnly = false,
): Promise<number | undefined> {
    const value = await vscode.window.showInputBox({
        prompt,
        placeHolder,
        value: String(initialValue),
        validateInput: (input) => {
            const parsed = Number(input);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return 'Enter a value greater than 0.';
            }
            if (integerOnly && !Number.isInteger(parsed)) {
                return 'Enter a whole number.';
            }
            return undefined;
        },
    });

    if (value === undefined) {
        return undefined;
    }

    return Number(value);
}

async function chooseLaunchTarget(deviceTargets: CaptureLaunchTarget[]): Promise<
    | { kind: 'local' }
    | { kind: 'device'; target: CaptureLaunchTarget }
    | undefined
> {
    const items: Array<vscode.QuickPickItem & {
        kindValue: 'local' | 'device';
        target?: CaptureLaunchTarget;
    }> = [];

    if (process.platform === 'win32') {
        items.push({
            label: 'Windows Local',
            description: 'Launch an executable on this machine and capture a frame',
            kindValue: 'local',
        });
    }

    for (const target of deviceTargets) {
        const suffix = target.supported ? '' : 'unsupported by RenderDoc on this device';
        items.push({
            label: target.name || target.id,
            description: target.url,
            detail: suffix || `Protocol: ${target.protocol}`,
            kindValue: 'device',
            target,
        });
    }

    if (items.length === 0) {
        vscode.window.showWarningMessage('No launch targets are available.');
        return undefined;
    }

    const choice = await vscode.window.showQuickPick(items, {
        title: 'Launch And Capture',
        placeHolder: 'Choose where to launch the target program',
    });

    if (!choice) {
        return undefined;
    }

    if (choice.kindValue === 'local') {
        return { kind: 'local' };
    }

    return choice.target ? { kind: 'device', target: choice.target } : undefined;
}

async function collectLaunchCaptureOptions(
    context: vscode.ExtensionContext,
): Promise<LaunchCaptureOptions | undefined> {
    const stored = (context.workspaceState.get<StoredLaunchCaptureState>(LAST_LAUNCH_CAPTURE_STATE_KEY) || {});

    await bridge.ensureNativeBridgeReady();

    let deviceTargets: CaptureLaunchTarget[] = [];
    try {
        deviceTargets = await bridge.nativeListCaptureTargets();
    } catch (err: any) {
        console.warn('[RenderDoc] listCaptureTargets failed:', err?.message);
    }

    const selected = await chooseLaunchTarget(deviceTargets);
    if (!selected) {
        return undefined;
    }

    if (selected.kind === 'device' && !selected.target.supported) {
        const action = await vscode.window.showWarningMessage(
            `RenderDoc reports that ${selected.target.name} may not support capture/replay. Continue anyway?`,
            'Continue',
            'Cancel',
        );
        if (action !== 'Continue') {
            return undefined;
        }
    }

    let executable = '';
    let workingDir = stored.workingDir || '';

    if (selected.kind === 'local') {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: 'Choose Windows Executable To Launch',
            defaultUri: stored.executable ? vscode.Uri.file(stored.executable) : undefined,
            filters: { Executable: ['exe'] },
        });
        if (!uris || uris.length === 0) {
            return undefined;
        }
        executable = uris[0].fsPath;
        const workingDirInput = await vscode.window.showInputBox({
            title: 'Working Directory',
            prompt: 'Working directory for the launched process',
            value: stored.workingDir || path.dirname(executable),
        });
        if (workingDirInput === undefined) {
            return undefined;
        }
        workingDir = workingDirInput;
    } else {
        const remoteTarget = isAndroidLikeTarget(selected.target)
            ? await chooseAndroidPackageActivity(selected.target, stored.executable || '')
            : await vscode.window.showInputBox({
                title: 'Remote Target Identifier',
                prompt: 'Package/activity or other launch identifier understood by the selected device protocol',
                placeHolder: 'com.example.game/.MainActivity',
                value: stored.executable || '',
                validateInput: (input) => input.trim() ? undefined : 'Enter a remote target identifier.',
            });
        if (remoteTarget === undefined) {
            return undefined;
        }
        executable = remoteTarget;
        workingDir = '';
    }

    const cmdLine = await vscode.window.showInputBox({
        title: 'Launch Arguments',
        prompt: 'Command-line arguments passed to the target program',
        placeHolder: '--scene test --width 1920 --height 1080',
        value: stored.cmdLine || '',
    });

    if (cmdLine === undefined) {
        return undefined;
    }

    const outputDir = await promptForCaptureOutputDir(executable, stored.outputDir);
    if (!outputDir) {
        return undefined;
    }

    const triggerOptions = await promptForCaptureTrigger(stored);
    if (!triggerOptions) {
        return undefined;
    }

    const captureStem = buildCaptureStem(executable);
    const captureOptions: LaunchCaptureOptions = {
        url: selected.kind === 'device' ? selected.target.url : '',
        executable,
        workingDir,
        cmdLine,
        captureFileTemplate: path.join(outputDir, captureStem),
        localCopyPath: path.join(outputDir, `${captureStem}_${Date.now()}.rdc`),
        ...triggerOptions,
    };

    await context.workspaceState.update(LAST_LAUNCH_CAPTURE_STATE_KEY, {
        targetKind: selected.kind,
        targetUrl: selected.kind === 'device' ? selected.target.url : '',
        executable,
        workingDir,
        cmdLine,
        outputDir,
        trigger: triggerOptions.trigger,
        frameNumber: triggerOptions.frameNumber,
        delaySeconds: triggerOptions.delaySeconds,
    } satisfies StoredLaunchCaptureState);

    return captureOptions;
}

async function launchProgramAndCapture(context: vscode.ExtensionContext) {
    try {
        const options = await collectLaunchCaptureOptions(context);
        if (!options) {
            return;
        }
        const result = await runCaptureWithProgress('RenderDoc — Launch And Capture', () => bridge.nativeLaunchCapture(options));
        await loadCapture(context, result.capturePath);
        const targetLabel = options.url ? options.url : 'local machine';
        vscode.window.showInformationMessage(
            `RenderDoc: captured frame ${result.frameNumber ?? '?'} from ${result.target || targetLabel}.`
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`RenderDoc: launch and capture failed - ${err?.message || err}`);
    }
}

function getLaunchFormState(context: vscode.ExtensionContext): LaunchFormState {
    const stored = (context.workspaceState.get<StoredLaunchCaptureState>(LAST_LAUNCH_CAPTURE_STATE_KEY) || {});
    return {
        executable: stored.executable || '',
        workingDir: stored.workingDir || '',
        cmdLine: stored.cmdLine || '',
    };
}

async function openLaunchApplication(context: vscode.ExtensionContext) {
    await bridge.ensureNativeBridgeReady();
    const panel = LaunchApplicationPanel.createOrShow(context, getLaunchFormState(context), {
        onLaunch: async (form) => {
            await launchProgramAndCaptureFromForm(context, form);
        },
        onCapture: async () => {
            await captureFromLiveTarget(context);
        },
        onBrowseExecutable: async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: 'Choose Windows Executable To Launch',
                filters: { Executable: ['exe'] },
            });
            return uris?.[0]?.fsPath;
        },
        onBrowseAndroidPackage: async (value) => {
            const selected = launchTargetState.getSelectedTarget();
            if (!selected) {
                vscode.window.showWarningMessage('Select a mobile device in the left Capture Target view first.');
                return undefined;
            }
            return chooseAndroidPackageActivity(selected, value);
        },
    });

    const selected = launchTargetState.getSelected();
    panel.setTarget(selected.kind === 'local'
        ? { kind: 'local' }
        : { kind: 'device', target: launchTargetState.getSelectedTarget() });
    panel.setLiveTarget(launchTargetState.getLiveTarget());

    const current = launchTargetState.getSelected();
    panel.setTarget(current.kind === 'local'
        ? { kind: 'local' }
        : { kind: 'device', target: launchTargetState.getSelectedTarget() });
    panel.setLiveTarget(launchTargetState.getLiveTarget());
}

async function launchProgramAndCaptureFromForm(context: vscode.ExtensionContext, form: LaunchFormState) {
    const selected = launchTargetState.getSelected();
    const selectedTarget = launchTargetState.getSelectedTarget();

    if (!form.executable.trim()) {
        throw new Error(selected.kind === 'local' ? 'Executable path is required.' : 'Package/activity is required.');
    }

    const tempDir = getLiveCaptureTempDir(context);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const options: LaunchCaptureOptions = {
        url: selected.kind === 'device' ? selectedTarget?.url || '' : '',
        executable: form.executable.trim(),
        workingDir: selected.kind === 'local' ? form.workingDir.trim() : '',
        cmdLine: form.cmdLine,
        captureFileTemplate: buildLiveCaptureTemplate(tempDir, form.executable),
    };

    await context.workspaceState.update(LAST_LAUNCH_CAPTURE_STATE_KEY, {
        targetKind: selected.kind === 'local' ? 'local' : 'device',
        targetUrl: selected.kind === 'device' ? selectedTarget?.url || '' : '',
        executable: form.executable.trim(),
        workingDir: selected.kind === 'local' ? form.workingDir.trim() : '',
        cmdLine: form.cmdLine,
    } satisfies StoredLaunchCaptureState);

    const result = await runCaptureWithProgress('RenderDoc — Launch Application', () => bridge.nativeLaunchCapture(options));
    launchTargetState.setLiveTarget(result);
    await refreshLiveTargetState();
    const targetLabel = selected.kind === 'device' ? (result.target || selectedTarget?.name || selectedTarget?.url || 'device') : 'local machine';
    vscode.window.showInformationMessage(`RenderDoc: launched ${targetLabel}. Use Capture when you are ready to grab a frame.`);
}

async function collectAttachCaptureOptions(
    context: vscode.ExtensionContext,
): Promise<AttachCaptureOptions | undefined> {
    const stored = (context.workspaceState.get<StoredAttachCaptureState>(LAST_ATTACH_CAPTURE_STATE_KEY) || {});
    await bridge.ensureNativeBridgeReady();

    const remoteDevices = await bridge.nativeListCaptureTargets().catch((): CaptureLaunchTarget[] => []);
    const source = await vscode.window.showQuickPick([
        process.platform === 'win32'
            ? {
                label: 'Local Windows Process',
                description: 'Inject into an already running process on this machine',
                value: 'local' as const,
            }
            : undefined,
        ...remoteDevices.map((target) => ({
            label: target.name || target.id,
            description: target.url,
            detail: 'Attach to an already running RenderDoc target on this device',
            value: 'remote' as const,
            target,
        })),
    ].filter(Boolean) as Array<(vscode.QuickPickItem & { value: 'local' | 'remote'; target?: CaptureLaunchTarget })>, {
        title: 'Attach And Capture',
        placeHolder: 'Choose a local process or a remote device target',
    });

    if (!source) {
        return undefined;
    }

    let processName = stored.processName || '';
    let pid = stored.pid;
    let url = '';
    let ident: number | undefined;

    if (source.value === 'local') {
        const processes = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'RenderDoc — Enumerating Local Processes',
                cancellable: false,
            },
            async () => listLocalProcesses(),
        );
        const pick = await vscode.window.showQuickPick(
            processes.map((proc) => ({
                label: `${proc.processName} (${proc.pid})`,
                description: proc.path || '',
                proc,
            })),
            {
                title: 'Local Process',
                placeHolder: 'Choose the running process to inject into',
            },
        );
        if (!pick) {
            return undefined;
        }
        processName = pick.proc.processName;
        pid = pick.proc.pid;
    } else {
        url = source.target?.url || '';
        const attachTargets = await runCaptureWithProgress('RenderDoc — Enumerating Remote Targets', async () => {
            const targets = await bridge.nativeListAttachTargets(url);
            return {
                capturePath: '',
                target: '',
                local: true,
                frameNumber: 0,
                api: '',
                targets,
            } as LaunchCaptureResult & { targets: CaptureAttachTarget[] };
        });
        const pick = await vscode.window.showQuickPick(
            attachTargets.targets.map((target) => ({
                label: target.target || `ident ${target.ident}`,
                description: target.api ? `${target.api} · PID ${target.pid}` : `PID ${target.pid}`,
                detail: target.busyClient ? `Busy: ${target.busyClient}` : source.target?.url,
                target,
            })),
            {
                title: 'Remote Running Target',
                placeHolder: 'Choose the already running RenderDoc target to capture',
            },
        );
        if (!pick) {
            return undefined;
        }
        ident = pick.target.ident;
        processName = pick.target.target;
    }

    const tempDir = getLiveCaptureTempDir(context);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const options: AttachCaptureOptions = {
        url,
        ident,
        pid,
        processName,
        captureFileTemplate: buildLiveCaptureTemplate(tempDir, processName || `pid_${pid || ident || 'target'}`),
    };

    await context.workspaceState.update(LAST_ATTACH_CAPTURE_STATE_KEY, {
        mode: source.value,
        targetUrl: url,
        processName,
        pid,
    } satisfies StoredAttachCaptureState);

    return options;
}

async function attachProcessAndCapture(context: vscode.ExtensionContext) {
    try {
        const options = await collectAttachCaptureOptions(context);
        if (!options) {
            return;
        }

        const result = await runCaptureWithProgress('RenderDoc — Attach To Process', () => bridge.nativeAttachCapture(options));
        launchTargetState.setLiveTarget(result);
        await refreshLiveTargetState();
        vscode.window.showInformationMessage(
            `RenderDoc: attached to ${result.target || options.processName || options.pid || 'target'}. Use Capture when you are ready to grab a frame.`
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`RenderDoc: attach failed - ${err?.message || err}`);
    }
}

function closeCapture() {
    if (!currentCapturePath) return;
    
    // Clear state
    currentCapturePath = undefined;
    bridgeLoadedCapturePath = undefined;
    currentSelectedDrawCall = undefined;
    currentSelectedResource = undefined;
    currentDrawCalls = [];
    currentResources = [];
    shaderAliasScanGeneration += 1;

    // Shut down the bridge to cleanly release all memory and file locks
    console.log('[RenderDoc] User requested close capture; killing bridge.');
    bridge.restartNativeBridge();

    // Reset UI providers
    captureInfoProvider.update(undefined);
    drawCallProvider.update([]);
    resourceProvider.update([]);
    apiInspectorProvider.clear();

    // Reset webview if open
    if (InspectorPanel.currentPanel) {
        InspectorPanel.currentPanel.setCapture(undefined, [], []);
    }
    if (ThumbnailPanel.currentPanel) {
        ThumbnailPanel.currentPanel.dispose();
    }
    if (DrawOverlayPanel.currentPanel) {
        DrawOverlayPanel.currentPanel.dispose();
    }
}

function isWeakShaderResourceName(name: string | undefined): boolean {
    const value = (name || '').trim();
    return value === '' || /^Shader\s+\d+$/i.test(value) || /^main$/i.test(value);
}

function needsShaderMetadata(resource: ResourceInfo): boolean {
    if (resource.type !== 'Shader') {
        return false;
    }
    return isWeakShaderResourceName(resource.name)
        || !resource.shaderStages
        || resource.shaderStages.length === 0;
}

function applyShaderMetadata(resources: ResourceInfo[], metadata: Map<string, { name: string; stages: string[] }>): boolean {
    let changed = false;
    for (const resource of resources) {
        if (resource.type !== 'Shader') { continue; }
        const value = metadata.get(resource.resourceId);
        if (!value) { continue; }

        if (value.stages.length > 0) {
            const currentStages = resource.shaderStages || [];
            const sameStages = currentStages.length === value.stages.length
                && currentStages.every((stage, index) => stage === value.stages[index]);
            if (!sameStages) {
                resource.shaderStages = value.stages;
                changed = true;
            }
        }

        if (value.name && resource.name !== value.name && (isWeakShaderResourceName(resource.name) || !resource.name.trim())) {
            resource.name = value.name;
            changed = true;
        }
    }
    return changed;
}

async function startShaderAliasScan(captureInfo: CaptureInfo, drawCalls: DrawCall[], resources: ResourceInfo[]) {
    if (!bridge.hasNativeBridge()) {
        return;
    }
    if (drawCalls.length === 0 || resources.every((resource) => !needsShaderMetadata(resource))) {
        return;
    }
    const generation = ++shaderAliasScanGeneration;
    try {
        const metadata = await bridge.buildShaderMetadataMap(drawCalls);
        if (generation !== shaderAliasScanGeneration) {
            return;
        }
        if (!applyShaderMetadata(resources, metadata)) {
            return;
        }

        currentResources = resources;
        resourceProvider.update(resources);
        if (InspectorPanel.currentPanel) {
            InspectorPanel.currentPanel.setCapture(captureInfo, drawCalls, resources);
        }
        try {
            captureCache.put(captureInfo.filePath, captureInfo, drawCalls, resources);
        } catch (err: any) {
            console.warn('[RenderDoc] captureCache.put after alias scan failed:', err?.message);
        }
    } catch (err: any) {
        console.warn('[RenderDoc] shader alias scan failed:', err?.message);
    }
}

async function enrichCaptureInfoWithStatistics(captureInfo: CaptureInfo | undefined): Promise<CaptureInfo | undefined> {
    if (!captureInfo || !bridge.hasNativeBridge()) {
        return captureInfo;
    }
    try {
        captureInfo.statistics = await bridge.nativeGetCaptureStatistics();
    } catch (err: any) {
        console.warn('[RenderDoc] capture statistics unavailable:', err?.message);
    }
    return captureInfo;
}

async function loadCapture(context: vscode.ExtensionContext, filePath: string, silent = false) {
    currentCapturePath = filePath;
    console.log('[RenderDoc] loadCapture called:', filePath, 'silent:', silent);
    console.log('[RenderDoc] hasNativeBridge:', bridge.hasNativeBridge());

    // ── Fast path: serve from cache ──────────────────────────────────────
    // If we've previously loaded this exact rdc (same path, mtime, size),
    // the draw-call tree and resource list are on disk. Populate the UI
    // instantly so the user can browse the tree while the 50+ s replay init
    // happens transparently in the background!
    const cached = captureCache.get(filePath);
    if (cached) {
        console.log('[RenderDoc] loadCapture: cache hit, populating UI instantly.');
        captureInfoProvider.update(cached.captureInfo);
        currentDrawCalls = cached.drawCalls;
        currentResources = cached.resources;
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
                closeExclusiveRenderDocPanels('thumbnail');
                ThumbnailPanel.createOrShow(context, thumbnail, cached.captureInfo);
            }
        }).catch(() => { /* best-effort */ });
        if (!silent) {
            vscode.window.showInformationMessage(
                `RenderDoc: Loaded UI from cache instantly. Starting local replay in background...`
            );
        }
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

    await syncReplayHostSelection(!silent);

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
                const replayMode = nativeResult.replayRemote ? 'remote replay' : 'local replay';
                const replayTarget = nativeResult.replayRemote && nativeResult.replayHost
                    ? ` on ${nativeResult.replayHost}`
                    : '';
                progress.report({ message: `Initialising ${replayMode}${replayTarget}...`, increment: 0 });
                let lastPct = 0;
                let cancelled = false;
                const unsubscribe = bridge.onNativeNotification('tryReplayProgress', (params) => {
                    const p = Math.max(0, Math.min(1, Number(params?.progress ?? 0)));
                    const pct = Math.round(p * 70); // reserve 30% for analysis
                    const delta = pct - lastPct;
                    if (delta > 0) {
                        lastPct = pct;
                        progress.report({ message: `Initialising ${replayMode}${replayTarget}... ${Math.round(p * 100)}%`, increment: delta });
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
                        if (!silent && tryResult.replayRemote && tryResult.replayHost) {
                            vscode.window.showInformationMessage(`RenderDoc: remote replay started on ${tryResult.replayHost}.`);
                        } else if (!silent && nativeResult.suggestRemote) {
                            vscode.window.showInformationMessage('RenderDoc: local replay started (cross-OS capture).');
                        }
                    } else {
                        captureInfoProvider.setReplayStatus('failed');
                        if (!silent) {
                            const msg = tryResult?.replayError || nativeResult.replayMessage || 'Unknown error';
                            const label = tryResult?.replayRemote || nativeResult.replayRemote ? 'remote replay' : 'local replay';
                            vscode.window.showWarningMessage(`RenderDoc: ${label} failed — ${msg}`);
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
                                `RenderDoc: replay initialisation failed — ${err?.message || err}. ` +
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
                        await syncReplayHostSelection();
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
            if (cached) {
                // If we hit the cache initially, use those to save the expensive JSON fetch time
                drawCalls = cached.drawCalls;
                resources = cached.resources;
                currentDrawCalls = drawCalls;
                currentResources = resources;
                progress.report({ message: 'Loading draw calls & resources... (done from cache)', increment: 20 });
            } else {
                try {
                    if (token.isCancellationRequested) { return; }
                    progress.report({ message: 'Loading draw calls...', increment: 10 });
                    const replayData = await loadReplayDataWithRetry(filePath, token, progress);
                    drawCalls = replayData.drawCalls;
                    currentDrawCalls = drawCalls;
                    drawCallProvider.update(drawCalls);

                    if (token.isCancellationRequested) { return; }
                    progress.report({ message: 'Loading resources...', increment: 10 });
                    resources = replayData.resources;
                    currentResources = resources;
                    resourceProvider.update(resources);
                } catch (err: any) {
                    replayErr = err;
                    drawCallProvider.update([]);
                    resourceProvider.update([]);
                }
            }
            apiInspectorProvider.clear();

            if (!replayErr && captureInfo) {
                await enrichCaptureInfoWithStatistics(captureInfo);
                captureInfoProvider.update(captureInfo);
            }

            // Persist successful results so the next open of this capture
            // can populate the UI instantly (avoiding expensive JSON fetch again).
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

            if (!replayErr && captureInfo) {
                void startShaderAliasScan(captureInfo, drawCalls, resources);
            }

            // Step 4: Thumbnail — uses renderdoccmd binary, no replay needed.
            try {
                if (token.isCancellationRequested) { return; }
                progress.report({ message: 'Loading thumbnail...', increment: 10 });
                const thumbnail = await bridge.getThumbnail(filePath);
                if (thumbnail && !silent) {
                    closeExclusiveRenderDocPanels('thumbnail');
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
        closeExclusiveRenderDocPanels('thumbnail');
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
    const replayData = await loadReplayDataWithRetry(info.filePath);
    const drawCalls = replayData.drawCalls;
    currentDrawCalls = drawCalls;
    drawCallProvider.update(drawCalls);
    const resources = replayData.resources;
    currentResources = resources;
    resourceProvider.update(resources);
    await enrichCaptureInfoWithStatistics(captureInfo);
    captureInfoProvider.update(captureInfo);
    if (InspectorPanel.currentPanel) {
        InspectorPanel.currentPanel.setCapture(captureInfo, drawCalls, resources);
    }
    void startShaderAliasScan(captureInfo, drawCalls, resources);
}

/** Walk draw call tree and attach GPU timings by eventId, aggregating sums for parents. */
function applyTimingsToTree(calls: DrawCall[], timings: Map<number, number>): number {
    let aggregatedTotal = 0;
    
    for (const dc of calls) {
        let nodeDuration = timings.get(dc.eventId);
        let childrenTotal = 0;
        
        if (dc.children && dc.children.length > 0) {
            childrenTotal = applyTimingsToTree(dc.children, timings);
        }

        // If the native backend didn't report a duration for this specific group/marker,
        // but its children have accumulated time, use the children's total time (just like qrenderdoc).
        if ((nodeDuration === undefined || nodeDuration < 0.0) && childrenTotal > 0) {
            nodeDuration = childrenTotal;
        }

        if (nodeDuration !== undefined && nodeDuration > 0) {
            dc.durationUs = nodeDuration;
            aggregatedTotal += nodeDuration;
        } else if (childrenTotal > 0) {
            // Even if node itself has no valid time, still pass children total up for ancestry.
            aggregatedTotal += childrenTotal;
        }
    }
    
    return aggregatedTotal;
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

    const normalizedDrawCall = normalizeSelectedDrawCall(item.drawCall)
        ?? normalizeSelectedDrawCall(findDrawCallByEventId(item.eventId));
    const resolvedEventId = normalizedDrawCall?.eventId ?? item.eventId;

    closeExclusiveRenderDocPanels('inspector');

    const existingInspector = InspectorPanel.currentPanel;
    if (existingInspector) {
        existingInspector.reveal();
        if (existingInspector.getCurrentEventId() !== resolvedEventId) {
            await existingInspector.setEvent(resolvedEventId, normalizedDrawCall ?? item.drawCall);
        }
        return;
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
    await inspector.setEvent(resolvedEventId, normalizedDrawCall ?? item.drawCall);
}

async function showResourceDetails(context: vscode.ExtensionContext, item: any) {
    if (!item) { return; }
    const info = captureInfoProvider.getCaptureInfo();
    const resourceId = item.resourceId;
    if (!info || !resourceId) {
        vscode.window.showWarningMessage('Open a capture and select a resource first.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Loading resource details...' },
        async () => {
            try {
                const detail = await bridge.getResourceDetail(info.filePath, String(resourceId));
                const title = item.label ? `Resource: ${item.label}` : `Resource ${resourceId}`;
                const panel = vscode.window.createWebviewPanel(
                    'renderdoc-resource-detail',
                    title,
                    vscode.ViewColumn.One,
                    { enableScripts: false }
                );
                panel.webview.html = getResourceDetailHtml(detail);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get resource details: ${err.message}`);
            }
        }
    );
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
    const resourceId = item.resourceId ? String(item.resourceId) : undefined;

    if (!bridge.hasNativeBridge()) {
        vscode.window.showWarningMessage(
            'Shader source requires an active local replay. Open a capture that can replay on this machine first.'
        );
        return;
    }

    if (eventId === undefined && !resourceId) {
        vscode.window.showWarningMessage('Select a draw call or shader resource first.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RenderDoc: Loading shader source...' },
        async () => {
            try {
                if (resourceId && eventId === undefined) {
                    const result = await bridge.getShaderSourceByResource(resourceId);
                    showShaderPanel(context, result.panelData, parseInt(resourceId, 10) || 0);
                    return;
                }

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
    closeExclusiveRenderDocPanels('inspector');
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
    if (!bridge.hasNativeBridge() || bridgeLoadedCapturePath !== currentCapturePath) {
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

        if (bridge.hasNativeBridge() && bridgeLoadedCapturePath) {
            console.log('[RenderDoc] Different capture open; restarting bridge before replay...');
            bridge.restartNativeBridge();
        } else if (!bridge.hasNativeBridge()) {
            console.log('[RenderDoc] Native bridge not running; attempting start before replay...');
            bridge.tryStartNativeBridge();
        }
        bridgeLoadedCapturePath = undefined;
        
        // Give the process a moment to spawn; hasNativeBridge() flips synchronously on spawn.
        if (!bridge.hasNativeBridge()) {
            vscode.window.showWarningMessage(
                'Failed to start the native bridge process. Check the Extension Host log for [RenderDoc] errors.'
            );
            return;
        }
        await syncReplayHostSelection(false);
        try { await bridge.nativeOpenCapture(currentCapturePath); }
        catch (err: any) {
            vscode.window.showWarningMessage(`Native bridge restarted but failed to open capture: ${err.message}`);
            return;
        }
        bridgeLoadedCapturePath = currentCapturePath;
    }

    const replayHostUrl = await syncReplayHostSelection(false);
    if (!replayHostUrl) {
        const confirm = await vscode.window.showWarningMessage(
            'Attempting local replay may crash if the capture is from a different platform. Continue?',
            { modal: true },
            'Try Replay'
        );
        if (confirm !== 'Try Replay') { return; }
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: replayHostUrl
                ? `RenderDoc — Initialising remote replay on ${replayHostUrl}...`
                : 'RenderDoc — Initialising local replay...',
            cancellable: true,
        },
        async (progress, token) => {
            let lastPct = 0;
            let cancelled = false;
            const unsubscribe = bridge.onNativeNotification('tryReplayProgress', (params) => {
                const p = Math.max(0, Math.min(1, Number(params?.progress ?? 0)));
                const pct = Math.round(p * 100);
                const delta = pct - lastPct;
                if (delta > 0) {
                    lastPct = pct;
                    progress.report({ message: `${pct}%`, increment: delta });
                }
            });
            const cancelSub = token.onCancellationRequested(() => {
                cancelled = true;
                console.log('[RenderDoc] User cancelled replay init — killing bridge.');
                bridge.restartNativeBridge();
            });

            try {
                const result = await bridge.nativeTryReplay();
                if (cancelled) {
                    captureInfoProvider.setReplayStatus('unavailable');
                } else if (result && result.replay) {
                    captureInfoProvider.setReplayStatus('active');
                    InspectorPanel.currentPanel?.invalidateReplayCaches();
                    if (result.replayRemote && result.replayHost) {
                        vscode.window.showInformationMessage(`Remote replay active on ${result.replayHost}. Shader/pipeline/texture features are now available.`);
                    } else {
                        vscode.window.showInformationMessage('Local replay active! Shader/pipeline/texture features are now available.');
                    }
                } else {
                    captureInfoProvider.setReplayStatus('failed');
                    const label = result?.replayRemote ? 'Remote replay' : 'Local replay';
                    vscode.window.showWarningMessage(`${label} failed: ${result?.replayError || 'Unknown error'}`);
                }
            } catch (err: any) {
                if (cancelled) {
                    captureInfoProvider.setReplayStatus('unavailable');
                    return;
                }
                captureInfoProvider.setReplayStatus('failed');
                console.log('[RenderDoc] tryLocalReplay crashed, restarting bridge...');
                bridge.tryStartNativeBridge();
                if (bridge.hasNativeBridge()) {
                    await syncReplayHostSelection();
                    try { await bridge.nativeOpenCapture(currentCapturePath!); } catch { /* ignore */ }
                }
                vscode.window.showWarningMessage(
                    replayHostUrl
                        ? 'Remote replay failed — inspection features are disabled for this capture until replay is restored.'
                        : 'Local replay crashed — this capture cannot be replayed on this GPU. Inspection features are disabled for this capture.'
                );
            } finally {
                unsubscribe();
                cancelSub.dispose();
            }
        }
    );
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
