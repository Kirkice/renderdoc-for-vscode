import { RenderDocBridge } from '../renderdocBridge';
import { CaptureInfo, DrawCall, ResourceInfo } from '../types';
import { InspectorPanel } from '../views/inspectorPanel';

export interface RenderDocSelectionContext {
    selectedDrawCall: any;
    selectedResource: any;
}

export interface RenderDocToolRuntimeOptions {
    bridge: RenderDocBridge;
    getCurrentCapturePath: () => string | undefined;
    getSelectionContext: () => RenderDocSelectionContext;
    getCurrentDrawCalls?: () => DrawCall[];
}

export interface RenderDocChatToolReference {
    name: string;
    description: string;
}

export interface RenderDocToolJsonSchema {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
}

export interface RenderDocToolDefinition<Input = unknown> extends RenderDocChatToolReference {
    chatAvailability: 'always' | 'native';
    prepareInvocationMessage: (input: Input | undefined) => string;
    invoke: (input: Input | undefined) => Promise<unknown>;
}

export interface RenderDocExternalToolDefinition extends RenderDocChatToolReference {
    inputSchema: RenderDocToolJsonSchema;
}

let runtimeOptions: RenderDocToolRuntimeOptions | undefined;

export function initRenderDocToolRuntime(options: RenderDocToolRuntimeOptions): void {
    runtimeOptions = {
        ...options,
        getCurrentDrawCalls: options.getCurrentDrawCalls ?? (() => []),
    };
}

function requireRuntimeOptions(): RenderDocToolRuntimeOptions {
    if (!runtimeOptions) {
        throw new Error('RenderDoc tool runtime is not initialized.');
    }
    return runtimeOptions;
}

function getBridge(): RenderDocBridge {
    return requireRuntimeOptions().bridge;
}

function getCurrentDrawCalls(): DrawCall[] {
    return requireRuntimeOptions().getCurrentDrawCalls?.() ?? [];
}

function requireCapturePath(): string {
    const filePath = requireRuntimeOptions().getCurrentCapturePath();
    if (!filePath) {
        throw new Error('No capture file is currently loaded. Use the "RenderDoc: Open RDC Capture" command first.');
    }
    return filePath;
}

interface GetDrawCallsInput {
    filter?: string;
}

interface GetResourcesInput {
    type?: string;
    limit?: number;
    offset?: number;
}

interface GetResourceDetailInput {
    resourceId: string;
}

interface GetEventDetailsInput {
    eventId: number;
}

interface GetPipelineStateInput {
    eventId: number;
}

interface GetShaderSourceInput {
    eventId: number;
    stage?: string;
}

interface GetTextureInfoInput {
    textureId?: string;
}

interface GetMeshDataInput {
    eventId: number;
    stage?: 'vsin' | 'vsout' | 'gsout';
    maxVertices?: number;
    instance?: number;
}

