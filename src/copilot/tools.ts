import * as vscode from 'vscode';
import * as path from 'path';
import { RenderDocBridge } from '../renderdocBridge';
import { CaptureInfo, DrawCall, ResourceInfo } from '../types';
import { InspectorPanel } from '../views/inspectorPanel';

// Shared state — set by extension.ts after bridge/providers are initialized
let _bridge: RenderDocBridge;
let _getCurrentCapturePath: () => string | undefined;
let _getSelectionContext: () => { selectedDrawCall: any; selectedResource: any };
let _getCurrentDrawCalls: () => DrawCall[];

export function initTools(
    bridge: RenderDocBridge,
    getCurrentCapturePath: () => string | undefined,
    getSelectionContext: () => { selectedDrawCall: any; selectedResource: any },
    getCurrentDrawCalls?: () => DrawCall[],
) {
    _bridge = bridge;
    _getCurrentCapturePath = getCurrentCapturePath;
    _getSelectionContext = getSelectionContext;
    _getCurrentDrawCalls = getCurrentDrawCalls ?? (() => []);
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
interface GetDrawCallsInput {
    filter?: string;
    /** Only include draw calls whose ancestor marker name contains this string (case-insensitive). */
    markerFilter?: string;
    /** Exclude marker/group nodes; return only leaf events. */
    excludeMarkers?: boolean;
    /** Only return actual GPU draw operations (Drawcall, Dispatch, MeshDispatch flags). */
    onlyDrawCalls?: boolean;
    /** Only include events with eventId >= this value. */
    eventIdMin?: number;
    /** Only include events with eventId <= this value. */
    eventIdMax?: number;
}

interface GetActionTimingsInput {
    /** Optional list of specific event IDs to query. If omitted, returns all matching leaf actions. */
    eventIds?: number[];
    /** Only include actions inside a marker group whose name contains this string (case-insensitive). */
    markerFilter?: string;
    /** Exclude actions inside marker groups whose names contain any of these strings (case-insensitive). */
    excludeMarkers?: string[];
    /** Only include actual draw/dispatch/mesh-dispatch leaf actions. */
    onlyDrawCalls?: boolean;
    /** Maximum timing rows to return. Defaults to 200. Set to 0 for unlimited. */
    limit?: number;
}

export class GetDrawCallsTool implements vscode.LanguageModelTool<GetDrawCallsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDrawCallsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        // Prefer the in-memory draw calls (may contain durationUs from fetchTimings).
        // Fall back to re-fetching from the bridge if nothing is cached yet.
        let drawCalls = _getCurrentDrawCalls();
        if (drawCalls.length === 0) {
            drawCalls = await _bridge.getDrawCalls(filePath);
        }

        const filter = options.input?.filter?.toLowerCase();
        if (filter) {
            drawCalls = filterDrawCalls(drawCalls, filter);
        }

        // Apply new filter options
        const { markerFilter, excludeMarkers, onlyDrawCalls, eventIdMin, eventIdMax } = options.input ?? {};
        if (markerFilter || excludeMarkers || onlyDrawCalls || eventIdMin !== undefined || eventIdMax !== undefined) {
            drawCalls = filterDrawCallsAdvanced(drawCalls, { markerFilter, excludeMarkers, onlyDrawCalls, eventIdMin, eventIdMax });
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

export class GetActionTimingsTool implements vscode.LanguageModelTool<GetActionTimingsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetActionTimingsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        requireCapturePath();

        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'GPU timings require an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        let timings: Map<number, number>;
        try {
            timings = await _bridge.getDrawTimings();
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: err.message,
                }, null, 2)),
            ]);
        }

        let drawCalls = _getCurrentDrawCalls();
        if (drawCalls.length === 0) {
            drawCalls = await _bridge.getDrawCalls(requireCapturePath());
        }

        applyTimingsToDrawCallTree(drawCalls, timings);

        const limit = options.input?.limit === 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, options.input?.limit ?? 200);
        const eventIdSet = options.input?.eventIds?.length ? new Set(options.input.eventIds) : undefined;
        const entries = collectActionTimingEntries(drawCalls, {
            eventIdSet,
            markerFilter: options.input?.markerFilter,
            excludeMarkers: options.input?.excludeMarkers,
            onlyDrawCalls: options.input?.onlyDrawCalls,
        }).sort((a, b) => b.durationUs - a.durationUs);

        const truncated = entries.length > limit;
        const returned = entries.slice(0, limit);
        const missingEventIds = eventIdSet
            ? Array.from(eventIdSet).filter((eventId) => !entries.some((entry) => entry.eventId === eventId))
            : [];

        const payload = {
            available: true,
            unit: 'microseconds',
            fetchedEventCount: timings.size,
            returned: returned.length,
            totalMatched: entries.length,
            truncated,
            missingEventIds: missingEventIds.length > 0 ? missingEventIds : undefined,
            timings: returned,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetActionTimingsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const scope = options.input?.eventIds?.length
            ? `${options.input.eventIds.length} selected events`
            : 'the current capture';
        return { invocationMessage: `Fetching GPU timings for ${scope}…` };
    }
}

// ─── Tool: Get Resources ────────────────────────────────────────────────────
interface GetResourcesInput {
    type?: string;
    /** Max entries to return. Defaults to 500. Set to 0 for unlimited (discouraged for large captures). */
    limit?: number;
    /** Offset for pagination. Defaults to 0. */
    offset?: number;
}

/** Default cap — prevents dumping thousands of entries into a tool response. */
const RESOURCES_DEFAULT_LIMIT = 500;

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

        const total = resources.length;
        const offset = Math.max(0, options.input?.offset ?? 0);
        const rawLimit = options.input?.limit;
        const limit = rawLimit === 0 ? total : (rawLimit ?? RESOURCES_DEFAULT_LIMIT);
        const page = resources.slice(offset, offset + limit);
        const truncated = page.length < total - offset;

        const payload = {
            total,
            offset,
            limit,
            returned: page.length,
            truncated,
            nextOffset: truncated ? offset + page.length : null,
            resources: page,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
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
                    'Pipeline state inspection requires an active local replay via the RenderDoc native bridge.',
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
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Shader source requires an active local replay. The RenderDoc native bridge is not running.'
                ),
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

interface GetShaderInfoInput {
    /** Event ID to inspect. */
    eventId: number;
    /** Optional shader stage filter, e.g. vertex, fragment, pixel, compute. */
    stage?: string;
    /** Include full source files / disassembly when available. Defaults to true when stage is specified. */
    includeSource?: boolean;
    /** Include decoded constant buffer contents. Defaults to true. */
    includeConstantBuffers?: boolean;
}

export class GetShaderInfoTool implements vscode.LanguageModelTool<GetShaderInfoInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetShaderInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Shader inspection requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const includeSource = options.input.includeSource ?? !!options.input.stage;
        const includeConstantBuffers = options.input.includeConstantBuffers ?? true;

        const [shaderPayload, pipelineState] = await Promise.all([
            _bridge.nativeGetShaderSource(options.input.eventId),
            _bridge.nativeGetPipelineState(options.input.eventId),
        ]);

        const shaderStages = (shaderPayload && typeof shaderPayload === 'object' && shaderPayload.shaders)
            ? shaderPayload.shaders as Record<string, any>
            : {};
        const stageResources = (pipelineState && typeof pipelineState === 'object' && pipelineState.stageResources)
            ? pipelineState.stageResources as Record<string, any>
            : {};

        const availableStages = collectAvailableShaderStages(shaderStages, stageResources);
        const resolvedStages = resolveRequestedShaderStages(options.input.stage, availableStages);

        if (resolvedStages.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId: options.input.eventId,
                    requestedStage: options.input.stage ?? null,
                    availableStages,
                    reason: options.input.stage
                        ? `Requested shader stage "${options.input.stage}" is not bound at this event.`
                        : 'No shaders are bound at this event.',
                }, null, 2)),
            ]);
        }

        const stages: Record<string, any> = {};
        for (const stageKey of resolvedStages) {
            const shader = shaderStages[stageKey] ?? null;
            const resources = stageResources[stageKey] ?? {};
            const stageSummary: any = {
                shader: summarizeShaderStage(shader, includeSource),
                bindings: {
                    textures: summarizeShaderTextures(resources.textures),
                    samplers: summarizeShaderSamplers(resources.samplers),
                    constantBlocks: summarizeConstantBlockMetadata(resources.constantBlocks),
                },
            };

            if (includeConstantBuffers) {
                const blockEntries = Array.isArray(resources.constantBlocks) ? resources.constantBlocks : [];
                stageSummary.constantBuffers = await Promise.all(blockEntries.map(async (block: any) => {
                    try {
                        const details = await _bridge.nativeGetPipelineConstantBufferContents({
                            eventId: options.input.eventId,
                            stage: stageKey,
                            cbufferIndex: Number(block.cbufferIndex ?? 0),
                            arrayElement: Number(block.arrayElement ?? 0),
                        });
                        return summarizeConstantBufferDetails(details);
                    } catch (err: any) {
                        return {
                            name: block?.name ?? `Constant Buffer ${block?.cbufferIndex ?? '?'}`,
                            cbufferIndex: block?.cbufferIndex,
                            arrayElement: block?.arrayElement ?? 0,
                            error: err.message,
                        };
                    }
                }));
            }

            stages[stageKey] = stageSummary;
        }

        const payload = {
            available: true,
            eventId: options.input.eventId,
            api: pipelineState?.api ?? shaderPayload?.api ?? null,
            requestedStage: options.input.stage ?? null,
            availableStages,
            sourceIncluded: includeSource,
            constantBuffersIncluded: includeConstantBuffers,
            stages,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetShaderInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const stage = options.input?.stage ? ` (${options.input.stage})` : '';
        return { invocationMessage: `Gathering shader info at EID ${options.input?.eventId}${stage}…` };
    }
}

