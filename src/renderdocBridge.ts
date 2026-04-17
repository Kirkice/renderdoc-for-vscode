import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CaptureInfo, DrawCall, ResourceInfo, ResourceDetail, ThumbnailData } from './types';
import { parseRdcFile } from './rdcParser';

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
 * Bridge between the VS Code extension and RenderDoc.
 * Uses native binary parsing for metadata + renderdoccmd for thumbnails and XML conversion.
 * No Python dependency required.
 */
export class RenderDocBridge {
    private renderdocPath: string | undefined;
    private renderdocCmd: string | undefined;
    /** Global-storage directory where we cache a downloaded renderdoc_bridge.exe. */
    private downloadedBridgeDir: string | undefined;

    constructor() {}

    /** Tell the bridge where it can look for (and save) a downloaded binary. */
    setDownloadedBridgeDir(dir: string) {
        this.downloadedBridgeDir = dir;
    }

    /**
     * Detects if RenderDoc is available on the system.
     * Checks: 1) user-configured path, 2) common install locations, 3) PATH
     */
    async checkAvailability(): Promise<boolean> {
        // 1. Check user-configured path
        const config = vscode.workspace.getConfiguration('renderdoc');
        const configuredPath = config.get<string>('installPath');
        if (configuredPath && await this.validateRenderdocDir(configuredPath)) {
            this.renderdocPath = configuredPath;
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
                if (await this.validateRenderdocDir(p)) {
                    this.renderdocPath = p;
                    return true;
                }
            }
        }

        // 3. Linux/macOS: check PATH for renderdoccmd
        if (process.platform !== 'win32') {
            try {
                const result = await this.exec('which renderdoccmd');
                if (result.trim()) {
                    this.renderdocCmd = result.trim();
                    this.renderdocPath = path.dirname(result.trim());
                    return true;
                }
            } catch {
                // not found
            }
        }

