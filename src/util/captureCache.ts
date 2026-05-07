import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CaptureInfo, DrawCall, ResourceInfo } from '../types';

const CACHE_VERSION = 5;

export interface CachedCapture {
    version: number;
    filePath: string;
    mtimeMs: number;
    size: number;
    savedAt: number;
    captureInfo: CaptureInfo;
    drawCalls: DrawCall[];
    resources: ResourceInfo[];
}

/**
 * Persists expensive post-replay results (draw-call tree, resource list,
 * capture header) keyed by the rdc file's path + mtime + size, so reopening
 * the same capture skips the multi-second (often 50+ s) replay init for
 * casual browsing. The live replay can still be upgraded on demand via the
 * "Try Local Replay" command when shader/pipeline/texture inspection is
 * needed.
 */
export class CaptureCache {
    private readonly cacheDir: string;

    constructor(context: vscode.ExtensionContext) {
        this.cacheDir = path.join(context.globalStorageUri.fsPath, 'cache');
        try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch { /* ignore */ }
    }

    private keyFor(filePath: string): { key: string; mtimeMs: number; size: number } | undefined {
        try {
            const st = fs.statSync(filePath);
            const hash = crypto
                .createHash('sha1')
                .update(filePath)
                .update('|')
                .update(String(st.mtimeMs))
                .update('|')
                .update(String(st.size))
                .digest('hex');
            return { key: hash, mtimeMs: st.mtimeMs, size: st.size };
        } catch {
            return undefined;
        }
    }

    private pathFor(key: string): string {
        return path.join(this.cacheDir, `${key}.json`);
    }

    get(filePath: string): CachedCapture | undefined {
        const k = this.keyFor(filePath);
        if (!k) { return undefined; }
        try {
            const raw = fs.readFileSync(this.pathFor(k.key), 'utf8');
            const data = JSON.parse(raw) as CachedCapture;
            if (data.version !== CACHE_VERSION) { return undefined; }
            if (data.mtimeMs !== k.mtimeMs || data.size !== k.size) { return undefined; }
            return data;
        } catch {
            return undefined;
        }
    }

    put(filePath: string, captureInfo: CaptureInfo, drawCalls: DrawCall[], resources: ResourceInfo[]): void {
        const k = this.keyFor(filePath);
        if (!k) { return; }
        const payload: CachedCapture = {
            version: CACHE_VERSION,
            filePath,
            mtimeMs: k.mtimeMs,
            size: k.size,
            savedAt: Date.now(),
            captureInfo,
            drawCalls,
            resources,
        };
        try {
            fs.writeFileSync(this.pathFor(k.key), JSON.stringify(payload));
        } catch (err: any) {
            console.warn('[RenderDoc] CaptureCache.put failed:', err?.message);
        }
    }

    /** Total size in bytes and file count of the cache directory. */
    stats(): { files: number; bytes: number } {
        let files = 0;
        let bytes = 0;
        try {
            for (const name of fs.readdirSync(this.cacheDir)) {
                const st = fs.statSync(path.join(this.cacheDir, name));
                if (st.isFile()) { files += 1; bytes += st.size; }
            }
        } catch { /* ignore */ }
        return { files, bytes };
    }

    clear(): { files: number; bytes: number } {
        const before = this.stats();
        try {
            for (const name of fs.readdirSync(this.cacheDir)) {
                try { fs.unlinkSync(path.join(this.cacheDir, name)); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
        return before;
    }
}

export function formatBytes(n: number): string {
    if (n < 1024) { return `${n} B`; }
    if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
