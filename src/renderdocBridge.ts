import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { z } from 'zod';
import {
    AttachCaptureOptions,
    CaptureInfo,
    CaptureAttachTarget,
    CaptureLaunchTarget,
    DrawCall,
    LiveTargetInfo,
    LaunchCaptureOptions,
    LaunchCaptureResult,
    ReplayHostInfo,
    ResourceInfo,
    ResourceDetail,
    ThumbnailData,
    TextureOverlayMode,
    TriggerCaptureOptions,
    TriggerCaptureResult,
} from './types';
import { parseRdcFile, parseRdcThumbnail } from './rdcParser';
import {
    logRenderDocDiagnostic,
    logRenderDocError,
    logRenderDocInfo,
    logRenderDocWarning,
} from './util/diagnostics';
import {
    InitResponse,
    GetVersionResponse,
    GetResourcesResponse,
    GetTexturesResponse,
    GetCaptureStatisticsResponse,
    LiveTargetInfoResponse,
    ListAttachTargetsResponse,
    ListCaptureTargetsResponse,
    TriggerCaptureResponse,
    GetShaderEntryPointsResponse,
    GetShaderSourceResponse,
    ApplyShaderEditResponse,
    CompileShaderEditResponse,
    RevertShaderEditResponse,
    GetPipelineConstantBufferContentsResponse,
    OpenCaptureResponse,
    ReplayHostInfoResponse,
    TryReplayResponse,
    GetTimingsResponse,
    validateResponse,
    type TGetVersionResponse,
    type TGetTexturesResponse,
    type TGetCaptureStatisticsResponse,
    type TLiveTargetInfoResponse,
    type TListAttachTargetsResponse,
    type TListCaptureTargetsResponse,
    type TTriggerCaptureResponse,
    type TGetShaderEntryPointsResponse,
    type TGetShaderSourceResponse,
    type TApplyShaderEditResponse,
    type TCompileShaderEditResponse,
    type TRevertShaderEditResponse,
    type TGetPipelineConstantBufferContentsResponse,
    type TOpenCaptureResponse,
    type TReplayHostInfoResponse,
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
const DIAGNOSTIC_NATIVE_METHODS = new Set([
    'init',
    'getReplayHost',
    'setReplayHost',
    'disconnectReplayHost',
    'openCapture',
    'tryReplay',
]);

function shouldTraceNativeMethod(method: string): boolean {
    return DIAGNOSTIC_NATIVE_METHODS.has(method);
}

function summarizeNativeParams(method: string, params: any): unknown {
    switch (method) {
        case 'init':
            return { renderdocPath: params?.renderdocPath };
        case 'setReplayHost':
            return { url: params?.url };
        case 'openCapture':
            return { path: params?.path };
        default:
            return params;
    }
}

function summarizeNativeResult(method: string, result: any): unknown {
    switch (method) {
        case 'getReplayHost':
        case 'setReplayHost':
        case 'disconnectReplayHost':
            return {
                connected: result?.connected,
                url: result?.url,
                protocol: result?.protocol,
                localProxies: result?.localProxies,
                remoteSupportedReplays: result?.remoteSupportedReplays,
            };
        case 'openCapture':
            return {
                api: result?.api,
                localReplaySupport: result?.localReplaySupport,
                canTryReplay: result?.canTryReplay,
                replayRemote: result?.replayRemote,
                suggestRemote: result?.suggestRemote,
                replayMessage: result?.replayMessage,
            };
        case 'tryReplay':
            return {
                replay: result?.replay,
                replayRemote: result?.replayRemote,
                replayHost: result?.replayHost,
                replayError: result?.replayError,
            };
        default:
            return result;
    }
}

function classifyBridgeStderr(line: string): 'INFO' | 'WARN' | 'ERROR' {
    const text = line.toLowerCase();
    if (/crash|exception|failed|error|timeout|timed out|no replay active/.test(text)) {
        return 'ERROR';
    }
    if (/retry|fallback|warning|warn|reconnect|lost/.test(text)) {
        return 'WARN';
    }
    return 'INFO';
}

function shouldSuppressNativeErrorLog(method: string, code: unknown, message: string): boolean {
    return method === 'ping'
        && Number(code) === -100
        && message.includes('Unknown method: ping');
}

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

const HIDDEN_RESOURCE_TYPES = new Set<string>(['StateObject']);

function isGenericShaderName(name: string | undefined): boolean {
    return /^Shader\s+\d+$/i.test((name || '').trim());
}

function isWeakShaderDisplayName(name: string | undefined): boolean {
    const value = (name || '').trim();
    if (!value) { return true; }
    if (isGenericShaderName(value)) { return true; }
    return isGenericShaderLabel(value);
}

function fileLeaf(filePath: string | undefined): string {
    const value = (filePath || '').trim();
    if (!value) { return ''; }
    const parts = value.split(/[\\/]/);
    return parts[parts.length - 1] || value;
}

function stripExtension(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
}

function isGenericShaderLabel(label: string | undefined): boolean {
    const value = (label || '').trim().toLowerCase();
    return value === ''
        || value === 'shader'
        || value === 'main'
        || value === 'vertex'
        || value === 'fragment'
        || value === 'pixel'
        || value === 'compute'
        || value === 'geometry'
        || value === 'hull'
        || value === 'domain'
        || value === 'vert'
        || value === 'frag'
        || value === 'comp'
        || value === 'geom'
        || value === 'vs'
        || value === 'ps'
        || value === 'fs'
        || value === 'gs'
        || value === 'hs'
        || value === 'ds';
}

function derivePathLabel(filePath: string | undefined): string {
    const parts = (filePath || '')
        .split(/[\\/]/)
        .map((part) => stripExtension(part.trim()))
        .filter((part) => part && !isGenericShaderLabel(part));
    if (parts.length === 0) { return ''; }
    return parts.slice(-3).join('/');
}

function stageToLabel(stage: number): string {
    const labels: Record<number, string> = {
        0: 'Vertex',
        1: 'Hull',
        2: 'Domain',
        3: 'Geometry',
        4: 'Pixel',
        5: 'Compute',
    };
    return labels[stage] || `Stage ${stage}`;
}

function normalizeShaderStageLabel(label: string): string {
    const normalized = (label || '').trim();
    const map: Record<string, string> = {
        Pixel: 'Fragment',
        Fragment: 'Fragment',
        Vertex: 'Vertex',
        Compute: 'Compute',
        Geometry: 'Geometry',
        Hull: 'Hull',
        Domain: 'Domain',
    };
    return map[normalized] || normalized;
}

function collectPipelineEventIds(drawCalls: DrawCall[], out: number[] = []): number[] {
    for (const drawCall of drawCalls) {
        if (/drawcall|dispatch/i.test(drawCall.flags || '')) {
            out.push(drawCall.eventId);
        }
        if (drawCall.children?.length) {
            collectPipelineEventIds(drawCall.children, out);
        }
    }
    return out;
}

function pickPipelineShaderAlias(info: any): string {
    const candidates = [info?.programName, info?.shaderName, info?.name];
    for (const candidate of candidates) {
        if (!isWeakShaderDisplayName(candidate)) {
            return String(candidate).trim();
        }
    }
    for (const candidate of candidates) {
        if ((candidate || '').trim()) {
            return String(candidate).trim();
        }
    }
    return '';
}

function pipelineStageKeyToLabel(stageKey: string, info: any): string {
    const normalized = String(stageKey || '').trim().toLowerCase();
    const keyMap: Record<string, string> = {
        vertex: 'Vertex',
        fragment: 'Fragment',
        pixel: 'Fragment',
        compute: 'Compute',
        geometry: 'Geometry',
        hull: 'Hull',
        tesscontrol: 'Hull',
        tess_control: 'Hull',
        domain: 'Domain',
        tesseval: 'Domain',
        tess_eval: 'Domain',
    };
    if (keyMap[normalized]) {
        return keyMap[normalized];
    }

    const numericStage = typeof info?.stage === 'number' ? stageToLabel(info.stage) : '';
    const numericMap: Record<string, string> = {
        Vertex: 'Vertex',
        Pixel: 'Fragment',
        Compute: 'Compute',
        Geometry: 'Geometry',
        Hull: 'Hull',
        Domain: 'Domain',
    };
    return numericMap[numericStage] || normalizeShaderStageLabel(numericStage) || stageKey;
}

function deriveShaderDisplayName(source: TGetShaderSourceResponse, fallbackName: string, resourceId: string): string {
    for (const file of source.sourceFiles || []) {
        const shaderDecl = (file.contents || '').match(/\bShader\s+"([^"]+)"/);
        if (shaderDecl?.[1]) {
            return shaderDecl[1];
        }

        const pathLabel = derivePathLabel(file.filename);
        if (pathLabel) {
            return pathLabel;
        }

        const leaf = fileLeaf(file.filename);
        const stem = stripExtension(leaf);
        if (!isGenericShaderLabel(stem)) {
            return stem;
        }
    }
    return fallbackName || `Shader ${resourceId}`;
}

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
    private shaderDisplayNameCache = new Map<string, string>();
    private nativeFeatureSupport = new Map<string, boolean>();
    private pendingEnsureNativeBridgeReady: Promise<void> | undefined;

    constructor() {}

    /** Tell the bridge where it can look for (and save) a downloaded binary. */
    setDownloadedBridgeDir(dir: string) {
        this.downloadedBridgeDir = dir;
    }

    private getExtensionDir(): string {
        return path.dirname(path.dirname(__filename));
    }

    private getBundledRenderdocDir(): string | undefined {
        const bundledDir = path.join(this.getExtensionDir(), '.renderdoc-runtime');
        return fs.existsSync(bundledDir) ? bundledDir : undefined;
    }

    private formatDirectorySnapshot(dir: string, limit = 64): string {
        try {
            if (!fs.existsSync(dir)) { return '<missing>'; }
            const entries = fs.readdirSync(dir, { withFileTypes: true })
                .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
                .sort((a, b) => a.localeCompare(b));
            if (entries.length === 0) { return '<empty>'; }
            if (entries.length > limit) {
                return `${entries.slice(0, limit).join(', ')} ... (+${entries.length - limit} more)`;
            }
            return entries.join(', ');
        } catch (error: any) {
            return `<error: ${error?.message ?? String(error)}>`;
        }
    }

    private logRenderdocRuntimeDiagnostics(label: string, dir: string): void {
        console.log(`[RenderDoc] ${label} runtime dir: ${dir}`);
        console.log(`[RenderDoc] ${label} runtime entries: ${this.formatDirectorySnapshot(dir)}`);

        const pluginsDir = path.join(dir, 'plugins');
        console.log(`[RenderDoc] ${label} plugins dir: ${pluginsDir}`);
        console.log(`[RenderDoc] ${label} plugins entries: ${this.formatDirectorySnapshot(pluginsDir)}`);

        const glesPluginsDir = path.join(pluginsDir, 'gles');
        console.log(`[RenderDoc] ${label} plugins/gles dir: ${glesPluginsDir}`);
        console.log(`[RenderDoc] ${label} plugins/gles entries: ${this.formatDirectorySnapshot(glesPluginsDir)}`);
    }

    /**
     * Detects if RenderDoc is available on the system.
     * Checks: 1) VSIX-bundled runtime, 2) common install locations, 3) PATH
     */
    async checkAvailability(): Promise<boolean> {
        let nextRenderdocPath: string | undefined;
        let nextRenderdocCmd: string | undefined;

        // 1. Check the self-contained runtime bundled with the extension.
        const bundledPath = this.getBundledRenderdocDir();
        const bundledCmd = bundledPath ? await this.validateRenderdocDir(bundledPath) : undefined;
        if (bundledPath && bundledCmd) {
            nextRenderdocPath = bundledPath;
            nextRenderdocCmd = bundledCmd;
            this.renderdocPath = nextRenderdocPath;
            this.renderdocCmd = nextRenderdocCmd;
            this.logRenderdocRuntimeDiagnostics('Bundled', bundledPath);
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
                const cmdPath = await this.validateRenderdocDir(p);
                if (cmdPath) {
                    nextRenderdocPath = p;
                    nextRenderdocCmd = cmdPath;
                    this.renderdocPath = nextRenderdocPath;
                    this.renderdocCmd = nextRenderdocCmd;
                    this.logRenderdocRuntimeDiagnostics('System', p);
                    return true;
                }
            }
        }

        // 3. Linux/macOS: check PATH for renderdoccmd
        if (process.platform !== 'win32') {
            try {
                const result = await this.exec('which renderdoccmd');
                if (result.trim()) {
                    nextRenderdocCmd = result.trim();
                    nextRenderdocPath = path.dirname(result.trim());
                    this.renderdocCmd = nextRenderdocCmd;
                    this.renderdocPath = nextRenderdocPath;
                    return true;
                }
            } catch {
                // not found
            }
        }

        this.renderdocPath = undefined;
        this.renderdocCmd = undefined;
        return false;
    }

    /** Validates that a directory looks like a RenderDoc installation */
    private async validateRenderdocDir(dir: string): Promise<string | undefined> {
        try {
            const stat = await fs.promises.stat(dir);
            if (!stat.isDirectory()) { return undefined; }

            const cmdName = process.platform === 'win32' ? 'renderdoccmd.exe' : 'bin/renderdoccmd';
            const cmdPath = path.join(dir, cmdName);
            if (await this.fileExists(cmdPath)) {
                return cmdPath;
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    /** Get the renderdoccmd executable path */
    private getCmd(): string {
        if (!this.renderdocCmd) {
            throw new Error('RenderDoc runtime is unavailable. The bundled runtime is missing and no system RenderDoc install was auto-detected.');
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
        const resources = resRes.resources
            .map((r) => nativeResourceToInfo(r, textures))
            .filter((resource) => !HIDDEN_RESOURCE_TYPES.has(resource.type));

        const shaderResources = resources.filter((resource) => resource.type === 'Shader' && isGenericShaderName(resource.name));
        await this.enrichShaderResourceNames(shaderResources);

        return resources;
    }

    private async enrichShaderResourceNames(resources: ResourceInfo[]): Promise<void> {
        const maxConcurrency = 4;
        let index = 0;
        const runWorker = async () => {
            while (index < resources.length) {
                const current = resources[index++];
                try {
                    const metadata = await this.resolveShaderResourceMetadata(current.resourceId, current.name);
                    current.name = metadata.name;
                    current.shaderStages = metadata.stages;
                } catch {
                    // Keep the original resource name if reflection lookup fails.
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(maxConcurrency, resources.length) }, () => runWorker()));
    }

    async resolveShaderResourceMetadata(resourceId: string, fallbackName = ''): Promise<{ name: string; stages: string[] }> {
        const cached = this.shaderDisplayNameCache.get(resourceId);
        let entries: TGetShaderEntryPointsResponse['entryPoints'] = [];
        try {
            const epRes = await this.nativeCallT('getShaderEntryPoints', GetShaderEntryPointsResponse, { resourceId });
            entries = epRes.entryPoints;
        } catch {
            const fallback = fallbackName || `Shader ${resourceId}`;
            this.shaderDisplayNameCache.set(resourceId, fallback);
            return { name: cached || fallback, stages: [] };
        }

        if (entries.length === 0) {
            entries = [{ name: 'main', stage: 0 }];
        }

        const stages = Array.from(new Set(entries.map((entry) => normalizeShaderStageLabel(stageToLabel(entry.stage))))).filter(Boolean).sort();

        if (cached && stages.length > 0) {
            return { name: cached, stages };
        }

        for (const entry of entries) {
            try {
                const source = await this.nativeCallT(
                    'getShaderSource',
                    GetShaderSourceResponse,
                    { resourceId, entryPoint: entry.name, stage: entry.stage },
                );
                const resolved = deriveShaderDisplayName(source, fallbackName, resourceId);
                this.shaderDisplayNameCache.set(resourceId, resolved);
                return { name: resolved, stages };
            } catch {
                // Try the next entry point.
            }
        }

        const fallback = fallbackName || `Shader ${resourceId}`;
        this.shaderDisplayNameCache.set(resourceId, fallback);
        return { name: cached || fallback, stages };
    }

    async resolveShaderDisplayName(resourceId: string, fallbackName = ''): Promise<string> {
        const metadata = await this.resolveShaderResourceMetadata(resourceId, fallbackName);
        return metadata.name;
    }

    async getShaderSourceByResource(resourceId: string): Promise<{ displayName: string; panelData: Record<string, string> }> {
        if (!this.hasNativeBridge()) {
            throw new Error(NATIVE_REPLAY_REQUIRED_MSG);
        }

        let entries: TGetShaderEntryPointsResponse['entryPoints'] = [];
        const epRes = await this.nativeCallT('getShaderEntryPoints', GetShaderEntryPointsResponse, { resourceId });
        entries = epRes.entryPoints;
        if (entries.length === 0) {
            entries = [{ name: 'main', stage: 0 }];
        }

        const displayName = await this.resolveShaderDisplayName(resourceId, `Shader ${resourceId}`);
        const panelData: Record<string, string> = {};

        for (const entry of entries) {
            const source = await this.nativeCallT(
                'getShaderSource',
                GetShaderSourceResponse,
                { resourceId, entryPoint: entry.name, stage: entry.stage },
            );
            const files = source.sourceFiles || [];
            let code = '';
            if (files.length > 0) {
                code = files.map((file) => file.contents || '').join('\n\n');
            } else if (typeof source.disassembly === 'string') {
                code = source.disassembly;
            }
            if (!code.trim()) {
                continue;
            }
            const entrySuffix = source.entryPoint && source.entryPoint !== 'main' ? ` (${source.entryPoint})` : '';
            panelData[`${stageToLabel(source.stage)}  ${displayName}${entrySuffix}`] = code;
        }

        if (Object.keys(panelData).length === 0) {
            throw new Error(`No shader source returned for resource ${resourceId}.`);
        }

        return { displayName, panelData };
    }

    async buildShaderMetadataMap(
        drawCalls: DrawCall[],
        onProgress?: (completed: number, total: number) => void,
    ): Promise<Map<string, { name: string; stages: string[] }>> {
        if (!this.hasNativeBridge()) {
            throw new Error(NATIVE_REPLAY_REQUIRED_MSG);
        }

        const eventIds = collectPipelineEventIds(drawCalls);
        const metadata = new Map<string, { name: string; stages: Set<string> }>();
        const total = eventIds.length;

        for (let index = 0; index < eventIds.length; index++) {
            const eventId = eventIds[index];
            try {
                const pipeline = await this.nativeGetPipelineState(eventId);
                const shaders = pipeline?.shaders || {};
                for (const [stageKey, info] of Object.entries(shaders) as [string, any][]) {
                    if (!info || info.resourceId == null) { continue; }
                    const resourceId = String(info.resourceId);
                    const alias = pickPipelineShaderAlias(info);
                    const stage = pipelineStageKeyToLabel(stageKey, info);

                    const existing = metadata.get(resourceId) || {
                        name: this.shaderDisplayNameCache.get(resourceId) || '',
                        stages: new Set<string>(),
                    };
                    if (stage) {
                        existing.stages.add(stage);
                    }
                    if (alias && (!existing.name || (isWeakShaderDisplayName(existing.name) && !isWeakShaderDisplayName(alias)))) {
                        existing.name = alias;
                        this.shaderDisplayNameCache.set(resourceId, alias);
                    }
                    metadata.set(resourceId, existing);
                }
            } catch {
                // Some events don't expose valid pipeline state; keep scanning.
            }

            if (onProgress) {
                onProgress(index + 1, total);
            }
        }

        return new Map(
            Array.from(metadata.entries()).map(([resourceId, value]) => [
                resourceId,
                {
                    name: value.name,
                    stages: Array.from(value.stages).sort(),
                },
            ])
        );
    }

    /** Get capture thumbnail, preferring the embedded RDC thumbnail parser. */
    async getThumbnail(filePath: string): Promise<ThumbnailData | null> {
        try {
            const parsedThumbnail = await parseRdcThumbnail(filePath);
            if (parsedThumbnail) {
                return parsedThumbnail;
            }
        } catch {
            // Fall through to renderdoccmd for unsupported or malformed thumbnail payloads.
        }

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
            try { await fs.promises.unlink(tmpFile); } catch {
                // Best-effort cleanup for temp preview files.
            }
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
    private nativeBridgeRenderdocPath: string | undefined;
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
        logRenderDocInfo('Attempting to start native bridge.', {
            bridgePath: bridgePath ?? '<not found>',
            renderdocPath: this.renderdocPath ?? '<unset>',
        });
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
            this.nativeFeatureSupport.clear();
            console.log('[RenderDoc] Native bridge spawned, pid:', child.pid);
            logRenderDocInfo('Native bridge spawned.', {
                pid: child.pid,
                bridgePath,
                cwd: this.renderdocPath || process.cwd(),
            });

            child.stdout?.on('data', (data: Buffer) => {
                // Only process output from the current bridge. Stale data from
                // a previously-killed bridge (during a restart) must be ignored
                // so it doesn't corrupt the new bridge's response stream.
                if (this.nativeProcess !== child) { return; }
                this.nativeOutputBuffer += data.toString();
                this.processNativeOutput();
            });

            child.stderr?.on('data', (data: Buffer) => {
                const lines = data.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
                for (const line of lines) {
                    console.log('[RenderDoc] bridge stderr:', line);
                    logRenderDocDiagnostic(classifyBridgeStderr(line), 'Native bridge stderr', line);
                }
            });

            child.on('exit', (code, signal) => {
                console.log('[RenderDoc] Native bridge exited with code:', code, 'pid:', child.pid);
                logRenderDocWarning('Native bridge exited.', {
                    pid: child.pid,
                    code,
                    signal,
                    pendingRequests: Array.from(this.nativePendingRequests.values()).map((pending) => pending.method),
                });
                // Only clear state if this is still the active process.
                // During a restart the old process's exit fires AFTER the new
                // one has already been spawned — without this guard it would
                // clobber the new `nativeProcess` reference and any pending
                // requests queued against the new bridge.
                if (this.nativeProcess !== child) { return; }
                this.nativeProcess = undefined;
                this.nativeBridgeRenderdocPath = undefined;
                this.nativeFeatureSupport.clear();
                // Reject all pending requests
                for (const [, pending] of this.nativePendingRequests) {
                    pending.reject(new BridgeError('exited', 'Native bridge process exited', { method: pending.method }));
                }
                this.nativePendingRequests.clear();
            });

            child.on('error', (err) => {
                console.error('[RenderDoc] Native bridge spawn error:', err.message);
                logRenderDocError('Native bridge spawn error.', err);
                if (this.nativeProcess !== child) { return; }
                this.nativeProcess = undefined;
                this.nativeBridgeRenderdocPath = undefined;
            });

            // Initialize with RenderDoc path
            if (this.renderdocPath) {
                this.nativeCall('init', { renderdocPath: this.renderdocPath }).catch((error) => {
                    logRenderDocError('Native bridge init failed.', error);
                });
            }
        } catch (error) {
            logRenderDocError('Failed to spawn native bridge.', error);
            this.nativeProcess = undefined;
        }
    }

    /** Kill and restart the native bridge (e.g. after installing ANGLE DLLs) */
    restartNativeBridge(): void {
        if (this.nativeProcess) {
            try { this.nativeProcess.kill(); } catch { /* ignore */ }
            this.nativeProcess = undefined;
        }
        this.nativeBridgeRenderdocPath = undefined;
        this.nativeFeatureSupport.clear();
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

        // 1. Next to the extension (dev build or VSIX-bundled)
        const extensionDir = this.getExtensionDir();
        const candidates = [
            path.join(extensionDir, 'native', 'build', 'Release', exeName),
            path.join(extensionDir, 'native', 'build', exeName),
            path.join(extensionDir, exeName),
        ];

        // 2. Downloaded copy in globalStorage (populated on first run)
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
                        if (!shouldSuppressNativeErrorLog(pending.method, msg.error.code, String(msg.error.message || ''))) {
                            logRenderDocWarning(`Native bridge call failed: ${pending.method}`, {
                                code: msg.error.code,
                                message: msg.error.message,
                            });
                        }
                        pending.reject(new BridgeError(
                            'remote',
                            msg.error.message || 'Unknown native bridge error',
                            { method: pending.method, code: msg.error.code },
                        ));
                    } else {
                        if (shouldTraceNativeMethod(pending.method)) {
                            logRenderDocInfo(`Native bridge call succeeded: ${pending.method}`, summarizeNativeResult(pending.method, msg.result));
                        }
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
                logRenderDocWarning('Ignored unparseable native bridge stdout line.', trimmed);
            }
        }
    }

    /** Send a JSON-RPC style request to the native bridge */
    private nativeCall(method: string, params: any = {}, timeoutMs?: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            if (!this.nativeProcess || !this.nativeProcess.stdin) {
                logRenderDocError(`Native bridge unavailable before call: ${method}`);
                reject(new BridgeError('unavailable', 'Native bridge not available', { method }));
                return;
            }
            const id = ++this.nativeRequestId;
            const msg = JSON.stringify({ id, method, params }) + '\n';

            if (shouldTraceNativeMethod(method)) {
                logRenderDocInfo(`Native bridge call started: ${method}`, summarizeNativeParams(method, params));
            }

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
                        logRenderDocError(`Native bridge call timed out: ${method}`, { timeoutMs: ms });
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
                    logRenderDocError(`Native bridge stdin write failed: ${method}`, err);
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

    async ensureNativeBridgeReady(): Promise<void> {
        if (this.pendingEnsureNativeBridgeReady) {
            return this.pendingEnsureNativeBridgeReady;
        }

        const readyPromise = (async () => {
            const available = await this.checkAvailability();
            const renderdocPath = this.renderdocPath;
            if (!available || !renderdocPath) {
                throw new Error('RenderDoc runtime is unavailable. The bundled runtime is missing and no system RenderDoc install was auto-detected.');
            }

            if (!this.hasNativeBridge()) {
                this.tryStartNativeBridge();
            } else if (this.nativeBridgeRenderdocPath !== renderdocPath || !(await this.nativePing())) {
                this.restartNativeBridge();
            }

            if (!this.hasNativeBridge()) {
                throw new Error('RenderDoc native bridge is not available.');
            }

            console.log('[RenderDoc] Native bridge init renderdocPath:', renderdocPath);
            console.log('[RenderDoc] Native bridge init cwd:', renderdocPath);
            await this.nativeCallT('init', InitResponse, { renderdocPath });
            this.nativeBridgeRenderdocPath = renderdocPath;
        })();

        this.pendingEnsureNativeBridgeReady = readyPromise;

        try {
            await readyPromise;
        } finally {
            if (this.pendingEnsureNativeBridgeReady === readyPromise) {
                this.pendingEnsureNativeBridgeReady = undefined;
            }
        }
    }

    /** Open a capture in the native replay controller */
    async nativeOpenCapture(filePath: string): Promise<TOpenCaptureResponse> {
        await this.ensureNativeBridgeReady();
        this.shaderDisplayNameCache.clear();
        console.log('[RenderDoc] nativeOpenCapture preflight capture:', filePath);
        console.log('[RenderDoc] nativeOpenCapture preflight renderdocPath:', this.renderdocPath ?? '<unset>');
        console.log('[RenderDoc] nativeOpenCapture preflight bridge cwd:', this.renderdocPath ?? '<default process cwd>');
        return this.nativeCallT('openCapture', OpenCaptureResponse, { path: filePath });
    }

    async nativeSetReplayHost(url: string): Promise<ReplayHostInfo> {
        await this.ensureNativeBridgeReady();
        const result: TReplayHostInfoResponse = await this.nativeCallT(
            'setReplayHost',
            ReplayHostInfoResponse,
            { url },
        );
        return result;
    }

    async nativeGetReplayHost(): Promise<ReplayHostInfo> {
        await this.ensureNativeBridgeReady();
        const result: TReplayHostInfoResponse = await this.nativeCallT(
            'getReplayHost',
            ReplayHostInfoResponse,
            {},
        );
        return result;
    }

    async nativePingReplayHost(): Promise<ReplayHostInfo> {
        await this.ensureNativeBridgeReady();
        const result: TReplayHostInfoResponse = await this.nativeCallT(
            'pingReplayHost',
            ReplayHostInfoResponse,
            {},
        );
        return result;
    }

    async nativeDisconnectReplayHost(): Promise<ReplayHostInfo> {
        await this.ensureNativeBridgeReady();
        const result: TReplayHostInfoResponse = await this.nativeCallT(
            'disconnectReplayHost',
            ReplayHostInfoResponse,
            {},
        );
        return result;
    }

    /** Explicitly try local replay for SuggestRemote captures (user-initiated) */
    async nativeTryReplay(): Promise<TTryReplayResponse> {
        await this.ensureNativeBridgeReady();
        // Initialising a replay driver can be very expensive for large
        // captures (Unity GLES, big D3D12 frames): compiling shaders,
        // creating a GL/D3D context, uploading resources, etc. RenderDoc's
        // own GUI doesn't time-box this operation, so we disable the
        // per-call timeout here (0 = no timeout) to match that behaviour.
        return this.nativeCallT('tryReplay', TryReplayResponse, {}, 0);
    }

    /** Get pipeline state at a specific event via native bridge */
    async nativeGetPipelineState(eventId: number): Promise<any> {
        return this.nativeCall('getPipelineState', { eventId });
    }

    async nativeGetPipelineConstantBufferContents(params: {
        eventId: number;
        stage: string;
        cbufferIndex: number;
        arrayElement?: number;
    }): Promise<TGetPipelineConstantBufferContentsResponse> {
        await this.ensureNativeBridgeReady();
        return this.nativeCallT(
            'getPipelineConstantBufferContents',
            GetPipelineConstantBufferContentsResponse,
            params,
        );
    }

    /** Get shader source at a specific event via native bridge */
    async nativeGetShaderSource(eventId: number, stage?: string): Promise<any> {
        return this.nativeCall('getShaderSourceForEvent', { eventId, stage });
    }

    async nativeApplyShaderEdit(params: {
        resourceId: string;
        shaderStage: number;
        sourceEncoding: number;
        entryPoint: string;
        entryFileIndex: number;
        compileFlags: Array<{ name: string; value: string }>;
        files: Array<{ filename: string; contents: string }>;
    }): Promise<TApplyShaderEditResponse> {
        await this.ensureNativeBridgeReady();
        return this.nativeCallT('applyShaderEdit', ApplyShaderEditResponse, params, 0);
    }

    async nativeCompileShaderEdit(params: {
        resourceId: string;
        shaderStage: number;
        sourceEncoding: number;
        entryPoint: string;
        entryFileIndex: number;
        compileFlags: Array<{ name: string; value: string }>;
        files: Array<{ filename: string; contents: string }>;
    }): Promise<TCompileShaderEditResponse> {
        await this.ensureNativeBridgeReady();
        return this.nativeCallT('compileShaderEdit', CompileShaderEditResponse, params, 0);
    }

    async nativeRevertShaderEdit(resourceId: string): Promise<TRevertShaderEditResponse> {
        await this.ensureNativeBridgeReady();
        return this.nativeCallT('revertShaderEdit', RevertShaderEditResponse, { resourceId }, 0);
    }

    /** Get texture data via native bridge (saves to temp PNG, returns base64) */
    async nativeGetTextureData(textureId: string, mip?: number, eventId?: number, channelExtract?: number): Promise<any> {
        try {
            return await this.nativeCall('getTexturePreview', { resourceId: textureId, mip: mip ?? 0, eventId: eventId ?? 0, channelExtract: channelExtract ?? -1 });
        } catch (error) {
            this.rethrowBridgeCompatibilityError('getTexturePreview', error);
        }
    }

    /** Get a RenderDoc replay-style current draw preview for the selected event. */
    async nativeGetCurrentDrawPreview(
        eventId: number,
        channelExtract: number = -1,
        overlayMode: TextureOverlayMode = 'none',
        baseGammaEnabled: boolean = true,
        resourceId?: string,
        overlayResourceId?: string,
        label?: string,
    ): Promise<any> {
        await this.ensureNativeFeature('getCurrentDrawPreview', { eventId: 0, channelExtract: -1, overlayMode: 'none' });
        try {
            return await this.nativeCall('getCurrentDrawPreview', {
                eventId,
                channelExtract,
                overlayMode,
                baseGammaEnabled,
                resourceId,
                overlayResourceId,
                label,
            });
        } catch (error) {
            this.rethrowBridgeCompatibilityError('getCurrentDrawPreview', error);
        }
    }

    private async ensureNativeFeature(method: string, probeParams: any): Promise<void> {
        if (this.nativeFeatureSupport.get(method)) {
            return;
        }
        try {
            await this.nativeCall(method, probeParams, NATIVE_PING_TIMEOUT_MS);
            this.nativeFeatureSupport.set(method, true);
            return;
        } catch (error: any) {
            const message = String(error?.message ?? error ?? '');
            if (message.includes(`Unknown method: ${method}`)) {
                this.nativeFeatureSupport.set(method, false);
                throw new Error(
                    `The native bridge executable is outdated and does not support '${method}'. ` +
                    `Rebuild or replace renderdoc_bridge.exe, then reload VS Code.`
                );
            }
            this.nativeFeatureSupport.set(method, true);
        }
    }

    private rethrowBridgeCompatibilityError(method: string, error: unknown): never {
        const message = String((error as any)?.message ?? error ?? '');
        let compatibilityMessage: string | undefined;

        if (message.includes(`Unknown method: ${method}`)) {
            compatibilityMessage =
                `The native bridge executable is outdated and does not support '${method}'. ` +
                `Rebuild or replace renderdoc_bridge.exe, then reload VS Code.`;
        } else if (message.includes('[json.exception.type_error.302]') && message.includes('type must be number, but is string')) {
            compatibilityMessage =
                'The native bridge executable is outdated and is incompatible with the current resource-id protocol. ' +
                'Rebuild or replace renderdoc_bridge.exe, then reload VS Code.';
        }

        if (!compatibilityMessage) {
            throw error;
        }

        if (BridgeError.is(error)) {
            throw new BridgeError(error.kind, `${compatibilityMessage} (${message})`, {
                method: error.method,
                code: error.code,
                issues: error.issues,
                cause: error,
            });
        }

        throw new Error(`${compatibilityMessage} (${message})`);
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
        const textures = resourceIds.map(id => ({ resourceId: id, mip: 0 }));
        return this.nativeCall('getTextureThumbBatch', { eventId, textures });
    }

    /** Get RenderDoc-style capture statistics via the native replay bridge. */
    async nativeGetCaptureStatistics(): Promise<TGetCaptureStatisticsResponse> {
        return this.nativeCallT('getCaptureStatistics', GetCaptureStatisticsResponse, {});
    }

    async nativeListCaptureTargets(): Promise<CaptureLaunchTarget[]> {
        await this.ensureNativeBridgeReady();
        const result: TListCaptureTargetsResponse = await this.nativeCallT(
            'listCaptureTargets',
            ListCaptureTargetsResponse,
            {},
        );
        return result.targets;
    }

    async nativeGetVersion(): Promise<string> {
        await this.ensureNativeBridgeReady();
        const result: TGetVersionResponse = await this.nativeCallT(
            'getVersion',
            GetVersionResponse,
            {},
        );
        return result.version;
    }

    async nativeListAttachTargets(url = ''): Promise<CaptureAttachTarget[]> {
        await this.ensureNativeBridgeReady();
        const result: TListAttachTargetsResponse = await this.nativeCallT(
            'listAttachTargets',
            ListAttachTargetsResponse,
            { url },
        );
        return result.targets;
    }

    async nativeLaunchCapture(options: LaunchCaptureOptions): Promise<LaunchCaptureResult> {
        await this.ensureNativeBridgeReady();
        const result: TLiveTargetInfoResponse = await this.nativeCallT(
            'launchCapture',
            LiveTargetInfoResponse,
            options,
            0,
        );
        return result;
    }

    async nativeAttachCapture(options: AttachCaptureOptions): Promise<LaunchCaptureResult> {
        await this.ensureNativeBridgeReady();
        const result: TLiveTargetInfoResponse = await this.nativeCallT(
            'attachCapture',
            LiveTargetInfoResponse,
            options,
            0,
        );
        return result;
    }

    async nativeGetLiveTarget(): Promise<LiveTargetInfo | undefined> {
        await this.ensureNativeBridgeReady();
        const result = await this.nativeCall('getLiveTarget', {});
        if (!result) {
            return undefined;
        }
        return validateResponse(LiveTargetInfoResponse, result, 'getLiveTarget');
    }

    async nativeTriggerCapture(options: TriggerCaptureOptions): Promise<TriggerCaptureResult> {
        await this.ensureNativeBridgeReady();
        const result: TTriggerCaptureResponse = await this.nativeCallT(
            'triggerCapture',
            TriggerCaptureResponse,
            options,
            0,
        );
        return result;
    }

    async nativeDisconnectLiveTarget(): Promise<void> {
        await this.ensureNativeBridgeReady();
        await this.nativeCall('disconnectLiveTarget', {}, 0);
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

    /** Get raw buffer contents via native bridge. Returns base64-encoded bytes. */
    async nativeGetBufferContents(resourceId: string, offset?: number, len?: number, eventId?: number): Promise<any> {
        return this.nativeCall('getBufferContents', {
            resourceId,
            offset: offset ?? 0,
            len: len ?? 4096,
            eventId: eventId ?? 0,
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