interface FindProjectImplementationInput {
    /** Optional event ID. If omitted, the tool falls back to the focused inspector/sidebar event. */
    eventId?: number;
    /** Optional explicit shader name or shader file name to search in the project. */
    shaderName?: string;
    /** Optional explicit pass or marker name to search in C# project code. */
    passName?: string;
    /** Additional free-form search terms to include in both shader/C# project searches. */
    additionalTerms?: string[];
    /** Maximum results to return per category. Defaults to 12. */
    limit?: number;
}

export class FindProjectImplementationTool implements vscode.LanguageModelTool<FindProjectImplementationInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindProjectImplementationInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    compatibility: {
                        status: 'noWorkspace',
                        likelyProjectWorkspace: false,
                        summary: 'No project workspace is open, so source mapping cannot search shader or C# implementation files.',
                        shaderFileCount: 0,
                        csharpFileCount: 0,
                        suggestions: [
                            'Open the game or rendering project folder in this VS Code workspace.',
                            'If only the capture is open, provide an explicit shaderName or passName after opening the project.',
                        ],
                    },
                }, null, 2)),
            ]);
        }

        const eventId = resolveFocusedEventId(options.input.eventId);
        const limit = Math.max(1, options.input.limit ?? 12);
        const notes: string[] = [];
        const shaderTerms = new Map<string, ProjectSearchTerm>();
        const passTerms = new Map<string, ProjectSearchTerm>();
        const markerTerms = new Map<string, ProjectSearchTerm>();
        const drawTerms = new Map<string, ProjectSearchTerm>();
        const additionalTerms = new Map<string, ProjectSearchTerm>();

        collectProjectSearchTerms(
            shaderTerms,
            options.input.shaderName,
            inferShaderSearchSource(options.input.shaderName),
            'input.shaderName',
        );
        collectProjectSearchTerms(passTerms, options.input.passName, 'passName', 'input.passName');
        for (const term of options.input.additionalTerms ?? []) {
            collectProjectSearchTerms(additionalTerms, term, 'additional', 'input.additionalTerms');
        }

        if (eventId !== undefined) {
            if (_bridge.hasNativeBridge()) {
                try {
                    const shaderPayload = await _bridge.nativeGetShaderSource(eventId);
                    collectShaderTermsFromPayload(shaderPayload, shaderTerms);
                } catch (err: any) {
                    notes.push(`Could not derive shader names from EID ${eventId}: ${err.message}`);
                }
            } else if (!options.input.shaderName) {
                notes.push('Native bridge is unavailable, so shader names can only come from explicit input.');
            }

            try {
                const drawCalls = await getCachedOrLoadedDrawCalls();
                const trace = findDrawCallTraceByEventId(drawCalls, eventId);
                if (trace) {
                    collectTraceTerms(trace, passTerms, markerTerms, drawTerms);
                } else {
                    notes.push(`Could not resolve draw hierarchy for EID ${eventId}.`);
                }
            } catch (err: any) {
                notes.push(`Could not derive pass names from EID ${eventId}: ${err.message}`);
            }
        } else if (options.input.shaderName === undefined && options.input.passName === undefined) {
            notes.push('No event is focused, so project mapping can only use explicit shaderName, passName, or additionalTerms input.');
        }

        const shaderSearchTerms = mergeProjectSearchTerms(shaderTerms, passTerms, additionalTerms);
        const csharpSearchTerms = mergeProjectSearchTerms(passTerms, markerTerms, shaderTerms, drawTerms, additionalTerms);

        if (shaderSearchTerms.length === 0 && csharpSearchTerms.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId: eventId ?? null,
                    reason: 'No usable shader name, pass name, or additional project search term was available.',
                    derivedTerms: {
                        shaderTerms: serializeProjectSearchTerms(shaderTerms),
                        passTerms: serializeProjectSearchTerms(passTerms),
                        markerTerms: serializeProjectSearchTerms(markerTerms),
                        drawTerms: serializeProjectSearchTerms(drawTerms),
                        additionalTerms: serializeProjectSearchTerms(additionalTerms),
                    },
                    notes: notes.length > 0 ? notes : undefined,
                }, null, 2)),
            ]);
        }

        const [shaderSearch, csharpSearch] = await Promise.all([
            searchWorkspaceImplementationCandidates(shaderSearchTerms, PROJECT_SHADER_FILE_GLOB, PROJECT_SHADER_FILE_LIMIT, limit, 'shader'),
            searchWorkspaceImplementationCandidates(csharpSearchTerms, PROJECT_CSHARP_FILE_GLOB, PROJECT_CSHARP_FILE_LIMIT, limit, 'csharp'),
        ]);

        const prioritizedMatches = [...shaderSearch.matches, ...csharpSearch.matches]
            .sort(compareProjectImplementationMatches)
            .slice(0, limit * 2);
        const compatibility = assessWorkspaceCompatibility(
            workspaceFolders,
            shaderSearch,
            csharpSearch,
            prioritizedMatches,
        );

        const payload = {
            available: true,
            eventId: eventId ?? null,
            workspaceFolders: workspaceFolders.map((folder) => folder.uri.fsPath),
            compatibility,
            derivedTerms: {
                shaderTerms: serializeProjectSearchTerms(shaderTerms),
                passTerms: serializeProjectSearchTerms(passTerms),
                markerTerms: serializeProjectSearchTerms(markerTerms),
                drawTerms: serializeProjectSearchTerms(drawTerms),
                additionalTerms: serializeProjectSearchTerms(additionalTerms),
            },
            prioritizedMatches,
            shaderMatches: shaderSearch.matches,
            csharpMatches: csharpSearch.matches,
            searchedFiles: {
                shaderFiles: shaderSearch.searchedFileCount,
                csharpFiles: csharpSearch.searchedFileCount,
            },
            notes: notes.length > 0 ? notes : undefined,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindProjectImplementationInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const eventId = options.input?.eventId;
        if (eventId !== undefined) {
            return { invocationMessage: `Searching project code for implementation candidates related to EID ${eventId}…` };
        }
        return { invocationMessage: 'Searching project code for shader/pass implementation candidates…' };
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

function applyTimingsToDrawCallTree(calls: DrawCall[], timings: Map<number, number>): number {
    let aggregatedTotal = 0;

    for (const dc of calls) {
        let nodeDuration = timings.get(dc.eventId);
        let childrenTotal = 0;

        if (dc.children && dc.children.length > 0) {
            childrenTotal = applyTimingsToDrawCallTree(dc.children, timings);
        }

        if ((nodeDuration === undefined || nodeDuration < 0.0) && childrenTotal > 0) {
            nodeDuration = childrenTotal;
        }

        if (nodeDuration !== undefined && nodeDuration > 0) {
            dc.durationUs = nodeDuration;
            aggregatedTotal += nodeDuration;
        } else if (childrenTotal > 0) {
            aggregatedTotal += childrenTotal;
        }
    }

    return aggregatedTotal;
}

interface ActionTimingEntry {
    eventId: number;
    name: string;
    flags: string;
    durationUs: number;
    durationMs: number;
    fullPath: string;
    markerPath: string[];
    numIndices: number;
    numInstances: number;
}

interface CollectActionTimingOptions {
    eventIdSet?: Set<number>;
    markerFilter?: string;
    excludeMarkers?: string[];
    onlyDrawCalls?: boolean;
}

function collectActionTimingEntries(
    drawCalls: DrawCall[],
    options: CollectActionTimingOptions,
    markerPath: string[] = [],
    inMarkerScope = !options.markerFilter,
): ActionTimingEntry[] {
    const entries: ActionTimingEntry[] = [];
    const markerFilterLower = options.markerFilter?.toLowerCase();
    const excludedLower = (options.excludeMarkers ?? []).map(value => value.toLowerCase());

    for (const dc of drawCalls) {
        const markerNode = isMarkerGroup(dc);
        const nextMarkerPath = markerNode ? [...markerPath, dc.name] : markerPath;
        const excluded = excludedLower.some((needle) => nextMarkerPath.some((name) => name.toLowerCase().includes(needle)));
        if (excluded) {
            continue;
        }

        const nextInMarkerScope = !markerFilterLower
            ? true
            : inMarkerScope || (markerNode && dc.name.toLowerCase().includes(markerFilterLower));

        if (dc.children?.length) {
            entries.push(...collectActionTimingEntries(dc.children, options, nextMarkerPath, nextInMarkerScope));
            continue;
        }

        if (!nextInMarkerScope) {
            continue;
        }
        if (options.onlyDrawCalls && !isRealDrawCall(dc.flags)) {
            continue;
        }
        if (options.eventIdSet && !options.eventIdSet.has(dc.eventId)) {
            continue;
        }
        if (typeof dc.durationUs !== 'number' || dc.durationUs <= 0) {
            continue;
        }

        entries.push({
            eventId: dc.eventId,
            name: dc.name,
            flags: dc.flags,
            durationUs: dc.durationUs,
            durationMs: dc.durationUs / 1000.0,
            fullPath: nextMarkerPath.length > 0 ? `${nextMarkerPath.join(' -> ')} -> ${dc.name}` : dc.name,
            markerPath: nextMarkerPath,
            numIndices: dc.numIndices,
            numInstances: dc.numInstances,
        });
    }

    return entries;
}

interface AdvancedFilterOptions {
    markerFilter?: string;
    excludeMarkers?: boolean;
    onlyDrawCalls?: boolean;
    eventIdMin?: number;
    eventIdMax?: number;
}

/** Returns true if the flags string indicates a real GPU operation (not a marker/group). */
function isRealDrawCall(flags: string): boolean {
    const f = flags.toLowerCase();
    return f.includes('drawcall') || f.includes('dispatch') || f.includes('meshdispatch') || f.includes('clear');
}

/** Returns true if this draw call is a marker/group (has children and no GPU operation flags). */
function isMarkerGroup(dc: DrawCall): boolean {
    return !!(dc.children?.length) && !isRealDrawCall(dc.flags);
}

function collectAvailableShaderStages(shaderStages: Record<string, any>, stageResources: Record<string, any>): string[] {
    const preferredOrder = ['vertex', 'hull', 'tessControl', 'domain', 'tessEval', 'geometry', 'pixel', 'fragment', 'compute'];
    const seen = new Set<string>();
    for (const key of Object.keys(shaderStages ?? {})) {
        seen.add(key);
    }
    for (const key of Object.keys(stageResources ?? {})) {
        seen.add(key);
    }

    const ordered: string[] = [];
    for (const stage of preferredOrder) {
        if (seen.has(stage)) {
            ordered.push(stage);
            seen.delete(stage);
        }
    }
    for (const stage of seen) {
        ordered.push(stage);
    }
    return ordered;
}

function shaderStageAliases(stage?: string): string[] {
    if (!stage) {
        return [];
    }

    switch (stage.toLowerCase()) {
    case 'fragment':
    case 'pixel':
        return ['fragment', 'pixel'];
    case 'hull':
    case 'tesscontrol':
    case 'tesc':
        return ['hull', 'tesscontrol'];
    case 'domain':
    case 'tesseval':
    case 'tese':
        return ['domain', 'tesseval'];
    default:
        return [stage.toLowerCase()];
    }
}

function resolveRequestedShaderStages(requestedStage: string | undefined, availableStages: string[]): string[] {
    if (!requestedStage) {
        return availableStages;
    }

    const aliases = shaderStageAliases(requestedStage);
    return availableStages.filter(stage => aliases.includes(stage.toLowerCase()));
}

function summarizeShaderStage(stage: any, includeSource: boolean): any {
    if (!stage || typeof stage !== 'object') {
        return null;
    }

    const summary: any = {
        resourceId: stage.resourceId,
        name: stage.name,
        entryPoint: stage.entryPoint,
        shaderStage: stage.shaderStage,
        editable: stage.editable,
        hasReplacement: stage.hasReplacement,
        compiler: stage.compiler,
        sourceEncoding: stage.sourceEncoding,
        entrySourceName: stage.entrySourceName,
        compileFlags: Array.isArray(stage.compileFlags)
            ? stage.compileFlags.map((flag: any) => `${flag.name}=${flag.value}`)
            : undefined,
    };

    if (includeSource) {
        if (Array.isArray(stage.sourceFiles)) {
            summary.sourceFiles = stage.sourceFiles;
        }
        if (typeof stage.source === 'string') {
            summary.source = stage.source;
        }
        if (typeof stage.disassembly === 'string') {
            summary.disassembly = stage.disassembly;
            summary.disassemblyTarget = stage.disassemblyTarget;
        }
    } else {
        if (Array.isArray(stage.sourceFiles)) {
            summary.sourceFiles = stage.sourceFiles.map((file: any, index: number) => ({
                filename: file.filename,
                isEntry: stage.entryFileIndex === index,
                lineCount: typeof file.contents === 'string' ? file.contents.split(/\r?\n/).length : 0,
                byteLength: typeof file.contents === 'string' ? file.contents.length : 0,
            }));
        }
        summary.hasDisassembly = typeof stage.disassembly === 'string' && stage.disassembly.length > 0;
    }

    return summary;
}

function summarizeShaderTextures(entries: any): any[] {
    const textures = Array.isArray(entries) ? entries : [];
    return textures.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        slot: entry.slot,
        space: entry.space,
        arrayElement: entry.arrayElement,
        resourceId: entry.resourceId,
        resourceName: entry.resourceName,
        byteOffset: entry.byteOffset,
        byteSize: entry.byteSize,
        staticallyUnused: entry.staticallyUnused,
    }));
}

