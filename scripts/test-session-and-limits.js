const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const transitions = fs.readFileSync(path.join(root, 'src', 'sessionTransitions.ts'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'src', 'copilot', 'toolRegistry.ts'), 'utf8');
const tools = fs.readFileSync(path.join(root, 'src', 'copilot', 'tools.ts'), 'utf8');

const phases = ['idle', 'checking', 'ready', 'launching', 'running', 'capturing', 'completed', 'failed'];
const allowed = {
  idle: ['checking', 'launching', 'running'],
  checking: ['ready', 'launching', 'failed', 'idle'],
  ready: ['launching', 'running', 'capturing', 'failed', 'idle'],
  launching: ['running', 'ready', 'failed', 'idle'],
  running: ['capturing', 'completed', 'failed', 'idle'],
  capturing: ['completed', 'running', 'failed', 'idle'],
  completed: ['capturing', 'running', 'launching', 'failed', 'idle'],
  failed: ['checking', 'launching', 'running', 'capturing', 'idle'],
};
const isValid = (from, to) => from === to || allowed[from].includes(to);
assert.deepStrictEqual(phases.filter((phase) => isValid(phase, phase)), phases);
assert.strictEqual(isValid('idle', 'completed'), false);
assert.strictEqual(isValid('capturing', 'launching'), false);
assert.strictEqual(isValid('failed', 'checking'), true);

assert.match(transitions, /from === to \|\| allowedTransitions\[from\]\.includes\(to\)/);
assert.match(transitions, /idle: \['checking', 'launching', 'running'\]/);
assert.match(transitions, /failed: \['checking', 'launching', 'running', 'capturing', 'idle'\]/);

assert.match(registry, /limit: z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(2000\)/);
assert.match(registry, /offset: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
assert.match(registry, /maxVertices: z\.number\(\)\.int\(\)\.positive\(\)\.max\(4096\)/);
assert.match(registry, /len: z\.number\(\)\.int\(\)\.positive\(\)\.max\(65536\)/);
assert.match(registry, /maxEvents: z\.number\(\)\.int\(\)\.positive\(\)\.max\(500\)/);

assert.match(tools, /Math\.min\(2000, Math\.max\(1, options\.input\?\.limit \?\? 200\)\)/);
assert.match(tools, /Math\.min\(RESOURCES_DEFAULT_LIMIT, Math\.max\(1, options\.input\?\.limit \?\? RESOURCES_DEFAULT_LIMIT\)\)/);
assert.match(tools, /Math\.min\(4096, Math\.max\(1, requestedMaxVertices\)/);
assert.match(tools, /result\.base64\.length <= 1024 \* 1024/);
assert.match(tools, /dataTruncated: !!result\.base64/);
assert.match(tools, /Math\.min\(65536, Math\.max\(1, requestedLen\)/);
assert.match(tools, /evidenceWorkflow: \{/);
assert.match(tools, /timing: 'Call renderdoc_getActionTimings/);
assert.match(tools, /mali: 'Mali\/offline compiler analysis/);

console.log('Session transition and large-data limit tests passed.');
