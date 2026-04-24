import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { z } from 'zod';
import { CaptureInfo, DrawCall, ResourceInfo, ResourceDetail, ThumbnailData } from './types';
import { parseRdcFile } from './rdcParser';
import { withTimeout } from './util/async';
import {
    GetRootActionsResponse,
    GetResourcesResponse,
    GetTexturesResponse,
    GetShaderEntryPointsResponse,
    GetShaderSourceResponse,
    GetShaderSourceForEventResponse,
    GetPipelineStateResponse,
    GetTexturePreviewResponse,
    OpenCaptureResponse,
    TryReplayResponse,
    GetTimingsResponse,
    validateResponse,
    type TGetRootActionsResponse,
    type TGetResourcesResponse,
    type TGetTexturesResponse,
    type TGetShaderEntryPointsResponse,
    type TGetShaderSourceResponse,
    type TGetShaderSourceForEventResponse,
    type TGetPipelineStateResponse,
    type TGetTexturePreviewResponse,
    type TOpenCaptureResponse,
    type TTryReplayResponse,
    type TGetTimingsResponse,
} from './ipc/schemas';
import { BridgeError } from './ipc/bridgeError';

/** Default per-call timeout (ms) for native bridge requests.
 *  0 = no timeout. RenderDoc's own GUI doesn't time-box replay-related
 *  calls (OpenCapture, replay driver init, GetRootActions etc. can take
 *  tens of seconds on large GLES / D3D12 captures). We rely on the
 *  process-death detector in `processNativeOutput` to reject hung calls
 *  if the bridge actually crashes. Light health-check calls like `ping`
 *  still pass their own short timeout explicitly.
 */
const DEFAULT_NATIVE_CALL_TIMEOUT_MS = 0;
/** Shorter timeout used for the lightweight `ping` health check. */
const NATIVE_PING_TIMEOUT_MS = 2_000;

// ─────────────────────────────────────────────────────────────────────
// Native ActionDescription → DrawCall converter (preserves hierarchy)
// ─────────────────────────────────────────────────────────────────────
// ActionFlags bitmask values (must match native/include/renderdoc/replay_enums.h)
const ACTION_FLAG_CLEAR        = 0x0001;
const ACTION_FLAG_DRAWCALL     = 0x0002;
const ACTION_FLAG_DISPATCH     = 0x0004;
const ACTION_FLAG_MESHDISPATCH = 0x0008;
const ACTION_FLAG_SETMARKER    = 0x0020;
const ACTION_FLAG_PUSHMARKER   = 0x0040;
const ACTION_FLAG_PRESENT      = 0x0100;
const ACTION_FLAG_COPY         = 0x0400;
const ACTION_FLAG_RESOLVE      = 0x0800;
const ACTION_FLAG_GENMIPS      = 0x1000;
const ACTION_FLAG_PASSBOUNDARY = 0x2000;

function flagsBitmaskToName(flags: number, hasChildren: boolean): string {
    if (flags & ACTION_FLAG_DRAWCALL)     { return 'Drawcall'; }
    if (flags & ACTION_FLAG_DISPATCH)     { return 'Dispatch'; }
    if (flags & ACTION_FLAG_MESHDISPATCH) { return 'Dispatch'; }
    if (flags & ACTION_FLAG_CLEAR)        { return 'Clear'; }
    if (flags & ACTION_FLAG_COPY)         { return 'Copy'; }
    if (flags & ACTION_FLAG_RESOLVE)      { return 'Resolve'; }
    if (flags & ACTION_FLAG_GENMIPS)      { return 'GenMips'; }
    if (flags & ACTION_FLAG_PRESENT)      { return 'Present'; }
    if (flags & ACTION_FLAG_PASSBOUNDARY) { return 'PassBoundary'; }
    if (flags & (ACTION_FLAG_PUSHMARKER | ACTION_FLAG_SETMARKER)) { return 'Marker'; }
    return hasChildren ? 'Group' : '';
}