function summarizeShaderSamplers(entries: any): any[] {
    const samplers = Array.isArray(entries) ? entries : [];
    return samplers.map((entry) => ({
        name: entry.name,
        slot: entry.slot,
        space: entry.space,
        arrayElement: entry.arrayElement,
        resourceId: entry.resourceId,
        resourceName: entry.resourceName,
        minFilter: entry.minFilter,
        magFilter: entry.magFilter,
        mipFilter: entry.mipFilter,
        addressU: entry.addressU,
        addressV: entry.addressV,
        addressW: entry.addressW,
        compareEnable: entry.compareEnable,
        compareFunc: entry.compareFunc,
        staticallyUnused: entry.staticallyUnused,
    }));
}

function summarizeConstantBlockMetadata(entries: any): any[] {
    const blocks = Array.isArray(entries) ? entries : [];
    return blocks.map((entry) => ({
        name: entry.name,
        cbufferIndex: entry.cbufferIndex,
        slot: entry.slot,
        space: entry.space,
        arrayElement: entry.arrayElement,
        byteSize: entry.byteSize,
        boundByteSize: entry.boundByteSize,
        bufferBacked: entry.bufferBacked,
        compileConstants: entry.compileConstants,
        inlineDataBytes: entry.inlineDataBytes,
        variablesCount: entry.variablesCount,
        bufferResourceId: entry.bufferResourceId,
        bufferResourceName: entry.bufferResourceName,
        staticallyUnused: entry.staticallyUnused,
    }));
}

function formatShaderVariableValue(row: unknown): string {
    if (Array.isArray(row)) {
        return row.map((cell) => String(cell)).join(', ');
    }
    return row == null ? '—' : String(row);
}

