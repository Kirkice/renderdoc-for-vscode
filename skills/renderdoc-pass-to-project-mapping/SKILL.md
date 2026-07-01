---
name: renderdoc-pass-to-project-mapping
description: Map RenderDoc passes, events, and shaders back to likely project-side source files and implementation points. Use when asked where a pass is implemented, which project files correspond to a capture event, or how a RenderDoc shader links back to workspace code.
---

# RenderDoc Pass To Project Mapping

Connect capture evidence to workspace code so the user can leave the frame and change the real implementation.

## Workflow

1. Resolve capture state.
Call `renderdoc_openCapture` if needed.

2. Resolve the target pass or event.
Use `renderdoc_getSelectionContext` for current-selection questions.
Call `renderdoc_getEventDetails` for the target EID.
Call `renderdoc_getFrameSummary` when the user starts from a high-level pass description instead of a specific event.

3. Gather the best search anchors.
Call `renderdoc_getShaderInfo` for stage names, entry points, and binding context.
Call `renderdoc_getShaderSource` only if the source text is needed to improve project-side matching.

4. Search the workspace implementation.
Call `renderdoc_findProjectImplementation` with the strongest available anchors from the event, pass, and shader data.

## Output

Report:
- The pass or event being mapped
- The strongest implementation clues from the capture
- The most likely project files or code regions
- Any ambiguity and how to disambiguate it

## Guardrails

- Do not present weak filename guesses as confirmed ownership.
- If the mapping is ambiguous, show the leading candidates and explain why.
- Keep RenderDoc facts and project-side guesses clearly separated.
