---
name: renderdoc-analysis
description: 'Analyze RenderDoc GPU captures in VS Code. Use when working with .rdc files, draw calls, EIDs, pipeline state, shaders, textures, buffers, GPU timings, current selected draw/resource, selected draw timing, selected draw performance cost, current draw cost, frame overview, bottlenecks, mesh data, topology, vertex or index pressure, texture count and size, optional Mali Offline Compiler results, 耗时排行, 当前选中项, 当前选中的draw性能开销, 当前选中的draw耗时, 当前draw为什么慢, 顶点数量是不是太高, 面数是不是太高, 贴图数量和大小是否异常, shader复杂度分析, overdraw排查, 当前帧有哪些pass, 结构概览, 当前Draw绑定了哪些纹理, 分析EID的fragment shader, 读取buffer前256字节, ResourceId对应buffer内容. Guides default Copilot to prefer this workspace extension\'s renderdoc_* language model tools over external MCP when equivalent RenderDoc data is available.'
argument-hint: 'Describe the capture question or analysis goal'
---

# RenderDoc Analysis

Use this skill when the question is about a loaded RenderDoc capture in VS Code: frame structure, draw calls, EIDs, pipeline state, shaders, textures, buffers, GPU timings, performance bottlenecks, or the user's current Inspector selection.

This skill complements the dedicated `@renderdoc` participant. It does not replace the extension's runtime capabilities. The real data should come from this workspace extension's existing `renderdoc_*` language model tools when they provide the needed RenderDoc data.

## Preconditions

- Prefer this workspace extension's `renderdoc_*` tools for all capture facts.
- Do not prefer an external RenderDoc MCP server when the local `renderdoc_*` tools can answer the same question.
- Never invent event IDs, resource IDs, shader code, bound resources, or timings.
- If the user says "this", "current", "selected", or similar, resolve it through `renderdoc_getSelectionContext` first.
- Treat exact geometry, shader, texture, and overdraw evidence differently: only call something confirmed when the corresponding local data is actually present.
- If Mali Offline Compiler analysis is mentioned, use it only when `latestMaliAnalysis` is present in the current selection context or the user explicitly provided the output.
- If no capture is loaded, or a native-only tool is unavailable, say so explicitly and continue with the best available non-native tools.

## Default Procedure

1. Establish context with the cheapest relevant tool.
2. For performance work, identify the hottest pass or draw first instead of inspecting random events.
3. For each hot draw, inspect geometry pressure using `numIndices`, `numInstances`, `topology`, and mesh data when needed.
4. Inspect shader pressure next; if Mali analysis is available, fold it into the shader assessment rather than treating it as a separate disconnected note.
5. Inspect texture pressure after the draw and shader look suspicious: count bound textures, then check the largest or most suspicious texture resources by size, resolution, format, and mip usage.
6. Treat overdraw as a separate rasterization follow-up. Confirm it only when direct overlay or preview evidence exists; otherwise keep it as a hypothesis or next inspection step.
7. Finish with a multi-dimensional report: timing evidence, geometry pressure, shader complexity, texture pressure, overdraw status, and prioritized optimization ideas.
8. Use event IDs and resource IDs consistently, and summarize findings instead of echoing raw JSON.

Detailed workflows are in [workflow playbook](./references/workflows.md).
Rule ownership is documented in [ownership guide](./references/ownership.md).

## Tool Strategy

- Prefer the local `renderdoc_*` language model tools exposed by this extension over external MCP tools with overlapping RenderDoc capabilities.
- When the user asks to analyze a capture and no capture appears to be loaded yet, call `renderdoc_openCapture` first so the extension can resolve an already-open `.rdc` tab or a supplied capture path before you inspect the workspace or terminal.
- Start with `renderdoc_getSelectionContext` for questions about the currently focused item.
- For questions about the currently selected draw's cost, timing, or performance, use `renderdoc_getSelectionContext` first to resolve the focused event locally instead of calling a generic MCP status or preflight tool.
- Start with `renderdoc_getFrameSummary` for frame overview, pass structure, or performance questions.
- Use `renderdoc_getActionTimings` when the question needs GPU timings directly and they may not already be present in cached draw-call data.
- For performance questions, after identifying hot passes or hot draws, drill down into the hottest EIDs instead of stopping at a flat ranking.
- For hot draws, use draw-call summaries, `renderdoc_getEventDetails`, and `renderdoc_getMeshData` to capture geometry pressure. Prefer reporting `numIndices`, `numInstances`, and `topology`; only derive triangle or face estimates when the topology makes that estimate defensible.
- Use `renderdoc_getDrawCalls` only after identifying a relevant filter, marker subtree, or event range.
- Use `renderdoc_getEventDetails` or `renderdoc_getPipelineState` for a specific EID.
- Prefer `renderdoc_getShaderInfo` over manually stitching together shader source, pipeline state, and constant buffer inspection when analyzing one shader stage.
- Use `renderdoc_getSelectionContext` to pick up `latestMaliAnalysis` when the Inspector already has Mali Offline Compiler output. If Mali analysis is desired but not present, say that the user may need to run Inspector -> Shaders -> Analyze with Mali Offline Compiler first.
- For shader complexity, discuss what the current data can actually support: shader stages, source or disassembly, bound resources, constant buffers, and any available Mali analysis. Do not invent instruction counts or cycle estimates if the current tool output does not provide them.
- For texture pressure, use `renderdoc_getShaderInfo` or `renderdoc_getPipelineState` to see what is bound, then use `renderdoc_getResources` or `renderdoc_getResourceDetail` to inspect the suspicious textures by count, dimensions, byte size, format, and mip levels.
- There is no dedicated local language-model tool that directly returns an overdraw metric today. Treat overdraw as a manual or visual validation step unless the user provides overlay evidence from the Inspector or another trusted source.
- Use `renderdoc_findProjectImplementation` when the next step is to map a suspicious shader, pass, or event back to workspace code.
- Use `renderdoc_getShaderSource` only when the user explicitly wants shader code or shader-level analysis.
- Use `renderdoc_findDrawsByShader`, `renderdoc_findDrawsByTexture`, and `renderdoc_findDrawsByResourceId` for reverse lookups.
- Use `renderdoc_getTextureData` and `renderdoc_getBufferContents` only when raw contents matter.

