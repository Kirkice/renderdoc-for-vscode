---
name: renderdoc-performance-investigation
description: Investigate performance bottlenecks in a RenderDoc capture and explain which passes or draws are expensive and why. Use when asked to find the hottest work in a frame, rank expensive draws, explain GPU cost, or produce an optimization report for a RenderDoc capture.
---

# RenderDoc Performance Investigation

Find the real hotspots first, then drill from timing evidence into geometry, shader, and texture pressure.

## Workflow

1. Resolve capture state.
Call `renderdoc_openCapture` first if capture state is unknown.

2. Build frame context.
Call `renderdoc_getFrameSummary`.
Call `renderdoc_getCaptureInfo` if API or replay context may matter.

3. Fetch timing evidence.
Call `renderdoc_getActionTimings`.
Do not make "hot" or "slow" claims without timing data unless you clearly mark them as hypotheses.

4. Identify the hottest passes and leaf draws.
Prefer the most expensive top-level groups first, then the hottest leaf events inside them.

5. Drill into each hot event.
Call `renderdoc_getEventDetails`.
Call `renderdoc_getMeshData` when geometry pressure may matter.
Call `renderdoc_getShaderInfo` or `renderdoc_getPipelineState` for shader and binding pressure.
Call `renderdoc_getResourceDetail` or `renderdoc_getTextureInfo` when large or suspicious textures may contribute.

6. End with concrete recommendations.
Tie every recommendation back to a measured event or resource.

## Output

Organize findings by:
- Timing evidence
- Hottest passes or leaf draws
- Likely causes
- Recommended next fixes

For each hot event, report the EID, the full marker path if available, the timing evidence, and the most likely source of cost.

## Guardrails

- Do not stop at a flat list of timings.
- Do not claim overdraw, shader complexity, or memory pressure unless the available evidence supports it.
- Distinguish clearly between confirmed facts, likely causes, and follow-up validation ideas.
- If replay-only inspection is unavailable, still report the timing picture and explain what deeper evidence is missing.
