/**
 * Zod schemas for every JSON-RPC response the native bridge can emit.
 *
 * These act as a runtime contract between `renderdoc_bridge.exe` (C++, see
 * `native/src/main.cpp`) and the TS extension host. If the C++ side drops or
 * renames a field, `validate()` throws with a clear diagnostic instead of
 * letting `undefined` silently propagate through the UI.
 *
 * Design notes:
 *   - Responses from API-variant handlers (`getPipelineState`,
 *     `getShaderSourceForEvent`) use `.passthrough()` because their shape
 *     legitimately differs between GL/Vulkan/D3D11/D3D12 and new fields may
 *     be added without notice. We still validate the fields we depend on.
 *   - The `resourceId` field is emitted as a JS number by nlohmann::json
 *     (the C++ side writes a `uint64_t`). Very large IDs may lose precision,
 *     but the rest of the extension has always treated them as numbers — we
 *     keep that contract here.
 */

import { z } from 'zod';
import { BridgeError } from './bridgeError';

// ─── Leaf types ──────────────────────────────────────────────────────────────

const ResourceId = z.number();

const EntryPoint = z.object({
    name: z.string(),
    stage: z.number(),
});

const ShaderSourceFile = z.object({
    filename: z.string(),
    contents: z.string(),
});

/** Recursive: each `ActionDescription` may embed its children. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NativeAction = {
    eventId: number;
    actionId: number;
    name: string;
    flags: number;
    numIndices?: number;
    numInstances?: number;
    children?: NativeAction[];
};
const NativeActionSchema: z.ZodType<NativeAction> = z.lazy(() =>
    z.object({
        eventId: z.number(),
        actionId: z.number(),
        name: z.string(),
        flags: z.number(),
        numIndices: z.number().optional(),
        numInstances: z.number().optional(),
        children: z.array(NativeActionSchema).optional(),
    })
);

// ─── Per-method response schemas ─────────────────────────────────────────────

export const InitResponse = z.object({
    version: z.string(),
    commitHash: z.string().optional(),
});

export const GetVersionResponse = z.object({
    version: z.string(),
});

export const OpenCaptureResponse = z.object({
    path: z.string(),
    driver: z.string(),
    replay: z.boolean(),
    replayError: z.string().optional(),
    replayMessage: z.string().optional(),
    suggestRemote: z.boolean().optional(),
    canTryReplay: z.boolean().optional(),
});

export const TryReplayResponse = z.object({
    replay: z.boolean(),
    message: z.string().optional(),
    replayError: z.string().optional(),
});

export const CloseCaptureResponse = z.object({
    closed: z.boolean(),
});

export const SetFrameEventResponse = z.object({
    eventId: z.number(),
});

export const GetRootActionsResponse = z.object({
    actions: z.array(NativeActionSchema),
    count: z.number(),
});

export const NativeResource = z.object({
    resourceId: ResourceId,
    name: z.string(),
    type: z.number(),
});

export const GetResourcesResponse = z.object({
    resources: z.array(NativeResource),
    count: z.number(),
});

export const NativeTexture = z.object({
    resourceId: ResourceId,
    name: z.string().optional(),
    format: z.string(),
    textureType: z.string().optional(),
    width: z.number(),
    height: z.number(),
    depth: z.number(),
    mips: z.number(),
    arraySize: z.number().optional(),
    arraysize: z.number().optional(),   // compat with old bridge builds
    cubemap: z.boolean().optional(),
    msaaSamples: z.number().optional(),
    msaaQuality: z.number().optional(),
    byteSize: z.number().optional(),
    usage: z.string().optional(),
});

export const GetTexturesResponse = z.object({
    textures: z.array(NativeTexture),
    count: z.number(),
});

export const TimingEntry = z.object({
    eventId: z.number(),
    durationUs: z.number().nullable().optional(),
});

export const GetTimingsResponse = z.object({
    timings: z.array(TimingEntry),
    count: z.number(),
});

export type TGetTimingsResponse = z.infer<typeof GetTimingsResponse>;

export const GetDisassemblyTargetsResponse = z.object({
    targets: z.array(z.string()),
});

export const GetShaderEntryPointsResponse = z.object({
    entryPoints: z.array(EntryPoint),
});

export const GetShaderSourceResponse = z.object({
    entryPoint: z.string(),
    stage: z.number(),
    disassembly: z.string().optional(),
    hasRawBytes: z.boolean().optional(),
    rawBytesSize: z.number().optional(),
    sourceFiles: z.array(ShaderSourceFile).optional(),
});

/** Variable-shape: one key per bound stage ("vertex", "fragment", …). */
export const GetShaderSourceForEventResponse = z
    .object({
        eventId: z.number().optional(),
        api: z.string().optional(),
        shaders: z.record(z.string(), z.unknown()),
    })
    .passthrough();

export const GetTexturePreviewResponse = z.object({
    base64: z.string(),
    format: z.string(),
    width: z.number(),
    height: z.number(),
    texFormat: z.string(),
    size: z.number(),
    compCount: z.number(),
});

export const SaveTextureResponse = z.object({
    path: z.string(),
    saved: z.boolean(),
});

/** Pipeline state differs per API; only assert the discriminator. */
export const GetPipelineStateResponse = z
    .object({
        api: z.string().optional(),
        shaders: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough();

export type TInitResponse                = z.infer<typeof InitResponse>;
export type TGetVersionResponse          = z.infer<typeof GetVersionResponse>;
export type TOpenCaptureResponse         = z.infer<typeof OpenCaptureResponse>;
export type TTryReplayResponse           = z.infer<typeof TryReplayResponse>;
export type TCloseCaptureResponse        = z.infer<typeof CloseCaptureResponse>;
export type TSetFrameEventResponse       = z.infer<typeof SetFrameEventResponse>;
export type TGetRootActionsResponse      = z.infer<typeof GetRootActionsResponse>;
export type TGetResourcesResponse        = z.infer<typeof GetResourcesResponse>;
export type TGetTexturesResponse         = z.infer<typeof GetTexturesResponse>;
export type TGetDisassemblyTargetsResponse = z.infer<typeof GetDisassemblyTargetsResponse>;
export type TGetShaderEntryPointsResponse  = z.infer<typeof GetShaderEntryPointsResponse>;
export type TGetShaderSourceResponse     = z.infer<typeof GetShaderSourceResponse>;
export type TGetShaderSourceForEventResponse = z.infer<typeof GetShaderSourceForEventResponse>;
export type TGetTexturePreviewResponse   = z.infer<typeof GetTexturePreviewResponse>;
export type TSaveTextureResponse         = z.infer<typeof SaveTextureResponse>;
export type TGetPipelineStateResponse    = z.infer<typeof GetPipelineStateResponse>;

/**
 * Runtime-validate a native bridge response. On failure, throws an Error
 * whose message identifies the offending method and the first few problems.
 * This is intentionally cheap and synchronous — schemas are tiny.
 */
export function validateResponse<T>(
    schema: z.ZodType<T>,
    data: unknown,
    method: string,
): T {
    const result = schema.safeParse(data);
    if (result.success) {
        return result.data;
    }
    const issues = result.error.issues.slice(0, 3).map((i) => {
        const where = i.path.length ? i.path.join('.') : '<root>';
        return `${where}: ${i.message}`;
    });
    throw new BridgeError(
        'validation',
        `Native bridge returned malformed response for '${method}': ${issues.join('; ')}`,
        { method, issues },
    );
}
