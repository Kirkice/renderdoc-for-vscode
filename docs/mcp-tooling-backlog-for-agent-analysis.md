# RenderDoc MCP Agent Analysis Backlog

## Goal

Improve the RenderDoc MCP surface so external agents can perform graphics analysis and performance analysis with fewer tool calls, less fragile reasoning, and less custom JSON parsing.

The current MCP toolset already covers most low-level primitives:

- Capture resolution
- Draw/event listing
- GPU timings
- Resources and resource detail
- Pipeline state
- Shader info and source
- Texture and buffer reads
- Mesh reads
- Reverse search by shader, texture, and resource ID

The main gaps are higher-level analysis surfaces:

- Direct bound-resource summaries
- Resource producer/consumer tracing
- State diffs
- Replay/capability introspection
- Visual preview tools
- Structured pass/dependency summaries
- Single-call drilldowns for hot events

This document turns those gaps into a development checklist.

## Priority Order

Implement in this order unless blocked:

1. `renderdoc_getBoundResources`
2. `renderdoc_traceResourceUsage`
3. `renderdoc_diffPipelineState`
4. `renderdoc_getReplayStatus`
5. `renderdoc_getCurrentDrawPreview`
6. `renderdoc_getEventChunks`
7. `renderdoc_analyzeHotEvent`
8. `renderdoc_getPassGraph`

## Common Integration Pattern

For each new MCP tool, the usual changes will be in these files:

- [src/copilot/toolRegistry.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/toolRegistry.ts:1)
- [src/copilot/tools.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/tools.ts:1)
- [src/renderdocBridge.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/renderdocBridge.ts:1)

If native support is missing, also touch:

- [native/src/main.cpp](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/native/src/main.cpp:1)
- [src/ipc/schemas.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/ipc/schemas.ts:1)

If there is already an extension-side feature using the capability, prefer reusing its existing bridge call and shaping the output for MCP rather than inventing a new native protocol.

## P0. `renderdoc_getBoundResources`

### Why

Agents constantly need to answer:

- Which textures are sampled by this draw?
- Which render targets or depth targets are bound?
- Which buffers, samplers, and constant buffers matter here?

Right now they must inspect raw pipeline state or shader info and reconstruct this themselves. That is noisy and brittle.

### Proposed MCP Tool

`renderdoc_getBoundResources(eventId, includeUnused?, includeConstantBuffers?)`

### Expected Output Shape

Return a compact structure grouped by stage and by role:

- `eventId`
- `renderTargets`
- `depthTarget`
- `stages[]`
  - `stage`
  - `shaderName`
  - `readOnlyTextures[]`
  - `readWriteTextures[]`
  - `buffers[]`
  - `samplers[]`
  - `constantBuffers[]`
- `resourceCounts`

Each resource row should include:

- `resourceId`
- `name`
- `type`
- `slot`
- `format` when texture
- `width` and `height` when texture
- `byteSize` when known

### Implementation Plan

1. Start in [src/copilot/tools.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/tools.ts:1).
2. Reuse `nativeGetPipelineState(eventId)` and the logic already used by reverse-search indexing.
3. Normalize Vulkan, D3D11, D3D12, and GL pipeline layouts into one MCP-facing schema.
4. Join resource IDs back to metadata via resource list or resource detail when necessary.
5. Keep the response compact and sorted.

### Notes

- This can likely be implemented without new native bridge work.
- Prefer stage-normalized output over returning raw pipeline JSON.

### Acceptance

- Agent can answer "what is bound here?" with one MCP call.
- Agent does not need to inspect raw `renderdoc_getPipelineState` for common binding questions.

## P0. `renderdoc_traceResourceUsage`

### Why

Current reverse-search tools are search-oriented, not flow-oriented.
Agents need a direct producer/consumer story for a resource.

### Proposed MCP Tool

`renderdoc_traceResourceUsage(resourceId, eventId?, maxProducers?, maxConsumers?)`

### Expected Output Shape

- `resource`
- `producers[]`
- `consumers[]`
- `firstSeenEventId`
- `lastSeenEventId`
- `suspectedRole`
- `summary`

Each producer or consumer row should include:

- `eventId`
- `name`
- `markerPath`
- `usageType`
  - `renderTargetWrite`
  - `depthWrite`
  - `sampledRead`
  - `uavReadWrite`
  - `bufferBinding`

