import { createServer, type Server as HttpServer } from 'node:http';

import * as vscode from 'vscode';
import { RENDERDOC_TOOL_REGISTRY, type RenderDocToolDefinition } from '../copilot/toolRegistry';

const MCP_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const DEFAULT_MCP_PORT = 38967;

let mcpRuntimePromise: Promise<{
    McpServer: any;
    NodeStreamableHTTPServerTransport: any;
}> | undefined;

interface McpCallToolResult {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

interface McpServerLike {
    close(): Promise<void>;
    registerTool(name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<McpCallToolResult>): void;
    connect(transport: McpTransportLike): Promise<void>;
}

interface McpTransportLike {
    close(): Promise<void>;
    handleRequest(req: unknown, res: unknown, parsedBody?: unknown): Promise<void>;
}

type McpToolBinding = RenderDocToolDefinition & { tool: vscode.LanguageModelTool<any> };

export interface RenderDocMcpStatus {
    enabled: boolean;
    running: boolean;
    host: string;
    port: number;
    path: string;
    url?: string;
    toolNames: string[];
    lastError?: string;
}

function createMcpToolBindings(): McpToolBinding[] {
    return RENDERDOC_TOOL_REGISTRY.map((definition) => ({
        ...definition,
        tool: definition.createTool(),
    }));
}

function getRenderDocMcpConfiguration() {
    const configuration = vscode.workspace.getConfiguration('renderdoc');
    const enabled = configuration.get<boolean>('mcpServer.enabled', true) ?? true;
    const configuredPort = configuration.get<number>('mcpServer.port', DEFAULT_MCP_PORT) ?? DEFAULT_MCP_PORT;
    const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
        ? configuredPort
        : DEFAULT_MCP_PORT;

    return { enabled, port };
}

async function loadMcpRuntime() {
    if (!mcpRuntimePromise) {
        mcpRuntimePromise = Promise.all([
            import('@modelcontextprotocol/server'),
            import('@modelcontextprotocol/node'),
        ]).then(([serverModule, nodeModule]) => ({
            McpServer: serverModule.McpServer,
            NodeStreamableHTTPServerTransport: nodeModule.NodeStreamableHTTPServerTransport,
        }));
    }

    return mcpRuntimePromise;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    return input as Record<string, unknown>;
}

function serializeToolResult(result: vscode.LanguageModelToolResult): { text: string; structuredContent?: Record<string, unknown> } {
    const textParts: string[] = [];

    for (const part of result.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            textParts.push(part.value);
            continue;
        }

        const candidate = (part as { value?: unknown } | undefined)?.value;
        if (typeof candidate === 'string') {
            textParts.push(candidate);
        }
    }

    const text = textParts.join('\n\n').trim();
    if (!text) {
        return { text: '' };
    }

    try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { text, structuredContent: parsed as Record<string, unknown> };
        }
    } catch {
        // Leave plain-text results as-is.
    }

    return { text };
}

async function invokeLanguageModelTool(tool: vscode.LanguageModelTool<any>, input: Record<string, unknown>): Promise<McpCallToolResult> {
    const tokenSource = new vscode.CancellationTokenSource();

    try {
        const result = await tool.invoke(
            { input } as vscode.LanguageModelToolInvocationOptions<any>,
            tokenSource.token,
        );
        if (!result) {
            return { content: [] };
        }
        const serialized = serializeToolResult(result);
        const text = serialized.text || (serialized.structuredContent
            ? JSON.stringify(serialized.structuredContent, null, 2)
            : '');

        return {
            content: text ? [{ type: 'text', text }] : [],
            ...(serialized.structuredContent ? { structuredContent: serialized.structuredContent } : {}),
        };
    } catch (error: any) {
        const message = error?.message ?? String(error);
        return {
            isError: true,
            content: [{ type: 'text', text: message }],
        };
    } finally {
        tokenSource.dispose();
    }
}

function buildGenericConfigSnippet(url: string): string {
    return JSON.stringify(
        {
            mcpServers: {
                'renderdoc-for-vscode': {
                    type: 'streamable-http',
                    url,
                },
            },
        },
        null,
        2,
    );
}

