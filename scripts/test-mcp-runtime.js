const assert = require('assert');

async function run() {
  const [serverModule, nodeModule, zodModule] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/node'),
    import('zod/v4'),
  ]);

  const { McpServer } = serverModule;
  const { NodeStreamableHTTPServerTransport } = nodeModule;
  const z = zodModule;

  assert.equal(typeof McpServer, 'function', 'McpServer export is missing');
  assert.equal(
    typeof NodeStreamableHTTPServerTransport,
    'function',
    'NodeStreamableHTTPServerTransport export is missing',
  );

  const server = new McpServer({
    name: 'renderdoc-for-vscode-mcp-runtime-smoke',
    version: '0.0.0',
    title: 'RenderDoc For VSCode MCP Runtime Smoke',
  });

  server.registerTool(
    'renderdoc_runtime_smoke',
    {
      title: 'RenderDoc For VSCode MCP Runtime Smoke',
      description: 'Verifies RenderDoc For VSCode MCP runtime API compatibility for the VS Code extension.',
      inputSchema: z.object({
        ping: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }),
  );

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  assert.equal(typeof server.connect, 'function', 'McpServer.connect is missing');
  assert.equal(typeof server.close, 'function', 'McpServer.close is missing');
  assert.equal(typeof transport.handleRequest, 'function', 'Transport.handleRequest is missing');
  assert.equal(typeof transport.close, 'function', 'Transport.close is missing');

  await transport.close();
  await server.close();

  console.log('MCP runtime smoke check passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});