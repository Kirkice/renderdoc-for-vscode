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

Never call an event hot or expensive without timing evidence. State when timings or byte sizes are unavailable, and separate confirmed facts, likely causes, and follow-up validation.
