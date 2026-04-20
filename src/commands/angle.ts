import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * ANGLE (libEGL / libGLESv2) detection and installation helpers.
 *
 * GLES captures replayed on desktop require ANGLE DLLs to be present in
 * RenderDoc's `plugins/gles` folder. These helpers locate the RenderDoc
 * install directory, check whether the DLLs are already there, scan common
 * browser installs for ready-to-copy sources, and perform the copy
 * (elevating via PowerShell when needed on Windows).
 */

export function getRenderDocDir(): string {
    const config = vscode.workspace.getConfiguration('renderdoc');
    const configuredPath = config.get<string>('installPath');
    if (configuredPath) { return configuredPath; }
    // Default Windows path
    return path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'RenderDoc');
}

export function checkAngleAvailability(): { available: boolean; targetDir: string } {
    const rdcDir = getRenderDocDir();
    const pluginDir = path.join(rdcDir, 'plugins', 'gles');
    const eglPath = path.join(pluginDir, 'libEGL.dll');
    const glesPath = path.join(pluginDir, 'libGLESv2.dll');
    return {
        available: fs.existsSync(eglPath) && fs.existsSync(glesPath),
        targetDir: pluginDir,
    };
}

export function findAngleSources(): { egl: string; gles: string; source: string } | null {
    // Search for ANGLE DLLs in common locations
    const candidates: Array<{ dir: string; source: string }> = [];

    // Chrome
    const chromeDirs = [
        path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application'),
    ];
    for (const chromeBase of chromeDirs) {
        try {
            if (!fs.existsSync(chromeBase)) { continue; }
            const entries = fs.readdirSync(chromeBase).filter(e => /^\d+\./.test(e)).sort().reverse();
            for (const ver of entries) {
                const dir = path.join(chromeBase, ver);
                candidates.push({ dir, source: `Chrome ${ver}` });
            }
        } catch { /* ignore */ }
    }

    // Edge
    const edgeDirs = [
        path.join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application'),
    ];
    for (const edgeBase of edgeDirs) {
        try {
            if (!fs.existsSync(edgeBase)) { continue; }
            const entries = fs.readdirSync(edgeBase).filter(e => /^\d+\./.test(e)).sort().reverse();
            for (const ver of entries) {
                const dir = path.join(edgeBase, ver);
                candidates.push({ dir, source: `Edge ${ver}` });
            }
        } catch { /* ignore */ }
    }

    for (const { dir, source } of candidates) {
        const egl = path.join(dir, 'libEGL.dll');
        const gles = path.join(dir, 'libGLESv2.dll');
        if (fs.existsSync(egl) && fs.existsSync(gles)) {
            return { egl, gles, source };
        }
    }
    return null;
}

export async function installAngleDlls(sources: { egl: string; gles: string; source: string }): Promise<boolean> {
    const { targetDir } = checkAngleAvailability();
    try {
        // Try direct copy first (may fail without admin)
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.copyFileSync(sources.egl, path.join(targetDir, 'libEGL.dll'));
        fs.copyFileSync(sources.gles, path.join(targetDir, 'libGLESv2.dll'));
        return true;
    } catch {
        // Need admin elevation on Windows
        if (process.platform === 'win32') {
            try {
                const cp = await import('child_process');
                const psCmd = `New-Item '${targetDir}' -ItemType Directory -Force | Out-Null; ` +
                    `Copy-Item '${sources.egl}' '${path.join(targetDir, 'libEGL.dll')}' -Force; ` +
                    `Copy-Item '${sources.gles}' '${path.join(targetDir, 'libGLESv2.dll')}' -Force`;
                cp.execSync(`powershell -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command',\\"${psCmd.replace(/"/g, '`"')}\\""`, { timeout: 30000 });
                // Verify
                return fs.existsSync(path.join(targetDir, 'libEGL.dll')) && fs.existsSync(path.join(targetDir, 'libGLESv2.dll'));
            } catch (adminErr: any) {
                vscode.window.showErrorMessage(`Failed to install ANGLE (admin privileges required): ${adminErr.message}`);
                return false;
            }
        }
        return false;
    }
}
