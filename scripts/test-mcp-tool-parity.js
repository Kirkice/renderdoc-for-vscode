const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
const toolRegistrySource = fs.readFileSync(path.join(workspaceRoot, 'src', 'copilot', 'toolRegistry.ts'), 'utf8');
const serverSource = fs.readFileSync(path.join(workspaceRoot, 'src', 'mcp', 'server.ts'), 'utf8');

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

// Extract tool names from the shared registry in toolRegistry.ts
const registryToolNames = new Set(
  Array.from(toolRegistrySource.matchAll(/name:\s*'(renderdoc_[^']+)'/g), (match) => match[1]),
);

// Verify the MCP server imports and uses the shared RENDERDOC_TOOL_REGISTRY
assert.ok(
  serverSource.includes('RENDERDOC_TOOL_REGISTRY'),
  'The MCP server should consume the shared RenderDoc tool registry.',
);

// Verify no stale contributes.languageModelTools remain in package.json
// (Copilot integration was removed; all tools are now MCP-only)
const contributedToolNames = new Set(
  (packageJson.contributes?.languageModelTools || [])
    .map((entry) => entry?.name)
    .filter((value) => typeof value === 'string' && value.startsWith('renderdoc_')),
);

assert.strictEqual(
  contributedToolNames.size,
  0,
  `package.json should not contain contributes.languageModelTools (Copilot removed, MCP-only). Found: ${[...contributedToolNames].join(', ')}`,
);

// Verify no stale onLanguageModelTool activation events remain
const activationToolNames = new Set(
  (packageJson.activationEvents || [])
    .filter((value) => typeof value === 'string' && value.startsWith('onLanguageModelTool:renderdoc_'))
    .map((value) => value.slice('onLanguageModelTool:'.length)),
);

assert.strictEqual(
  activationToolNames.size,
  0,
  `package.json should not contain onLanguageModelTool activation events (Copilot removed, MCP-only). Found: ${[...activationToolNames].join(', ')}`,
);

// Verify no duplicate tool names in the registry
const registryToolList = Array.from(toolRegistrySource.matchAll(/name:\s*'(renderdoc_[^']+)'/g), (match) => match[1]);
const duplicates = registryToolList.filter((name, index) => registryToolList.indexOf(name) !== index);
assert.deepStrictEqual(
  duplicates,
  [],
  `Duplicate tool names found in toolRegistry.ts: ${[...new Set(duplicates)].join(', ')}`,
);

console.log(`MCP tool parity check passed for ${registryToolNames.size} tools (MCP-only mode).`);
