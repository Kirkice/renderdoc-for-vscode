---
name: renderdoc-shader-review
description: Review shader behavior for a RenderDoc event, including stage roles, bindings, constant buffers, and likely issues. Use when asked to analyze a shader, explain shader-stage behavior, inspect bindings, review constant data, or suggest shader optimizations from a RenderDoc capture.
---

# RenderDoc Shader Review

Review shader behavior in context, not as isolated source text.

## Workflow

1. Resolve capture state.
Call `renderdoc_openCapture` if needed.

2. Resolve the target event.
Use `renderdoc_getSelectionContext` for current-selection questions.
Call `renderdoc_getEventDetails` for the target EID.

3. Gather shader-side evidence.
Call `renderdoc_getShaderInfo` first for stage summaries, bindings, samplers, and decoded constant buffers.
Call `renderdoc_getPipelineState` when broader graphics state or render-target context matters.

4. Read source only when needed.
Call `renderdoc_getShaderSource` only when the user explicitly asks for code, source-level review, or line-specific reasoning.

5. Map back to project code when helpful.
Call `renderdoc_findProjectImplementation` if the user asks where the shader or pass lives in the workspace.

## Output

Report:
- Which shader stages matter most for the target event
- Important bindings, samplers, or constant-buffer values
- The likely job of the shader in the pass
- Concrete issues or optimization ideas, marked as confirmed or inferred

## Guardrails

- Do not dump raw shader code unless requested.
- Do not discuss shader optimization in a vacuum; tie it to the event and pass context.
- Distinguish source facts from performance hypotheses.
- If replay-only shader inspection is unavailable, say that clearly.
