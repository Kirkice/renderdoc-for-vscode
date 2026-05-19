# RenderDoc Workflow Playbook

This file intentionally focuses on question-to-workflow routing. See [ownership guide](./ownership.md) for which rules belong in the skill, the `@renderdoc` participant prompt, or the tool layer.

## Selection-First Questions

Use this path when the user says "this", "current", or "selected".

1. Call `renderdoc_getSelectionContext`.
2. Use the current focused event or selected resource to determine the next tool.
3. If the user is asking about the selected draw's cost, timing, or performance, use the focused event from selection context and then call `renderdoc_getActionTimings` or `renderdoc_getEventDetails` as appropriate.
4. If the user needs deeper event detail, call `renderdoc_getEventDetails`.
5. If the user needs resource detail, call `renderdoc_getResourceDetail` or `renderdoc_getTextureInfo` as appropriate.

## Frame Overview And Performance

Use this path for bottlenecks, pass layout, render flow, or frame-wide questions.

1. Call `renderdoc_getCaptureInfo` early if API context matters.
2. Call `renderdoc_getFrameSummary` first.
3. If the question needs direct GPU timing data and timings may not already be cached, call `renderdoc_getActionTimings`.
4. Identify the hottest passes or leaf draws first, then inspect the top few hot EIDs instead of stopping at a ranking list.
5. For hot EIDs, call `renderdoc_getEventDetails`, and if needed `renderdoc_getShaderInfo` or `renderdoc_getPipelineState`, to explain why the event is expensive.
6. If the user wants the engine- or project-side owner of the bottleneck, call `renderdoc_findProjectImplementation` with the hot EID or derived shader/pass names.
7. Use `renderdoc_getDrawCalls` with a narrower scope than the full frame whenever possible when the hierarchy itself still needs clarification.
8. Use `renderdoc_analyzeFrame` when the user wants a broad issue scan.

For performance answers, prefer this shape:

1. Frame-level takeaway.
2. Top expensive passes or leaf draws with full hierarchy path and timings.
3. Deeper evidence for the hottest EIDs: shader stage, bindings, state, or constant-buffer clues when relevant.
4. Likely implications and the next best debugging target.

## Event, Pipeline, And Shader Analysis

Use this path when the user wants to inspect a specific EID.

1. Resolve the target event.
2. Call `renderdoc_getEventDetails` for the base event information.
3. Prefer `renderdoc_getShaderInfo` when the question is about a shader stage together with its bindings or constant buffers.
4. Call `renderdoc_getPipelineState` when the question is about state, bindings, or render targets outside the shader-focused aggregate path.
5. If the user wants the likely engine/project-side implementation, call `renderdoc_findProjectImplementation` with the event or derived shader/pass names.
6. Call `renderdoc_getShaderSource` only if shader code or stage-specific analysis is requested and the aggregate shader tool is not a better fit.
7. Call `renderdoc_getMeshData` only for geometry, attribute layout, topology, or vertex-data questions.

## Texture And Resource Tracing

Use this path when the user is tracking texture usage or resource ownership.

1. Resolve the resource with `renderdoc_getResourceDetail` or `renderdoc_getTextureInfo`.
2. For reverse tracing, use:
   - `renderdoc_findDrawsByTexture`
   - `renderdoc_findDrawsByShader`
   - `renderdoc_findDrawsByResourceId`
3. If the user needs pixel inspection, call `renderdoc_getTextureData`.
4. Keep texture data requests narrow: prefer a specific `eventId`, `mip`, and channel if known.

## Buffer Inspection

Use this path when the user asks for vertex/index/constant/storage buffer contents.

1. Identify the exact buffer resource ID first.
2. Call `renderdoc_getBufferContents` with a small `len` by default.
3. Use `offset` and repeated calls to paginate larger buffers.
4. If the buffer is tied to a specific event, include `eventId`.
5. Summarize decoded meaning when possible.

## Answer Shape

- Prefer short findings first, then supporting evidence.
- For comparisons, use a table when it improves readability.
- Summarize likely impact: correctness, performance, or debugging relevance.