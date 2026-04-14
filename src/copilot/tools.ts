import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';
import { CaptureInfo, DrawCall, ResourceInfo } from '../types';

// Shared state — set by extension.ts after bridge/providers are initialized
let _bridge: RenderDocBridge;
let _getCurrentCapturePath: () => string | undefined;

export function initTools(bridge: RenderDocBridge, getCurrentCapturePath: () => string | undefined) {
    _bridge = bridge;
    _getCurrentCapturePath = getCurrentCapturePath;
}

function requireCapturePath(): string {
    const p = _getCurrentCapturePath();
    if (!p) { throw new Error('No capture file is currently loaded. Use the "RenderDoc: Open RDC Capture" command first.'); }
    return p;
}

// ─── Tool: Get Capture Info ─────────────────────────────────────────────────
export class GetCaptureInfoTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const info = await _bridge.getCaptureInfo(filePath);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(info, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: 'Reading capture file metadata…',
        };
    }
}

// ─── Tool: Get Draw Calls ───────────────────────────────────────────────────
interface GetDrawCallsInput { filter?: string }

export class GetDrawCallsTool implements vscode.LanguageModelTool<GetDrawCallsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDrawCallsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        let drawCalls = await _bridge.getDrawCalls(filePath);

        const filter = options.input?.filter?.toLowerCase();
        if (filter) {
            drawCalls = filterDrawCalls(drawCalls, filter);
        }

        // Summarize to avoid overwhelming context
        const summary = summarizeDrawCalls(drawCalls);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetDrawCallsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading draw calls…' };
    }
}

// ─── Tool: Get Resources ────────────────────────────────────────────────────
interface GetResourcesInput { type?: string }

export class GetResourcesTool implements vscode.LanguageModelTool<GetResourcesInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetResourcesInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        let resources = await _bridge.getResources(filePath);

        if (options.input?.type) {
            const t = options.input.type.toLowerCase();
            resources = resources.filter(r => r.type.toLowerCase() === t);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(resources, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetResourcesInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading resources…' };
    }
}

// ─── Tool: Get Resource Detail ──────────────────────────────────────────────
interface GetResourceDetailInput { resourceId: string }

export class GetResourceDetailTool implements vscode.LanguageModelTool<GetResourceDetailInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetResourceDetailInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const detail = await _bridge.getResourceDetail(filePath, options.input.resourceId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(detail, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetResourceDetailInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading resource details…' };
    }
}

// ─── Tool: Get Event Details ────────────────────────────────────────────────
interface GetEventDetailsInput { eventId: number }

export class GetEventDetailsTool implements vscode.LanguageModelTool<GetEventDetailsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetEventDetailsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const drawCalls = await _bridge.getDrawCalls(filePath);
        const eventId = options.input.eventId;

        // Find the draw call with this eventId
        const found = findDrawCallByEventId(drawCalls, eventId);
        if (!found) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No draw call found with eventId ${eventId}`),
            ]);
        }

        // Try to get pipeline state from native bridge if available
        let pipelineState: any = null;
        if (_bridge.hasNativeBridge()) {
            try {
                pipelineState = await _bridge.nativeGetPipelineState(eventId);
            } catch { /* native bridge not available yet */ }
        }

        const result: any = {
            event: found,
            pipelineState: pipelineState ?? 'Native bridge required for pipeline state. Currently using CLI-only mode.',
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetEventDetailsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Looking up event #${_options.input.eventId}…` };
    }
}

// ─── Tool: Get Pipeline State ───────────────────────────────────────────────
interface GetPipelineStateInput { eventId: number }

export class GetPipelineStateTool implements vscode.LanguageModelTool<GetPipelineStateInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetPipelineStateInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Pipeline state inspection requires the native RenderDoc bridge (renderdoc_bridge.exe). ' +
                    'It is not yet available. Falling back to partial information from XML conversion.',
                ),
            ]);
        }
        const state = await _bridge.nativeGetPipelineState(options.input.eventId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(state, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetPipelineStateInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Getting pipeline state at event #${_options.input.eventId}…` };
    }
}

// ─── Tool: Get Shader Source ────────────────────────────────────────────────
interface GetShaderSourceInput { eventId: number; stage?: string }

export class GetShaderSourceTool implements vscode.LanguageModelTool<GetShaderSourceInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetShaderSourceInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            // Fallback: try to extract shaders from XML
            const filePath = requireCapturePath();
            const shaders = await _bridge.getShaderSourcesFromXml(filePath);
            if (shaders.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No shader sources found in the capture XML. Native bridge required for full shader access.'),
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(shaders, null, 2)),
            ]);
        }

        const result = await _bridge.nativeGetShaderSource(options.input.eventId, options.input.stage);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetShaderSourceInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Retrieving shader source code…' };
    }
}

// ─── Tool: Get Texture Info ─────────────────────────────────────────────────
interface GetTextureInfoInput { textureId?: string }

export class GetTextureInfoTool implements vscode.LanguageModelTool<GetTextureInfoInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTextureInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const resources = await _bridge.getResources(filePath);
        let textures = resources.filter(r => r.type === 'Texture');

        if (options.input?.textureId) {
            textures = textures.filter(r => r.resourceId === options.input!.textureId);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(textures, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetTextureInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Looking up texture info…' };
    }
}

