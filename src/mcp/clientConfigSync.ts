import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

const RENDERDOC_MCP_SERVER_NAME = 'renderdoc-for-vscode';

type McpConfigRootKey = 'servers' | 'mcpServers';

export interface WorkspaceMcpClientConfigFileResult {
    label: string;
    filePath: string;
    status: 'created' | 'updated' | 'unchanged' | 'error';
    error?: string;
}

export interface WorkspaceMcpClientConfigSyncResult {
    files: WorkspaceMcpClientConfigFileResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildJsonText(data: Record<string, unknown>): string {
    return `${JSON.stringify(data, null, 4)}\n`;
}

async function syncNamedServerConfig(options: {
    filePath: string;
    label: string;
    rootKey: McpConfigRootKey;
    serverConfig: Record<string, unknown>;
}): Promise<WorkspaceMcpClientConfigFileResult> {
    try {
        let currentData: Record<string, unknown> = {};
        let existed = false;

        if (fs.existsSync(options.filePath)) {
            existed = true;
            const raw = await fs.promises.readFile(options.filePath, 'utf8');
            if (raw.trim()) {
                const parsed = JSON.parse(raw) as unknown;
                if (!isRecord(parsed)) {
                    throw new Error('Expected the config file to contain a top-level JSON object.');
                }
                currentData = parsed;
            }
        }

        const currentRoot = currentData[options.rootKey];
        if (currentRoot != null && !isRecord(currentRoot)) {
            throw new Error(`Expected \"${options.rootKey}\" to be a JSON object.`);
        }

        const nextRoot: Record<string, unknown> = {
            ...(isRecord(currentRoot) ? currentRoot : {}),
            [RENDERDOC_MCP_SERVER_NAME]: options.serverConfig,
        };

        const nextData: Record<string, unknown> = {
            ...currentData,
            [options.rootKey]: nextRoot,
        };

        if (JSON.stringify(currentData) === JSON.stringify(nextData)) {
            return {
                label: options.label,
                filePath: options.filePath,
                status: 'unchanged',
            };
        }

        await fs.promises.mkdir(path.dirname(options.filePath), { recursive: true });
        await fs.promises.writeFile(options.filePath, buildJsonText(nextData), 'utf8');

        return {
            label: options.label,
            filePath: options.filePath,
            status: existed ? 'updated' : 'created',
        };
    } catch (error: any) {
        return {
            label: options.label,
            filePath: options.filePath,
            status: 'error',
            error: error?.message ?? String(error),
        };
    }
}

export async function syncWorkspaceMcpClientConfigs(url: string): Promise<WorkspaceMcpClientConfigSyncResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const results: WorkspaceMcpClientConfigFileResult[] = [];

    for (const folder of workspaceFolders) {
        const workspaceRoot = folder.uri.fsPath;

        results.push(await syncNamedServerConfig({
            filePath: path.join(workspaceRoot, '.vscode', 'mcp.json'),
            label: 'VS Code workspace MCP',
            rootKey: 'servers',
            serverConfig: {
                type: 'http',
                url,
            },
        }));

        results.push(await syncNamedServerConfig({
            filePath: path.join(workspaceRoot, '.roo', 'mcp.json'),
            label: 'Roo/Zoo workspace MCP',
            rootKey: 'mcpServers',
            serverConfig: {
                type: 'streamable-http',
                url,
            },
        }));
    }

    return { files: results };
}