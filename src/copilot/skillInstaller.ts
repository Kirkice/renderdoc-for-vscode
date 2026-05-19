import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const USER_SKILL_ROOT = path.join(os.homedir(), '.copilot', 'skills');
const USER_INSTRUCTION_ROOT = path.join(os.homedir(), '.copilot', 'instructions');
const MARKER_FILE = '.renderdoc-managed-skill.json';
const MANAGED_FILE_MARKER_SUFFIX = '.renderdoc-managed.json';
const USER_INSTRUCTION_FILE_NAME = 'renderdoc-capture-analysis.instructions.md';

interface ExtensionPackageInfo {
    id: string;
    version: string;
}

interface ManagedSkillMarker {
    managedBy: string;
    extensionVersion: string;
    contentHash: string;
    skillName: string;
    installedAt: string;
}

interface ManagedInstructionMarker {
    managedBy: string;
    extensionVersion: string;
    contentHash: string;
    fileName: string;
    installedAt: string;
}

interface SkillSyncResult {
    installed: string[];
    updated: string[];
    removed: string[];
    conflicts: string[];
}

interface InstructionSyncResult {
    installed: string[];
    updated: string[];
    removed: string[];
    conflicts: string[];
}

interface CopilotCustomizationSyncResult {
    skills: SkillSyncResult;
    instructions: InstructionSyncResult;
}

export async function ensureBundledSkillsInstalled(context: vscode.ExtensionContext): Promise<void> {
    await ensureBundledCopilotCustomizationsInstalled(context);
}

export async function reinstallBundledCopilotCustomizations(context: vscode.ExtensionContext): Promise<void> {
    await ensureBundledCopilotCustomizationsInstalled(context, { forceShowSummary: true });
}

export async function ensureBundledCopilotCustomizationsInstalled(
    context: vscode.ExtensionContext,
    options: { forceShowSummary?: boolean } = {},
): Promise<CopilotCustomizationSyncResult> {
    const packageInfo = await readExtensionPackageInfo(context.extensionUri.fsPath);
    const skillSourceRoot = path.join(context.extensionUri.fsPath, '.github', 'skills');
    const instructionSourceFile = path.join(context.extensionUri.fsPath, '.github', 'copilot-instructions.md');
    const hasBundledSkills = await isDirectory(skillSourceRoot);

    const skills = hasBundledSkills
        ? await syncBundledSkills({
            sourceRoot: skillSourceRoot,
            targetRoot: USER_SKILL_ROOT,
            managedBy: packageInfo.id,
            extensionVersion: packageInfo.version,
        })
        : createEmptySkillSyncResult();

    if (!hasBundledSkills) {
        console.log('[RenderDoc] No bundled skills found at', skillSourceRoot);
    }

    const instructions = await syncBundledInstructions({
        sourceFile: instructionSourceFile,
        targetRoot: USER_INSTRUCTION_ROOT,
        targetFileName: USER_INSTRUCTION_FILE_NAME,
        managedBy: packageInfo.id,
        extensionVersion: packageInfo.version,
    });

    if (skills.conflicts.length > 0) {
        console.warn(
            '[RenderDoc] Skill sync skipped existing unmanaged directories:',
            skills.conflicts.join(', '),
        );
    }
    if (instructions.conflicts.length > 0) {
        console.warn(
            '[RenderDoc] Instruction sync skipped existing unmanaged files:',
            instructions.conflicts.join(', '),
        );
    }

    const result: CopilotCustomizationSyncResult = { skills, instructions };
    await showSyncSummary(result, { forceShowSummary: options.forceShowSummary ?? false });
    return result;
}

function createEmptySkillSyncResult(): SkillSyncResult {
    return {
        installed: [],
        updated: [],
        removed: [],
        conflicts: [],
    };
}

function createEmptyInstructionSyncResult(): InstructionSyncResult {
    return {
        installed: [],
        updated: [],
        removed: [],
        conflicts: [],
    };
}

