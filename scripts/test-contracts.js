const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const registry = fs.readFileSync(path.join(root, 'src', 'copilot', 'toolRegistry.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'mcp', 'server.ts'), 'utf8');
const state = fs.readFileSync(path.join(root, 'src', 'launchTargetState.ts'), 'utf8');
const tools = fs.readFileSync(path.join(root, 'src', 'copilot', 'tools.ts'), 'utf8');

assert.match(server, /inputSchema\?\.safeParse\(input\)/, 'MCP must validate input before invocation');
assert.match(server, /INVALID_TOOL_INPUT/, 'MCP must expose a stable invalid-input error code');
assert.match(server, /binding\.inputSchema/, 'MCP must reuse the shared registry schema');
assert.match(state, /isValidSessionTransition\(this\.session\.phase, nextPhase\)/, 'Session updates must enforce transitions');
assert.match(state, /sessionTransitions/, 'Session transition rules must be kept in a testable module');
assert.match(
  fs.readFileSync(path.join(root, 'src', 'sessionTransitions.ts'), 'utf8'),
  /failed: \['checking', 'launching', 'running', 'capturing', 'idle'\]/,
  'Failed sessions must expose recovery transitions',
);
assert.match(tools, /format\s*===\s*['"]json['"]\s*\?/, 'Report tools must select JSON or Markdown output');
assert.match(tools, /# RenderDoc (Performance|Environment Diagnostics) Report/, 'Report tools must produce Markdown output');
assert.match(tools, /fs\.promises\.writeFile\(outputPath, content, 'utf8'\)/, 'Report tools must persist exported content');
assert.match(registry, /name: 'renderdoc_diagnoseEnvironment'[\s\S]{0,500}format: z\.enum\(\['json', 'markdown'\]\)/, 'Diagnostics registry must expose export format');
assert.match(registry, /name: 'renderdoc_generatePerformanceReport'[\s\S]{0,500}format: z\.enum\(\['json', 'markdown'\]\)/, 'Performance registry must expose export format');

console.log('Contract tests passed.');
