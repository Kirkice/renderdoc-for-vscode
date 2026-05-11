/** Shared type definitions for the extension */

export interface CaptureStatisticsApiSummary {
    indexVertexSets: number;
    constantSets: number;
    samplerSets: number;
    resourceSets: number;
    shaderSets: number;
    blendSets: number;
    depthStencilSets: number;
    rasterizationSets: number;
    resourceUpdates: number;
    outputSets: number;
}

export interface CaptureStatistics {
    compressedFileSize: number;
    uncompressedFileSize: number;
    persistentSize: number;
    initDataSize: number;
    drawCount: number;
    dispatchCount: number;
    apiCallCount: number;
    apiDrawDispatchRatio: number;
    textureCount: number;
    textureBytes: number;
    largeTextureBytes: number;
    renderTargetCount: number;
    renderTargetBytes: number;
    avgTextureWidth: number;
    avgTextureHeight: number;
    avgLargeTextureWidth: number;
    avgLargeTextureHeight: number;
    bufferCount: number;
    bufferBytes: number;
    indexBufferBytes: number;
    vertexBufferBytes: number;
    totalGpuBytes: number;
    renderTargetSwitches: number;
    estimatedGpuTimeAvailable?: boolean;
    estimatedGpuTimeUs?: number;
    apiSummary?: CaptureStatisticsApiSummary;
}

export interface CaptureLaunchTarget {
    protocol: string;
    url: string;
    id: string;
    name: string;
    supported: boolean;
    supportsMultiplePrograms: boolean;
}

export interface CaptureAttachTarget {
    url: string;
    ident: number;
    pid: number;
    target: string;
    api: string;
    busyClient?: string;
}

export interface LaunchCaptureOptions {
    url?: string;
    executable: string;
    workingDir?: string;
    cmdLine?: string;
    captureFileTemplate?: string;
}

export interface AttachCaptureOptions {
    url?: string;
    ident?: number;
    pid?: number;
    processName?: string;
    captureFileTemplate?: string;
}

export interface TriggerCaptureOptions {
    localCopyPath: string;
    trigger: 'immediate' | 'frame' | 'delay';
    frameNumber?: number;
    delaySeconds?: number;
}

export interface LiveTargetInfo {
    target: string;
    api?: string;
    pid?: number;
    ident?: number;
    url?: string;
    local: boolean;
}

export interface ReplayHostInfo {
    connected: boolean;
    url?: string;
    protocol?: string;
    localProxies?: string[];
    remoteSupportedReplays?: string[];
}

export interface LaunchCaptureResult extends LiveTargetInfo {
}

export interface TriggerCaptureResult extends LiveTargetInfo {
    capturePath: string;
    frameNumber?: number;
}

export interface LiveCaptureEntry {
    id: string;
    filePath: string;
    displayName: string;
    target?: string;
    api?: string;
    frameNumber?: number;
    local: boolean;
    saved: boolean;
    sourceUrl?: string;
    createdAt: string;
}

export interface CaptureInfo {
    filePath: string;
    api: string;
    driver: string;
    machineIdent: string;
    rdocVersion: string;
    timestamp: string;
    frameCount: number;
    sectionCount: number;
    sections: SectionInfo[];
    statistics?: CaptureStatistics;
}

export interface SectionInfo {
    name: string;
    type: string;
    size: number;
    compressedSize: number;
    version: number;
    flags: string;
}

export interface DrawCall {
    eventId: number;
    drawIndex: number;
    name: string;
    flags: string;
    numIndices: number;
    numInstances: number;
    children: DrawCall[];
    /** GPU duration in microseconds — populated by renderdoc.fetchTimings */
    durationUs?: number;
}

export interface ResourceInfo {
    resourceId: string;
    name: string;
    type: string;       // "Texture" | "Buffer" | "Shader" | "Other"
    shaderStages?: string[];
    format: string;
    width: number;
    height: number;
    depth: number;
    arraySize: number;
    mipLevels: number;
    byteSize: number;
}

export interface ResourceDetail extends ResourceInfo {
    creationType: string;
    usage: string[];
    bindFlags: string[];
    [key: string]: any;
}

export interface ThumbnailData {
    width: number;
    height: number;
    base64: string;     // base64 encoded JPG/PNG/BMP
    format: string;     // "jpg" | "png" | "bmp"
}

export type TextureOverlayMode = 'none' | 'drawcall' | 'wireframe' | 'depth' | 'stencil';