function flattenShaderVariablesForAi(variables: any, prefix = '', rows: Array<{ name: string; type: string; value: string }> = []): Array<{ name: string; type: string; value: string }> {
    const list = Array.isArray(variables) ? variables : [];
    for (const variable of list) {
        const variableName = String(variable?.name ?? 'var');
        const fullName = prefix ? `${prefix}.${variableName}` : variableName;
        const type = String(variable?.type ?? variable?.baseType ?? '—');
        const members = Array.isArray(variable?.members) ? variable.members : [];
        const displayRows = Array.isArray(variable?.displayRows) ? variable.displayRows : [];

        if (members.length > 0) {
            flattenShaderVariablesForAi(members, fullName, rows);
            continue;
        }

        if (displayRows.length <= 1) {
            rows.push({
                name: fullName,
                type,
                value: displayRows.length > 0 ? formatShaderVariableValue(displayRows[0]) : '—',
            });
            continue;
        }

        displayRows.forEach((row: unknown, index: number) => {
            rows.push({
                name: `${fullName}[${index}]`,
                type,
                value: formatShaderVariableValue(row),
            });
        });
    }
    return rows;
}

function summarizeConstantBufferDetails(details: any): any {
    const rows = flattenShaderVariablesForAi(details?.variables ?? []);
    const previewLimit = 64;
    return {
        name: details?.name,
        cbufferIndex: details?.cbufferIndex,
        slot: details?.slot,
        space: details?.space,
        arrayElement: details?.arrayElement ?? 0,
        entryPoint: details?.entryPoint,
        shaderResourceId: details?.shaderResourceId,
        byteSize: details?.byteSize,
        boundByteSize: details?.boundByteSize,
        bufferBacked: details?.bufferBacked,
        compileConstants: details?.compileConstants,
        inlineDataBytes: details?.inlineDataBytes,
        staticallyUnused: details?.staticallyUnused,
        bufferResourceId: details?.bufferResourceId,
        bufferResourceName: details?.bufferResourceName,
        variableRows: rows.slice(0, previewLimit),
        totalVariableRows: rows.length,
        truncated: rows.length > previewLimit,
    };
}

const PROJECT_SHADER_FILE_GLOB = '**/*.{shader,hlsl,hlsli,glsl,vert,frag,geom,tesc,tese,comp,compute,cginc,fx,fxh,shadergraph}';
const PROJECT_CSHARP_FILE_GLOB = '**/*.cs';
const PROJECT_SEARCH_EXCLUDE_GLOB = '**/{.git,node_modules,Library,Temp,Obj,obj,Bin,bin,Logs,build,dist,out,Packages/package-cache}/**';
const PROJECT_SHADER_FILE_LIMIT = 400;
const PROJECT_CSHARP_FILE_LIMIT = 800;
const PROJECT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const PROJECT_SHADER_EXTENSIONS = new Set(['.shader', '.hlsl', '.hlsli', '.glsl', '.vert', '.frag', '.geom', '.tesc', '.tese', '.comp', '.compute', '.cginc', '.fx', '.fxh', '.shadergraph']);

type ProjectSearchTermSource = 'shaderFile' | 'shaderName' | 'passName' | 'markerPath' | 'drawName' | 'additional';

interface DrawCallTrace {
    event: DrawCall;
    markerPath: string[];
    fullPath: string[];
}

interface ProjectSearchTerm {
    value: string;
    source: ProjectSearchTermSource;
    origin: string;
}

interface ProjectImplementationMatch {
    category: 'shader' | 'csharp';
    matchKind: 'fileName' | 'content';
    term: string;
    termSource: ProjectSearchTermSource;
    origin: string;
    file: string;
    line?: number;
    preview?: string;
    score: number;
    scoreLabel: 'high' | 'medium' | 'low';
    reasons: string[];
}

interface ProjectImplementationSearchResult {
    category: 'shader' | 'csharp';
    relevantFileCount: number;
    searchedFileCount: number;
    matches: ProjectImplementationMatch[];
}

interface WorkspaceCompatibility {
    status: 'ready' | 'partial' | 'weakMatch' | 'noRelevantFiles' | 'noWorkspace';
    likelyProjectWorkspace: boolean;
    summary: string;
    shaderFileCount: number;
    csharpFileCount: number;
    suggestions: string[];
}

function resolveFocusedEventId(explicitEventId?: number): number | undefined {
    if (explicitEventId !== undefined) {
        return explicitEventId;
    }

    const inspector = InspectorPanel.currentPanel;
    const inspectorEventId = inspector?.getCurrentEventId();
    if (inspectorEventId !== undefined && inspectorEventId !== null) {
        return inspectorEventId;
    }

    const selection = _getSelectionContext();
    return selection.selectedDrawCall?.eventId;
}

async function getCachedOrLoadedDrawCalls(): Promise<DrawCall[]> {
    let drawCalls = _getCurrentDrawCalls();
    if (drawCalls.length > 0) {
        return drawCalls;
    }

    const capturePath = _getCurrentCapturePath();
    if (!capturePath) {
        return [];
    }

    drawCalls = await _bridge.getDrawCalls(capturePath);
    return drawCalls;
}

function inferShaderSearchSource(value: unknown): ProjectSearchTermSource {
    if (typeof value === 'string' && PROJECT_SHADER_EXTENSIONS.has(path.extname(value).toLowerCase())) {
        return 'shaderFile';
    }
    return 'shaderName';
}

function projectSearchTermPriority(source: ProjectSearchTermSource): number {
    switch (source) {
    case 'shaderFile':
        return 6;
    case 'shaderName':
        return 5;
    case 'passName':
        return 4;
    case 'markerPath':
        return 3;
    case 'drawName':
        return 2;
    case 'additional':
    default:
        return 1;
    }
}

function collectProjectSearchTerms(
    target: Map<string, ProjectSearchTerm>,
    value: unknown,
    source: ProjectSearchTermSource,
    origin: string,
): void {
    if (typeof value !== 'string') {
        return;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return;
    }

    const rawVariants = new Set<string>([trimmed]);
    const basename = path.basename(trimmed).trim();
    if (basename) {
        rawVariants.add(basename);
        const basenameWithoutExt = basename.replace(/\.[^.]+$/, '').trim();
        if (basenameWithoutExt) {
            rawVariants.add(basenameWithoutExt);
        }
    }

    for (const variant of rawVariants) {
        const normalized = normalizeProjectSearchTerm(variant);
        if (normalized && isUsefulProjectSearchTerm(normalized)) {
            const key = normalized.toLowerCase();
            const next: ProjectSearchTerm = { value: normalized, source, origin };
            const existing = target.get(key);
            if (!existing || projectSearchTermPriority(source) > projectSearchTermPriority(existing.source)) {
                target.set(key, next);
            }
        }
    }
}

