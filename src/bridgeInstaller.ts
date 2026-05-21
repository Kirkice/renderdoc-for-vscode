import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import JSZip from 'jszip';
import { RenderDocBridge } from './renderdocBridge';

// Update this when you cut new Releases on GitHub.
const RELEASES_API = 'https://api.github.com/repos/Kirkice/renderdoc-for-vscode/releases/latest';
const RELEASES_PAGE = 'https://github.com/Kirkice/renderdoc-for-vscode/releases/latest';
export const BUILD_DOCS_URL = 'https://github.com/Kirkice/renderdoc-for-vscode#️-building-from-source';
const GLOBAL_STATE_SKIP_PROMPT = 'renderdoc.skipBridgePrompt';
const RESTORE_FROM_VSIX_ACTION = 'Restore From Latest VSIX';
const BUILD_FROM_SOURCE_ACTION = 'Build from Source';
const OPEN_LATEST_RELEASE_ACTION = 'Open Latest Release';

/**
 * On first activation (or every activation until the user opts out), check
 * whether `renderdoc_bridge` is available. If not, offer to restore the
 * bundled binary from the latest VSIX on GitHub Releases, or fall back to
 * guiding the user to build from source.
 */
export async function ensureNativeBridge(
    context: vscode.ExtensionContext,
    bridge: RenderDocBridge,
): Promise<void> {
    // Point the bridge at the per-user download cache so findNativeBridge()
    // picks up anything we've already downloaded on a previous run.
    const downloadDir = context.globalStorageUri.fsPath;
    try { fs.mkdirSync(downloadDir, { recursive: true }); } catch { /* ignore */ }
    bridge.setDownloadedBridgeDir(downloadDir);

    if (bridge.isNativeBridgeInstalled()) { return; }
    if (context.globalState.get<boolean>(GLOBAL_STATE_SKIP_PROMPT)) { return; }

    const pick = await vscode.window.showInformationMessage(
        'RenderDoc: the native bridge binary was not found. Advanced features ' +
        '(pipeline state, shader source, texture previews) require it.',
        RESTORE_FROM_VSIX_ACTION,
        BUILD_FROM_SOURCE_ACTION,
        'Not now',
        'Don\'t ask again',
    );

    if (pick === RESTORE_FROM_VSIX_ACTION) {
        await restoreBundledBridgeFromLatestVsix(context, bridge);
    } else if (pick === BUILD_FROM_SOURCE_ACTION) {
        vscode.env.openExternal(vscode.Uri.parse(BUILD_DOCS_URL));
    } else if (pick === 'Don\'t ask again') {
        await context.globalState.update(GLOBAL_STATE_SKIP_PROMPT, true);
    }
}

