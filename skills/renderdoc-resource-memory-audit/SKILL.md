# RenderDoc Resource Memory Audit

Use this skill when the user asks which captured resources consume the most memory, whether textures or buffers are oversized, or for a capture footprint summary.

## Workflow

1. Ensure a capture is loaded; call `renderdoc_openCapture` if needed.
2. Call `renderdoc_resourceMemoryAudit` with a focused limit.
3. Use `renderdoc_getResources` or `renderdoc_getResourceDetail` for suspicious entries.
4. Distinguish RenderDoc-reported capture `byteSize` from runtime allocation, lifetime, or leak evidence.

## Output

Report total resource count, total bytes/MiB, largest resources, formats, dimensions, and actionable follow-ups.

## Guardrails

Do not claim that capture footprint proves a runtime leak. State when metadata is incomplete or native replay is unavailable.
