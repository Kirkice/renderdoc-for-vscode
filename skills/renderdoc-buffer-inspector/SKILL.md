---
name: renderdoc-buffer-inspector
description: Inspect buffer resources and their contents in a RenderDoc capture, including raw bytes and event context. Use when asked to inspect a GPU buffer, constant-buffer contents, structured data, or the meaning of selected buffer bytes in a RenderDoc capture.
---

# RenderDoc Buffer Inspector

Inspect buffers carefully and incrementally so the answer stays grounded and readable.

## Workflow

1. Resolve capture state.
Call `renderdoc_openCapture` if needed.

2. Identify the target buffer exactly.
Use `renderdoc_getSelectionContext` for selected resources.
Call `renderdoc_getResourceDetail` first to confirm the resource is a buffer and to capture size and role.

3. Read a small slice before reading more.
Call `renderdoc_getBufferContents` with a narrow `offset` and `len` by default.
Page outward only if the user asks for more or the first slice is clearly insufficient.

4. Add event context when needed.
Call `renderdoc_findDrawsByResourceId` or `renderdoc_getEventDetails` if the meaning of the data depends on how the buffer is used.

5. Prefer decoded constant-buffer views when available.
If the question is really about bound constant values at an event, use shader and pipeline inspection before falling back to raw bytes.

## Output

Explain:
- What the buffer appears to be used for
- Which slice was inspected
- What patterns or values are visible
- What follow-up read would be most useful if the answer is still incomplete

## Guardrails

- Do not dump huge byte ranges by default.
- Do not pretend raw bytes are fully decoded structures unless the schema is known.
- If the resource is not a buffer, say so and pivot to the correct resource explanation.
