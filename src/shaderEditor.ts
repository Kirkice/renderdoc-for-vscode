import * as path from 'path';
import * as vscode from 'vscode';

export const RENDERDOC_GLSL_LANGUAGE_ID = 'renderdoc-glsl';

export interface OpenShaderSourceOptions {
    context: vscode.ExtensionContext;
    source: string;
    capturePath?: string;
    eventId?: number;
    resourceId?: string;
    stage?: string;
    filename?: string;
    language?: string;
    viewColumn?: vscode.ViewColumn;
    preserveFocus?: boolean;
    preview?: boolean;
    line?: number;
    column?: number;
    fileIndex?: number;
}

export interface ShaderSourceFileData {
    filename: string;
    contents: string;
}

export interface LinkedShaderDocumentInfo {
    uri: vscode.Uri;
    capturePath?: string;
    eventId?: number;
    resourceId?: string;
    stage?: string;
    filename?: string;
    language?: string;
    fileIndex: number;
}

export interface ResolveShaderSourceFilesOptions {
    context: vscode.ExtensionContext;
    capturePath?: string;
    eventId?: number;
    resourceId?: string;
    stage?: string;
    language?: string;
    files: ShaderSourceFileData[];
}

const stageExtensionByKey: Record<string, string> = {
    vertex: 'vert',
    fragment: 'frag',
    pixel: 'frag',
    geometry: 'geom',
    hull: 'tesc',
    tess_control: 'tesc',
    domain: 'tese',
    tess_evaluation: 'tese',
    compute: 'comp',
    mesh: 'mesh',
    task: 'task',
    amplification: 'task',
    raygen: 'rgen',
    anyhit: 'rahit',
    closesthit: 'rchit',
    miss: 'rmiss',
    callable: 'rcall',
};

const linkedShaderDocuments = new Map<string, LinkedShaderDocumentInfo>();