async function syncBundledInstructions(options: {
    sourceFile: string;
    targetRoot: string;
    targetFileName: string;
    managedBy: string;
    extensionVersion: string;
}): Promise<InstructionSyncResult> {
    const result = createEmptyInstructionSyncResult();
    const targetFile = path.join(options.targetRoot, options.targetFileName);
    const markerPath = getManagedFileMarkerPath(targetFile);
    const existingMarker = await readInstructionMarker(markerPath);

    if (!(await exists(options.sourceFile))) {
        if (existingMarker?.managedBy === options.managedBy) {
            await removeFile(targetFile);
            await removeFile(markerPath);
            result.removed.push(options.targetFileName);
        }
        return result;
    }

    await fs.promises.mkdir(options.targetRoot, { recursive: true });

    const sourceContent = buildUserInstructionContent(
        await fs.promises.readFile(options.sourceFile, 'utf8'),
    );
    const sourceHash = hashString(sourceContent);

    if (await exists(targetFile)) {
        if (existingMarker?.managedBy === options.managedBy) {
            if (existingMarker.contentHash === sourceHash
                && existingMarker.extensionVersion === options.extensionVersion) {
                return result;
            }

            await writeManagedInstructionFile(targetFile, sourceContent, {
                managedBy: options.managedBy,
                extensionVersion: options.extensionVersion,
                contentHash: sourceHash,
                fileName: options.targetFileName,
                installedAt: new Date().toISOString(),
            });
            result.updated.push(options.targetFileName);
            return result;
        }

        const existingContent = await fs.promises.readFile(targetFile, 'utf8').catch(() => '');
        if (normalizeTextForComparison(existingContent) === normalizeTextForComparison(sourceContent)) {
            await writeInstructionMarker(markerPath, {
                managedBy: options.managedBy,
                extensionVersion: options.extensionVersion,
                contentHash: sourceHash,
                fileName: options.targetFileName,
                installedAt: new Date().toISOString(),
            });
            return result;
        }

        result.conflicts.push(options.targetFileName);
        return result;
    }

    await writeManagedInstructionFile(targetFile, sourceContent, {
        managedBy: options.managedBy,
        extensionVersion: options.extensionVersion,
        contentHash: sourceHash,
        fileName: options.targetFileName,
        installedAt: new Date().toISOString(),
    });
    result.installed.push(options.targetFileName);
    return result;
}

function buildUserInstructionContent(sourceMarkdown: string): string {
    const body = sourceMarkdown.trim();
    return [
        '---',
        "name: RenderDoc Capture Analysis",
        'description: Apply this when the chat is about RenderDoc GPU captures, selected or current draws, EIDs, GPU timings, pipeline state, shader bindings, textures, buffers, or Unity-side mapping and local renderdoc_* tools may be available.',
        '---',
        '',
        body,
        '',
    ].join('\n');
}