async function restoreBundledBridgeFromLatestVsix(
    context: vscode.ExtensionContext,
    bridge: RenderDocBridge,
): Promise<void> {
    const exeName = process.platform === 'win32' ? 'renderdoc_bridge.exe' : 'renderdoc_bridge';
    const targetPath = path.join(
        context.globalStorageUri.fsPath,
        exeName,
    );
    const targetTmpPath = `${targetPath}.restoring`;
    const vsixPath = path.join(context.globalStorageUri.fsPath, `renderdoc-for-vscode-bridge-${Date.now()}.vsix`);

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Restoring bundled native bridge…',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Locating latest release…' });
                const release = await fetchJson(RELEASES_API);
                const asset = findLatestVsixAsset(release);
                if (!asset) {
                    throw new Error(
                        'No VSIX asset was found in the latest release. ' +
                        'Install the latest extension package manually or build from source.',
                    );
                }

                progress.report({ message: `Downloading ${asset.name}…` });
                await downloadToFile(asset.browser_download_url, vsixPath);

                progress.report({ message: 'Extracting bundled native bridge…' });
                const bridgeBytes = await extractBundledBridgeFromVsix(vsixPath);
                try { fs.rmSync(targetTmpPath, { force: true }); } catch { /* ignore */ }
                fs.writeFileSync(targetTmpPath, bridgeBytes);

                // On POSIX, make it executable.
                if (process.platform !== 'win32') {
                    try { fs.chmodSync(targetTmpPath, 0o755); } catch { /* ignore */ }
                }

                try { fs.rmSync(targetPath, { force: true }); } catch { /* ignore */ }
                fs.renameSync(targetTmpPath, targetPath);
            },
        );

        vscode.window.showInformationMessage(
            'RenderDoc native bridge restored successfully from the latest VSIX. Reload the window to activate it.',
            'Reload Window',
        ).then((choice) => {
            if (choice === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });

        // Try starting it immediately too — reload isn't strictly required.
        bridge.tryStartNativeBridge();
    } catch (err: any) {
        const msg = err?.message || String(err);
        const action = await vscode.window.showErrorMessage(
            `Failed to restore the native bridge from the latest VSIX: ${msg}`,
            OPEN_LATEST_RELEASE_ACTION,
            BUILD_FROM_SOURCE_ACTION,
            'Dismiss',
        );
        if (action === OPEN_LATEST_RELEASE_ACTION) {
            vscode.env.openExternal(vscode.Uri.parse(RELEASES_PAGE));
        } else if (action === BUILD_FROM_SOURCE_ACTION) {
            vscode.env.openExternal(vscode.Uri.parse(BUILD_DOCS_URL));
        }
    } finally {
        try { fs.rmSync(vsixPath, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(targetTmpPath, { force: true }); } catch { /* ignore */ }
    }
}

function findLatestVsixAsset(release: any): { name: string; browser_download_url: string } | undefined {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const candidate = assets.find((asset: any) => {
        return typeof asset?.name === 'string'
            && asset.name.endsWith('.vsix')
            && typeof asset?.browser_download_url === 'string';
    });

    if (!candidate) {
        return undefined;
    }

    return {
        name: candidate.name,
        browser_download_url: candidate.browser_download_url,
    };
}

function getBundledBridgeArchivePaths(): string[] {
    const exeName = process.platform === 'win32' ? 'renderdoc_bridge.exe' : 'renderdoc_bridge';
    return [
        `extension/native/build/Release/${exeName}`,
        `extension/native/build/${exeName}`,
        `extension/${exeName}`,
    ];
}

async function extractBundledBridgeFromVsix(vsixPath: string): Promise<Buffer> {
    const archive = await JSZip.loadAsync(fs.readFileSync(vsixPath));

    for (const candidatePath of getBundledBridgeArchivePaths()) {
        const entry = archive.file(candidatePath);
        if (entry) {
            return entry.async('nodebuffer');
        }
    }

    throw new Error(
        `The latest VSIX does not contain a bundled native bridge at any expected path: ${getBundledBridgeArchivePaths().join(', ')}`,
    );
}

/** Minimal JSON GET with GitHub API headers + redirect handling. */
function fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            {
                headers: {
                    'User-Agent': 'renderdoc-for-vscode',
                    'Accept': 'application/vnd.github+json',
                },
            },
            (res) => {
                if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                    fetchJson(res.headers.location).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} from ${url}`));
                    res.resume();
                    return;
                }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            },
        );
        req.on('error', reject);
    });
}

/** Stream a URL to disk, following redirects. */
function downloadToFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = (u: string) => {
            https.get(
                u,
                {
                    headers: { 'User-Agent': 'renderdoc-for-vscode' },
                },
                (res) => {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        request(res.headers.location);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode} from ${u}`));
                        res.resume();
                        return;
                    }
                    const tmp = dest + '.downloading';
                    const out = fs.createWriteStream(tmp);
                    res.pipe(out);
                    out.on('finish', () => {
                        out.close((err) => {
                            if (err) { reject(err); return; }
                            try {
                                fs.renameSync(tmp, dest);
                                resolve();
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
                    out.on('error', reject);
                },
            ).on('error', reject);
        };
        request(url);
    });
}