        return false;
    }

    /** Validates that a directory looks like a RenderDoc installation */
    private async validateRenderdocDir(dir: string): Promise<boolean> {
        try {
            const stat = await fs.promises.stat(dir);
            if (!stat.isDirectory()) { return false; }

            const cmdName = process.platform === 'win32' ? 'renderdoccmd.exe' : 'bin/renderdoccmd';
            const cmdPath = path.join(dir, cmdName);
            if (await this.fileExists(cmdPath)) {
                this.renderdocCmd = cmdPath;
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    /** Get the renderdoccmd executable path */
    private getCmd(): string {
        if (!this.renderdocCmd) {
            throw new Error('RenderDoc not found. Please install RenderDoc or configure the path.');
        }
        return this.renderdocCmd;
    }

    /** Get capture file metadata by parsing the RDC binary directly */
    async getCaptureInfo(filePath: string): Promise<CaptureInfo> {
        return parseRdcFile(filePath);
    }

    /** Get draw calls – prefer the native bridge (hierarchical tree); fall back to flat XML parse. */
    async getDrawCalls(filePath: string): Promise<DrawCall[]> {
        if (this.hasNativeBridge()) {
            try {
                // NOTE: do NOT call nativeOpenCapture here — that tears down the
                // active replay controller and for SuggestRemote (GLES etc.)
                // captures it won't be re-established without a tryReplay call.
                // loadCapture() already opened the capture; we just query it.
                const native = await this.nativeGetRootActions();
                if (native && Array.isArray(native.actions) && native.actions.length > 0) {
                    console.log('[RenderDoc] getDrawCalls: using native tree,',
                        native.actions.length, 'root action(s)');
                    return native.actions.map((a: any) => convertNativeActionToDrawCall(a));
                }
                console.log('[RenderDoc] getDrawCalls: native returned empty, falling back to XML');
            } catch (e: any) {
                console.warn('[RenderDoc] native getDrawCalls failed, falling back to XML:', e?.message);
            }
        }
        const xml = await this.convertToXml(filePath);
        return this.parseDrawCallsFromXml(xml);
    }

    /** Get resource list by converting RDC → XML and parsing */
    async getResources(filePath: string): Promise<ResourceInfo[]> {
        const xml = await this.convertToXml(filePath);
        return this.parseResourcesFromXml(xml);
    }

    /** Get capture thumbnail using renderdoccmd thumb */
    async getThumbnail(filePath: string): Promise<ThumbnailData | null> {
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
            try { await fs.promises.unlink(tmpFile); } catch {}
        }
    }

    /** Get detailed resource info (from XML) */
    async getResourceDetail(filePath: string, resourceId: string): Promise<ResourceDetail> {
        const xml = await this.convertToXml(filePath);
        return this.parseResourceDetailFromXml(xml, resourceId);
    }

    // --- XML conversion and parsing ---

    /** Cache for XML conversion (avoid re-converting the same file) */
    private xmlCache: { filePath: string; xml: string } | undefined;

    /** Convert RDC to XML via renderdoccmd convert */
    private async convertToXml(filePath: string): Promise<string> {
        // Return cached if same file
        if (this.xmlCache && this.xmlCache.filePath === filePath) {
            return this.xmlCache.xml;
        }

        const tmpFile = path.join(os.tmpdir(), `rdcxml_${Date.now()}.xml`);
        try {
            await this.runCmd(['convert', '-f', filePath, '-o', tmpFile, '-c', 'xml']);
            const xml = await fs.promises.readFile(tmpFile, 'utf-8');
            this.xmlCache = { filePath, xml };
            return xml;
        } finally {
            try { await fs.promises.unlink(tmpFile); } catch {}
        }
    }

    /** Parse draw calls from the XML output */
    private parseDrawCallsFromXml(xml: string): DrawCall[] {
        const drawCalls: DrawCall[] = [];
        // Match chunk elements that are draw/clear/dispatch calls
        const chunkRegex = /<chunk\s[^>]*name="([^"]*)"[^>]*chunkIndex="(\d+)"[^>]*>([\s\S]*?)<\/chunk>/g;
        const chunkRegex2 = /<chunk\s[^>]*chunkIndex="(\d+)"[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/chunk>/g;

        // Collect all chunks
        const allChunks: Array<{ chunkIndex: number; name: string; body: string }> = [];
        let match: RegExpExecArray | null;

        // Handle varying attribute order
        const genericChunkRegex = /<chunk\s([^>]*)>([\s\S]*?)<\/chunk>/g;
        while ((match = genericChunkRegex.exec(xml)) !== null) {
            const attrs = match[1];
            const body = match[2];
            const nameMatch = attrs.match(/name="([^"]*)"/);
            const indexMatch = attrs.match(/chunkIndex="(\d+)"/);
            if (nameMatch && indexMatch) {
                allChunks.push({
                    chunkIndex: parseInt(indexMatch[1], 10),
                    name: nameMatch[1],
                    body,
                });
            }
        }

        // Filter for draw/clear/dispatch/present-related calls
        const drawCallPatterns = /^(gl|vk|ID3D|dx|Draw|Clear|Dispatch|Present|cmdDraw|cmdClear|cmdDispatch|CmdDraw|CmdClear|CmdDispatch)/i;
        const isDrawLike = (name: string): boolean => {
            const lower = name.toLowerCase();
            return lower.includes('draw') ||
                   lower.includes('clear') ||
                   lower.includes('dispatch') ||
                   lower.includes('present') ||
                   lower.includes('blit');
        };

        let eventId = 0;
        let drawIndex = 0;
        for (const chunk of allChunks) {
            if (!isDrawLike(chunk.name)) { continue; }

            // Extract count/indices info from body
            let numIndices = 0;
            let numInstances = 1;
            const countMatch = chunk.body.match(/name="count"[^>]*>(\d+)</);
            if (countMatch) { numIndices = parseInt(countMatch[1], 10); }
            const instanceMatch = chunk.body.match(/name="instancecount"[^>]*>(\d+)</i) ||
                                  chunk.body.match(/name="primcount"[^>]*>(\d+)</i);
            if (instanceMatch) { numInstances = parseInt(instanceMatch[1], 10); }

            // Determine flags
            let flags = '';
            const nameLower = chunk.name.toLowerCase();
            if (nameLower.includes('draw')) { flags = 'Drawcall'; }
            else if (nameLower.includes('clear')) { flags = 'Clear'; }
            else if (nameLower.includes('dispatch')) { flags = 'Dispatch'; }
            else if (nameLower.includes('present') || nameLower.includes('blit')) { flags = 'Present'; }

            drawCalls.push({
                eventId: chunk.chunkIndex,
                drawIndex: drawIndex++,
                name: chunk.name,
                flags,
                numIndices,
                numInstances,
                children: [],
            });
        }

        return drawCalls;
    }

    /** Parse resources from the XML output */
    private parseResourcesFromXml(xml: string): ResourceInfo[] {
        const resources: ResourceInfo[] = [];
        const seenIds = new Set<string>();

        // Parse all chunks
        const genericChunkRegex = /<chunk\s([^>]*)>([\s\S]*?)<\/chunk>/g;
        let match: RegExpExecArray | null;

        // Track texture/buffer creation
        const textures = new Map<string, ResourceInfo>();
        const buffers = new Map<string, ResourceInfo>();

        while ((match = genericChunkRegex.exec(xml)) !== null) {
            const attrs = match[1];
            const body = match[2];
            const nameMatch = attrs.match(/name="([^"]*)"/);
            if (!nameMatch) { continue; }
            const chunkName = nameMatch[1].toLowerCase();

            // Texture creation (glTexStorage2D, glTexStorage3D, etc.)
            if (chunkName.includes('texstorage') || chunkName.includes('teximage')) {
                const idMatch = body.match(/<ResourceId[^>]*>(\d+)<\/ResourceId>/);
                if (idMatch && !seenIds.has(idMatch[1])) {
                    seenIds.add(idMatch[1]);
                    const width = this.extractXmlValue(body, 'width', 'int|uint') || 0;
                    const height = this.extractXmlValue(body, 'height', 'int|uint') || 0;
                    const depth = this.extractXmlValue(body, 'depth', 'int|uint') || 1;
                    const format = this.extractXmlStringValue(body, 'internalformat') ||
                                   this.extractXmlStringValue(body, 'internalFormat') || '';

                    textures.set(idMatch[1], {
                        resourceId: idMatch[1],
                        name: '',
                        type: 'Texture',
                        format,
                        width,
                        height,
                        depth,
                        arraySize: 1,
                        mipLevels: this.extractXmlValue(body, 'levels', 'int|uint') || 1,
                        byteSize: 0,
                    });
                }
            }

            // Buffer creation (glBufferData, etc.)
            if (chunkName.includes('bufferdata') || chunkName.includes('bufferstorage')) {
                const idMatch = body.match(/<ResourceId[^>]*>(\d+)<\/ResourceId>/);
                if (idMatch && !seenIds.has(idMatch[1])) {
                    seenIds.add(idMatch[1]);
                    const size = this.extractXmlValue(body, 'size', 'int|uint') || 0;

                    buffers.set(idMatch[1], {
                        resourceId: idMatch[1],
                        name: '',
                        type: 'Buffer',
                        format: '',
                        width: 0,
                        height: 0,
                        depth: 0,
                        arraySize: 0,
                        mipLevels: 0,
                        byteSize: size,
                    });
                }
            }

            // Object labels (glObjectLabel)
            if (chunkName.includes('objectlabel') || chunkName.includes('debugname')) {
                const idMatch = body.match(/<ResourceId[^>]*>(\d+)<\/ResourceId>/);
                const labelMatch = body.match(/<string[^>]*name="Label"[^>]*>([^<]*)<\/string>/i) ||
                                   body.match(/<string[^>]*name="[^"]*"[^>]*>([^<]*)<\/string>/);
                if (idMatch && labelMatch) {
                    const rid = idMatch[1];
                    const label = labelMatch[1];
                    if (textures.has(rid)) { textures.get(rid)!.name = label; }
                    if (buffers.has(rid)) { buffers.get(rid)!.name = label; }
                }
            }
        }

        resources.push(...textures.values());
        resources.push(...buffers.values());
        return resources;
    }

    /** Parse resource detail from XML */
    private parseResourceDetailFromXml(xml: string, resourceId: string): ResourceDetail {
        // First get the basic resource info
        const resources = this.parseResourcesFromXml(xml);
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

    /** Extract a numeric value from XML body */
    private extractXmlValue(body: string, name: string, typePattern: string): number {
        const regex = new RegExp(`<(?:${typePattern})[^>]*name="${name}"[^>]*>(\\d+)<`, 'i');
        const match = body.match(regex);
        return match ? parseInt(match[1], 10) : 0;
    }

    /** Extract a string attribute value from XML enum body */
    private extractXmlStringValue(body: string, name: string): string {
        const regex = new RegExp(`name="${name}"[^>]*string="([^"]*)"`, 'i');
        const match = body.match(regex);
        return match ? match[1] : '';
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
    private nativeRequestId = 0;
    private nativePendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private nativeOutputBuffer = '';

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
        if (!bridgePath) { return; }

        try {
            this.nativeProcess = cp.spawn(bridgePath, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
            });
            console.log('[RenderDoc] Native bridge spawned, pid:', this.nativeProcess.pid);

            this.nativeProcess.stdout?.on('data', (data: Buffer) => {
                this.nativeOutputBuffer += data.toString();
                this.processNativeOutput();
            });

            this.nativeProcess.stderr?.on('data', (data: Buffer) => {
                console.log('[RenderDoc] bridge stderr:', data.toString().trim());
            });

            this.nativeProcess.on('exit', (code) => {
                console.log('[RenderDoc] Native bridge exited with code:', code);
                this.nativeProcess = undefined;
                // Reject all pending requests
                for (const [, pending] of this.nativePendingRequests) {
                    pending.reject(new Error('Native bridge process exited'));
                }
                this.nativePendingRequests.clear();
            });

            this.nativeProcess.on('error', (err) => {
                console.error('[RenderDoc] Native bridge spawn error:', err.message);
                this.nativeProcess = undefined;
            });

            // Initialize with RenderDoc path
            if (this.renderdocPath) {
                this.nativeCall('init', { renderdocPath: this.renderdocPath }).catch(() => {});
            }
        } catch {
            this.nativeProcess = undefined;
        }
    }

    /** Kill and restart the native bridge (e.g. after installing ANGLE DLLs) */
    restartNativeBridge(): void {
        if (this.nativeProcess) {
            try { this.nativeProcess.kill(); } catch { /* ignore */ }
            this.nativeProcess = undefined;
        }
        for (const [, pending] of this.nativePendingRequests) {
            pending.reject(new Error('Native bridge restarting'));
        }
        this.nativePendingRequests.clear();
        this.nativeOutputBuffer = '';
        this.tryStartNativeBridge();
    }

    /** Find the native bridge executable */
    private findNativeBridge(): string | undefined {
        const exeName = process.platform === 'win32' ? 'renderdoc_bridge.exe' : 'renderdoc_bridge';

        // 1. User setting override
        const override = vscode.workspace.getConfiguration('renderdoc').get<string>('nativeBridge.path');
        if (override && fs.existsSync(override)) { return override; }

        // 2. Next to the extension (dev build or VSIX-bundled)
        const extensionDir = path.dirname(path.dirname(__filename));
        const candidates = [
            path.join(extensionDir, 'native', 'build', 'Release', exeName),
            path.join(extensionDir, 'native', 'build', exeName),
            path.join(extensionDir, exeName),
        ];

        // 3. Downloaded copy in globalStorage (populated on first run)
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
                        pending.reject(new Error(msg.error.message || 'Unknown native bridge error'));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
            } catch {
                // Ignore unparseable lines
            }
        }
    }

    /** Send a JSON-RPC style request to the native bridge */
    private nativeCall(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.nativeProcess || !this.nativeProcess.stdin) {
                reject(new Error('Native bridge not available'));
                return;
            }
            const id = ++this.nativeRequestId;
            const msg = JSON.stringify({ id, method, params }) + '\n';
            this.nativePendingRequests.set(id, { resolve, reject });
            this.nativeProcess.stdin.write(msg, (err) => {
                if (err) {
                    this.nativePendingRequests.delete(id);
                    reject(err);
                }
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.nativePendingRequests.has(id)) {
                    this.nativePendingRequests.delete(id);
                    reject(new Error(`Native bridge call '${method}' timed out`));
                }
            }, 30000);
        });
    }

    /** Open a capture in the native replay controller */
    async nativeOpenCapture(filePath: string): Promise<any> {
        return this.nativeCall('openCapture', { path: filePath });
    }

    /** Explicitly try local replay for SuggestRemote captures (user-initiated) */
    async nativeTryReplay(): Promise<any> {
        return this.nativeCall('tryReplay', {});
    }

    /** Get pipeline state at a specific event via native bridge */
    async nativeGetPipelineState(eventId: number): Promise<any> {
        return this.nativeCall('getPipelineState', { eventId });
    }

    /** Get shader source at a specific event via native bridge */
    async nativeGetShaderSource(eventId: number, stage?: string): Promise<any> {
        return this.nativeCall('getShaderSourceForEvent', { eventId, stage });
    }

    /** Get texture data via native bridge (saves to temp PNG, returns base64) */
    async nativeGetTextureData(textureId: string, mip?: number, eventId?: number, channelExtract?: number): Promise<any> {
        return this.nativeCall('getTexturePreview', { resourceId: parseInt(textureId, 10) || 0, mip: mip ?? 0, eventId: eventId ?? 0, channelExtract: channelExtract ?? -1 });
    }

    /** Get root actions (draw call tree) via native bridge */
    async nativeGetRootActions(): Promise<any> {
        return this.nativeCall('getRootActions', {});
    }

    // ═══════════════════════════════════════════════════════════════════
    //  XML-based shader source extraction (fallback without native)
    // ═══════════════════════════════════════════════════════════════════

    /** Extract shader sources from XML conversion (e.g. glShaderSource chunks) */
    async getShaderSourcesFromXml(filePath: string): Promise<Array<{ name: string; source: string }>> {
        const xml = await this.convertToXml(filePath);
        const shaders: Array<{ name: string; source: string }> = [];

        const genericChunkRegex = /<chunk\s([^>]*)>([\s\S]*?)<\/chunk>/g;
        let match: RegExpExecArray | null;

        while ((match = genericChunkRegex.exec(xml)) !== null) {
            const attrs = match[1];
            const body = match[2];
            const nameMatch = attrs.match(/name="([^"]*)"/);
            if (!nameMatch) { continue; }

            const chunkName = nameMatch[1].toLowerCase();
            if (chunkName.includes('shadersource') || chunkName.includes('createshader')) {
                // Extract the source string
                const sourceMatch = body.match(/<string[^>]*>([\s\S]*?)<\/string>/);
                if (sourceMatch && sourceMatch[1].trim().length > 10) {
                    shaders.push({
                        name: nameMatch[1],
                        source: sourceMatch[1].trim(),
                    });
                }
            }
        }

        return shaders;
    }
}