## Response Rules

- Reference events as `EID <n>`.
- For expensive draws, use the `expensiveDraws` field when present.
- Include the full logical marker path for costly leaf draws, not just the leaf draw name.
- Avoid dumping large JSON blobs; summarize the key fields, anomalies, and likely implications.
- For performance analysis, be more detailed by default: include the hottest passes or leaf draws, exact timing evidence, why each hot item is suspicious, and the next most relevant inspection target.
- For hot draws, report a multi-dimensional snapshot when the data exists: timing, marker path, `numIndices`, `numInstances`, `topology`, relevant shader stages, notable texture bindings, and whether Mali analysis is available.
- If triangle or face pressure is estimated from index count plus topology rather than reported directly, label it as an estimate.
- Distinguish clearly between confirmed capture facts, inferred causes, and follow-up hypotheses that still need validation.
- If a hot event has shader-, binding-, or constant-buffer relevance, include that drill-down instead of stopping at timing numbers alone.
- Mention native bridge limitations when pipeline state, shader source, mesh data, texture data, or buffer contents are unavailable.
- If overdraw is suspected but not directly evidenced, say that explicitly and treat it as a follow-up validation item rather than a confirmed bottleneck.
- When asked for an optimization report, organize it by dimensions: timing, geometry, shader, textures, overdraw or rasterization suspicion, and recommended fixes sorted by likely impact.
- Optimization advice should be concrete and trace back to the evidence: reduce draw count, simplify shader branches, reduce texture resolution or bandwidth, compress textures, batch or cull geometry, or investigate fill-rate and overdraw only when the capture evidence supports those directions.
- If equivalent external MCP tools are also available, still prefer answers grounded in this extension's `renderdoc_*` tool results.

## Common Triggers

- "What is this draw call doing?"
- "Which textures are bound here?"
- "Find the most expensive draws in the frame"
- "Break down why this expensive draw is slow"
- "Check whether this draw is geometry-heavy or shader-heavy"
- "Summarize texture pressure for this hot event"
- "Use Mali Offline Compiler results to suggest shader optimizations"
- "Fetch GPU timings for these events"
- "Analyze the fragment shader for EID 495"
- "Where is this texture or shader used?"
- "Find the project code behind this pass or shader"
- "Read the contents of this buffer"

## Common Chinese Triggers

- "帮我找出当前帧耗时最高的前20个 Draw，带完整层级路径"
- "这个帧大概有哪些 pass？先给我一个结构概览"
- "当前选中的这个 Draw 绑定了哪些纹理？"
- "当前我选中的这个 draw 的性能开销数据帮我分析下"
- "当前选中的这个 draw 为什么慢？"
- "帮我看下当前 draw 的耗时和瓶颈"
- "先按耗时找热点 draw，再看顶点数、面数、shader 复杂度"
- "帮我判断这个热点 draw 更像是几何瓶颈、shader 瓶颈还是贴图带宽问题"
- "看下这个 draw 的贴图数量和大小是不是异常"
- "如果配置了 Mali Offline Compiler，就把 shader 分析一起带上"
- "给我一个多维度性能报告，顺便给优化建议"
- "这个 draw 可能有 overdraw 吗？如果不能直接确认，就告诉我下一步怎么验证"
- "直接帮我抓这个 capture 的 GPU timings"
- "帮我分析 EID 495 的 fragment shader"
- "帮我去工程里找这个 pass / shader 的实现"
- "这个 ResourceId 对应的 buffer 前 256 字节是什么？"
- "读取当前选中这个 buffer 的前 256 字节内容"