function hashString(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function getManagedFileMarkerPath(targetFile: string): string {
    const fileName = path.basename(targetFile);
    return path.join(path.dirname(targetFile), `.${fileName}${MANAGED_FILE_MARKER_SUFFIX}`);
}

async function writeManagedInstructionFile(
    targetFile: string,
    content: string,
    marker: ManagedInstructionMarker,
): Promise<void> {
    await fs.promises.writeFile(targetFile, content, 'utf8');
    await writeInstructionMarker(getManagedFileMarkerPath(targetFile), marker);
}

async function writeInstructionMarker(markerPath: string, marker: ManagedInstructionMarker): Promise<void> {
    await fs.promises.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');
}

async function readInstructionMarker(markerPath: string): Promise<ManagedInstructionMarker | undefined> {
    if (!(await exists(markerPath))) {
        return undefined;
    }

    try {
        const raw = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'));
        if (typeof raw?.managedBy !== 'string') {
            return undefined;
        }
        return raw as ManagedInstructionMarker;
    } catch {
        return undefined;
    }
}

function normalizeTextForComparison(content: string): string {
    return content.replace(/\r\n/g, '\n').trim();
}

async function showSyncSummary(
    result: CopilotCustomizationSyncResult,
    options: { forceShowSummary: boolean },
): Promise<void> {
    const changeCount = countChanges(result);
    const conflictCount = result.skills.conflicts.length + result.instructions.conflicts.length;
    const copilotInstalled = !!vscode.extensions.getExtension('github.copilot-chat');

    if (changeCount === 0 && conflictCount === 0 && !options.forceShowSummary) {
        return;
    }
    if (!options.forceShowSummary && !copilotInstalled) {
        return;
    }

    let message: string;
    if (changeCount === 0) {
        message = conflictCount > 0
            ? `RenderDoc Copilot customizations were not changed because ${conflictCount} unmanaged item${conflictCount === 1 ? '' : 's'} already exist in your user profile.`
            : 'RenderDoc Copilot customizations are already up to date in your user profile.';
    } else {
        message = `RenderDoc Copilot customizations ${buildSummaryParts(result).join(', ')} in your user profile.`;
        if (conflictCount > 0) {
            message += ` Skipped ${conflictCount} unmanaged item${conflictCount === 1 ? '' : 's'}.`;
        }
        message += ' Start a new Copilot chat or reload the window if they are not discovered immediately.';
    }

    const actions = copilotInstalled ? ['Reload Window'] : [];
    const action = conflictCount > 0
        ? await vscode.window.showWarningMessage(message, ...actions)
        : await vscode.window.showInformationMessage(message, ...actions);

    if (action === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

function countChanges(result: CopilotCustomizationSyncResult): number {
    return buildSummaryParts(result).length;
}

function buildSummaryParts(result: CopilotCustomizationSyncResult): string[] {
    const summary: string[] = [];
    appendSummary(summary, result.skills.installed.length, 'skill', 'installed');
    appendSummary(summary, result.skills.updated.length, 'skill', 'updated');
    appendSummary(summary, result.skills.removed.length, 'stale skill', 'removed');
    appendSummary(summary, result.instructions.installed.length, 'instruction file', 'installed');
    appendSummary(summary, result.instructions.updated.length, 'instruction file', 'updated');
    appendSummary(summary, result.instructions.removed.length, 'stale instruction file', 'removed');
    return summary;
}

function appendSummary(summary: string[], count: number, noun: string, verb: string): void {
    if (count > 0) {
        summary.push(`${verb} ${count} ${noun}${count === 1 ? '' : 's'}`);
    }
}

async function syncBundledSkills(options: {
    sourceRoot: string;
    targetRoot: string;
    managedBy: string;
    extensionVersion: string;
}): Promise<SkillSyncResult> {
    const result = createEmptySkillSyncResult();

    await fs.promises.mkdir(options.targetRoot, { recursive: true });

    const sourceEntries = await fs.promises.readdir(options.sourceRoot, { withFileTypes: true });
    const bundledSkillNames = new Set<string>();

    for (const entry of sourceEntries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const skillName = entry.name;
        const sourceDir = path.join(options.sourceRoot, skillName);
        const skillFile = path.join(sourceDir, 'SKILL.md');
        if (!(await exists(skillFile))) {
            continue;
        }

        bundledSkillNames.add(skillName);

        const targetDir = path.join(options.targetRoot, skillName);
        const sourceHash = await hashDirectory(sourceDir);
        const existingMarker = await readMarker(targetDir);

        if (await isDirectory(targetDir)) {
            if (existingMarker?.managedBy === options.managedBy) {
                if (existingMarker.contentHash === sourceHash
                    && existingMarker.extensionVersion === options.extensionVersion) {
                    continue;
                }

                await removeDirectory(targetDir);
                await copyDirectory(sourceDir, targetDir);
                await writeMarker(targetDir, {
                    managedBy: options.managedBy,
                    extensionVersion: options.extensionVersion,
                    contentHash: sourceHash,
                    skillName,
                    installedAt: new Date().toISOString(),
                });
                result.updated.push(skillName);
                continue;
            }

            const existingHash = await hashDirectory(targetDir).catch(() => '');
            if (existingHash === sourceHash) {
                await writeMarker(targetDir, {
                    managedBy: options.managedBy,
                    extensionVersion: options.extensionVersion,
                    contentHash: sourceHash,
                    skillName,
                    installedAt: new Date().toISOString(),
                });
                continue;
            }

            result.conflicts.push(skillName);
            continue;
        }

        await copyDirectory(sourceDir, targetDir);
        await writeMarker(targetDir, {
            managedBy: options.managedBy,
            extensionVersion: options.extensionVersion,
            contentHash: sourceHash,
            skillName,
            installedAt: new Date().toISOString(),
        });
        result.installed.push(skillName);
    }

    const targetEntries = await fs.promises.readdir(options.targetRoot, { withFileTypes: true });
    for (const entry of targetEntries) {
        if (!entry.isDirectory()) {
            continue;
        }

        if (bundledSkillNames.has(entry.name)) {
            continue;
        }

        const targetDir = path.join(options.targetRoot, entry.name);
        const marker = await readMarker(targetDir);
        if (marker?.managedBy !== options.managedBy) {
            continue;
        }

        await removeDirectory(targetDir);
        result.removed.push(entry.name);
    }

    return result;
}

async function readExtensionPackageInfo(extensionRoot: string): Promise<ExtensionPackageInfo> {
    const packageJsonPath = path.join(extensionRoot, 'package.json');
    const raw = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
    const publisher = typeof raw.publisher === 'string' ? raw.publisher : 'unknown';
    const name = typeof raw.name === 'string' ? raw.name : 'renderdoc-for-vscode';
    const version = typeof raw.version === 'string' ? raw.version : '0.0.0';
    return {
        id: `${publisher}.${name}`,
        version,
    };
}

async function writeMarker(targetDir: string, marker: ManagedSkillMarker): Promise<void> {
    const markerPath = path.join(targetDir, MARKER_FILE);
    await fs.promises.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');
}

async function readMarker(targetDir: string): Promise<ManagedSkillMarker | undefined> {
    const markerPath = path.join(targetDir, MARKER_FILE);
    if (!(await exists(markerPath))) {
        return undefined;
    }

    try {
        const raw = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'));
        if (typeof raw?.managedBy !== 'string') {
            return undefined;
        }
        return raw as ManagedSkillMarker;
    } catch {
        return undefined;
    }
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
    await fs.promises.mkdir(targetDir, { recursive: true });
    const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            await copyDirectory(sourcePath, targetPath);
        } else if (entry.isFile()) {
            await fs.promises.copyFile(sourcePath, targetPath);
        }
    }
}

async function hashDirectory(rootDir: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const files = await collectFiles(rootDir, rootDir);
    for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
        hash.update(file.relative);
        hash.update('\0');
        hash.update(await fs.promises.readFile(file.absolute));
        hash.update('\0');
    }
    return hash.digest('hex');
}

async function collectFiles(rootDir: string, currentDir: string): Promise<Array<{ absolute: string; relative: string }>> {
    const files: Array<{ absolute: string; relative: string }> = [];
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === MARKER_FILE) {
            continue;
        }

        const absolute = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(rootDir, absolute));
        } else if (entry.isFile()) {
            files.push({
                absolute,
                relative: path.relative(rootDir, absolute).replace(/\\/g, '/'),
            });
        }
    }
    return files;
}

async function removeDirectory(dirPath: string): Promise<void> {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
}

async function removeFile(filePath: string): Promise<void> {
    await fs.promises.rm(filePath, { force: true });
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function isDirectory(dirPath: string): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(dirPath);
        return stat.isDirectory();
    } catch {
        return false;
    }
}