function buildVsCodeConfigSnippet(url: string): string {
    return JSON.stringify(
        {
            servers: {
                'renderdoc-for-vscode': {
                    type: 'http',
                    url,
                },
            },
        },
        null,
        2,
    );
}

export class RenderDocMcpServer implements vscode.Disposable {
    private server: McpServerLike | undefined;
    private transport: McpTransportLike | undefined;
    private httpServer: HttpServer | undefined;
    private url: string | undefined;
    private actualPort: number | undefined;
    private lastError: string | undefined;
    private readonly outputChannel = vscode.window.createOutputChannel('RenderDoc For VSCode MCP');

    constructor(
        private readonly extensionVersion: string,
        private readonly getCurrentCapturePath: () => string | undefined,
    ) {}

    async startIfEnabled(): Promise<RenderDocMcpStatus> {
        const configuration = getRenderDocMcpConfiguration();
        if (!configuration.enabled) {
            await this.stop();
            return this.getStatus();
        }

        if (this.httpServer?.listening && this.actualPort === configuration.port && this.url) {
            return this.getStatus();
        }

        await this.stop();

        try {
            const runtime = await loadMcpRuntime();
            const toolBindings = createMcpToolBindings();
            const server = new runtime.McpServer(
                {
                    name: 'renderdoc-for-vscode-mcp',
                    version: this.extensionVersion,
                    title: 'RenderDoc For VSCode MCP',
                },
                {
                    instructions: [
                        'This RenderDoc For VSCode MCP server exposes RenderDoc capture analysis tools from the active VS Code window.',
                        'If capture state is unknown, call renderdoc_openCapture with no filePath first so the server can resolve an already loaded or open .rdc capture from this VS Code window.',
                        'Only ask the user for filePath when renderdoc_openCapture reports that no open or loaded capture could be resolved in this window.',
                        'Use renderdoc_getSelectionContext for questions about the current selection or focused draw.',
                    ].join(' '),
                },
            );

            for (const binding of toolBindings) {
                server.registerTool(
                    binding.name,
                    {
                        title: binding.title,
                        description: binding.description,
                        inputSchema: binding.inputSchema,
                        annotations: {
                            readOnlyHint: binding.readOnly,
                            destructiveHint: false,
                            openWorldHint: false,
                        },
                    },
                    async (args: unknown): Promise<McpCallToolResult> => invokeLanguageModelTool(binding.tool, normalizeToolInput(args)),
                );
            }

            const transport = new runtime.NodeStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });

            await server.connect(transport);