function normalizeStage(stage?: string): string {
    return String(stage || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

function sanitizeSegment(value: string): string {
    const cleaned = value
        .trim()
        .replace(/[<>:"/\\|?*]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[_\.]+|[_\.]+$/g, '');
    return cleaned || 'shader';
}

function normalizeShaderPathSegments(filename?: string): string[] {
    const normalized = String(filename || '')
        .replace(/^[A-Za-z]:[\\/]/, '')
        .replace(/\\/g, '/');

    return normalized
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
        .map((segment) => sanitizeSegment(segment));
}

function preferredLanguageId(language?: string): string | undefined {
    if ((language || '').trim().toLowerCase() === 'glsl') {
        return RENDERDOC_GLSL_LANGUAGE_ID;
    }
    return undefined;
}

function preferredFileExtension(language?: string, stage?: string): string {
    const normalizedLanguage = String(language || '').trim().toLowerCase();
    if (normalizedLanguage === 'glsl') {
        return '.' + (stageExtensionByKey[normalizeStage(stage)] || 'glsl');
    }
    if (normalizedLanguage === 'hlsl') {
        return '.hlsl';
    }
    return '.txt';
}

function ensureShaderFileName(filename: string | undefined, language?: string, stage?: string): string {
    const fallbackBase = sanitizeSegment(normalizeStage(stage) || 'shader');
    const baseName = sanitizeSegment(filename || fallbackBase);
    if (path.posix.extname(baseName)) {
        return baseName;
    }
    return baseName + preferredFileExtension(language, stage);
}

function captureFolderName(capturePath?: string): string {
    const captureBase = capturePath
        ? path.basename(capturePath, path.extname(capturePath))
        : 'capture';
    return sanitizeSegment(captureBase);
}

function shaderRootUri(context: vscode.ExtensionContext, capturePath?: string): vscode.Uri {
    return vscode.Uri.joinPath(
        context.globalStorageUri,
        'shader-editor',
        captureFolderName(capturePath),
    );
}

export function getShaderSourceDocumentUri(options: {
    context: vscode.ExtensionContext;
    capturePath?: string;
    eventId?: number;
    resourceId?: string;
    stage?: string;
    filename?: string;
    language?: string;
}): vscode.Uri {
    const segments = normalizeShaderPathSegments(options.filename);
    const normalizedStage = sanitizeSegment(normalizeStage(options.stage) || 'shader');
    const eventSegment = typeof options.eventId === 'number' ? `event-${options.eventId}` : 'event-unknown';
    const resourceSegment = options.resourceId ? `resource-${sanitizeSegment(options.resourceId)}` : 'resource-unknown';
    const baseDir = vscode.Uri.joinPath(
        shaderRootUri(options.context, options.capturePath),
        eventSegment,
        resourceSegment,
        normalizedStage,
    );

    const dirSegments = segments.length > 1 ? segments.slice(0, -1) : [];
    const rawFileName = segments.length > 0 ? segments[segments.length - 1] : undefined;
    const fileName = ensureShaderFileName(rawFileName, options.language, options.stage);
    return vscode.Uri.joinPath(baseDir, ...dirSegments, fileName);
}

async function writeShaderFileIfNeeded(uri: vscode.Uri, source: string): Promise<void> {
    const openDocument = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
    if (openDocument?.isDirty) {
        return;
    }

    const encoder = new TextEncoder();
    const desired = encoder.encode(source);

    try {
        if (openDocument && openDocument.getText() === source) {
            return;
        }

        const current = await vscode.workspace.fs.readFile(uri);
        if (current.length === desired.length && current.every((value, index) => value === desired[index])) {
            return;
        }
    } catch {
        // File does not exist yet or cannot be compared; fall through to write.
    }

    const parent = uri.with({ path: path.posix.dirname(uri.path) });
    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(uri, desired);
}

function registerLinkedShaderDocument(uri: vscode.Uri, options: {
    capturePath?: string;
    eventId?: number;
    resourceId?: string;
    stage?: string;
    filename?: string;
    language?: string;
    fileIndex?: number;
}) {
    linkedShaderDocuments.set(uri.toString(), {
        uri,
        capturePath: options.capturePath,
        eventId: options.eventId,
        resourceId: options.resourceId,
        stage: options.stage,
        filename: options.filename,
        language: options.language,
        fileIndex: options.fileIndex ?? 0,
    });
}

export function getLinkedShaderDocumentInfo(uri: vscode.Uri): LinkedShaderDocumentInfo | undefined {
    return linkedShaderDocuments.get(uri.toString());
}

export function findLinkedShaderDocumentInfos(predicate: (info: LinkedShaderDocumentInfo) => boolean): LinkedShaderDocumentInfo[] {
    return Array.from(linkedShaderDocuments.values()).filter(predicate);
}

export async function openShaderSourceDocument(options: OpenShaderSourceOptions): Promise<vscode.TextDocument> {
    const uri = getShaderSourceDocumentUri(options);
    await writeShaderFileIfNeeded(uri, options.source);
    registerLinkedShaderDocument(uri, options);

    let document = await vscode.workspace.openTextDocument(uri);
    const languageId = preferredLanguageId(options.language);
    if (languageId && document.languageId !== languageId) {
        document = await vscode.languages.setTextDocumentLanguage(document, languageId);
    }

    const editor = await vscode.window.showTextDocument(document, {
        viewColumn: options.viewColumn ?? vscode.ViewColumn.Active,
        preview: options.preview ?? false,
        preserveFocus: options.preserveFocus ?? false,
    });

    if (typeof options.line === 'number' && options.line > 0) {
        const position = new vscode.Position(options.line - 1, Math.max(0, (options.column ?? 1) - 1));
        const range = new vscode.Range(position, position);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    return document;
}

export async function loadShaderSourceFilesFromDocuments(options: ResolveShaderSourceFilesOptions): Promise<ShaderSourceFileData[]> {
    const resolvedFiles: ShaderSourceFileData[] = [];

    for (let fileIndex = 0; fileIndex < options.files.length; fileIndex++) {
        const file = options.files[fileIndex];
        const uri = getShaderSourceDocumentUri({
            context: options.context,
            capturePath: options.capturePath,
            eventId: options.eventId,
            resourceId: options.resourceId,
            stage: options.stage,
            filename: file.filename,
            language: options.language,
        });

        await writeShaderFileIfNeeded(uri, file.contents);
        registerLinkedShaderDocument(uri, {
            capturePath: options.capturePath,
            eventId: options.eventId,
            resourceId: options.resourceId,
            stage: options.stage,
            filename: file.filename,
            language: options.language,
            fileIndex,
        });

        let contents = file.contents;
        const openDocument = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
        if (openDocument) {
            contents = openDocument.getText();
        } else {
            try {
                contents = (await vscode.workspace.openTextDocument(uri)).getText();
            } catch {
                contents = file.contents;
            }
        }

        resolvedFiles.push({
            filename: file.filename,
            contents,
        });
    }

    return resolvedFiles;
}