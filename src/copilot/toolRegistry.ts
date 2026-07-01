import * as vscode from 'vscode';
import * as z from 'zod/v4';

import {
    AnalyzeFrameTool,
    FindDrawsByResourceIdTool,
    FindDrawsByShaderTool,
    FindDrawsByTextureTool,
    FindProjectImplementationTool,
    GetActionTimingsTool,
    GetBufferContentsTool,
    GetCaptureInfoTool,
    GetDrawCallsTool,
    GetEventDetailsTool,
    GetFrameSummaryTool,
    GetMeshDataTool,
    GetPipelineStateTool,
    GetResourceDetailTool,
    GetResourcesTool,
    GetSelectionContextTool,
    GetShaderInfoTool,
    GetShaderSourceTool,
    GetTextureDataTool,
    GetTextureInfoTool,
    OpenCaptureTool,
} from './tools';

export interface RenderDocToolDefinition {
    name: string;
    title: string;
    description: string;
    readOnly: boolean;
    inputSchema: z.ZodTypeAny;
    createTool: () => vscode.LanguageModelTool<any>;
}

export const RENDERDOC_TOOL_REGISTRY: readonly RenderDocToolDefinition[] = [
    {
        name: 'renderdoc_openCapture',
        title: 'Resolve Or Open Capture',
        description: 'Resolve the active RenderDoc capture in this VS Code window when called with no filePath, or load a specific .rdc file when filePath is provided.',
        readOnly: false,
        inputSchema: z.object({
            filePath: z.string().optional(),
        }),
        createTool: () => new OpenCaptureTool(),
    },
    {
        name: 'renderdoc_getCaptureInfo',
        title: 'Get Capture Info',
        description: 'Read metadata about the currently loaded RenderDoc capture.',
        readOnly: true,
        inputSchema: z.object({}),
        createTool: () => new GetCaptureInfoTool(),
    },
    {
        name: 'renderdoc_getDrawCalls',
        title: 'Get Draw Calls',
        description: 'List draw calls and marker hierarchy for the current capture.',
        readOnly: true,
        inputSchema: z.object({
            filter: z.string().optional(),
            markerFilter: z.string().optional(),
            excludeMarkers: z.boolean().optional(),
            onlyDrawCalls: z.boolean().optional(),
            eventIdMin: z.number().int().optional(),
            eventIdMax: z.number().int().optional(),
        }),
        createTool: () => new GetDrawCallsTool(),
    },
    {
        name: 'renderdoc_getActionTimings',
        title: 'Get Action Timings',
        description: 'Fetch GPU action timings for the current capture.',
        readOnly: true,
        inputSchema: z.object({
            eventIds: z.array(z.number().int()).optional(),
            markerFilter: z.string().optional(),
            excludeMarkers: z.array(z.string()).optional(),
            onlyDrawCalls: z.boolean().optional(),
            limit: z.number().int().optional(),
        }),
        createTool: () => new GetActionTimingsTool(),
    },
    {
        name: 'renderdoc_getResources',
        title: 'Get Resources',
        description: 'List GPU resources present in the current capture.',
        readOnly: true,
        inputSchema: z.object({
            type: z.string().optional(),
            limit: z.number().int().optional(),
            offset: z.number().int().optional(),
        }),
        createTool: () => new GetResourcesTool(),
    },
    {
        name: 'renderdoc_getResourceDetail',
        title: 'Get Resource Detail',
        description: 'Read detail for one GPU resource by resource ID.',
        readOnly: true,
        inputSchema: z.object({
            resourceId: z.string(),
        }),
        createTool: () => new GetResourceDetailTool(),
    },
    {
        name: 'renderdoc_getEventDetails',
        title: 'Get Event Details',
        description: 'Read detail for one draw call or GPU event by event ID.',
        readOnly: true,
        inputSchema: z.object({
            eventId: z.number().int(),
        }),
        createTool: () => new GetEventDetailsTool(),
    },
    {
        name: 'renderdoc_getPipelineState',
        title: 'Get Pipeline State',
        description: 'Read the full GPU pipeline state for one event.',
        readOnly: true,
        inputSchema: z.object({
            eventId: z.number().int(),
        }),
        createTool: () => new GetPipelineStateTool(),
    },
    {
        name: 'renderdoc_getShaderSource',
        title: 'Get Shader Source',
        description: 'Read shader source or disassembly for one event and stage.',
        readOnly: true,
        inputSchema: z.object({
            eventId: z.number().int(),
            stage: z.string().optional(),
        }),
        createTool: () => new GetShaderSourceTool(),
    },
    {
        name: 'renderdoc_getShaderInfo',
        title: 'Get Shader Info',
        description: 'Read aggregated shader metadata, bindings, and constant buffers for one event.',
        readOnly: true,
        inputSchema: z.object({
            eventId: z.number().int(),
            stage: z.string().optional(),
            includeSource: z.boolean().optional(),
            includeConstantBuffers: z.boolean().optional(),
        }),
        createTool: () => new GetShaderInfoTool(),
    },
    {
        name: 'renderdoc_findProjectImplementation',
        title: 'Find Project Implementation',
        description: 'Search the open workspace for shader or pass implementation candidates related to the current capture.',
        readOnly: true,
        inputSchema: z.object({
            eventId: z.number().int().optional(),
            shaderName: z.string().optional(),
            passName: z.string().optional(),
            additionalTerms: z.array(z.string()).optional(),
            limit: z.number().int().optional(),
        }),
        createTool: () => new FindProjectImplementationTool(),
    },
    {
        name: 'renderdoc_getTextureInfo',
        title: 'Get Texture Info',
        description: 'Read texture metadata for the current capture or a specific texture resource.',
        readOnly: true,
        inputSchema: z.object({
            textureId: z.string().optional(),
        }),
        createTool: () => new GetTextureInfoTool(),
    },
    {
        name: 'renderdoc_analyzeFrame',
        title: 'Analyze Frame',
        description: 'Perform a broad performance-oriented analysis of the current frame capture.',
        readOnly: true,
        inputSchema: z.object({}),
        createTool: () => new AnalyzeFrameTool(),
    },
    {
        name: 'renderdoc_getSelectionContext',
        title: 'Get Selection Context',
        description: 'Read the current RenderDoc inspector focus and sidebar selection from this VS Code window.',
        readOnly: true,
        inputSchema: z.object({}),
        createTool: () => new GetSelectionContextTool(),
    },
    {
        name: 'renderdoc_getMeshData',
        title: 'Get Mesh Data',
        description: 'Read mesh data for one event and mesh stage, including topology, attributes, and sampled rows.',
        readOnly: true,
        inputSchema: z.object({
            eventId: z.number().int(),
            stage: z.enum(['vsin', 'vsout', 'gsout']).optional(),
            maxVertices: z.number().int().optional(),
            instance: z.number().int().optional(),
        }),
        createTool: () => new GetMeshDataTool(),
    },
    {
        name: 'renderdoc_getFrameSummary',
        title: 'Get Frame Summary',
        description: 'Return a concise overview of frame structure, passes, and capture statistics.',
        readOnly: true,
        inputSchema: z.object({}),
        createTool: () => new GetFrameSummaryTool(),
    },
    {
        name: 'renderdoc_findDrawsByShader',
        title: 'Find Draws by Shader',
        description: 'Reverse-search draw calls that use a shader name or entry-point substring.',
        readOnly: true,
        inputSchema: z.object({
            shaderName: z.string(),
        }),
        createTool: () => new FindDrawsByShaderTool(),
    },
    {
        name: 'renderdoc_findDrawsByTexture',
        title: 'Find Draws by Texture',
        description: 'Reverse-search draw calls that sample a texture name substring.',
        readOnly: true,
        inputSchema: z.object({
            textureName: z.string(),
        }),
        createTool: () => new FindDrawsByTextureTool(),
    },
    {
        name: 'renderdoc_findDrawsByResourceId',
        title: 'Find Draws by Resource ID',
        description: 'Reverse-search draw calls that bind a specific resource ID.',
        readOnly: true,
        inputSchema: z.object({
            resourceId: z.string(),
        }),
        createTool: () => new FindDrawsByResourceIdTool(),
    },
    {
        name: 'renderdoc_getTextureData',
        title: 'Get Texture Data',
        description: 'Sample texture pixel data for a resource, mip level, and optional event.',
        readOnly: true,
        inputSchema: z.object({
            textureId: z.string(),
            mip: z.number().int().optional(),
            eventId: z.number().int().optional(),
            channelExtract: z.number().int().optional(),
        }),
        createTool: () => new GetTextureDataTool(),
    },
    {
        name: 'renderdoc_getBufferContents',
        title: 'Get Buffer Contents',
        description: 'Read a bounded byte range from a GPU buffer resource.',
        readOnly: true,
        inputSchema: z.object({
            resourceId: z.string(),
            offset: z.number().int().optional(),
            len: z.number().int().optional(),
            eventId: z.number().int().optional(),
        }),
        createTool: () => new GetBufferContentsTool(),
    },
];