interface DrawCallSummary {
    totalCount: number;
    drawCount: number;
    clearCount: number;
    dispatchCount: number;
    otherCount: number;
    topLevelGroups: number;
    tree: CompactDrawCall[];
    drawCalls: FlatDrawCall[];
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

const RESOURCES_DEFAULT_LIMIT = 500;
const FLAT_LIMIT = 100;
const TREE_DEPTH_LIMIT = 2;

function filterDrawCalls(drawCalls: DrawCall[], filter: string): DrawCall[] {
    const result: DrawCall[] = [];
    for (const drawCall of drawCalls) {
        if (drawCall.name.toLowerCase().includes(filter)) {
            result.push(drawCall);
        }
        if (drawCall.children?.length) {
            const filtered = filterDrawCalls(drawCall.children, filter);
            result.push(...filtered);
        }
    }
    return result;
}

function findDrawCallByEventId(drawCalls: DrawCall[], eventId: number): DrawCall | undefined {
    for (const drawCall of drawCalls) {
        if (drawCall.eventId === eventId) {
            return drawCall;
        }
        if (drawCall.children?.length) {
            const found = findDrawCallByEventId(drawCall.children, eventId);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

function toCompactTree(list: DrawCall[], depth = 0): CompactDrawCall[] {
    return list.map((drawCall) => {
        const node: CompactDrawCall = {
            eventId: drawCall.eventId,
            name: drawCall.name,
            childCount: drawCall.children?.length ?? 0,
        };
        if (drawCall.children?.length && depth < TREE_DEPTH_LIMIT) {
            node.children = toCompactTree(drawCall.children, depth + 1);
        }
        return node;
    });
}

function summarizeDrawCalls(drawCalls: DrawCall[]): DrawCallSummary {
    let drawCount = 0;
    let clearCount = 0;
    let dispatchCount = 0;
    let otherCount = 0;
    const flat: FlatDrawCall[] = [];

    const walk = (list: DrawCall[]) => {
        for (const drawCall of list) {
            const { children, ...rest } = drawCall;
            flat.push(rest);

            const lowerName = drawCall.name.toLowerCase();
            if (lowerName.includes('draw')) {
                drawCount++;
            } else if (lowerName.includes('clear')) {
                clearCount++;
            } else if (lowerName.includes('dispatch')) {
                dispatchCount++;
            } else {
                otherCount++;
            }

            if (children?.length) {
                walk(children);
            }
        }
    };

    walk(drawCalls);

    const expensiveDraws = flat
        .filter((drawCall) => typeof drawCall.durationUs === 'number')
        .sort((left, right) => right.durationUs! - left.durationUs!)
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

    const hugeTextures = textures.filter((texture) => texture.width >= 4096 || texture.height >= 4096);
    if (hugeTextures.length > 0) {
        issues.push(`${hugeTextures.length} textures are 4K+ resolution. Consider mipmapping or downscaling.`);
    }

    const totalTextureMegabytes = textures.reduce((sum, texture) => sum + (texture.byteSize || 0), 0) / (1024 * 1024);
    if (totalTextureMegabytes > 256) {
        issues.push(`Total texture memory is ${totalTextureMegabytes.toFixed(0)} MB. Consider texture compression or atlasing.`);
    }

    void buffers;
    return issues;
}

function buildFrameAnalysis(info: CaptureInfo, drawCalls: DrawCall[], resources: ResourceInfo[]) {
    const drawCallSummary = summarizeDrawCalls(drawCalls);
    const textures = resources.filter((resource) => resource.type === 'Texture');
    const buffers = resources.filter((resource) => resource.type === 'Buffer');
    const shaders = resources.filter((resource) => resource.type === 'Shader');

    const largeTextures = textures.filter((resource) => resource.width >= 2048 || resource.height >= 2048);
    const totalTextureBytes = textures.reduce((sum, texture) => sum + (texture.byteSize || 0), 0);
    const totalBufferBytes = buffers.reduce((sum, buffer) => sum + (buffer.byteSize || 0), 0);

    return {
        capture: {
            api: info.api,
            driver: info.driver,
            rdocVersion: info.rdocVersion,
        },
        drawCalls: {
            total: drawCallSummary.totalCount,
            draws: drawCallSummary.drawCount,
            clears: drawCallSummary.clearCount,
            dispatches: drawCallSummary.dispatchCount,
        },
        resources: {
            textureCount: textures.length,
            bufferCount: buffers.length,
            shaderCount: shaders.length,
            largeTextureCount: largeTextures.length,
            largeTextures: largeTextures.map((texture) => ({
                name: texture.name,
                dimensions: `${texture.width}x${texture.height}`,
                format: texture.format,
                byteSize: texture.byteSize,
            })),
            totalTextureMemory: totalTextureBytes,
            totalBufferMemory: totalBufferBytes,
        },
        potentialIssues: detectIssues(drawCallSummary, textures, buffers),
    };
}

const TOPOLOGY_NAMES = [
    'Unknown',
    'PointList',
    'LineList',
    'LineStrip',
    'TriangleList',
    'TriangleStrip',
    'LineList_Adj',
    'LineStrip_Adj',
    'TriangleList_Adj',
    'TriangleStrip_Adj',
    'PatchList_1CPs',
    'PatchList_2CPs',
    'PatchList_3CPs',
    'PatchList_4CPs',
    'PatchList_5CPs',
    'PatchList_6CPs',
    'PatchList_7CPs',
    'PatchList_8CPs',
    'PatchList_9CPs',
    'PatchList_10CPs',
    'PatchList_11CPs',
    'PatchList_12CPs',
    'PatchList_13CPs',
    'PatchList_14CPs',
    'PatchList_15CPs',
    'PatchList_16CPs',
];

const EMPTY_OBJECT_SCHEMA: RenderDocToolJsonSchema = {
    type: 'object',
    properties: {},
};

const TOOL_INPUT_SCHEMAS: Record<string, RenderDocToolJsonSchema> = {
    renderdoc_getSelectionContext: EMPTY_OBJECT_SCHEMA,
    renderdoc_getCaptureInfo: EMPTY_OBJECT_SCHEMA,
    renderdoc_getDrawCalls: {
        type: 'object',
        properties: {
            filter: {
                type: 'string',
                description: 'Optional name filter (case-insensitive substring match)',
            },
        },
    },
    renderdoc_getResources: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                description: 'Optional resource type filter: Texture, Buffer, Shader',
            },
            limit: {
                type: 'number',
                description: 'Max entries to return (default 500, 0 = unlimited)',
            },
            offset: {
                type: 'number',
                description: 'Offset for pagination (default 0)',
            },
        },
    },
    renderdoc_getResourceDetail: {
        type: 'object',
        properties: {
            resourceId: {
                type: 'string',
                description: 'The resource ID to look up',
            },
        },
        required: ['resourceId'],
    },
    renderdoc_getEventDetails: {
        type: 'object',
        properties: {
            eventId: {
                type: 'number',
                description: 'The event ID to inspect',
            },
        },
        required: ['eventId'],
    },
    renderdoc_getTextureInfo: {
        type: 'object',
        properties: {
            textureId: {
                type: 'string',
                description: 'Optional texture resource ID',
            },
        },
    },
    renderdoc_analyzeFrame: EMPTY_OBJECT_SCHEMA,
    renderdoc_getPipelineState: {
        type: 'object',
        properties: {
            eventId: {
                type: 'number',
                description: 'The event ID to get pipeline state for',
            },
        },
        required: ['eventId'],
    },
    renderdoc_getShaderSource: {
        type: 'object',
        properties: {
            eventId: {
                type: 'number',
                description: 'The event ID',
            },
            stage: {
                type: 'string',
                description: 'Shader stage: vertex, fragment, geometry, compute',
            },
        },
        required: ['eventId'],
    },
    renderdoc_getMeshData: {
        type: 'object',
        properties: {
            eventId: {
                type: 'number',
                description: 'The event ID to inspect',
            },
            stage: {
                type: 'string',
                description: "Mesh stage: 'vsin', 'vsout', or 'gsout'",
            },
            maxVertices: {
                type: 'number',
                description: 'Max decoded rows to return (default 32)',
            },
            instance: {
                type: 'number',
                description: 'Instance index for instanced draws (default 0)',
            },
        },
        required: ['eventId'],
    },
};

const renderDocToolDefinitions: RenderDocToolDefinition<any>[] = [
    {
        name: 'renderdoc_getSelectionContext',
        description: "Get what the user is focused on in the Inspector panel: focusedEventId, focusedDrawCall, pipelineState, sidebarSelectedResource. Call this first for any question about 'this' / 'the current' / 'the selected' item.",
        chatAvailability: 'always',
        prepareInvocationMessage: () => 'Reading current selection context…',
        invoke: async () => {
            const capturePath = requireRuntimeOptions().getCurrentCapturePath();
            const selection = requireRuntimeOptions().getSelectionContext();

            const inspector = InspectorPanel.currentPanel;
            const inspectorEventId = inspector?.getCurrentEventId();
            const inspectorDrawCall = inspector?.getCurrentDrawCall();
            const latestMaliAnalysis = inspector?.getLatestMaliAnalysisResult();

            const focusedEventId = inspectorEventId ?? selection.selectedDrawCall?.eventId;
            const focusedDrawCall = inspectorDrawCall ?? selection.selectedDrawCall;

            const context: any = {
                captureLoaded: !!capturePath,
                capturePath: capturePath ?? null,
                hasNativeBridge: getBridge().hasNativeBridge(),
                inspectorOpen: !!inspector,
                focusedEventId: focusedEventId ?? null,
                focusedDrawCall: focusedDrawCall ?? null,
                sidebarSelectedResource: selection.selectedResource ?? null,
                latestMaliAnalysis: latestMaliAnalysis ?? null,
            };

            if (focusedEventId !== undefined && focusedEventId !== null && getBridge().hasNativeBridge()) {
                try {
                    context.pipelineState = await getBridge().nativeGetPipelineState(focusedEventId);
                } catch (error: any) {
                    context.pipelineStateError = error.message;
                }
            }

            return context;
        },
    },
    {
        name: 'renderdoc_getCaptureInfo',
        description: 'Get metadata about the loaded RenderDoc capture file',
        chatAvailability: 'always',
        prepareInvocationMessage: () => 'Reading capture file metadata…',
        invoke: async () => {
            const filePath = requireCapturePath();
            return getBridge().getCaptureInfo(filePath);
        },
    },
    {
        name: 'renderdoc_getDrawCalls',
        description: 'Get draw calls from the capture, optionally filtered by name',
        chatAvailability: 'always',
        prepareInvocationMessage: () => 'Loading draw calls…',
        invoke: async (input?: GetDrawCallsInput) => {
            const filePath = requireCapturePath();
            let drawCalls = getCurrentDrawCalls();
            if (drawCalls.length === 0) {
                drawCalls = await getBridge().getDrawCalls(filePath);
            }

            const filter = input?.filter?.toLowerCase();
            if (filter) {
                drawCalls = filterDrawCalls(drawCalls, filter);
            }

            return summarizeDrawCalls(drawCalls);
        },
    },
    {
        name: 'renderdoc_getResources',
        description: 'Get GPU resources (textures, buffers, shaders), optionally filtered by type',
        chatAvailability: 'always',
        prepareInvocationMessage: () => 'Loading resources…',
        invoke: async (input?: GetResourcesInput) => {
            const filePath = requireCapturePath();
            let resources = await getBridge().getResources(filePath);

            if (input?.type) {
                const normalizedType = input.type.toLowerCase();
                resources = resources.filter((resource) => resource.type.toLowerCase() === normalizedType);
            }

            const total = resources.length;
            const offset = Math.max(0, input?.offset ?? 0);
            const rawLimit = input?.limit;
            const limit = rawLimit === 0 ? total : (rawLimit ?? RESOURCES_DEFAULT_LIMIT);
            const page = resources.slice(offset, offset + limit);
            const truncated = page.length < total - offset;

            return {
                total,
                offset,
                limit,
                returned: page.length,
                truncated,
                nextOffset: truncated ? offset + page.length : null,
                resources: page,
            };
        },
    },
    {
        name: 'renderdoc_getResourceDetail',
        description: 'Get detailed information about a specific resource by ID',
        chatAvailability: 'always',
        prepareInvocationMessage: () => 'Loading resource details…',
        invoke: async (input?: GetResourceDetailInput) => {
            if (!input?.resourceId) {
                throw new Error('resourceId is required');
            }
            const filePath = requireCapturePath();
            return getBridge().getResourceDetail(filePath, input.resourceId);
        },
    },
    {
        name: 'renderdoc_getEventDetails',
        description: 'Get details of a specific draw call event by event ID',
        chatAvailability: 'always',
        prepareInvocationMessage: (input?: GetEventDetailsInput) => `Looking up event #${input?.eventId}…`,
        invoke: async (input?: GetEventDetailsInput) => {
            if (input?.eventId === undefined) {
                throw new Error('eventId is required');
            }

            const filePath = requireCapturePath();
            const drawCalls = await getBridge().getDrawCalls(filePath);
            const found = findDrawCallByEventId(drawCalls, input.eventId);
            if (!found) {
                return `No draw call found with eventId ${input.eventId}`;
            }

            let pipelineState: any = null;
            if (getBridge().hasNativeBridge()) {
                try {
                    pipelineState = await getBridge().nativeGetPipelineState(input.eventId);
                } catch {
                    // Ignore optional pipeline-state failures for event details.
                }
            }

            return {
                event: found,
                pipelineState: pipelineState ?? 'Native bridge required for pipeline state. Currently using CLI-only mode.',
            };
        },
    },
    {
        name: 'renderdoc_getTextureInfo',
        description: 'Get texture-specific info',
        chatAvailability: 'always',
        prepareInvocationMessage: () => 'Looking up texture info…',
        invoke: async (input?: GetTextureInfoInput) => {
            const filePath = requireCapturePath();
            let textures = (await getBridge().getResources(filePath)).filter((resource) => resource.type === 'Texture');

            if (input?.textureId) {
                textures = textures.filter((resource) => resource.resourceId === input.textureId);
            }

            return textures;
        },
    },
    {
        name: 'renderdoc_analyzeFrame',
        description: 'Comprehensive frame analysis with performance issue detection',
        chatAvailability: 'always',
        prepareInvocationMessage: () => 'Analyzing frame performance…',
        invoke: async () => {
            const filePath = requireCapturePath();
            const [info, drawCalls, resources] = await Promise.all([
                getBridge().getCaptureInfo(filePath),
                getBridge().getDrawCalls(filePath),
                getBridge().getResources(filePath),
            ]);
            return buildFrameAnalysis(info, drawCalls, resources);
        },
    },
    {
        name: 'renderdoc_getPipelineState',
        description: 'Get GPU pipeline state at a specific event',
        chatAvailability: 'native',
        prepareInvocationMessage: (input?: GetPipelineStateInput) => `Getting pipeline state at event #${input?.eventId}…`,
        invoke: async (input?: GetPipelineStateInput) => {
            if (input?.eventId === undefined) {
                throw new Error('eventId is required');
            }
            if (!getBridge().hasNativeBridge()) {
                return 'Pipeline state inspection requires an active local replay via the RenderDoc native bridge.';
            }
            return getBridge().nativeGetPipelineState(input.eventId);
        },
    },
    {
        name: 'renderdoc_getShaderSource',
        description: 'Get shader source code at a specific event',
        chatAvailability: 'native',
        prepareInvocationMessage: () => 'Retrieving shader source code…',
        invoke: async (input?: GetShaderSourceInput) => {
            if (input?.eventId === undefined) {
                throw new Error('eventId is required');
            }
            if (!getBridge().hasNativeBridge()) {
                return 'Shader source requires an active local replay. The RenderDoc native bridge is not running.';
            }
            return getBridge().nativeGetShaderSource(input.eventId, input.stage);
        },
    },
    {
        name: 'renderdoc_getMeshData',
        description: 'Get vertex/mesh data at a specific event: attribute layout (name, format, perInstance), topology, vertex count, and decoded rows. Supports vsin/vsout/gsout stages. Use to inspect geometry, vertex attributes, position data, or index buffer.',
        chatAvailability: 'native',
        prepareInvocationMessage: (input?: GetMeshDataInput) => {
            const stage = input?.stage ?? 'vsin';
            return `Reading mesh data (${stage}) at EID ${input?.eventId}…`;
        },
        invoke: async (input?: GetMeshDataInput) => {
            if (input?.eventId === undefined) {
                throw new Error('eventId is required');
            }

            const stage = input.stage ?? 'vsin';
            const maxVertices = input.maxVertices ?? 32;
            const instance = input.instance ?? 0;
            const raw = await getBridge().nativeGetMeshData(input.eventId, stage, { maxVertices, instance });

            const topology = TOPOLOGY_NAMES[raw.topology] ?? `Topology(${raw.topology})`;
            const attributes = (raw.attributes ?? []).map((attribute: any) => ({
                name: attribute.name,
                format: attribute.format,
                used: attribute.used,
                perInstance: attribute.perInstance,
            }));
            const attributeNames = (raw.attributes ?? []).map((attribute: any) => attribute.name as string);
            const rows = (raw.rows ?? []).map((rowData: any) => {
                const row: Record<string, unknown> = { vtx: rowData.vtx };
                if (rowData.idx !== undefined) {
                    row.idx = rowData.idx;
                }
                if (rowData.restart) {
                    row.restart = true;
                }
                (rowData.cols ?? []).forEach((values: number[], index: number) => {
                    row[attributeNames[index] ?? `attr${index}`] = values.length === 1 ? values[0] : values;
                });
                return row;
            });

            return {
                eventId: raw.eventId,
                stage,
                topology,
                totalVertices: raw.totalIndices,
                returnedVertices: raw.returnedIndices,
                indexed: raw.indexByteStride > 0,
                indexByteStride: raw.indexByteStride || undefined,
                attributes,
                rows,
            };
        },
    },
];

export function getRenderDocToolDefinitions(): readonly RenderDocToolDefinition<any>[] {
    return renderDocToolDefinitions;
}

export function getRenderDocChatToolReferences(hasNative: boolean): RenderDocChatToolReference[] {
    return renderDocToolDefinitions
        .filter((tool) => hasNative || tool.chatAvailability === 'always')
        .map((tool) => ({
            name: tool.name,
            description: tool.description,
        }));
}

export function getRenderDocExternalToolDefinitions(hasNative: boolean): RenderDocExternalToolDefinition[] {
    return renderDocToolDefinitions
        .filter((tool) => hasNative || tool.chatAvailability === 'always')
        .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: TOOL_INPUT_SCHEMAS[tool.name] ?? EMPTY_OBJECT_SCHEMA,
        }));
}

export async function invokeRenderDocToolByName(name: string, input?: unknown): Promise<unknown> {
    const definition = renderDocToolDefinitions.find((tool) => tool.name === name);
    if (!definition) {
        throw new Error(`Unknown RenderDoc AI tool: ${name}`);
    }
    return definition.invoke(input);
}