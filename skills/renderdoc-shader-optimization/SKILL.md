---
name: renderdoc-shader-optimization
description: Review captured shader variants, bindings, source, and timing evidence to identify shader optimization opportunities.
---

# RenderDoc Shader Optimization

1. Resolve the current capture and identify the focused or user-provided event.
2. Call `renderdoc_findShaderVariants` when the shader name or resource is ambiguous.
3. Call `renderdoc_getShaderInfo` for stage metadata, bindings, and constant buffers.
4. Call `renderdoc_getShaderSource` only when source/disassembly is needed.
5. Use `renderdoc_getActionTimings` or `renderdoc_generatePerformanceReport` before claiming a shader is expensive.
6. Map the shader back to project code with `renderdoc_findProjectImplementation` when requested.

Separate captured facts from optimization hypotheses. Do not infer shader cost from source complexity alone.
