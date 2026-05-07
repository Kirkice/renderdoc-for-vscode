/**
 * Typed message contracts for the Inspector webview <-> extension IPC.
 *
 * Both sides of postMessage must conform to these discriminated unions so the
 * TypeScript compiler catches mismatched fields / typos. The webview JS is
 * currently embedded as a template string inside `inspectorPanel.ts` and
 * therefore cannot import these types directly; for now the extension side is
 * the sole TypeScript-checked consumer. When the webview is extracted to a
 * standalone media bundle it will also import from this module.
 */

import type { CaptureInfo, DrawCall, ResourceInfo } from '../types';

// ───────────────────────────── Webview → Extension ─────────────────────────────

export interface MsgReady {
    type: 'ready';
}

export interface MsgSelectEvent {
    type: 'selectEvent';
    eventId: number;
}

export interface MsgRequestTexture {
    type: 'requestTexture';
    resourceId: string;
    mip?: number;
    eventId?: number;
    channelExtract?: number;
}

export interface MsgOpenShaderInEditor {
    type: 'openShaderInEditor';
    source?: string;
    language?: string;
}

export interface MsgAnalyzeMaliOffline {
    type: 'analyzeMaliOffline';
    source: string;
    stage: string;
}

export interface MsgCopyToClipboard {
    type: 'copyToClipboard';
    text?: string;
}

export interface MsgExportTexture {
    type: 'exportTexture';
    resourceId: string;
    label?: string;
}

export interface MsgShowResourceDetails {
    type: 'showResourceDetails';
    resourceId: string;
    label?: string;
}

export interface MsgShowShaderSource {
    type: 'showShaderSource';
    resourceId: string;
    label?: string;
}

export interface MsgRequestMesh {
    type: 'requestMesh';
    eventId: number;
    stage: 'vsin' | 'vsout' | 'gsout';
    maxVertices?: number;
    instance?: number;
}

export type WebviewToExtensionMessage =
    | MsgReady
    | MsgSelectEvent
    | MsgRequestTexture
    | MsgOpenShaderInEditor
    | MsgAnalyzeMaliOffline
    | MsgCopyToClipboard
    | MsgExportTexture
    | MsgShowResourceDetails
    | MsgShowShaderSource
    | MsgRequestMesh;

// ───────────────────────────── Extension → Webview ─────────────────────────────

/** Trimmed resource view shipped to the webview — matches the mapping in setCapture. */
export interface WebviewResourceSummary {
    resourceId: string;
    name: string;
    type: string;
    shaderStages?: string[];
    format: string;
    width: number;
    height: number;
    byteSize: number;
}

export interface MsgCaptureLoaded {
    type: 'captureLoaded';
    captureInfo: CaptureInfo;
    drawCalls: DrawCall[];
    resources: WebviewResourceSummary[];
}

export interface MsgEventChanged {
    type: 'eventChanged';
    eventId: number;
    drawCall: DrawCall | undefined;
}

export interface MsgShadersLoaded {
    type: 'shadersLoaded';
    eventId: number;
    /** Either a shader-source payload from the native bridge, or `{ error }`. */
    data: unknown;
}

export interface MsgPipelineLoaded {
    type: 'pipelineLoaded';
    eventId: number;
    /** Either a pipeline-state payload from the native bridge, or `{ error }`. */
    data: unknown;
}

export interface MsgTexturePreview {
    type: 'texturePreview';
    key: string;
    base64?: string;
    width?: number;
    height?: number;
    texFormat?: string;
    error?: string;
}

export interface MsgMeshLoaded {
    type: 'meshLoaded';
    key: string;
    data?: unknown;
    error?: string;
}

export interface MsgMaliAnalysisResult {
    type: 'maliAnalysisResult';
    result?: string;
    error?: string;
}

export interface MsgTimingsLoaded {
    type: 'timingsLoaded';
    timings: Record<string, number>;
    available: boolean;
    error?: string;
}

export type ExtensionToWebviewMessage =
    | MsgCaptureLoaded
    | MsgEventChanged
    | MsgShadersLoaded
    | MsgPipelineLoaded
    | MsgTexturePreview
    | MsgMeshLoaded
    | MsgMaliAnalysisResult
    | MsgTimingsLoaded;
