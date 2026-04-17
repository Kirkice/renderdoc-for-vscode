import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { RenderDocBridge } from './renderdocBridge';

// Update this when you cut new Releases on GitHub.
const RELEASES_API = 'https://api.github.com/repos/Kirkice/renderdoc-for-vscode/releases/latest';
const RELEASES_PAGE = 'https://github.com/Kirkice/renderdoc-for-vscode/releases/latest';
const BUILD_DOCS_URL = 'https://github.com/Kirkice/renderdoc-for-vscode#️-building-from-source';
const GLOBAL_STATE_SKIP_PROMPT = 'renderdoc.skipBridgePrompt';

/**
 * On first activation (or every activation until the user opts out), check
 * whether `renderdoc_bridge` is available. If not, offer to download the
 * prebuilt binary from the latest GitHub Release, or fall back to guiding
 * the user to build from source.
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
        'Download Prebuilt',
        'Build from Source',
        'Not now',
        'Don\'t ask again',
    );

    if (pick === 'Download Prebuilt') {
        await downloadBridgeBinary(context, bridge);
    } else if (pick === 'Build from Source') {
        vscode.env.openExternal(vscode.Uri.parse(BUILD_DOCS_URL));
    } else if (pick === 'Don\'t ask again') {
        await context.globalState.update(GLOBAL_STATE_SKIP_PROMPT, true);
    }
}

async function downloadBridgeBinary(
    context: vscode.ExtensionContext,
    bridge: RenderDocBridge,
): Promise<void> {
    const assetName = RenderDocBridge.expectedBridgeAssetName();
    const targetPath = path.join(
        context.globalStorageUri.fsPath,
        process.platform === 'win32' ? 'renderdoc_bridge.exe' : 'renderdoc_bridge',
    );

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Downloading ${assetName}…`,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Locating latest release…' });
                const release = await fetchJson(RELEASES_API);
                const asset = (release.assets || []).find((a: any) => a.name === assetName);
                if (!asset) {
                    throw new Error(
                        `No asset named "${assetName}" in the latest release. ` +
                        `You may need to build from source on this platform.`,
                    );
                }

                progress.report({ message: 'Downloading binary…' });
                await downloadToFile(asset.browser_download_url, targetPath);

                // On POSIX, make it executable.
                if (process.platform !== 'win32') {
                    try { fs.chmodSync(targetPath, 0o755); } catch { /* ignore */ }
                }
            },
        );

        vscode.window.showInformationMessage(
            'RenderDoc native bridge downloaded successfully. Reload the window to activate it.',
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
            `Failed to download native bridge: ${msg}`,
            'Open Releases Page',
            'Build from Source',
            'Dismiss',
        );
        if (action === 'Open Releases Page') {
            vscode.env.openExternal(vscode.Uri.parse(RELEASES_PAGE));
        } else if (action === 'Build from Source') {
            vscode.env.openExternal(vscode.Uri.parse(BUILD_DOCS_URL));
        }
    }
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