function convertNativeActionToDrawCall(a: any): DrawCall {
    const children: DrawCall[] = Array.isArray(a.children)
        ? a.children.map((c: any) => convertNativeActionToDrawCall(c))
        : [];
    const flagsNum = typeof a.flags === 'number' ? a.flags : 0;
    return {
        eventId:     typeof a.eventId === 'number' ? a.eventId : 0,
        drawIndex:   typeof a.actionId === 'number' ? a.actionId : 0,
        name:        typeof a.name === 'string' ? a.name : '',
        flags:       flagsBitmaskToName(flagsNum, children.length > 0),
        numIndices:  typeof a.numIndices === 'number' ? a.numIndices : 0,
        numInstances:typeof a.numInstances === 'number' ? a.numInstances : 0,
        children,
    };
}

/**
 * Error message shown whenever a replay-dependent query is attempted but
 * the native bridge / replay controller is not available. Kept as a single
 * constant so the extension UI layer can match on it for user-facing hints.
 */
export const NATIVE_REPLAY_REQUIRED_MSG =
    'Local replay is required for this operation. The RenderDoc native bridge ' +
    'must be running and the capture must have been successfully replayed on this machine.';

/**
 * Mapping from RenderDoc's ResourceType enum (uint32) to the string labels
 * used by `ResourceInfo.type`. Must stay in sync with
 * native/include/renderdoc/replay_enums.h — enum class ResourceType.
 */
const RESOURCE_TYPE_NAMES: Record<number, string> = {
    0: 'Unknown',
    1: 'Device',
    2: 'Queue',
    3: 'CommandBuffer',
    4: 'Texture',
    5: 'Buffer',
    6: 'View',
    7: 'Sampler',
    8: 'SwapchainImage',
    9: 'Memory',
    10: 'Shader',
    11: 'ShaderBinding',
    12: 'PipelineState',
    13: 'StateObject',
    14: 'RenderPass',
    15: 'Query',
    16: 'Sync',
    17: 'Pool',
    18: 'AccelerationStructure',
    19: 'DescriptorStore',
};

/** Convert a native `ResourceDescription` (+ optional matching texture detail) to our `ResourceInfo`. */
function nativeResourceToInfo(r: any, textures: Map<string, any>): ResourceInfo {
    const id = String(r.resourceId ?? '');
    const typeNum = typeof r.type === 'number' ? r.type : 0;
    let typeStr = RESOURCE_TYPE_NAMES[typeNum] ?? 'Unknown';
    const tex = textures.get(id);
    if (tex) { typeStr = 'Texture'; }
    return {
        resourceId: id,
        name: (tex?.name ?? (typeof r.name === 'string' ? r.name : '')),
        type: typeStr,
        format: tex?.format ?? '',
        width: tex?.width ?? 0,
        height: tex?.height ?? 0,
        depth: tex?.depth ?? 0,
        arraySize: tex?.arraySize ?? tex?.arraysize ?? 0,
        mipLevels: tex?.mips ?? 0,
        byteSize: tex?.byteSize ?? 0,
        ...(tex ? {
            textureType:  tex.textureType,
            cubemap:      tex.cubemap,
            msaaSamples:  tex.msaaSamples,
            usage:        tex.usage,
        } : {}),
    };
}

/**
 * Bridge between the VS Code extension and RenderDoc.
 * Uses native binary parsing for RDC metadata and renderdoccmd for thumbnail
 * extraction. All draw-call / resource / shader / pipeline queries require a
 * live replay via the native bridge (renderdoc_bridge.exe + renderdoc.dll).
 * No Python dependency required.
 */
export class RenderDocBridge {
    private renderdocPath: string | undefined;
    private renderdocCmd: string | undefined;
    /** Global-storage directory where we cache a downloaded renderdoc_bridge.exe. */
    private downloadedBridgeDir: string | undefined;

