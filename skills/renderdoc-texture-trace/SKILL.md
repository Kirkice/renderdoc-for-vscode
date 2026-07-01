---
name: renderdoc-texture-trace
description: Trace how a texture is produced, consumed, and related to passes in a RenderDoc capture. Use when asked where a texture comes from, which draws sample it, where a render target is written, or how a texture flows through a frame.
---

# RenderDoc Texture Trace

Follow a texture through the frame as a resource, not just as a screenshot.

## Workflow

1. Resolve capture state.
Call `renderdoc_openCapture` if needed.

2. Identify the texture precisely.
Use `renderdoc_getSelectionContext` when the user refers to a selected resource.
Call `renderdoc_getTextureInfo` or `renderdoc_getResourceDetail` to confirm identity, dimensions, format, and type.

3. Find producer and consumer events.
Call `renderdoc_findDrawsByTexture` when tracing sampled usage.
Call `renderdoc_findDrawsByResourceId` when tracing exact resource references.

4. Add pass context.
Inspect representative events with `renderdoc_getEventDetails`.
Use `renderdoc_getPipelineState` only when the binding context or render-target role needs confirmation.

## Output

Summarize:
- What the texture is
- Where it is likely produced
- Where it is sampled or referenced
- Which passes seem to depend on it

Prefer a short producer-to-consumer story over a long event list.

## Guardrails

- Do not assume a texture is a shadow map, G-buffer target, or post-process intermediate without evidence.
- If there are many matches, group them by pass or role instead of dumping every EID.
- If the selected resource is not a texture, say so and switch to the most relevant resource-level explanation.