### Implementation Plan

1. Build on the existing reverse-search index logic in [src/copilot/tools.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/tools.ts:1).
2. Add a normalized bound-resource scan using pipeline state for leaf events.
3. Track whether the resource appears as:
   - RT output
   - depth output
   - sampled input
   - storage/UAV resource
   - generic resource binding
4. Aggregate matching events into a producer/consumer summary.
5. Infer a coarse `suspectedRole` only when evidence is strong.

### Notes

- This can start as a TypeScript-only implementation using existing bridge calls.
- Avoid claiming true write provenance if only binding evidence is available.

### Acceptance

- Agent can answer "where is this texture written and used?" in one call.
- Result groups usage semantically instead of dumping raw event IDs.

## P0. `renderdoc_diffPipelineState`

### Why

State comparison is a common debugging task:

- What changed between these draws?
- Why does draw B render differently from draw A?

Agents are bad at diffing two huge pipeline JSON payloads manually.

### Proposed MCP Tool

`renderdoc_diffPipelineState(eventIdA, eventIdB, includeUnchanged?)`

### Expected Output Shape

- `eventIdA`
- `eventIdB`
- `changed`
- `summary[]`
- `diff`
  - `shaders`
  - `renderTargets`
  - `depthStencil`
  - `blend`
  - `rasterizer`
  - `vertexInput`
  - `descriptors`
  - `samplers`
  - `constantBuffers`

### Implementation Plan

1. Fetch pipeline state for both events.
2. Normalize platform-specific structures into a comparison model.
3. Diff only the fields agents care about first.
4. Return both a short summary and a structured diff.

### Notes

- Start shallow. Do not attempt a perfect full-JSON diff at first.
- Prioritize bindings and active stage differences over obscure flags.

### Acceptance

- Agent can answer "what changed?" with one MCP call and a compact result.

## P0. `renderdoc_getReplayStatus`

### Why

Agents currently infer replay availability from failures. That causes wasted calls and messy error handling.

### Proposed MCP Tool

`renderdoc_getReplayStatus()`

### Expected Output Shape

- `captureLoaded`
- `capturePath`
- `replayActive`
- `replayMode`
  - `none`
  - `local`
  - `remote`
- `nativeBridgeRunning`
- `capabilities`
  - `pipelineState`
  - `shaderSource`
  - `shaderInfo`
  - `meshData`
  - `textureData`
  - `bufferContents`
  - `eventChunks`
  - `currentDrawPreview`
- `message`

### Implementation Plan

1. Pull current capture path from the extension-side shared state used by existing tools.
2. Expose replay status from the same state that feeds the UI and Inspector.
3. Report capability booleans using `hasNativeBridge()` and feature probes where appropriate.

### Notes

- This is a high-leverage, low-cost tool.
- It should become the standard guard before replay-heavy workflows.

### Acceptance

- Agent can decide what tools are safe to call before attempting shader or texture inspection.

## P1. `renderdoc_getCurrentDrawPreview`

### Why

Text-only analysis is not enough for many graphics debugging tasks. There is already extension-side support for current draw preview in the Inspector.

### Existing Capability

The bridge already exposes:

- `nativeGetCurrentDrawPreview(...)` in [src/renderdocBridge.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/renderdocBridge.ts:1390)

### Proposed MCP Tool

`renderdoc_getCurrentDrawPreview(eventId, overlayMode?, channelExtract?, resourceId?, overlayResourceId?)`

### Expected Output Shape

- `eventId`
- `resourceId`
- `label`
- `width`
- `height`
- `format`
- `overlayMode`
- `base64`

### Implementation Plan

1. Reuse the existing bridge call directly.
2. Add MCP input schema and a tool wrapper.
3. Keep the output aligned with `renderdoc_getTextureData` so clients can render it consistently.

### Notes

- No new native work should be required if the current bridge implementation is already stable.

### Acceptance

- Agent can visually inspect the current draw result without opening the VS Code UI manually.

## P1. `renderdoc_getEventChunks`

### Why

Agents need to inspect API-level call structure around an event:

- Which API calls are attached to this event?
- Which binds or barriers happened immediately around this draw?

### Existing Capability

The bridge already exposes:

- `nativeGetEventChunks(eventId)` in [src/renderdocBridge.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/renderdocBridge.ts:1579)

The sidebar provider already uses it:

- [src/views/apiInspectorProvider.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/views/apiInspectorProvider.ts:1)

### Proposed MCP Tool

`renderdoc_getEventChunks(eventId)`

### Expected Output Shape

- `eventId`
- `chunkCount`
- `chunks[]`
  - `eventId`
  - `name`
  - `params`

### Implementation Plan

1. Add a thin MCP wrapper around `nativeGetEventChunks`.
2. Do not over-process the payload in the first version.
3. Consider future additions like `filterByName` only after the first version lands.

### Acceptance

- Agent can answer API-level event sequencing questions without using the sidebar UI.

## P1. `renderdoc_analyzeHotEvent`

### Why

Agents currently need many calls to explain one expensive event. This tool should act as a one-call drilldown summary for a hot EID.

### Proposed MCP Tool

`renderdoc_analyzeHotEvent(eventId, includePreview?, includeMesh?, includeShaderBindings?)`

### Expected Output Shape

- `event`
- `timing`
- `geometry`
- `shaders`
- `targets`
- `sampledTextures`
- `resourceCounts`
- `suspiciousSignals[]`
- `followUpSuggestions[]`

### Implementation Plan

1. Compose existing tools internally:
   - event details
   - timings
   - pipeline state
   - shader info
   - mesh data
2. Normalize everything into a compact event-centric report.
3. Add heuristics for common suspicious signals:
   - fullscreen draw
   - many sampled textures
   - unusually large RTs
   - very high index count
   - heavy constant-buffer footprint

### Notes

- This should be implemented as a TypeScript composition tool first.
- Avoid pretending heuristics are facts. Label them as signals or hints.

### Acceptance

- Agent can produce a credible hot-event analysis from one tool call.

## P1. `renderdoc_getPassGraph`

### Why

`renderdoc_getFrameSummary` gives a lightweight overview, but not enough structure for agents to reason about pass dependencies and resource flow.

### Proposed MCP Tool

`renderdoc_getPassGraph(includeResources?, includeTimings?)`

### Expected Output Shape

- `passes[]`
  - `id`
  - `name`
  - `eventRange`
  - `drawCount`
  - `dispatchCount`
  - `durationUs` when available
  - `reads[]`
  - `writes[]`
- `edges[]`
  - `fromPassId`
  - `toPassId`
  - `resourceId`
  - `resourceName`
  - `usage`

### Implementation Plan

1. Start from top-level actions and marker groups.
2. Derive a pass model from marker hierarchy and event ranges.
3. Sample resource reads and writes from leaf-event pipeline bindings.
4. Build coarse edges between passes when a resource is written in one and read in another.

### Notes

- This is the most expensive item in this backlog.
- Implement only after the simpler high-value items are stable.

### Acceptance

- Agent can explain frame structure as a dependency graph instead of a flat event list.

## Stretch Items

These are useful but should wait until the main backlog lands:

### `renderdoc_getRenderTargets`

Single-purpose tool for "what is this event rendering to?".
This may end up being redundant if `renderdoc_getBoundResources` is good enough.

### `renderdoc_detectLargeRenderTargets`

Frame-level heuristic audit for large RTs, MSAA-heavy targets, and likely bandwidth hotspots.

### `renderdoc_detectExpensiveFullscreenPasses`

Heuristic scan for fullscreen or near-fullscreen events with suspicious timing or texture footprint.

### `renderdoc_traceTextureLifetimes`

More advanced version of resource tracing specialized for texture history across passes.

## Recommended Implementation Sequence

### Phase 1: High ROI, low native risk

Implement first:

- `renderdoc_getReplayStatus`
- `renderdoc_getBoundResources`
- `renderdoc_getEventChunks`
- `renderdoc_getCurrentDrawPreview`

Rationale:

- Fastest user-visible win
- Mostly TypeScript-side work
- Minimal protocol churn

### Phase 2: Better reasoning tools

Implement next:

- `renderdoc_traceResourceUsage`
- `renderdoc_diffPipelineState`
- `renderdoc_analyzeHotEvent`

Rationale:

- Makes agents far more capable
- Still mostly composition and normalization work

### Phase 3: Frame graph intelligence

Implement last:

- `renderdoc_getPassGraph`

Rationale:

- Most complex
- Highest design risk
- Benefits from stable lower-level normalized summaries first

## Guidance For The Implementing Agent

### Output design rules