function normalizeProjectSearchTerm(value: string): string {
    return value
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/[<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isUsefulProjectSearchTerm(value: string): boolean {
    if (value.length < 2) {
        return false;
    }

    const genericTerms = new Set([
        'main', 'shader', 'pass', 'draw', 'dispatch', 'compute', 'fragment', 'pixel', 'vertex', 'geometry', 'unknown',
    ]);

    return !genericTerms.has(value.toLowerCase());
}

function mergeProjectSearchTerms(...collections: Array<Map<string, ProjectSearchTerm>>): ProjectSearchTerm[] {
    const merged = new Map<string, ProjectSearchTerm>();
    for (const collection of collections) {
        for (const [key, term] of collection.entries()) {
            const existing = merged.get(key);
            if (!existing || projectSearchTermPriority(term.source) > projectSearchTermPriority(existing.source)) {
                merged.set(key, term);
            }
        }
    }

    return Array.from(merged.values()).sort((left, right) => {
        return projectSearchTermPriority(right.source) - projectSearchTermPriority(left.source)
            || left.value.length - right.value.length
            || left.value.localeCompare(right.value);
    });
}

function serializeProjectSearchTerms(terms: Map<string, ProjectSearchTerm>): Array<{ value: string; source: ProjectSearchTermSource; origin: string }> {
    return Array.from(terms.values()).sort((left, right) => {
        return projectSearchTermPriority(right.source) - projectSearchTermPriority(left.source)
            || left.value.localeCompare(right.value);
    }).map((term) => ({
        value: term.value,
        source: term.source,
        origin: term.origin,
    }));
}

function collectShaderTermsFromPayload(shaderPayload: any, target: Map<string, ProjectSearchTerm>): void {
    const shaders = shaderPayload && typeof shaderPayload === 'object' ? shaderPayload.shaders : undefined;
    if (!shaders || typeof shaders !== 'object') {
        return;
    }

    for (const [stageName, stage] of Object.entries(shaders as Record<string, any>)) {
        if (!stage || typeof stage !== 'object') {
            continue;
        }

        collectProjectSearchTerms(target, stage.name, 'shaderName', `shader.${stageName}.name`);
        collectProjectSearchTerms(target, stage.entrySourceName, 'shaderFile', `shader.${stageName}.entrySourceName`);
        for (const file of stage.sourceFiles ?? []) {
            collectProjectSearchTerms(target, file?.filename, 'shaderFile', `shader.${stageName}.sourceFiles.filename`);
        }
    }
}

function collectTraceTerms(
    trace: DrawCallTrace,
    passTerms: Map<string, ProjectSearchTerm>,
    markerTerms: Map<string, ProjectSearchTerm>,
    drawTerms: Map<string, ProjectSearchTerm>,
): void {
    trace.markerPath.forEach((marker, index) => {
        const isLeaf = index === trace.markerPath.length - 1;
        collectProjectSearchTerms(
            isLeaf ? passTerms : markerTerms,
            marker,
            isLeaf ? 'passName' : 'markerPath',
            `markerPath[${index}]`,
        );
    });

    collectProjectSearchTerms(drawTerms, trace.event.name, 'drawName', 'event.name');
}

function findDrawCallTraceByEventId(
    drawCalls: DrawCall[],
    eventId: number,
    markerPath: string[] = [],
    fullPath: string[] = [],
): DrawCallTrace | undefined {
    for (const drawCall of drawCalls) {
        const markerNode = isMarkerGroup(drawCall);
        const nextMarkerPath = markerNode ? [...markerPath, drawCall.name] : markerPath;
        const nextFullPath = [...fullPath, drawCall.name];

        if (drawCall.eventId === eventId) {
            return {
                event: drawCall,
                markerPath: nextMarkerPath,
                fullPath: nextFullPath,
            };
        }

        if (drawCall.children?.length) {
            const found = findDrawCallTraceByEventId(drawCall.children, eventId, nextMarkerPath, nextFullPath);
            if (found) {
                return found;
            }
        }
    }

    return undefined;
}

async function searchWorkspaceImplementationCandidates(
    terms: ProjectSearchTerm[],
    includeGlob: string,
    fileLimit: number,
    matchLimit: number,
    category: 'shader' | 'csharp',
): Promise<ProjectImplementationSearchResult> {
    if (terms.length === 0) {
        return {
            category,
            relevantFileCount: 0,
            searchedFileCount: 0,
            matches: [],
        };
    }

    const files = await vscode.workspace.findFiles(includeGlob, PROJECT_SEARCH_EXCLUDE_GLOB, fileLimit);
    const results: ProjectImplementationMatch[] = [];
    const seen = new Set<string>();
    let searchedFileCount = 0;

    for (const uri of files) {
        searchedFileCount++;
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        const relativeLower = relativePath.toLowerCase();
        const fileName = path.basename(relativePath);
        const fileNameLower = fileName.toLowerCase();
        const fileStemLower = path.basename(relativePath, path.extname(relativePath)).toLowerCase();

        for (const term of terms) {
            const needle = term.value.toLowerCase();
            const exactFileName = fileNameLower === needle || fileStemLower === needle;
            const fileNameContains = fileNameLower.includes(needle) || fileStemLower.includes(needle) || relativeLower.includes(needle);
            if (!fileNameContains) {
                continue;
            }

            const score = scoreProjectImplementationMatch(category, 'fileName', term, exactFileName);

            pushProjectImplementationMatch(results, seen, {
                category,
                matchKind: 'fileName',
                term: term.value,
                termSource: term.source,
                origin: term.origin,
                file: relativePath,
                score: score.score,
                scoreLabel: projectMatchScoreLabel(score.score),
                reasons: score.reasons,
            });
        }

        const text = await readWorkspaceTextFile(uri);
        if (!text) {
            continue;
        }

        const lines = text.split(/\r?\n/);
        const loweredLines = lines.map((line) => line.toLowerCase());

        for (const term of terms) {
            const needle = term.value.toLowerCase();
            const lineIndex = loweredLines.findIndex((line) => line.includes(needle));
            if (lineIndex === -1) {
                continue;
            }

            const rawLine = lines[lineIndex].trim();
            const exactContent = rawLine === term.value || rawLine.includes(`"${term.value}"`) || rawLine.includes(`'${term.value}'`);
            const score = scoreProjectImplementationMatch(category, 'content', term, exactContent);
            pushProjectImplementationMatch(results, seen, {
                category,
                matchKind: 'content',
                term: term.value,
                termSource: term.source,
                origin: term.origin,
                file: relativePath,
                line: lineIndex + 1,
                preview: rawLine.slice(0, 240),
                score: score.score,
                scoreLabel: projectMatchScoreLabel(score.score),
                reasons: score.reasons,
            });
        }
    }

    results.sort(compareProjectImplementationMatches);
    return {
        category,
        relevantFileCount: files.length,
        searchedFileCount,
        matches: results.slice(0, matchLimit),
    };
}

function pushProjectImplementationMatch(
    results: ProjectImplementationMatch[],
    seen: Set<string>,
    match: ProjectImplementationMatch,
): void {
    const key = `${match.category}|${match.matchKind}|${match.term.toLowerCase()}|${match.termSource}|${match.file}|${match.line ?? 0}`;
    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    results.push(match);
}

function scoreProjectImplementationMatch(
    category: 'shader' | 'csharp',
    matchKind: 'fileName' | 'content',
    term: ProjectSearchTerm,
    exact: boolean,
): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    if (matchKind === 'fileName') {
        if (category === 'shader') {
            if (term.source === 'shaderFile') {
                score += 340;
                reasons.push('shader file name match');
            } else if (term.source === 'shaderName') {
                score += 300;
                reasons.push('shader asset/name matched a shader file path');
            } else if (term.source === 'passName') {
                score += 180;
                reasons.push('pass name matched inside shader file path');
            } else if (term.source === 'additional') {
                score += 120;
                reasons.push('additional term matched a shader file path');
            } else {
                score += 80;
                reasons.push('secondary term matched a shader file path');
            }
        } else {
            if (term.source === 'passName') {
                score += 220;
                reasons.push('pass name matched a C# file path');
            } else if (term.source === 'shaderName' || term.source === 'shaderFile') {
                score += 150;
                reasons.push('shader identifier matched a C# file path');
            } else if (term.source === 'markerPath') {
                score += 130;
                reasons.push('marker path matched a C# file path');
            } else if (term.source === 'drawName') {
                score += 100;
                reasons.push('draw name matched a C# file path');
            } else {
                score += 90;
                reasons.push('additional term matched a C# file path');
            }
        }
    } else {
        if (category === 'csharp') {
            if (term.source === 'passName') {
                score += 280;
                reasons.push('C# pass string hit');
            } else if (term.source === 'markerPath') {
                score += 190;
                reasons.push('marker path hit in C# content');
            } else if (term.source === 'shaderName' || term.source === 'shaderFile') {
                score += 150;
                reasons.push('shader identifier hit in C# content');
            } else if (term.source === 'drawName') {
                score += 120;
                reasons.push('draw name hit in C# content');
            } else {
                score += 100;
                reasons.push('additional term hit in C# content');
            }
        } else {
            if (term.source === 'shaderFile') {
                score += 240;
                reasons.push('shader file-derived term hit in shader content');
            } else if (term.source === 'shaderName') {
                score += 210;
                reasons.push('shader name hit in shader content');
            } else if (term.source === 'passName') {
                score += 170;
                reasons.push('pass name hit in shader content');
            } else if (term.source === 'additional') {
                score += 100;
                reasons.push('additional term hit in shader content');
            } else {
                score += 80;
                reasons.push('secondary term hit in shader content');
            }
        }
    }

    if (exact) {
        score += 50;
        reasons.push('exact text match');
    }

    return { score, reasons };
}

function projectMatchScoreLabel(score: number): 'high' | 'medium' | 'low' {
    if (score >= 320) {
        return 'high';
    }
    if (score >= 200) {
        return 'medium';
    }
    return 'low';
}

function compareProjectImplementationMatches(left: ProjectImplementationMatch, right: ProjectImplementationMatch): number {
    return right.score - left.score
        || projectSearchTermPriority(right.termSource) - projectSearchTermPriority(left.termSource)
        || left.file.localeCompare(right.file)
        || (left.line ?? 0) - (right.line ?? 0);
}

function assessWorkspaceCompatibility(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    shaderSearch: ProjectImplementationSearchResult,
    csharpSearch: ProjectImplementationSearchResult,
    prioritizedMatches: ProjectImplementationMatch[],
): WorkspaceCompatibility {
    if (workspaceFolders.length === 0) {
        return {
            status: 'noWorkspace',
            likelyProjectWorkspace: false,
            summary: 'No project workspace is open.',
            shaderFileCount: 0,
            csharpFileCount: 0,
            suggestions: ['Open the game or rendering project folder in this workspace.'],
        };
    }

    const shaderFileCount = shaderSearch.relevantFileCount;
    const csharpFileCount = csharpSearch.relevantFileCount;
    const totalMatches = prioritizedMatches.length;
    const hasHighSignal = prioritizedMatches.some((match) => match.scoreLabel === 'high');

    if (shaderFileCount === 0 && csharpFileCount === 0) {
        return {
            status: 'noRelevantFiles',
            likelyProjectWorkspace: false,
            summary: 'The current workspace does not contain shader files or C# source files that look relevant to rendering implementation lookup.',
            shaderFileCount,
            csharpFileCount,
            suggestions: [
                'Open the actual game/rendering project workspace instead of a tools-only or extension-only folder.',
                'If the project lives in another repo, add that folder to the current VS Code workspace.',
            ],
        };
    }

    if (totalMatches === 0) {
        return {
            status: 'weakMatch',
            likelyProjectWorkspace: false,
            summary: 'The workspace has shader or C# files, but none matched the derived shader/pass/marker terms. The opened folder may be unrelated, or runtime names may differ from source names.',
            shaderFileCount,
            csharpFileCount,
            suggestions: [
                'Open the actual engine/game project if a different folder is currently active.',
                'Provide an explicit shaderName or passName if runtime names differ from source names.',
                'Check whether capture markers/pass names are too generic to map directly.',
            ],
        };
    }

    if (!hasHighSignal || shaderFileCount === 0 || csharpFileCount === 0) {
        return {
            status: 'partial',
            likelyProjectWorkspace: true,
            summary: 'The workspace looks usable, but the mapping signal is only partial. Results may be correct, but they should be treated as candidates rather than a confirmed source location.',
            shaderFileCount,
            csharpFileCount,
            suggestions: [
                'Prefer the highest-scoring matches first.',
                'If pass names are weak, try a more specific shaderName or a narrower eventId.',
            ],
        };
    }

    return {
        status: 'ready',
        likelyProjectWorkspace: true,
        summary: 'The workspace looks relevant and the highest-ranked matches have strong shader/pass mapping signals.',
        shaderFileCount,
        csharpFileCount,
        suggestions: ['Start from prioritizedMatches before exploring lower-ranked candidates.'],
    };
}

async function readWorkspaceTextFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > PROJECT_MAX_FILE_SIZE_BYTES) {
            return undefined;
        }

        const data = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(data).toString('utf8');
    } catch {
        return undefined;
    }
}

