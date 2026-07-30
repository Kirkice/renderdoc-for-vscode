---
name: renderdoc-shader-optimization
description: Review captured shader variants, bindings, source, and timing evidence to identify shader optimization opportunities.
---

# RenderDoc Shader Optimization

1. Resolve the current capture and identify the focused or user-provided event.
2. Call `renderdoc_findShaderVariants` when the shader name or resource is ambiguous.
3. Call `renderdoc_getShaderInfo` for stage metadata, bindings, and constant buffers.
4. Call `renderdoc_getShaderSource` only when source/disassembly is needed.
5. Call `renderdoc_getActionTimings` or `renderdoc_generatePerformanceReport` for the same EID before claiming a shader is expensive.
6. If the result includes `evidenceWorkflow.mali`, run the configured Mali/offline compiler workflow separately; never infer Mali results from source or GPU timings.
7. Map the shader back to project code with `renderdoc_findProjectImplementation` when requested.

Evidence chain: preserve the event ID, stage, shader identity, source availability, binding/constant-buffer summaries, and timing rows together. Report each conclusion as confirmed, inferred, or requiring verification. Separate captured facts from optimization hypotheses. Do not infer shader cost from source complexity alone.