- Prefer normalized summaries over raw RenderDoc payloads.
- Keep the first version compact and useful, not exhaustive.
- Include IDs and names together whenever possible.
- Distinguish facts from heuristics.

### Compatibility rules

- If a feature depends on native replay, return a structured unavailable result instead of throwing generic errors where possible.
- Reuse existing bridge calls before adding native protocol.
- Keep tool names consistent with the current `renderdoc_*` naming scheme.

### Validation checklist

For each new tool:

1. Add registry entry in [src/copilot/toolRegistry.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/toolRegistry.ts:1)
2. Implement tool class in [src/copilot/tools.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/tools.ts:1)
3. Reuse or add bridge method in [src/renderdocBridge.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/renderdocBridge.ts:1)
4. Update MCP runtime tests if needed
5. Verify the tool returns stable JSON on:
   - no capture loaded
   - capture loaded but no native replay
   - full replay active

## Nice Follow-Up After Implementation

After the first wave lands, add or update skills to explicitly route agents through the new higher-level tools:

- `renderdoc-performance-investigation`
- `renderdoc-current-selection-explainer`
- `renderdoc-texture-trace`
- `renderdoc-frame-overview`

Those skills will become much more effective once the MCP surface is less raw.

## Detailed Build Specs

This section is intentionally more implementation-oriented so another coding agent can take one item and execute with minimal extra discovery.

## 1. Detailed Spec: `renderdoc_getBoundResources`

### Developer Task

Implement a new MCP tool named `renderdoc_getBoundResources` that returns a normalized summary of resources bound at a given event.

### Subtasks

1. Add a new tool definition in [src/copilot/toolRegistry.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/toolRegistry.ts:1).
2. Add a new tool class in [src/copilot/tools.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/tools.ts:1).
3. Reuse `nativeGetPipelineState(eventId)` from [src/renderdocBridge.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/renderdocBridge.ts:1325).
4. Add helper functions in `tools.ts` to normalize stage bindings across Vulkan, D3D11, D3D12, and OpenGL.
5. Optionally enrich resource rows with metadata by using the already loaded resource list from the current capture.
6. Return stable JSON even when replay is unavailable.

### Suggested Input Schema

```ts
z.object({
  eventId: z.number().int(),
  includeUnused: z.boolean().optional(),
  includeConstantBuffers: z.boolean().optional(),
})
```

### Suggested Output Shape

```json
{
  "eventId": 495,
  "renderTargets": [
    {
      "slot": 0,
      "resourceId": "12345",
      "name": "MainColor",
      "format": "R16G16B16A16_FLOAT",
      "width": 1920,
      "height": 1080
    }
  ],
  "depthTarget": {
    "resourceId": "67890",
    "name": "MainDepth",
    "format": "D32_FLOAT",
    "width": 1920,
    "height": 1080
  },
  "stages": [
    {
      "stage": "Fragment",
      "shaderName": "LightingPS",
      "readOnlyTextures": [],
      "readWriteTextures": [],
      "buffers": [],
      "samplers": [],
      "constantBuffers": []
    }
  ],
  "resourceCounts": {
    "renderTargets": 1,
    "sampledTextures": 6,
    "storageTextures": 0,
    "buffers": 4,
    "samplers": 3,
    "constantBuffers": 2
  }
}
```

### Key Normalization Rules

- Map stage labels to a common set:
  - `Vertex`
  - `Hull`
  - `Domain`
  - `Geometry`
  - `Fragment`
  - `Compute`
- Distinguish:
  - render targets
  - depth target
  - sampled resources
  - storage/UAV resources
  - buffers
  - samplers
  - constant buffers
- Include slot/index where available.
- Omit giant raw subtrees from native pipeline state.

### Failure Behavior

If replay is unavailable, return:

```json
{
  "available": false,
  "reason": "Bound resource inspection requires an active local replay via the RenderDoc native bridge."
}
```

### Test Cases

1. No capture loaded.
2. Capture loaded, replay unavailable.
3. Graphics draw with fragment textures and RTs.
4. Compute dispatch with UAV/storage bindings.
5. Event with sparse bindings.

### Suggested Prompt For Another Agent

```text
Implement renderdoc_getBoundResources in the RenderDoc VS Code extension MCP layer.
Reuse existing pipeline-state bridge calls, normalize bound resources into a compact cross-API JSON schema, and do not expose raw pipeline JSON unless absolutely necessary.
Modify toolRegistry.ts and tools.ts, reuse renderdocBridge.ts as-is if possible, and keep replay-unavailable behavior structured instead of throwing vague text errors.
```