// ─── Tool: Analyze Frame Performance ────────────────────────────────────────
export class AnalyzeFrameTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const [info, drawCalls, resources] = await Promise.all([
            _bridge.getCaptureInfo(filePath),
            _bridge.getDrawCalls(filePath),
            _bridge.getResources(filePath),
        ]);

        const analysis = buildFrameAnalysis(info, drawCalls, resources);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(analysis, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Analyzing frame performance…' };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function filterDrawCalls(drawCalls: DrawCall[], filter: string): DrawCall[] {
    const result: DrawCall[] = [];
    for (const dc of drawCalls) {
        if (dc.name.toLowerCase().includes(filter)) {
            result.push(dc);
        }
        if (dc.children?.length) {
            const filtered = filterDrawCalls(dc.children, filter);
            result.push(...filtered);
        }
    }
    return result;
}

function findDrawCallByEventId(drawCalls: DrawCall[], eventId: number): DrawCall | undefined {
    for (const dc of drawCalls) {
        if (dc.eventId === eventId) { return dc; }
        if (dc.children?.length) {
            const found = findDrawCallByEventId(dc.children, eventId);
            if (found) { return found; }
        }
    }
    return undefined;
}

interface DrawCallSummary {
    totalCount: number;
    drawCount: number;
    clearCount: number;
    dispatchCount: number;
    otherCount: number;
    topLevelGroups: number;
    drawCalls: DrawCall[];
}

function summarizeDrawCalls(drawCalls: DrawCall[]): DrawCallSummary {
    let drawCount = 0, clearCount = 0, dispatchCount = 0, otherCount = 0;
    const flat: DrawCall[] = [];

    function walk(list: DrawCall[]) {
        for (const dc of list) {
            flat.push(dc);
            const lower = dc.name.toLowerCase();
            if (lower.includes('draw')) { drawCount++; }
            else if (lower.includes('clear')) { clearCount++; }
            else if (lower.includes('dispatch')) { dispatchCount++; }
            else { otherCount++; }
            if (dc.children?.length) { walk(dc.children); }
        }
    }
    walk(drawCalls);

    return {
        totalCount: flat.length,
        drawCount,
        clearCount,
        dispatchCount,
        otherCount,
        topLevelGroups: drawCalls.length,
        drawCalls: flat.length > 200 ? flat.slice(0, 200) : flat,
    };
}

function buildFrameAnalysis(info: CaptureInfo, drawCalls: DrawCall[], resources: ResourceInfo[]) {
    const dcSummary = summarizeDrawCalls(drawCalls);
    const textures = resources.filter(r => r.type === 'Texture');
    const buffers = resources.filter(r => r.type === 'Buffer');
    const shaders = resources.filter(r => r.type === 'Shader');

    const largeTextures = textures.filter(r => r.width >= 2048 || r.height >= 2048);
    const totalTextureBytes = textures.reduce((sum, t) => sum + (t.byteSize || 0), 0);
    const totalBufferBytes = buffers.reduce((sum, b) => sum + (b.byteSize || 0), 0);

    return {
        capture: {
            api: info.api,
            driver: info.driver,
            rdocVersion: info.rdocVersion,
        },
        drawCalls: {
            total: dcSummary.totalCount,
            draws: dcSummary.drawCount,
            clears: dcSummary.clearCount,
            dispatches: dcSummary.dispatchCount,
        },
        resources: {
            textureCount: textures.length,
            bufferCount: buffers.length,
            shaderCount: shaders.length,
            largeTextureCount: largeTextures.length,
            largeTextures: largeTextures.map(t => ({
                name: t.name,
                dimensions: `${t.width}x${t.height}`,
                format: t.format,
                byteSize: t.byteSize,
            })),
            totalTextureMemory: totalTextureBytes,
            totalBufferMemory: totalBufferBytes,
        },
        potentialIssues: detectIssues(dcSummary, textures, buffers),
    };
}

function detectIssues(
    drawCalls: DrawCallSummary,
    textures: ResourceInfo[],
    buffers: ResourceInfo[],
): string[] {
    const issues: string[] = [];

    if (drawCalls.totalCount > 500) {
        issues.push(`High draw call count (${drawCalls.totalCount}). Consider batching or instancing.`);
    }
    if (drawCalls.clearCount > 10) {
        issues.push(`${drawCalls.clearCount} clear operations detected. Check if all render targets need clearing.`);
    }

    const hugeTextures = textures.filter(t => t.width >= 4096 || t.height >= 4096);
    if (hugeTextures.length > 0) {
        issues.push(`${hugeTextures.length} textures are 4K+ resolution. Consider mipmapping or downscaling.`);
    }

    const totalTexMB = textures.reduce((s, t) => s + (t.byteSize || 0), 0) / (1024 * 1024);
    if (totalTexMB > 256) {
        issues.push(`Total texture memory is ${totalTexMB.toFixed(0)} MB. Consider texture compression or atlasing.`);
    }

    return issues;
}

// ─── Registration ───────────────────────────────────────────────────────────
export function registerAllTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('renderdoc_getCaptureInfo', new GetCaptureInfoTool()),
        vscode.lm.registerTool('renderdoc_getDrawCalls', new GetDrawCallsTool()),
        vscode.lm.registerTool('renderdoc_getResources', new GetResourcesTool()),
        vscode.lm.registerTool('renderdoc_getResourceDetail', new GetResourceDetailTool()),
        vscode.lm.registerTool('renderdoc_getEventDetails', new GetEventDetailsTool()),
        vscode.lm.registerTool('renderdoc_getPipelineState', new GetPipelineStateTool()),
        vscode.lm.registerTool('renderdoc_getShaderSource', new GetShaderSourceTool()),
        vscode.lm.registerTool('renderdoc_getTextureInfo', new GetTextureInfoTool()),
        vscode.lm.registerTool('renderdoc_analyzeFrame', new AnalyzeFrameTool()),
    );
}