function filterDrawCallsAdvanced(drawCalls: DrawCall[], opts: AdvancedFilterOptions, ancestorMarkerMatch = false): DrawCall[] {
    const result: DrawCall[] = [];
    const markerLower = opts.markerFilter?.toLowerCase();

    for (const dc of drawCalls) {
        // Determine if this node's marker name matches the markerFilter
        const selfMarkerMatch = markerLower ? dc.name.toLowerCase().includes(markerLower) : false;
        // Propagate match downward: once inside a matching marker subtree, all descendants qualify
        const inMarkerScope = ancestorMarkerMatch || selfMarkerMatch;

        // Recurse into children first (depth-first)
        const filteredChildren = dc.children?.length
            ? filterDrawCallsAdvanced(dc.children, opts, inMarkerScope)
            : [];

        // Evaluate this node
        const passesEventIdMin = opts.eventIdMin === undefined || dc.eventId >= opts.eventIdMin;
        const passesEventIdMax = opts.eventIdMax === undefined || dc.eventId <= opts.eventIdMax;
        const passesOnlyDrawCalls = !opts.onlyDrawCalls || isRealDrawCall(dc.flags);
        const passesExcludeMarkers = !opts.excludeMarkers || !isMarkerGroup(dc);
        const passesMarkerFilter = !markerLower || inMarkerScope || filteredChildren.length > 0;

        if (passesEventIdMin && passesEventIdMax && passesOnlyDrawCalls && passesExcludeMarkers && passesMarkerFilter) {
            // Produce a copy with filtered children
            result.push({ ...dc, children: filteredChildren });
        } else if (filteredChildren.length > 0) {
            // This node didn't pass but its children did — promote children
            result.push(...filteredChildren);
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
    /** Compact top-level tree (children stripped to childCount) for context efficiency. */
    tree: CompactDrawCall[];
    /** Flat leaf-level draw calls (no children), capped at 100. */
    drawCalls: FlatDrawCall[];
    /** Top 50 most expensive draw calls (sorted by durationUs, if available). Use this for performance and timing questions! */
    expensiveDraws?: FlatDrawCall[];
    truncated: boolean;
}

interface FlatDrawCall {
    eventId: number;
    name: string;
    flags: string;
    numIndices: number;
    numInstances: number;
    durationUs?: number;
}

interface CompactDrawCall {
    eventId: number;
    name: string;
    childCount: number;
    children?: CompactDrawCall[];
}

const FLAT_LIMIT = 100;
/**
 * Compact tree depth: 0 = camera/top-level groups, 1 = render-pass sub-groups.
 * At depth >= TREE_DEPTH_LIMIT children are replaced by childCount only.
 * Keeping this at 2 means the tree expands Camera→Pass→(count) — enough for a
 * render-flow diagram without listing every individual draw call.
 */
const TREE_DEPTH_LIMIT = 2;

function toCompactTree(list: DrawCall[], depth = 0): CompactDrawCall[] {
    return list.map(dc => {
        const node: CompactDrawCall = {
            eventId: dc.eventId,
            name: dc.name,
            childCount: dc.children?.length ?? 0,
        };
        if (dc.children?.length && depth < TREE_DEPTH_LIMIT) {
            node.children = toCompactTree(dc.children, depth + 1);
        }
        return node;
    });
}

function summarizeDrawCalls(drawCalls: DrawCall[]): DrawCallSummary {
    let drawCount = 0, clearCount = 0, dispatchCount = 0, otherCount = 0;
    const flat: FlatDrawCall[] = [];

    function walk(list: DrawCall[]) {
        for (const dc of list) {
            // Strip children to avoid recursive duplication in flat list
            const { children, ...rest } = dc;
            flat.push(rest);
            const lower = dc.name.toLowerCase();
            if (lower.includes('draw')) { drawCount++; }
            else if (lower.includes('clear')) { clearCount++; }
            else if (lower.includes('dispatch')) { dispatchCount++; }
            else { otherCount++; }
            if (children?.length) { walk(children); }
        }
    }
    walk(drawCalls);

    const expensiveDraws = flat
        .filter(dc => typeof dc.durationUs === 'number')
        .sort((a, b) => b.durationUs! - a.durationUs!)
        .slice(0, 50);

    return {
        totalCount: flat.length,
        drawCount,
        clearCount,
        dispatchCount,
        otherCount,
        topLevelGroups: drawCalls.length,
        tree: toCompactTree(drawCalls),
        drawCalls: flat.slice(0, FLAT_LIMIT),
        expensiveDraws: expensiveDraws.length > 0 ? expensiveDraws : undefined,
        truncated: flat.length > FLAT_LIMIT,
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

// ─── Tool: Get Selection Context ────────────────────────────────────────────
export class GetSelectionContextTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const capturePath = _getCurrentCapturePath();
        const selection = _getSelectionContext();

        // Inspector panel represents "what the user is looking at right now".
        // Its focused event takes precedence over sidebar selection when present.
        const inspector = InspectorPanel.currentPanel;
        const inspectorEventId = inspector?.getCurrentEventId();
        const inspectorDrawCall = inspector?.getCurrentDrawCall();
        const latestMaliAnalysis = inspector?.getLatestMaliAnalysisResult();

        const focusedEventId = inspectorEventId ?? selection.selectedDrawCall?.eventId;
        const focusedDrawCall = inspectorDrawCall ?? selection.selectedDrawCall;

        const context: any = {
            captureLoaded: !!capturePath,
            capturePath: capturePath ?? null,
            hasNativeBridge: _bridge.hasNativeBridge(),
            inspectorOpen: !!inspector,
            focusedEventId: focusedEventId ?? null,
            focusedDrawCall: focusedDrawCall ?? null,
            sidebarSelectedResource: selection.selectedResource ?? null,
            latestMaliAnalysis: latestMaliAnalysis ?? null,
        };

        // Enrich with pipeline state and bound-shader summary for the focused event.
        // We deliberately do NOT include full shader source here — the model should
        // call renderdoc_getShaderSource explicitly when it needs to read code.
        if (focusedEventId !== undefined && focusedEventId !== null && _bridge.hasNativeBridge()) {
            try {
                const pipelineState = await _bridge.nativeGetPipelineState(focusedEventId);
                context.pipelineState = pipelineState;
            } catch (e: any) {
                context.pipelineStateError = e.message;
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(context, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Reading current selection context…' };
    }
}

// ─── Tool: Get Mesh Data ─────────────────────────────────────────────────────
interface GetMeshDataInput {
    eventId: number;
    /** 'vsin' = vertex shader input, 'vsout' = post-VS, 'gsout' = post-GS. Default: 'vsin' */
    stage?: 'vsin' | 'vsout' | 'gsout';
    /** Max vertices to return in 'rows'. Copilot default: 32. UI default: 256. */
    maxVertices?: number;
    /** Instance index (for instanced draws). Default: 0 */
    instance?: number;
}

export class GetMeshDataTool implements vscode.LanguageModelTool<GetMeshDataInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetMeshDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { eventId, stage = 'vsin', maxVertices = 32, instance = 0 } = options.input;
        const raw = await _bridge.nativeGetMeshData(eventId, stage, { maxVertices, instance });

        // Topology enum → readable string (mirrors RenderDoc Topology enum order)
        const TOPOLOGY = ['Unknown','PointList','LineList','LineStrip','TriangleList','TriangleStrip',
            'LineList_Adj','LineStrip_Adj','TriangleList_Adj','TriangleStrip_Adj',
            'PatchList_1CPs','PatchList_2CPs','PatchList_3CPs','PatchList_4CPs',
            'PatchList_5CPs','PatchList_6CPs','PatchList_7CPs','PatchList_8CPs',
            'PatchList_9CPs','PatchList_10CPs','PatchList_11CPs','PatchList_12CPs',
            'PatchList_13CPs','PatchList_14CPs','PatchList_15CPs','PatchList_16CPs',
        ];
        const topoStr = TOPOLOGY[raw.topology] ?? `Topology(${raw.topology})`;

        // Build a compact summary instead of dumping all raw rows
        const attrs: Array<{ name: string; format: string; used: boolean; perInstance: boolean }> =
            (raw.attributes ?? []).map((a: any) => ({
                name: a.name,
                format: a.format,
                used: a.used,
                perInstance: a.perInstance,
            }));

        // Build human-readable rows: { vtx, idx?, [attrName]: [values] }
        const attrNames: string[] = (raw.attributes ?? []).map((a: any) => a.name as string);
        const rows = (raw.rows ?? []).map((r: any) => {
            const row: Record<string, unknown> = { vtx: r.vtx };
            if (r.idx !== undefined) { row.idx = r.idx; }
            if (r.restart) { row.restart = true; }
            (r.cols ?? []).forEach((vals: number[], k: number) => {
                row[attrNames[k] ?? `attr${k}`] = vals.length === 1 ? vals[0] : vals;
            });
            return row;
        });

        const summary = {
            eventId: raw.eventId,
            stage,
            topology: topoStr,
            totalVertices: raw.totalIndices,
            returnedVertices: raw.returnedIndices,
            indexed: raw.indexByteStride > 0,
            indexByteStride: raw.indexByteStride || undefined,
            attributes: attrs,
            rows,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetMeshDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const stage = options.input?.stage ?? 'vsin';
        return { invocationMessage: `Reading mesh data (${stage}) at EID ${options.input?.eventId}…` };
    }
}

// ─── Reverse-search cache ────────────────────────────────────────────────────
// Lazily built per capture path. Maps bound resource names/IDs to event IDs.
interface ReverseSearchIndex {
    capturePath: string;
    // shaderKey → eventIds (key is lowercased shader name or entry point)
    byShader: Map<string, number[]>;
    // textureKey → eventIds
    byTexture: Map<string, number[]>;
    // resourceId string → eventIds
    byResourceId: Map<string, number[]>;
}

let _reverseSearchIndex: ReverseSearchIndex | null = null;

async function buildReverseIndex(capturePath: string): Promise<ReverseSearchIndex> {
    if (_reverseSearchIndex?.capturePath === capturePath) {
        return _reverseSearchIndex;
    }

    const idx: ReverseSearchIndex = {
        capturePath,
        byShader: new Map(),
        byTexture: new Map(),
        byResourceId: new Map(),
    };

    // Collect all leaf draw events
    let drawCalls = _getCurrentDrawCalls();
    if (drawCalls.length === 0) {
        drawCalls = await _bridge.getDrawCalls(capturePath);
    }
    const leafEvents: number[] = [];
    function collectLeaves(list: DrawCall[]) {
        for (const dc of list) {
            if (dc.children?.length) {
                collectLeaves(dc.children);
            } else {
                leafEvents.push(dc.eventId);
            }
        }
    }
    collectLeaves(drawCalls);

    function addTo(map: Map<string, number[]>, key: string, eid: number) {
        const k = key.toLowerCase();
        if (!map.has(k)) { map.set(k, []); }
        map.get(k)!.push(eid);
    }

    // Iterate leaf events and collect pipeline state bindings
    for (const eid of leafEvents) {
        try {
            const ps = await _bridge.nativeGetPipelineState(eid);
            // Shader stages: try Vulkan, D3D11, D3D12, GL structures
            const stages: any[] = [];
            if (ps.vulkan?.shaderStages) { stages.push(...ps.vulkan.shaderStages); }
            else if (ps.d3d12?.shaderStages) { stages.push(...ps.d3d12.shaderStages); }
            else if (ps.d3d11?.shaderStages) { stages.push(...ps.d3d11.shaderStages); }
            else if (ps.openGL?.shaderStages) { stages.push(...ps.openGL.shaderStages); }
            // Also check flat shaderStages in case structure differs
            if (ps.shaderStages) { stages.push(...ps.shaderStages); }

            for (const stage of stages) {
                if (stage.shaderName) { addTo(idx.byShader, stage.shaderName, eid); }
                if (stage.entryPoint) { addTo(idx.byShader, stage.entryPoint, eid); }
                if (stage.resourceId) { addTo(idx.byResourceId, String(stage.resourceId), eid); }
                // Bound textures/resources in this stage
                for (const res of (stage.resources ?? [])) {
                    if (res.resourceId) { addTo(idx.byResourceId, String(res.resourceId), eid); }
                    if (res.name) { addTo(idx.byTexture, res.name, eid); }
                }
                for (const res of (stage.readOnlyResources ?? [])) {
                    if (res.resourceId) { addTo(idx.byResourceId, String(res.resourceId), eid); }
                    if (res.name) { addTo(idx.byTexture, res.name, eid); }
                }
            }
        } catch { /* skip events where pipeline state is unavailable */ }
    }

    _reverseSearchIndex = idx;
    return idx;
}

// ─── Tool: Get Frame Summary ─────────────────────────────────────────────────
export class GetFrameSummaryTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        requireCapturePath();

        // Combine statistics + root actions for a concise frame overview
        let stats: any = null;
        let rootMarkers: any[] = [];

        if (_bridge.hasNativeBridge()) {
            try {
                stats = await _bridge.nativeGetCaptureStatistics();
            } catch { /* non-fatal */ }
            try {
                const roots = await _bridge.nativeGetRootActions();
                // roots is an array of top-level action nodes
                const actionList: any[] = Array.isArray(roots) ? roots : (roots?.actions ?? []);
                rootMarkers = actionList.map((a: any) => ({
                    eventId: a.eventId,
                    name: a.name,
                    flags: a.flags,
                    childCount: (a.children ?? []).length,
                }));
            } catch { /* non-fatal */ }
        }

        const drawCalls = _getCurrentDrawCalls();
        let drawCount = 0, dispatchCount = 0, clearCount = 0, totalCount = 0;
        function countLeaves(list: DrawCall[]) {
            for (const dc of list) {
                if (dc.children?.length) { countLeaves(dc.children); }
                else {
                    totalCount++;
                    const f = dc.flags.toLowerCase();
                    if (f.includes('drawcall') || f.includes('meshdispatch')) { drawCount++; }
                    else if (f.includes('dispatch')) { dispatchCount++; }
                    else if (f.includes('clear')) { clearCount++; }
                }
            }
        }
        countLeaves(drawCalls);

        const summary = {
            topLevelPasses: rootMarkers,
            leafCounts: { total: totalCount, draws: drawCount, dispatches: dispatchCount, clears: clearCount },
            statistics: stats ?? 'Native bridge required',
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Building frame summary…' };
    }
}

// ─── Tool: Find Draws by Shader ───────────────────────────────────────────────
interface FindDrawsByShaderInput {
    /** Shader name or entry point substring to search (case-insensitive). */
    shaderName: string;
}

export class FindDrawsByShaderTool implements vscode.LanguageModelTool<FindDrawsByShaderInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindDrawsByShaderInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Reverse shader search requires the RenderDoc native bridge.'),
            ]);
        }
        const capturePath = requireCapturePath();
        const needle = options.input.shaderName.toLowerCase();
        const idx = await buildReverseIndex(capturePath);

        const matchedEventIds: number[] = [];
        for (const [key, eids] of idx.byShader) {
            if (key.includes(needle)) {
                for (const eid of eids) {
                    if (!matchedEventIds.includes(eid)) { matchedEventIds.push(eid); }
                }
            }
        }
        matchedEventIds.sort((a, b) => a - b);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({
                query: options.input.shaderName,
                matchCount: matchedEventIds.length,
                eventIds: matchedEventIds,
            }, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindDrawsByShaderInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching draws by shader "${options.input?.shaderName}"…` };
    }
}

// ─── Tool: Find Draws by Texture ──────────────────────────────────────────────
interface FindDrawsByTextureInput {
    /** Texture name substring to search (case-insensitive). */
    textureName: string;
}

export class FindDrawsByTextureTool implements vscode.LanguageModelTool<FindDrawsByTextureInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindDrawsByTextureInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Reverse texture search requires the RenderDoc native bridge.'),
            ]);
        }
        const capturePath = requireCapturePath();
        const needle = options.input.textureName.toLowerCase();
        const idx = await buildReverseIndex(capturePath);

        const matchedEventIds: number[] = [];
        for (const [key, eids] of idx.byTexture) {
            if (key.includes(needle)) {
                for (const eid of eids) {
                    if (!matchedEventIds.includes(eid)) { matchedEventIds.push(eid); }
                }
            }
        }
        matchedEventIds.sort((a, b) => a - b);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({
                query: options.input.textureName,
                matchCount: matchedEventIds.length,
                eventIds: matchedEventIds,
            }, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindDrawsByTextureInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching draws by texture "${options.input?.textureName}"…` };
    }
}