## 2. Detailed Spec: `renderdoc_traceResourceUsage`

### Developer Task

Implement a new MCP tool named `renderdoc_traceResourceUsage` that tells an agent how a resource is used across the frame, with emphasis on producers and consumers.

### Subtasks

1. Add a registry entry in `toolRegistry.ts`.
2. Add a tool class in `tools.ts`.
3. Reuse and refactor the existing reverse-index logic in `tools.ts` so it can classify resource usage by role instead of only returning event ID matches.
4. Add helper logic that inspects per-event pipeline state and classifies the resource as:
   - render-target output
   - depth output
   - sampled input
   - storage/UAV
   - generic buffer/resource binding
5. Build a compact result with producers, consumers, and a summary.

### Suggested Input Schema

```ts
z.object({
  resourceId: z.string(),
  eventId: z.number().int().optional(),
  maxProducers: z.number().int().optional(),
  maxConsumers: z.number().int().optional(),
})
```

### Suggested Output Shape

```json
{
  "resource": {
    "resourceId": "12345",
    "name": "ShadowMapAtlas",
    "type": "Texture"
  },
  "suspectedRole": "shadow_map",
  "firstSeenEventId": 180,
  "lastSeenEventId": 650,
  "producers": [
    {
      "eventId": 188,
      "name": "ShadowPass.Draw",
      "markerPath": "Frame/Shadow Pass",
      "usageType": "renderTargetWrite"
    }
  ],
  "consumers": [
    {
      "eventId": 402,
      "name": "Lighting.Draw",
      "markerPath": "Frame/Lighting Pass",
      "usageType": "sampledRead"
    }
  ],
  "summary": "Written during the shadow pass, then sampled by later lighting events."
}
```

### Implementation Notes

- Use event-order traversal over leaf events.
- For the first version, it is acceptable to classify usage from pipeline binding evidence only.
- If true write provenance cannot be guaranteed, avoid overclaiming and use wording like:
  - `likelyProducerEvents`
  - `likelyConsumerEvents`

### Helpful Refactor

The existing reverse index near the reverse-search tools in [src/copilot/tools.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/tools.ts:2100) should be split into:

- a reusable scan pass over leaf events
- reusable binding extraction
- simple query-specific adapters

That will make `findDrawsByShader`, `findDrawsByTexture`, and `findDrawsByResourceId` easier to maintain too.

### Test Cases

1. Texture written as RT then sampled later.
2. Depth texture later sampled in lighting.
3. Buffer only bound as read-only resource.
4. Resource ID exists but has no obvious usage in replay-visible state.

### Suggested Prompt For Another Agent

```text
Implement renderdoc_traceResourceUsage as a higher-level resource-flow MCP tool.
Refactor the existing reverse-search indexing in tools.ts so the new tool can classify per-event resource usage as outputs or inputs, then aggregate producer/consumer summaries.
Prefer a compact structured answer over a raw list of every matching event.
```

## 3. Detailed Spec: `renderdoc_diffPipelineState`

### Developer Task

Implement a new MCP tool named `renderdoc_diffPipelineState` that compares pipeline state between two events and reports only the most useful differences.

### Subtasks

1. Add a registry entry in `toolRegistry.ts`.
2. Add a tool class in `tools.ts`.
3. Reuse `nativeGetPipelineState` for both event IDs.
4. Add a normalization layer that extracts comparison-friendly slices:
   - active shaders
   - RT/depth attachments
   - blend state
   - depth/stencil state
   - raster state
   - vertex layout
   - key descriptor/resource bindings
5. Add a diff layer that returns a compact summary plus structured sections.

### Suggested Input Schema

```ts
z.object({
  eventIdA: z.number().int(),
  eventIdB: z.number().int(),
  includeUnchanged: z.boolean().optional(),
})
```

### Suggested Output Shape

```json
{
  "eventIdA": 300,
  "eventIdB": 355,
  "changed": true,
  "summary": [
    "Fragment shader changed from LightingPS to LightingAlphaPS.",
    "Depth write disabled at EID 355.",
    "Texture slot t3 changed from ShadowMapAtlas to ContactShadowMask."
  ],
  "diff": {
    "shaders": {},
    "renderTargets": {},
    "depthStencil": {},
    "blend": {},
    "rasterizer": {},
    "vertexInput": {},
    "descriptors": {}
  }
}
```

