---
name: renderdoc-current-selection-explainer
description: Explain the currently selected RenderDoc draw, event, or resource in practical terms. Use when the user refers to "this", "current", or "selected" in a RenderDoc capture and wants to know what it is doing, why it matters, or what to inspect next.
---

# RenderDoc Current Selection Explainer

Translate the current RenderDoc selection into a short, grounded explanation without making the user specify raw IDs.

## Workflow

1. Resolve capture state if needed.
Call `renderdoc_openCapture` if no capture is loaded.

2. Resolve the selection first.
Call `renderdoc_getSelectionContext` before interpreting "this", "current", or "selected".

3. Branch on the selected thing.
If a draw or event is selected, call `renderdoc_getEventDetails`.
If pipeline or shader context matters, call `renderdoc_getShaderInfo` or `renderdoc_getPipelineState`.
If a resource is selected, call `renderdoc_getResourceDetail` or `renderdoc_getTextureInfo`.

4. Add only the most useful supporting detail.
Pull in mesh, texture, or buffer details only if they materially explain the selection.

## Output

Explain:
- What the selected item is
- What role it appears to play in the frame
- The most important evidence behind that explanation
- The next best follow-up question or inspection step

Prefer plain language over raw JSON.

## Guardrails

- If there is no current selection, say that explicitly and ask for a selection only if the user intent truly depends on it.
- Do not guess what "this" refers to without `renderdoc_getSelectionContext`.
- Keep the answer scoped to the selected item unless the user asks for broader frame context.