// ─── Tool: Find Draws by Resource ID ─────────────────────────────────────────
interface FindDrawsByResourceIdInput {
    /** Resource ID string to search for. */
    resourceId: string;
}

export class FindDrawsByResourceIdTool implements vscode.LanguageModelTool<FindDrawsByResourceIdInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindDrawsByResourceIdInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Reverse resource search requires the RenderDoc native bridge.'),
            ]);
        }
        const capturePath = requireCapturePath();
        const idx = await buildReverseIndex(capturePath);

        const key = options.input.resourceId.toLowerCase();
        const matchedEventIds = (idx.byResourceId.get(key) ?? []).slice().sort((a, b) => a - b);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({
                resourceId: options.input.resourceId,
                matchCount: matchedEventIds.length,
                eventIds: matchedEventIds,
            }, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindDrawsByResourceIdInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching draws that use resource ${options.input?.resourceId}…` };
    }
}

// ─── Tool: Get Texture Data ───────────────────────────────────────────────────
interface GetTextureDataInput {
    /** Resource ID of the texture. */
    textureId: string;
    /** Mip level. Defaults to 0 (largest mip). */
    mip?: number;
    /** Event ID at which to sample the texture (0 = end of frame). */
    eventId?: number;
    /** Channel to extract: -1=all, 0=R, 1=G, 2=B, 3=A. Default: -1 */
    channelExtract?: number;
}

export class GetTextureDataTool implements vscode.LanguageModelTool<GetTextureDataInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTextureDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Texture data sampling requires the RenderDoc native bridge.'),
            ]);
        }

        const { textureId, mip = 0, eventId = 0, channelExtract = -1 } = options.input;
        const result = await _bridge.nativeGetTextureData(textureId, mip, eventId, channelExtract);

        // Return metadata + base64 data; suppress raw base64 if very large
        const summary: any = {
            resourceId: result.resourceId ?? textureId,
            width: result.width,
            height: result.height,
            format: result.format,
            mip,
            eventId,
            channelExtract,
            base64: result.base64,
            base64Length: result.base64?.length ?? 0,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetTextureDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Sampling texture ${options.input?.textureId} at mip ${options.input?.mip ?? 0}…` };
    }
}

