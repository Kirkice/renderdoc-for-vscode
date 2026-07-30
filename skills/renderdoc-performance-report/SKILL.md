---
name: renderdoc-performance-report
description: Generate an evidence-based RenderDoc performance and resource footprint report from the current capture.
---

# RenderDoc Performance Report

1. Resolve the current capture with `renderdoc_openCapture` when needed.
2. Call `renderdoc_getFrameSummary` and `renderdoc_getCaptureInfo` for context.
3. Call `renderdoc_generatePerformanceReport` for GPU-timed hotspots.
4. Call `renderdoc_resourceMemoryAudit` for the largest captured resources when memory pressure is relevant.
5. Drill into selected EIDs with event, shader, pipeline, mesh, and resource tools.
6. Preserve the evidence chain for every conclusion: EID, GPU timing, marker/pass path, resource IDs/byte sizes, pipeline state, shader identity, and mesh data when available.
7. Classify findings as confirmed, inferred, or toVerify. If timing, byte-size, replay, or native-bridge evidence is unavailable, state the limitation instead of estimating it.
8. For side-effecting report export, confirm the returned output path and format before claiming the report was written.

Never call an event hot or expensive without timing evidence. Separate confirmed facts, likely causes, and follow-up validation.
