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

function diff(left, right) {
  return sorted([...left].filter((value) => !right.has(value)));
}

const activationToolNames = new Set(
  (packageJson.activationEvents || [])
    .filter((value) => typeof value === 'string' && value.startsWith('onLanguageModelTool:renderdoc_'))
    .map((value) => value.slice('onLanguageModelTool:'.length)),
);

const contributedToolNames = new Set(
  (packageJson.contributes?.languageModelTools || [])
    .map((entry) => entry?.name)
    .filter((value) => typeof value === 'string' && value.startsWith('renderdoc_')),
);

const registryToolNames = new Set(
  Array.from(toolRegistrySource.matchAll(/name:\s*'(renderdoc_[^']+)'/g), (match) => match[1]),
);

const activationMissingFromContributes = diff(activationToolNames, contributedToolNames);
const contributesMissingFromActivation = diff(contributedToolNames, activationToolNames);
const contributesMissingFromRegistry = diff(contributedToolNames, registryToolNames);
const registryMissingFromContributes = diff(registryToolNames, contributedToolNames);

assert.deepStrictEqual(
  activationMissingFromContributes,
  [],
  `Activation events reference tools missing from contributes.languageModelTools: ${activationMissingFromContributes.join(', ')}`,
);
assert.deepStrictEqual(
  contributesMissingFromActivation,
  [],
  `contributes.languageModelTools contains tools missing from activationEvents: ${contributesMissingFromActivation.join(', ')}`,
);
assert.deepStrictEqual(
  contributesMissingFromRegistry,
  [],
  `Shared tool registry is missing tools from contributes.languageModelTools: ${contributesMissingFromRegistry.join(', ')}`,
);
assert.deepStrictEqual(
  registryMissingFromContributes,
  [],
  `Shared tool registry contains tools missing from contributes.languageModelTools: ${registryMissingFromContributes.join(', ')}`,
);

assert.ok(
  serverSource.includes('RENDERDOC_TOOL_REGISTRY'),
  'The MCP server should consume the shared RenderDoc tool registry.',
);

console.log(`MCP tool parity check passed for ${contributedToolNames.size} tools.`);