### Implementation Notes

- The first version should ignore obscure fields.
- Focus on agent-meaningful differences.
- If some sections cannot be normalized across every API, omit them rather than returning inconsistent junk.

### Failure Behavior

If either event cannot be inspected, return a structured partial result or a clear unavailability payload.

### Test Cases

1. Two similar draws with a texture-binding difference.
2. Two draws with different shaders.
3. Two draws in different passes with RT/depth differences.
4. Replay unavailable.

### Suggested Prompt For Another Agent

```text
Implement renderdoc_diffPipelineState as a compact, agent-friendly comparison tool.
Do not dump two full raw pipeline JSON payloads.
Instead normalize the most important state sections and produce a concise summary plus structured diff fields.
```

## 4. Detailed Spec: `renderdoc_getReplayStatus`

### Developer Task

Implement a new MCP tool named `renderdoc_getReplayStatus` so agents can cheaply discover whether replay-dependent analysis is possible.

### Subtasks

1. Add a registry entry in `toolRegistry.ts`.
2. Add a tool class in `tools.ts`.
3. Expose enough extension-side state through the existing shared closures used by `initTools(...)`.
4. Report:
   - whether a capture is loaded
   - whether the native bridge is running
   - whether replay is active
   - replay mode
   - which major MCP capabilities are usable

### Suggested Input Schema

```ts
z.object({})
```

### Suggested Output Shape

```json
{
  "captureLoaded": true,
  "capturePath": "C:/captures/frame_001.rdc",
  "nativeBridgeRunning": true,
  "replayActive": true,
  "replayMode": "local",
  "capabilities": {
    "pipelineState": true,
    "shaderSource": true,
    "shaderInfo": true,
    "meshData": true,
    "textureData": true,
    "bufferContents": true,
    "eventChunks": true,
    "currentDrawPreview": true
  },
  "message": "Local replay is active."
}
```

### Implementation Notes

- Some capability booleans may initially be inferred from `hasNativeBridge()`.
- If you want to be more accurate, reuse bridge feature probing similar to `ensureNativeFeature(...)` in [src/renderdocBridge.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/renderdocBridge.ts:1415).
- Do not require agents to intentionally trigger errors just to know replay state.

### Likely Required Small Refactor

`initTools(...)` in [src/copilot/tools.ts](/C:/Users/admin/.vscode/extensions/renderdoc-community.renderdoc-for-vscode-0.0.1/src/copilot/tools.ts:18) currently receives:

- capture path getter
- selection context getter
- current draw calls getter
- openCapture handler

It will probably need one more getter for replay state or capability state.

### Test Cases

1. No capture loaded.
2. Capture loaded but no native bridge.
3. Native bridge running, replay unavailable.
4. Replay active.

### Suggested Prompt For Another Agent

```text
Implement renderdoc_getReplayStatus as a lightweight MCP introspection tool.
It should tell an external agent whether capture and replay state are available and which replay-only analysis tools are safe to call, without forcing the agent to infer status from failures.
Prefer a small shared-state refactor in tools.ts over duplicating UI logic.
```

## Suggested Execution Plan For A Coding Agent

If another agent is going to implement the top four items, ask it to proceed in this order:

1. Implement `renderdoc_getReplayStatus`
2. Implement `renderdoc_getBoundResources`
3. Refactor reverse-search internals
4. Implement `renderdoc_traceResourceUsage`
5. Implement `renderdoc_diffPipelineState`

Reason:

- `getReplayStatus` makes subsequent tools easier to guard and test.
- `getBoundResources` creates normalization helpers that `traceResourceUsage` and `diffPipelineState` can reuse.
- Reverse-index refactor should happen before the usage-tracing tool, not after.

## Suggested Review Checklist

When reviewing another agent's implementation, verify:

1. New MCP tools are registered in `toolRegistry.ts`.
2. New tool classes are discoverable and return JSON, not loose prose.
3. Replay-unavailable behavior is structured and consistent.
4. Tool outputs are compact and normalized.
5. No new tool returns giant raw pipeline-state blobs by default.
6. Existing reverse-search tools still work after any refactor.
7. No tool invents unsupported producer/write claims without evidence.