// ─── Tool: Get Buffer Contents ────────────────────────────────────────────────
interface GetBufferContentsInput {
    /** Resource ID of the buffer. */
    resourceId: string;
    /** Byte offset into the buffer. Default: 0 */
    offset?: number;
    /** Number of bytes to read. Default: 4096. Max: 65536. */
    len?: number;
    /** Event ID at which to read the buffer (0 = end of frame). */
    eventId?: number;
}

export class GetBufferContentsTool implements vscode.LanguageModelTool<GetBufferContentsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetBufferContentsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Buffer contents reading requires the RenderDoc native bridge.'),
            ]);
        }

        const { resourceId, offset = 0, len = 4096, eventId = 0 } = options.input;
        const result = await _bridge.nativeGetBufferContents(resourceId, offset, len, eventId);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetBufferContentsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const len = options.input?.len ?? 4096;
        return { invocationMessage: `Reading ${len} bytes from buffer ${options.input?.resourceId}…` };
    }
}

// ─── Registration ───────────────────────────────────────────────────────────
export function registerAllTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('renderdoc_getCaptureInfo', new GetCaptureInfoTool()),
        vscode.lm.registerTool('renderdoc_getDrawCalls', new GetDrawCallsTool()),
        vscode.lm.registerTool('renderdoc_getActionTimings', new GetActionTimingsTool()),
        vscode.lm.registerTool('renderdoc_getResources', new GetResourcesTool()),
        vscode.lm.registerTool('renderdoc_getResourceDetail', new GetResourceDetailTool()),
        vscode.lm.registerTool('renderdoc_getEventDetails', new GetEventDetailsTool()),
        vscode.lm.registerTool('renderdoc_getPipelineState', new GetPipelineStateTool()),
        vscode.lm.registerTool('renderdoc_getShaderSource', new GetShaderSourceTool()),
        vscode.lm.registerTool('renderdoc_getShaderInfo', new GetShaderInfoTool()),
        vscode.lm.registerTool('renderdoc_findProjectImplementation', new FindProjectImplementationTool()),
        vscode.lm.registerTool('renderdoc_getTextureInfo', new GetTextureInfoTool()),
        vscode.lm.registerTool('renderdoc_analyzeFrame', new AnalyzeFrameTool()),
        vscode.lm.registerTool('renderdoc_getSelectionContext', new GetSelectionContextTool()),
        vscode.lm.registerTool('renderdoc_getMeshData', new GetMeshDataTool()),
        vscode.lm.registerTool('renderdoc_getFrameSummary', new GetFrameSummaryTool()),
        vscode.lm.registerTool('renderdoc_findDrawsByShader', new FindDrawsByShaderTool()),
        vscode.lm.registerTool('renderdoc_findDrawsByTexture', new FindDrawsByTextureTool()),
        vscode.lm.registerTool('renderdoc_findDrawsByResourceId', new FindDrawsByResourceIdTool()),
        vscode.lm.registerTool('renderdoc_getTextureData', new GetTextureDataTool()),
        vscode.lm.registerTool('renderdoc_getBufferContents', new GetBufferContentsTool()),
    );
}
