/** Shared type definitions for the extension */

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
}

export interface ResourceInfo {
    resourceId: string;
    name: string;
    type: string;       // "Texture" | "Buffer" | "Shader" | "Other"
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
    base64: string;     // base64 encoded JPG/PNG
    format: string;     // "jpg" | "png"
}