            const httpServer = createServer(async (req, res) => {
                try {
                    const requestUrl = new URL(req.url ?? '/', `http://${MCP_HOST}`);
                    if (requestUrl.pathname !== MCP_PATH) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Not found' }));
                        return;
                    }

                    await transport.handleRequest(req, res);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.lastError = message;
                    console.warn('[RenderDoc For VSCode MCP] Request handling failed:', message);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: message }));
                    }
                }
            });

            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => {
                    httpServer.off('error', onError);
                    reject(error);
                };

                httpServer.once('error', onError);
                httpServer.listen(configuration.port, MCP_HOST, () => {
                    httpServer.off('error', onError);
                    resolve();
                });
            });

            httpServer.unref();
            httpServer.on('error', (error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.lastError = message;
                console.warn('[RenderDoc For VSCode MCP] Server error:', message);
            });

            const address = httpServer.address();
            this.actualPort = typeof address === 'object' && address ? address.port : configuration.port;
            this.url = `http://${MCP_HOST}:${this.actualPort}${MCP_PATH}`;
            this.lastError = undefined;
            this.server = server;
            this.transport = transport;
            this.httpServer = httpServer;

            console.log('[RenderDoc For VSCode MCP] Listening on', this.url);
        } catch (error: any) {
            this.lastError = error?.message ?? String(error);
            await this.stop();
        }

        return this.getStatus();
    }

    async restart(): Promise<RenderDocMcpStatus> {
        await this.stop();
        return this.startIfEnabled();
    }

    async stop(): Promise<void> {
        const httpServer = this.httpServer;
        const transport = this.transport;
        const server = this.server;

        this.httpServer = undefined;
        this.transport = undefined;
        this.server = undefined;
        this.url = undefined;
        this.actualPort = undefined;

        const pending: Array<Promise<unknown>> = [];

        if (httpServer?.listening) {
            pending.push(new Promise<void>((resolve, reject) => {
                httpServer.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            }));
        }

        if (transport) {
            pending.push(transport.close());
        }
        if (server) {
            pending.push(server.close());
        }

        await Promise.allSettled(pending);
    }

    getStatus(): RenderDocMcpStatus {
        const configuration = getRenderDocMcpConfiguration();
        return {
            enabled: configuration.enabled,
            running: !!this.httpServer?.listening && !!this.url,
            host: MCP_HOST,
            port: this.actualPort ?? configuration.port,
            path: MCP_PATH,
            url: this.url,
            toolNames: RENDERDOC_TOOL_REGISTRY.map((binding) => binding.name),
            lastError: this.lastError,
        };
    }

    async showConnectionInfo(): Promise<void> {
        const status = await this.startIfEnabled();
        const capturePath = this.getCurrentCapturePath();

        this.outputChannel.clear();
        this.outputChannel.appendLine('RenderDoc For VSCode MCP');
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`Enabled: ${status.enabled ? 'yes' : 'no'}`);
        this.outputChannel.appendLine(`Running: ${status.running ? 'yes' : 'no'}`);
        this.outputChannel.appendLine(`Endpoint: ${status.url ?? '<not running>'}`);
        this.outputChannel.appendLine(`Current capture: ${capturePath ?? '<none>'}`);
        if (status.lastError) {
            this.outputChannel.appendLine(`Last error: ${status.lastError}`);
        }
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('Notes:');
        this.outputChannel.appendLine('- This MCP server is bound to the active VS Code window state.');
        this.outputChannel.appendLine('- Open a capture in this extension first, or call renderdoc_openCapture from your MCP client.');
        this.outputChannel.appendLine('- Selection-aware questions should call renderdoc_getSelectionContext first.');
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('Exposed tools:');
        for (const toolName of status.toolNames) {
            this.outputChannel.appendLine(`- ${toolName}`);
        }

        if (status.url) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('VS Code mcp.json snippet:');
            this.outputChannel.appendLine(buildVsCodeConfigSnippet(status.url));
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('Generic MCP client config snippet:');
            this.outputChannel.appendLine(buildGenericConfigSnippet(status.url));
        }

        this.outputChannel.show(true);

        if (!status.running || !status.url) {
            void vscode.window.showWarningMessage(
                status.enabled
                    ? `RenderDoc For VSCode MCP is unavailable${status.lastError ? `: ${status.lastError}` : '.'}`
                    : 'RenderDoc For VSCode MCP is disabled in settings.',
            );
            return;
        }

        const copyEndpointAction = 'Copy Endpoint';
        const copyVsCodeConfigAction = 'Copy VS Code Config';
        const copyGenericConfigAction = 'Copy Generic Config';
        const configureClientsAction = 'Configure Workspace Clients';
        const choice = await vscode.window.showInformationMessage(
            `RenderDoc For VSCode MCP is listening on ${status.url}`,
            copyEndpointAction,
            copyVsCodeConfigAction,
            copyGenericConfigAction,
            configureClientsAction,
        );

        if (choice === copyEndpointAction) {
            await vscode.env.clipboard.writeText(status.url);
        }
        if (choice === copyVsCodeConfigAction) {
            await vscode.env.clipboard.writeText(buildVsCodeConfigSnippet(status.url));
        }
        if (choice === copyGenericConfigAction) {
            await vscode.env.clipboard.writeText(buildGenericConfigSnippet(status.url));
        }
        if (choice === configureClientsAction) {
            await vscode.commands.executeCommand('renderdoc.configureMcpClients');
        }
    }

    dispose(): void {
        this.outputChannel.dispose();
        void this.stop();
    }
}