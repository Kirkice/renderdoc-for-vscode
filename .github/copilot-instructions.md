# Copilot Instructions

This extension contributes local `renderdoc_*` language model tools for RenderDoc capture analysis when they are available in the current chat session.

When the user asks about a loaded RenderDoc capture, the current selection, a draw call, an EID, GPU timings, shader bindings, buffers, textures, or Unity-side mapping for a RenderDoc event:

- Treat the extension's local `renderdoc_*` tools, when available in the current session, as the primary and authoritative source for RenderDoc capture facts.
- For capture-analysis requests when no capture is loaded yet, call `renderdoc_openCapture` first so the extension can resolve the already-open `.rdc` tab or an explicit file path locally.
- Do not call an external RenderDoc MCP tool when an equivalent local `renderdoc_*` tool can answer the question.
- Do not use external RenderDoc MCP preflight or status tools such as generic capture-status checks before trying the local RenderDoc tool path.
- If the local `renderdoc_*` tools are unavailable in the current session, say that explicitly before falling back to other approaches.
- Do not search the workspace or run terminal commands to locate `.rdc` files before trying `renderdoc_openCapture`.
- Only fall back to an external RenderDoc MCP tool if all of the following are true: the user explicitly wants that MCP path, or the local `renderdoc_*` tools are unavailable or clearly insufficient for the exact question, and you state that reason explicitly.
- Do not replace missing local capture context with broad repository guessing, generic workspace search, or profiler-source questionnaires.
- For questions about "this", "current", "selected", or the currently selected draw, call `renderdoc_getSelectionContext` first.
- For frame structure or performance questions, start with `renderdoc_getFrameSummary` and then use `renderdoc_getActionTimings` when timing data is needed.
- For performance analysis, first locate the hottest pass or leaf draw, then drill into the hottest EIDs instead of stopping at a flat timing list.
- For each hot draw, inspect geometry pressure next using `numIndices`, `numInstances`, `topology`, `renderdoc_getEventDetails`, and `renderdoc_getMeshData` when needed. Only estimate triangle or face pressure when the topology makes that estimate defensible.
- Then inspect shader pressure with `renderdoc_getShaderInfo` or `renderdoc_getPipelineState`. If `renderdoc_getSelectionContext` includes `latestMaliAnalysis`, incorporate it. If the user wants Mali Offline Compiler guidance and no such result is present, say that Inspector -> Shaders -> Analyze with Mali Offline Compiler may be needed first.
- Then inspect texture pressure: summarize bound texture count and inspect suspicious textures by dimensions, format, byte size, and mip levels with `renderdoc_getResourceDetail` or related resource tools.
- Treat overdraw as a separate rasterization validation step. Do not claim it is confirmed unless the capture includes direct overlay or other visual evidence.
- Do not invent shader instruction counts, cycle estimates, overdraw metrics, or Mali results when the local tools did not provide them.
- When providing an optimization report, organize it by timing evidence, geometry pressure, shader or Mali findings, texture pressure, overdraw status, and prioritized fixes.
- Distinguish clearly between confirmed capture facts and inferred bottlenecks or follow-up hypotheses.
- For a specific hot event, continue with `renderdoc_getEventDetails`, `renderdoc_getShaderInfo`, or `renderdoc_getPipelineState` as needed instead of stopping at a flat timing list.
- If the user asks where a suspicious pass or shader comes from in project code, use `renderdoc_findProjectImplementation`.
- If no capture is loaded, say so explicitly instead of searching the repository for substitute data.
- Never ask the user which profiling tool produced the currently selected draw if the local RenderDoc selection context can answer that directly.

Treat the `@renderdoc` participant as the most deterministic entry point, but default Copilot should still use these local tools when they are available and the user does not explicitly mention `@renderdoc`.