    constructor() {}

    /** Tell the bridge where it can look for (and save) a downloaded binary. */
    setDownloadedBridgeDir(dir: string) {
        this.downloadedBridgeDir = dir;
    }

    /**
     * Detects if RenderDoc is available on the system.
     * Checks: 1) user-configured path, 2) common install locations, 3) PATH
     */
    async checkAvailability(): Promise<boolean> {
        // 1. Check user-configured path
        const config = vscode.workspace.getConfiguration('renderdoc');
        const configuredPath = config.get<string>('installPath');
        if (configuredPath && await this.validateRenderdocDir(configuredPath)) {
            this.renderdocPath = configuredPath;
            return true;
        }

        // 2. Windows: check common install locations
        if (process.platform === 'win32') {
            const commonPaths = [
                path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'RenderDoc'),
                path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'RenderDoc'),
                path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'RenderDoc'),
            ];
            for (const p of commonPaths) {
                if (await this.validateRenderdocDir(p)) {
                    this.renderdocPath = p;
                    return true;
                }
            }
        }

        // 3. Linux/macOS: check PATH for renderdoccmd
        if (process.platform !== 'win32') {
            try {
                const result = await this.exec('which renderdoccmd');
                if (result.trim()) {
                    this.renderdocCmd = result.trim();
                    this.renderdocPath = path.dirname(result.trim());
                    return true;
                }
            } catch {
                // not found
            }
        }

        return false;
    }

    /** Validates that a directory looks like a RenderDoc installation */
    private async validateRenderdocDir(dir: string): Promise<boolean> {
        try {
            const stat = await fs.promises.stat(dir);
            if (!stat.isDirectory()) { return false; }

            const cmdName = process.platform === 'win32' ? 'renderdoccmd.exe' : 'bin/renderdoccmd';
            const cmdPath = path.join(dir, cmdName);
            if (await this.fileExists(cmdPath)) {
                this.renderdocCmd = cmdPath;
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    /** Get the renderdoccmd executable path */
    private getCmd(): string {
        if (!this.renderdocCmd) {
            throw new Error('RenderDoc not found. Please install RenderDoc or configure the path.');
        }
        return this.renderdocCmd;
    }

    /** Get capture file metadata by parsing the RDC binary directly */
    async getCaptureInfo(filePath: string): Promise<CaptureInfo> {
        return parseRdcFile(filePath);
    }

    /** Get draw calls — requires the native bridge with an active replay. */
    async getDrawCalls(_filePath: string): Promise<DrawCall[]> {
        if (!this.hasNativeBridge()) {
            throw new Error(NATIVE_REPLAY_REQUIRED_MSG);
        }
        const native = await this.nativeGetRootActions();
        return native.actions.map((a: any) => convertNativeActionToDrawCall(a));
    }

    /**
     * Fetch per-event GPU duration by running `FetchCounters(EventGPUDuration)`.
     * This re-replays the whole frame with timer queries and can take several
     * seconds. Returns a map of eventId → duration in microseconds.
     */
    async getDrawTimings(): Promise<Map<number, number>> {
        if (!this.hasNativeBridge()) {
            throw new Error(NATIVE_REPLAY_REQUIRED_MSG);
        }
        const res: TGetTimingsResponse = await this.nativeCallT('getTimings', GetTimingsResponse, {});
        const map = new Map<number, number>();
        for (const t of res.timings) {
            if (t.durationUs != null) {
                map.set(t.eventId, t.durationUs);
            }
        }
        return map;
    }

    /** Get resource list — requires the native bridge with an active replay. */
    async getResources(_filePath: string): Promise<ResourceInfo[]> {
        if (!this.hasNativeBridge()) {
            throw new Error(NATIVE_REPLAY_REQUIRED_MSG);
        }
        const [resRes, texRes] = await Promise.all([
            this.nativeCallT('getResources', GetResourcesResponse, {}),
            this.nativeCallT('getTextures', GetTexturesResponse, {})
                .catch((): TGetTexturesResponse => ({ textures: [], count: 0 })),
        ]);
        const textures = new Map<string, TGetTexturesResponse['textures'][number]>();
        for (const t of texRes.textures) {
            textures.set(String(t.resourceId), t);
        }
        return resRes.resources.map((r) => nativeResourceToInfo(r, textures));
    }

    /** Get capture thumbnail using renderdoccmd thumb */
    async getThumbnail(filePath: string): Promise<ThumbnailData | null> {
        const tmpFile = path.join(os.tmpdir(), `rdcthumb_${Date.now()}.jpg`);
        try {
            await this.runCmd(['thumb', `--out=${tmpFile}`, filePath]);
            if (!await this.fileExists(tmpFile)) { return null; }

            const data = await fs.promises.readFile(tmpFile);
            if (data.length === 0) { return null; }

            // Read dimensions from the RDC header directly
            const fd = await fs.promises.open(filePath, 'r');
            const hdrBuf = Buffer.alloc(40);
            await fd.read(hdrBuf, 0, 40, 0);
            await fd.close();
            const thumbWidth = hdrBuf.readUInt16LE(32);
            const thumbHeight = hdrBuf.readUInt16LE(34);

            return {
                width: thumbWidth,
                height: thumbHeight,
                base64: data.toString('base64'),
                format: 'jpg',
            };
        } finally {
            // Clean up temp file
            try { await fs.promises.unlink(tmpFile); } catch {}
        }
    }

    /** Get detailed resource info — requires native bridge. */
    async getResourceDetail(filePath: string, resourceId: string): Promise<ResourceDetail> {
        const resources = await this.getResources(filePath);
        const resource = resources.find(r => r.resourceId === resourceId);
        if (!resource) {
            throw new Error(`Resource ${resourceId} not found.`);
        }
        return {
            ...resource,
            creationType: '',
            usage: [],
            bindFlags: [],
        };
    }

    // --- renderdoccmd execution ---

    /** Run renderdoccmd with given arguments */
    private runCmd(args: string[]): Promise<string> {
        const cmd = this.getCmd();
        const config = vscode.workspace.getConfiguration('renderdoc');
        const timeout = config.get<number>('commandTimeout', 60000);

        return new Promise<string>((resolve, reject) => {
            cp.execFile(
                cmd,
                args,
                {
                    timeout,
                    maxBuffer: 50 * 1024 * 1024,
                },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(`renderdoccmd error: ${error.message}\n${stderr}`));
                        return;
                    }
                    resolve(stdout);
                }
            );
        });
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private exec(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(command, { timeout: 5000 }, (err, stdout) => {
                if (err) { reject(err); }
                else { resolve(stdout); }
            });
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Native Bridge (renderdoc_bridge.exe) — JSON-over-stdio protocol
    // ═══════════════════════════════════════════════════════════════════

    private nativeProcess: cp.ChildProcess | undefined;
    private nativeRequestId = 0;
    private nativePendingRequests = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: BridgeError) => void }>();
    private nativeOutputBuffer = '';
    /** Listeners for notifications (messages with no `id`) sent from the native bridge. */
    private nativeNotificationListeners = new Map<string, Set<(params: any) => void>>();

    /** Subscribe to a native bridge notification (e.g. `tryReplayProgress`). Returns an unsubscribe fn. */
    onNativeNotification(method: string, listener: (params: any) => void): () => void {
        let set = this.nativeNotificationListeners.get(method);
        if (!set) {
            set = new Set();
            this.nativeNotificationListeners.set(method, set);
        }
        set.add(listener);
        return () => { set!.delete(listener); };
    }

    /** Check if native bridge is running */
    hasNativeBridge(): boolean {
        return !!this.nativeProcess && !this.nativeProcess.killed;
    }

    /** Is the bridge binary present on disk (even if not yet spawned)? */
    isNativeBridgeInstalled(): boolean {
        return !!this.findNativeBridge();
    }

    /** Absolute path to an installed bridge binary, or undefined. */
    getNativeBridgePath(): string | undefined {
        return this.findNativeBridge();
    }

    /** Target platform asset name for the bridge binary on the current OS. */
    static expectedBridgeAssetName(): string {
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        if (process.platform === 'win32')  { return `renderdoc_bridge-win32-${arch}.exe`; }
        if (process.platform === 'darwin') { return `renderdoc_bridge-darwin-${arch}`; }
        return `renderdoc_bridge-linux-${arch}`;
    }

    /** Try to start the native bridge process */
    tryStartNativeBridge(): void {
        if (this.nativeProcess) { return; }

        const bridgePath = this.findNativeBridge();
        console.log('[RenderDoc] findNativeBridge:', bridgePath ?? 'NOT FOUND');
        if (!bridgePath) { return; }

        try {
            // Spawn with cwd + PATH set to the RenderDoc install dir, so
            // renderdoc.dll can find its sibling DLLs and plugins/ subfolder.
            // Without this, OpenCapture can hang for several minutes searching
            // for missing plugin DLLs (the official RenderDoc GUI never hits
            // this because it always runs from its own install dir).
            const env = { ...process.env };
            if (this.renderdocPath) {
                const sep = process.platform === 'win32' ? ';' : ':';
                const existingPath = env.PATH || env.Path || '';
                env.PATH = this.renderdocPath + sep + existingPath;
            }
            const child = cp.spawn(bridgePath, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
                cwd: this.renderdocPath || undefined,
            });
            this.nativeProcess = child;
            console.log('[RenderDoc] Native bridge spawned, pid:', child.pid);

            child.stdout?.on('data', (data: Buffer) => {
                // Only process output from the current bridge. Stale data from
                // a previously-killed bridge (during a restart) must be ignored
                // so it doesn't corrupt the new bridge's response stream.
                if (this.nativeProcess !== child) { return; }
                this.nativeOutputBuffer += data.toString();
                this.processNativeOutput();
            });

            child.stderr?.on('data', (data: Buffer) => {
                console.log('[RenderDoc] bridge stderr:', data.toString().trim());
            });

            child.on('exit', (code) => {
                console.log('[RenderDoc] Native bridge exited with code:', code, 'pid:', child.pid);
                // Only clear state if this is still the active process.
                // During a restart the old process's exit fires AFTER the new
                // one has already been spawned — without this guard it would
                // clobber the new `nativeProcess` reference and any pending
                // requests queued against the new bridge.
                if (this.nativeProcess !== child) { return; }
                this.nativeProcess = undefined;
                // Reject all pending requests
                for (const [, pending] of this.nativePendingRequests) {
                    pending.reject(new BridgeError('exited', 'Native bridge process exited', { method: pending.method }));
                }
                this.nativePendingRequests.clear();
            });

            child.on('error', (err) => {
                console.error('[RenderDoc] Native bridge spawn error:', err.message);
                if (this.nativeProcess !== child) { return; }
                this.nativeProcess = undefined;
            });

            // Initialize with RenderDoc path
            if (this.renderdocPath) {
                this.nativeCall('init', { renderdocPath: this.renderdocPath }).catch(() => {});
            }
        } catch {
            this.nativeProcess = undefined;
        }
    }

    /** Kill and restart the native bridge (e.g. after installing ANGLE DLLs) */
    restartNativeBridge(): void {
        if (this.nativeProcess) {
            try { this.nativeProcess.kill(); } catch { /* ignore */ }
            this.nativeProcess = undefined;
        }
        for (const [, pending] of this.nativePendingRequests) {
            pending.reject(new BridgeError('restarting', 'Native bridge restarting', { method: pending.method }));
        }
        this.nativePendingRequests.clear();
        this.nativeOutputBuffer = '';
        this.tryStartNativeBridge();
    }

    /** Find the native bridge executable */
    private findNativeBridge(): string | undefined {
        const exeName = process.platform === 'win32' ? 'renderdoc_bridge.exe' : 'renderdoc_bridge';

        // 1. User setting override
        const override = vscode.workspace.getConfiguration('renderdoc').get<string>('nativeBridge.path');
        if (override && fs.existsSync(override)) { return override; }

        // 2. Next to the extension (dev build or VSIX-bundled)
        const extensionDir = path.dirname(path.dirname(__filename));
        const candidates = [
            path.join(extensionDir, 'native', 'build', 'Release', exeName),
            path.join(extensionDir, 'native', 'build', exeName),
            path.join(extensionDir, exeName),
        ];

        // 3. Downloaded copy in globalStorage (populated on first run)
        if (this.downloadedBridgeDir) {
            candidates.push(path.join(this.downloadedBridgeDir, exeName));
        }

        for (const c of candidates) {
            if (fs.existsSync(c)) { return c; }
        }
        return undefined;
    }

    /** Process line-delimited JSON messages from native bridge */
    private processNativeOutput(): void {
        const lines = this.nativeOutputBuffer.split('\n');
        // Keep the incomplete last line in buffer
        this.nativeOutputBuffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { continue; }
            try {
                const msg = JSON.parse(trimmed);
                if (msg.id !== undefined && this.nativePendingRequests.has(msg.id)) {
                    const pending = this.nativePendingRequests.get(msg.id)!;
                    this.nativePendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new BridgeError(
                            'remote',
                            msg.error.message || 'Unknown native bridge error',
                            { method: pending.method, code: msg.error.code },
                        ));
                    } else {
                        pending.resolve(msg.result);
                    }
                } else if (msg.id === undefined && typeof msg.method === 'string') {
                    // Notification (no response expected). Dispatch to any
                    // registered listeners for that method name.
                    const listeners = this.nativeNotificationListeners.get(msg.method);
                    if (listeners) {
                        for (const fn of listeners) {
                            try { fn(msg.params ?? {}); } catch { /* ignore listener errors */ }
                        }
                    }
                }
            } catch {
                // Ignore unparseable lines
            }
        }
    }

    /** Send a JSON-RPC style request to the native bridge */
    private nativeCall(method: string, params: any = {}, timeoutMs?: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            if (!this.nativeProcess || !this.nativeProcess.stdin) {
                reject(new BridgeError('unavailable', 'Native bridge not available', { method }));
                return;
            }
            const id = ++this.nativeRequestId;
            const msg = JSON.stringify({ id, method, params }) + '\n';

            // Resolve timeout: explicit arg > user setting > default.
            // A value of 0 (or negative) explicitly disables the timeout —
            // used for heavy operations like tryReplay that can legitimately
            // take minutes on large captures.
            const configured = vscode.workspace.getConfiguration('renderdoc')
                .get<number>('nativeBridge.callTimeoutMs');
            const ms = timeoutMs
                ?? (typeof configured === 'number' && configured > 0 ? configured : DEFAULT_NATIVE_CALL_TIMEOUT_MS);

            // Wire up the timeout first so we can cancel it on success.
            // If ms <= 0, skip the timer entirely (no deadline).
            const timer: NodeJS.Timeout | null = ms > 0
                ? setTimeout(() => {
                    if (this.nativePendingRequests.has(id)) {
                        this.nativePendingRequests.delete(id);
                        reject(new BridgeError(
                            'timeout',
                            `Native bridge call '${method}' timed out after ${ms}ms`,
                            { method },
                        ));
                    }
                }, ms)
                : null;

            this.nativePendingRequests.set(id, {
                method,
                resolve: (v) => { if (timer) { clearTimeout(timer); } resolve(v); },
                reject:  (e) => { if (timer) { clearTimeout(timer); } reject(e); },
            });

            this.nativeProcess.stdin.write(msg, (err) => {
                if (err) {
                    if (timer) { clearTimeout(timer); }
                    this.nativePendingRequests.delete(id);
                    reject(new BridgeError('io', `stdin write failed: ${err.message}`, { method, cause: err }));
                }
            });
        });
    }

    /**
     * Typed + validated variant of `nativeCall`. The response is parsed
     * against a Zod schema before being returned; malformed responses throw
     * with a message that names the failing path(s). Use this in preference
     * to the raw `nativeCall` anywhere the response shape is known.
     */
    private async nativeCallT<T>(
        method: string,
        schema: z.ZodType<T>,
        params: any = {},
        timeoutMs?: number,
    ): Promise<T> {
        const raw = await this.nativeCall(method, params, timeoutMs);
        return validateResponse(schema, raw, method);
    }

    /**
     * Lightweight health check for the native bridge.
     *
     * `hasNativeBridge()` only checks process liveness, which doesn't catch
     * a deadlocked replay controller. `ping()` issues a real round-trip with
     * a short timeout so callers can verify the bridge is actually responsive.
     *
     * Treats ANY response from the bridge as "alive" (including an error
     * response for unknown methods) — we only need a round-trip. Only a
     * timeout or a dead process count as unhealthy.
     */
    async nativePing(): Promise<boolean> {
        if (!this.hasNativeBridge()) { return false; }
        try {
            await this.nativeCall('ping', {}, NATIVE_PING_TIMEOUT_MS);
            return true;
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            // Timeout or process-gone mean the bridge is unhealthy. Any other
            // error (e.g. "Unknown method 'ping'") still proves the bridge
            // responded and is therefore alive.
            if (msg.includes('timed out') || msg.includes('not available') || msg.includes('exited')) {
                return false;
            }
            return true;
        }
    }

    /** Open a capture in the native replay controller */
    async nativeOpenCapture(filePath: string): Promise<any> {
        return this.nativeCall('openCapture', { path: filePath });
    }

    /** Explicitly try local replay for SuggestRemote captures (user-initiated) */
    async nativeTryReplay(): Promise<any> {
        // Initialising a replay driver can be very expensive for large
        // captures (Unity GLES, big D3D12 frames): compiling shaders,
        // creating a GL/D3D context, uploading resources, etc. RenderDoc's
        // own GUI doesn't time-box this operation, so we disable the
        // per-call timeout here (0 = no timeout) to match that behaviour.
        return this.nativeCall('tryReplay', {}, 0);
    }

    /** Get pipeline state at a specific event via native bridge */
    async nativeGetPipelineState(eventId: number): Promise<any> {
        return this.nativeCall('getPipelineState', { eventId });
    }

    /** Get shader source at a specific event via native bridge */
    async nativeGetShaderSource(eventId: number, stage?: string): Promise<any> {
        return this.nativeCall('getShaderSourceForEvent', { eventId, stage });
    }

    /** Get texture data via native bridge (saves to temp PNG, returns base64) */
    async nativeGetTextureData(textureId: string, mip?: number, eventId?: number, channelExtract?: number): Promise<any> {
        return this.nativeCall('getTexturePreview', { resourceId: parseInt(textureId, 10) || 0, mip: mip ?? 0, eventId: eventId ?? 0, channelExtract: channelExtract ?? -1 });
    }

    /**
     * Render multiple textures at THUMB_DIM×THUMB_DIM using the GPU thumbnail output.
     * Much faster than N individual getTexturePreview calls because:
     *   1. SetFrameEvent is called only once for the whole batch
     *   2. GPU renders directly to 256×256 — no temp file, no large PNG encode
     * @param eventId Frame event to seek to (0 = end-of-frame)
     * @param resourceIds Resource IDs to render
     */
    async nativeGetTextureThumbBatch(eventId: number, resourceIds: string[]): Promise<any> {
        const textures = resourceIds.map(id => ({ resourceId: parseInt(id, 10) || 0, mip: 0 }));
        return this.nativeCall('getTextureThumbBatch', { eventId, textures });
    }

    /** Render the first bound color RT at `eventId` with a Drawcall overlay. */
    async nativeGetDrawcallOverlay(eventId: number): Promise<{
        base64: string;
        format: string;
        width: number;
        height: number;
        eventId: number;
        resourceId: number;
        rtName?: string;
    }> {
        return (await this.nativeCall('getDrawcallOverlay', { eventId })) as any;
    }

    /**
     * Return the structured-file chunks that belong to the given event id.
     * Feeds the API Inspector sidebar: one row per underlying `APIEvent`
     * (e.g. glBindBuffer / glDrawElements) attached to the action.
     */
    async nativeGetEventChunks(eventId: number): Promise<{
        eventId: number;
        chunks: Array<{ eventId: number; name: string; params: string }>;
    }> {
        return (await this.nativeCall('getEventChunks', { eventId })) as any;
    }

    /** Fetch decoded mesh data for the draw at `eventId`. */
    async nativeGetMeshData(
        eventId: number,
        stage: 'vsin' | 'vsout' | 'gsout' = 'vsin',
        opts?: { maxVertices?: number; instance?: number; view?: number },
    ): Promise<any> {
        return this.nativeCall('getMeshData', {
            eventId,
            stage,
            maxVertices: opts?.maxVertices ?? 256,
            instance: opts?.instance ?? 0,
            view: opts?.view ?? 0,
        });
    }

    /** Get root actions (draw call tree) via native bridge */
    async nativeGetRootActions(): Promise<any> {
        return this.nativeCall('getRootActions', {});
    }

    // ═══════════════════════════════════════════════════════════════════
    //  High-level: list every shader resource in the capture (name + source).
    //  Requires a live replay — iterates native getResources → filter Shaders
    //  → getShaderEntryPoints → getShaderSource for each entry.
    // ═══════════════════════════════════════════════════════════════════

    async getAllShaders(): Promise<Array<{ name: string; source: string }>> {
        if (!this.hasNativeBridge()) {
            throw new Error(NATIVE_REPLAY_REQUIRED_MSG);
        }
        const resRes = await this.nativeCallT('getResources', GetResourcesResponse, {});
        const shaders = resRes.resources.filter((r) => RESOURCE_TYPE_NAMES[r.type] === 'Shader');

        const out: Array<{ name: string; source: string }> = [];
        for (const s of shaders) {
            const rid = s.resourceId;
            if (rid === undefined || rid === null) { continue; }
            let entries: TGetShaderEntryPointsResponse['entryPoints'] = [];
            try {
                const epRes = await this.nativeCallT('getShaderEntryPoints', GetShaderEntryPointsResponse, { resourceId: rid });
                entries = epRes.entryPoints;
            } catch {
                continue;
            }
            if (entries.length === 0) {
                // Some APIs have no explicit entry points; try a default one.
                entries = [{ name: 'main', stage: 0 }];
            }
            for (const ep of entries) {
                try {
                    const src: TGetShaderSourceResponse = await this.nativeCallT(
                        'getShaderSource',
                        GetShaderSourceResponse,
                        { resourceId: rid, entryPoint: ep.name, stage: ep.stage },
                    );
                    // Prefer reflection source files; fall back to disassembly if present.
                    let source = '';
                    if (src.sourceFiles && src.sourceFiles.length > 0) {
                        source = src.sourceFiles.map((f) => f.contents ?? '').join('\n\n');
                    } else if (typeof src.disassembly === 'string') {
                        source = src.disassembly;
                    }
                    if (source.trim().length > 0) {
                        const label = s.name || `shader_${rid}`;
                        out.push({ name: `${label} [${ep.name}]`, source });
                    }
                } catch {
                    // Skip shaders we can't decode.
                }
            }
        }
        return out;
    }
}
